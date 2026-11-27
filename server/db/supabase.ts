// Minimal PostgREST client for Supabase. Avoids the realtime/websocket stack
// of supabase-js and degrades gracefully when the v2 columns are missing.
import type { DatabaseHealth } from "@shared/schema";
import { randomUUID } from "node:crypto";
import { fetchWithTimeout } from "../http";
import type { Punch } from "@shared/punches";
import { MAX_PUNCH_QUERY, type DataStore, type ImportData, type ImportOptions, type PunchPatch, type PunchQuery, type TimesheetRow, type TimesheetWrite, StoreError, patchToRow, punchToRow, rowToPunch, toSummary } from "./types";

const EXT_COLS = ["site_id", "meta_json"] as const;
const ROW_COLS = [
  "id", "filename", "custom_label", "period_start", "period_end", "employee_count", "total_pay", "result_json", "wages_json",
  "manual_employees_json", "csv_data", "site_id", "meta_json", "created_at", "updated_at",
];
/** Rows asked for per request (Supabase's default reply cap). */
const PAGE = 1000;
const SUMMARY_COLS = "id,filename,custom_label,period_start,period_end,employee_count,total_pay,created_at,updated_at";

export class SupabaseStore implements DataStore {
  readonly kind = "supabase" as const;
  readonly label: string;
  private base: string;
  private extended = true;

  constructor(url: string, private key: string, opts: { label?: string; proxy?: boolean } = {}) {
    this.base = url.replace(/\/+$/, "") + "/rest/v1";
    this.label = opts.label ?? new URL(url).host;
    this.proxy = !!opts.proxy;
  }
  private proxy: boolean;

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json", ...extra };
    if (this.proxy) h["x-api-key"] = this.key;
    else {
      h.apikey = this.key;
      if (this.key.startsWith("eyJ")) h.Authorization = `Bearer ${this.key}`;
    }
    return h;
  }

  private async req(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<any> {
    let res: Response;
    try {
      res = await fetchWithTimeout(`${this.base}${path}`, { method, headers: this.headers(extra), body: body === undefined ? undefined : JSON.stringify(body) }, 15000);
    } catch (err: any) {
      throw new StoreError(`Database unreachable: ${err.message}`, 503);
    }
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!res.ok) {
      const msg = json?.message || json?.error || res.statusText;
      const err: any = new StoreError(`Database error: ${msg}`, res.status === 401 || res.status === 403 ? 502 : res.status >= 500 ? 503 : 400);
      err.code = json?.code;
      err.raw = msg;
      throw err;
    }
    return json;
  }

  /**
   * GET every row, one page at a time. Supabase caps each reply (1000 rows by
   * default, whatever limit= asks for), so a single request can silently cut
   * a backup short. `query` must include a stable order= (ending in a unique
   * column). Pages are read until an empty one, so a lower server cap is fine.
   */
  private async getAll(table: string, query: string, opts: { max?: number; punches?: boolean } = {}): Promise<any[]> {
    const max = opts.max ?? Infinity;
    const out: any[] = [];
    for (let guard = 0; out.length < max && guard < 10_000; guard++) {
      const want = Math.min(PAGE, max - out.length);
      const path = `/${table}?${query}&limit=${want}&offset=${out.length}`;
      const page = (opts.punches ? await this.punchReq("GET", path) : await this.req("GET", path)) ?? [];
      if (!Array.isArray(page) || !page.length) break;
      out.push(...page);
    }
    return out;
  }

  private isMissingColumn(err: any) {
    return err?.code === "42703" || err?.code === "PGRST204" || /column .* does not exist|Could not find the .* column/i.test(err?.raw ?? "");
  }

  async init() {
    try {
      await this.req("GET", `/recent_uploads?select=site_id,meta_json&limit=1`);
      this.extended = true;
    } catch (err: any) {
      if (this.isMissingColumn(err)) this.extended = false;
      else throw err;
    }
    await this.req("GET", `/app_settings?select=key&limit=1`);
  }

  async getSetting(key: string) {
    const rows = await this.req("GET", `/app_settings?select=value&key=eq.${encodeURIComponent(key)}`);
    return rows?.[0]?.value ?? null;
  }
  async getSettings(keys: string[]) {
    if (!keys.length) return {};
    const list = keys.map((k) => `"${k.replace(/"/g, '\\"')}"`).join(",");
    const rows = await this.req("GET", `/app_settings?select=key,value&key=in.(${encodeURIComponent(list)})`);
    return Object.fromEntries((rows ?? []).map((r: any) => [r.key, r.value]));
  }
  async allSettings() {
    return this.getAll("app_settings", "select=key,value&order=key");
  }
  async setSetting(key: string, value: string) {
    await this.req("POST", `/app_settings?on_conflict=key`, [{ key, value, updated_at: new Date().toISOString() }], {
      Prefer: "resolution=merge-duplicates,return=minimal",
    });
  }
  async deleteSetting(key: string) {
    await this.req("DELETE", `/app_settings?key=eq.${encodeURIComponent(key)}`, undefined, { Prefer: "return=minimal" });
  }

  async listTimesheets() {
    const cols = this.extended
      ? `${SUMMARY_COLS},site_id,status:meta_json->>status,deleted_at:meta_json->>deletedAt`
      : `${SUMMARY_COLS},site_id:result_json->__meta->>siteId,status:result_json->__meta->>status,deleted_at:result_json->__meta->>deletedAt`;
    const rows = await this.getAll("recent_uploads", `select=${cols}&order=updated_at.desc.nullslast,created_at.desc,id.asc`, { max: 5000 });
    return rows.map(toSummary);
  }
  private decode(r: any): TimesheetRow {
    if (!this.extended && r?.result_json?.__meta) {
      r.meta_json = r.result_json.__meta;
      r.site_id = r.result_json.__meta.siteId ?? null;
    }
    return { site_id: null, meta_json: null, ...r };
  }
  private encode(row: Partial<TimesheetWrite>) {
    const out: any = {};
    for (const [k, v] of Object.entries(row)) if (ROW_COLS.includes(k)) out[k] = v;
    if (!this.extended) {
      const meta = out.meta_json ? { ...out.meta_json, siteId: out.site_id ?? out.meta_json.siteId } : undefined;
      for (const c of EXT_COLS) delete out[c];
      if (meta && out.result_json) out.result_json = { ...out.result_json, __meta: meta };
    }
    return out;
  }
  async getTimesheet(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const rows = await this.req("GET", `/recent_uploads?select=*&id=eq.${id}`);
    return rows?.[0] ? this.decode(rows[0]) : null;
  }
  async allTimesheets() {
    const rows = await this.getAll("recent_uploads", "select=*&order=created_at.asc,id.asc");
    return rows.map((r: any) => this.decode(r));
  }

  private async write(method: "POST" | "PATCH", path: string, row: any, prefer: string): Promise<any[]> {
    try {
      return await this.req(method, path, row, { Prefer: prefer });
    } catch (err: any) {
      if (this.extended && this.isMissingColumn(err)) {
        this.extended = false; // database lacks v2 columns: store metadata inside result_json instead
        return await this.req(method, path, this.encode(row), { Prefer: prefer });
      }
      throw err;
    }
  }
  async insertTimesheet(row: TimesheetWrite) {
    const now = new Date().toISOString();
    const data = this.encode({ ...row, updated_at: now } as any);
    if (!data.id) delete data.id;
    const prefer = data.id ? "return=representation,resolution=merge-duplicates" : "return=representation";
    const rows = await this.write("POST", `/recent_uploads?select=${SUMMARY_COLS}`, data, prefer);
    return toSummary({ ...rows[0], site_id: row.site_id, status: row.meta_json?.status, deleted_at: row.meta_json?.deletedAt });
  }
  async updateTimesheet(id: string, row: Partial<TimesheetWrite>) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const data = this.encode({ ...row, updated_at: new Date().toISOString() } as any);
    delete data.id;
    if (!this.extended && row.meta_json && !row.result_json) {
      // keep metadata in sync when only the label changes
      const cur = await this.getTimesheet(id);
      if (cur) data.result_json = { ...(cur.result_json ?? {}), __meta: { ...(cur.meta_json ?? {}), ...row.meta_json } };
    }
    const rows = await this.write("PATCH", `/recent_uploads?id=eq.${id}&select=${SUMMARY_COLS}`, data, "return=representation");
    if (!rows?.[0]) return null;
    const full = await this.getTimesheet(id);
    return toSummary({ ...rows[0], site_id: full?.site_id ?? null, status: full?.meta_json?.status, deleted_at: full?.meta_json?.deletedAt });
  }
  async deleteTimesheet(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    const rows = await this.req("DELETE", `/recent_uploads?id=eq.${id}&select=id`, undefined, { Prefer: "return=representation" });
    return (rows ?? []).length > 0;
  }

  // ── Punches ────────────────────────────────────────────────────────────────
  private async punchReq(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<any> {
    try {
      return await this.req(method, path, body, extra);
    } catch (err: any) {
      if (err?.code === "42P01" || err?.code === "PGRST205" || /Could not find the table|relation .*punches.* does not exist/i.test(err?.raw ?? "")) {
        throw new StoreError("The time clock needs the punches table. Open Settings → Database, copy the setup SQL and run it in Supabase.", 503);
      }
      throw err;
    }
  }
  async listPunches(q: PunchQuery) {
    const f: string[] = ["select=*"];
    if (q.siteId) f.push(`site_id=eq.${encodeURIComponent(q.siteId)}`);
    if (q.employeeId) f.push(`employee_id=eq.${encodeURIComponent(q.employeeId)}`);
    if (q.from) f.push(`at=gte.${encodeURIComponent(q.from)}`);
    if (q.to) f.push(`at=lt.${encodeURIComponent(q.to)}`);
    f.push("order=at.asc,id.asc");
    const max = Math.max(1, Math.min(q.limit ?? 20000, MAX_PUNCH_QUERY + 1));
    return (await this.getAll("punches", f.join("&"), { max, punches: true })).map(rowToPunch);
  }
  async getPunch(id: string) {
    const rows = await this.punchReq("GET", `/punches?select=*&id=eq.${encodeURIComponent(id)}`);
    return rows?.[0] ? rowToPunch(rows[0]) : null;
  }
  async insertPunch(p: Punch) {
    const rows = await this.punchReq("POST", `/punches?on_conflict=id`, [punchToRow(p)], { Prefer: "resolution=ignore-duplicates,return=representation" });
    if (rows?.[0]) return { punch: rowToPunch(rows[0]), created: true };
    return { punch: (await this.getPunch(p.id))!, created: false };
  }
  async updatePunch(id: string, patch: PunchPatch) {
    const rows = await this.punchReq("PATCH", `/punches?id=eq.${encodeURIComponent(id)}`, patchToRow(patch), { Prefer: "return=representation" });
    return rows?.[0] ? rowToPunch(rows[0]) : null;
  }
  async deletePunch(id: string) {
    const rows = await this.punchReq("DELETE", `/punches?id=eq.${encodeURIComponent(id)}&select=id`, undefined, { Prefer: "return=representation" });
    return (rows ?? []).length > 0;
  }
  async allPunches() {
    try {
      return (await this.getAll("punches", "select=*&order=at.asc,id.asc", { punches: true })).map(rowToPunch);
    } catch (err: any) {
      if (err instanceof StoreError && err.status === 503 && /punches table/.test(err.message)) return [];
      throw err;
    }
  }
  async *punchPages() {
    let offset = 0;
    for (;;) {
      let page: any[];
      try {
        page = (await this.punchReq("GET", `/punches?select=*&order=at.asc,id.asc&limit=${PAGE}&offset=${offset}`)) ?? [];
      } catch (err: any) {
        if (err instanceof StoreError && err.status === 503 && /punches table/.test(err.message)) return;
        throw err;
      }
      if (!Array.isArray(page) || !page.length) return;
      yield page.map(rowToPunch);
      offset += page.length;
    }
  }

  /**
   * PostgREST runs each request in one transaction, so every table is written
   * with a single request: a bad row fails the whole batch. Timesheets go
   * first so a failure never leaves settings pointing at missing data.
   */
  async importAll(data: ImportData, opts: ImportOptions = {}) {
    const now = new Date().toISOString();
    const keep = opts.keepSetting ?? (() => false);
    const settings = data.settings.filter((x) => !keep(x.key));
    const rows = data.timesheets.map((t) => {
      const r = this.encode({ ...t, updated_at: now } as any);
      if (!r.id) r.id = randomUUID();
      return r;
    });
    // Upsert first, then delete what the import doesn't contain: if a request
    // fails part-way, nothing from the backup is missing.
    if (rows.length) await this.write("POST", `/recent_uploads?on_conflict=id`, rows, "resolution=merge-duplicates,return=minimal");
    if (settings.length) {
      await this.req("POST", `/app_settings?on_conflict=key`, settings.map((s) => ({ key: s.key, value: s.value, updated_at: now })), {
        Prefer: "resolution=merge-duplicates,return=minimal",
      });
    }
    if (data.punches?.length) {
      await this.punchReq("POST", `/punches?on_conflict=id`, data.punches.map(punchToRow), {
        Prefer: `resolution=${opts.replace ? "merge" : "ignore"}-duplicates,return=minimal`,
      });
    }
    if (opts.replace) {
      const ids = new Set(rows.map((r: any) => String(r.id)));
      const extra = (await this.getAll("recent_uploads", "select=id&order=id")).map((r: any) => String(r.id)).filter((id: string) => !ids.has(id));
      await this.deleteIn("/recent_uploads", "id", extra);
      const keys = new Set(settings.map((s) => s.key));
      const extraKeys = (await this.getAll("app_settings", "select=key&order=key")).map((r: any) => String(r.key)).filter((k: string) => !keys.has(k) && !keep(k));
      await this.deleteIn("/app_settings", "key", extraKeys);
      if (data.punches) {
        const pids = new Set(data.punches.map((p) => p.id));
        const extraP = (await this.getAll("punches", "select=id&order=id", { punches: true })).map((r: any) => String(r.id)).filter((id: string) => !pids.has(id));
        await this.deleteIn("/punches", "id", extraP);
      }
    }
    return { settings: settings.length, timesheets: rows.length, punches: data.punches?.length ?? 0 };
  }
  private async deleteIn(table: string, col: string, values: string[]) {
    for (let i = 0; i < values.length; i += 100) {
      const list = values.slice(i, i + 100).map((v) => `"${v.replace(/"/g, '\\"')}"`).join(",");
      await this.req("DELETE", `${table}?${col}=in.(${encodeURIComponent(list)})`, undefined, { Prefer: "return=minimal" });
    }
  }

  async health(): Promise<DatabaseHealth> {
    const t = Date.now();
    const h: DatabaseHealth = { ok: false, kind: "supabase", label: this.label, latencyMs: null, error: null, missingTables: [], missingColumns: [], timesheetCount: null };
    for (const table of ["app_settings", "recent_uploads"]) {
      try {
        await this.req("GET", `/${table}?select=*&limit=0`);
      } catch (err: any) {
        if (err?.code === "42P01" || err?.code === "PGRST205" || /does not exist|Could not find the table/i.test(err?.raw ?? "")) h.missingTables.push(table);
        else { h.error = err.message; return h; }
      }
    }
    if (!h.missingTables.includes("recent_uploads")) {
      for (const c of EXT_COLS) {
        try { await this.req("GET", `/recent_uploads?select=${c}&limit=0`); } catch (err: any) { if (this.isMissingColumn(err)) h.missingColumns.push(c); }
      }
      try {
        const res = await fetchWithTimeout(`${this.base}/recent_uploads?select=id&limit=1`, { headers: this.headers({ Prefer: "count=exact" }) }, 10000);
        const range = res.headers.get("content-range");
        h.timesheetCount = range ? Number(range.split("/")[1]) || 0 : null;
      } catch { /* ignore */ }
    }
    this.extended = !h.missingColumns.length;
    // The time clock's table is optional: report it without failing the connection.
    try { await this.req("GET", `/punches?select=id&limit=0`); } catch (err: any) {
      if (err?.code === "42P01" || err?.code === "PGRST205" || /does not exist|Could not find the table/i.test(err?.raw ?? "")) h.missingTables.push("punches");
    }
    h.latencyMs = Date.now() - t;
    const core = h.missingTables.filter((x) => x !== "punches");
    h.ok = !core.length;
    if (core.length) h.error = `Missing tables: ${h.missingTables.join(", ")}. Run the setup SQL.`;
    else if (h.missingTables.length) h.error = "The time clock's punches table is missing. Run the setup SQL to use the kiosk.";
    return h;
  }
  close() { /* stateless */ }
}
