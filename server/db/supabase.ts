// Minimal PostgREST client for Supabase. Avoids the realtime/websocket stack
// of supabase-js and degrades gracefully when the v2 columns are missing.
import type { DatabaseHealth } from "@shared/schema";
import { fetchWithTimeout } from "../http";
import { type DataStore, type TimesheetRow, type TimesheetWrite, StoreError, toSummary } from "./types";

const EXT_COLS = ["site_id", "meta_json"] as const;
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
    return (await this.req("GET", `/app_settings?select=key,value&order=key`)) ?? [];
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
      ? `${SUMMARY_COLS},site_id,status:meta_json->>status`
      : `${SUMMARY_COLS},site_id:result_json->__meta->>siteId,status:result_json->__meta->>status`;
    const rows = await this.req("GET", `/recent_uploads?select=${cols}&order=updated_at.desc.nullslast,created_at.desc&limit=5000`);
    return (rows ?? []).map(toSummary);
  }
  private decode(r: any): TimesheetRow {
    if (!this.extended && r?.result_json?.__meta) {
      r.meta_json = r.result_json.__meta;
      r.site_id = r.result_json.__meta.siteId ?? null;
    }
    return { site_id: null, meta_json: null, ...r };
  }
  private encode(row: Partial<TimesheetWrite>) {
    const out: any = { ...row };
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
    const rows = await this.req("GET", `/recent_uploads?select=*&order=created_at.asc&limit=10000`);
    return (rows ?? []).map((r: any) => this.decode(r));
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
    return toSummary({ ...rows[0], site_id: row.site_id, status: row.meta_json?.status });
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
    return toSummary({ ...rows[0], site_id: full?.site_id ?? null, status: full?.meta_json?.status });
  }
  async deleteTimesheet(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    const rows = await this.req("DELETE", `/recent_uploads?id=eq.${id}&select=id`, undefined, { Prefer: "return=representation" });
    return (rows ?? []).length > 0;
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
    h.latencyMs = Date.now() - t;
    h.ok = !h.missingTables.length;
    if (h.missingTables.length) h.error = `Missing tables: ${h.missingTables.join(", ")}. Run the setup SQL.`;
    return h;
  }
  close() { /* stateless */ }
}
