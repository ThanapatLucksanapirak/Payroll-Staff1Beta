import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseHealth } from "@shared/schema";
import type { Punch } from "@shared/punches";
import { MAX_PUNCH_QUERY, type DataStore, type ImportData, type ImportOptions, type PunchPatch, type PunchQuery, type TimesheetRow, type TimesheetWrite, StoreError, patchToRow, punchToRow, rowToPunch, toSummary } from "./types";

const JSON_COLS = ["result_json", "wages_json", "manual_employees_json", "meta_json"] as const;
const ROW_COLS = [
  "id", "filename", "custom_label", "period_start", "period_end", "employee_count", "total_pay", "result_json", "wages_json",
  "manual_employees_json", "csv_data", "site_id", "meta_json", "created_at", "updated_at",
] as const;

/**
 * Versioned schema migrations. Each entry runs once, in order, inside a
 * transaction; the database's `user_version` records how far it has got.
 * Never edit a migration that has shipped: add a new one instead.
 */
export const MIGRATIONS: { version: number; name: string; up: (db: Database.Database) => void }[] = [
  {
    version: 1,
    name: "base tables",
    up: (db) => db.exec(`
      create table if not exists app_settings (key text primary key, value text not null, updated_at text);
      create table if not exists recent_uploads (
        id text primary key, filename text not null default '', custom_label text, period_start text, period_end text,
        employee_count integer not null default 0, total_pay real not null default 0,
        result_json text, wages_json text, manual_employees_json text, csv_data text,
        created_at text not null, updated_at text
      );
    `),
  },
  {
    version: 2,
    name: "locations and document metadata",
    up: (db) => {
      const cols = new Set((db.prepare("pragma table_info(recent_uploads)").all() as { name: string }[]).map((c) => c.name));
      if (!cols.has("site_id")) db.exec("alter table recent_uploads add column site_id text");
      if (!cols.has("meta_json")) db.exec("alter table recent_uploads add column meta_json text");
      db.exec("create index if not exists recent_uploads_site_idx on recent_uploads (site_id, updated_at)");
    },
  },
  // Version 3 is reserved for user accounts (developed separately).
  {
    version: 4,
    name: "time clock punches",
    up: (db) => db.exec(`
      create table if not exists punches (
        id text primary key, site_id text not null, employee_id text not null, employee_name text not null,
        type text not null, at text not null, source text not null default 'kiosk', device_id text, note text,
        created_at text not null, edited_at text, meta_json text
      );
      create index if not exists punches_site_at_idx on punches (site_id, at);
      create index if not exists punches_employee_at_idx on punches (employee_id, at);
    `),
  },
];
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export class SqliteStore implements DataStore {
  readonly kind = "sqlite" as const;
  readonly label: string;
  private db!: Database.Database;

  constructor(private file: string) {
    this.label = `Local file (${path.basename(file)})`;
  }

  async init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // A zero-byte file isn't one the app made (it writes a header at once): don't treat it as a fresh database and set up over it.
    if (fs.existsSync(this.file) && fs.statSync(this.file).size === 0) {
      throw new StoreError(`The database file is empty. It may have been damaged or truncated. Restore it from a backup, or delete the empty file to start fresh.`, 503);
    }
    const existed = fs.existsSync(this.file) && fs.statSync(this.file).size > 0;
    this.db = new Database(this.file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    // Payroll data: readable by the server's own user only (new files were 0644).
    for (const f of [this.file, `${this.file}-wal`, `${this.file}-shm`]) {
      try { if (fs.existsSync(f)) fs.chmodSync(f, 0o600); } catch { /* e.g. a read-only or Windows file system */ }
    }
    const quick = this.db.pragma("quick_check", { simple: true });
    if (quick !== "ok") console.error(`[db] integrity check reported: ${quick}`);
    await this.migrate(existed);
  }

  /** Bring the schema up to date, taking a copy of the file first. */
  private async migrate(existed: boolean) {
    const current = Number(this.db.pragma("user_version", { simple: true })) || 0;
    if (current > SCHEMA_VERSION) console.warn(`[db] this database is from a newer version of the app (schema ${current}, this app knows ${SCHEMA_VERSION}). Update the app; saving data may not work correctly until you do.`);
    const pending = MIGRATIONS.filter((m) => m.version > current);
    if (!pending.length) return;
    const hasData = existed && !!this.db.prepare("select 1 from sqlite_master where type = 'table' and name = 'recent_uploads'").get();
    if (hasData) {
      const dir = path.join(path.dirname(this.file), "backups");
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `before-migration-v${current}-to-v${SCHEMA_VERSION}-${Date.now()}.db`);
      await this.db.backup(target);
      console.log(`[db] saved a copy before upgrading the schema: ${target}`);
    }
    for (const m of pending) {
      this.db.transaction(() => {
        m.up(this.db);
        this.db.pragma(`user_version = ${m.version}`);
      })();
      console.log(`[db] applied migration ${m.version} (${m.name})`);
    }
  }

  schemaVersion(): number {
    return Number(this.db.pragma("user_version", { simple: true })) || 0;
  }

  private decode(r: any): TimesheetRow {
    const out = { ...r };
    for (const c of JSON_COLS) {
      try { out[c] = r[c] == null ? null : JSON.parse(r[c]); } catch { out[c] = null; }
    }
    return out;
  }

  private encode(row: Partial<TimesheetWrite>) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(row)) if ((ROW_COLS as readonly string[]).includes(k)) out[k] = v;
    for (const c of JSON_COLS) if (c in out) out[c] = out[c] == null ? null : JSON.stringify(out[c]);
    return out;
  }

  async getSetting(key: string) {
    const r = this.db.prepare("select value from app_settings where key = ?").get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }
  async getSettings(keys: string[]) {
    if (!keys.length) return {};
    const rows = this.db.prepare(`select key, value from app_settings where key in (${keys.map(() => "?").join(",")})`).all(...keys) as any[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
  async allSettings() {
    return this.db.prepare("select key, value from app_settings order by key").all() as { key: string; value: string }[];
  }
  private setSettingSync(key: string, value: string) {
    this.db.prepare("insert into app_settings (key, value, updated_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at")
      .run(key, value, new Date().toISOString());
  }
  async setSetting(key: string, value: string) {
    this.setSettingSync(key, value);
  }
  async deleteSetting(key: string) {
    this.db.prepare("delete from app_settings where key = ?").run(key);
  }
  async listTimesheets() {
    const rows = this.db.prepare(`select id, site_id, filename, custom_label, period_start, period_end, employee_count, total_pay, created_at, updated_at,
      json_extract(meta_json, '$.status') as status, json_extract(meta_json, '$.deletedAt') as deleted_at
      from recent_uploads order by coalesce(updated_at, created_at) desc`).all();
    return rows.map(toSummary);
  }
  async getTimesheet(id: string) {
    const r = this.db.prepare("select * from recent_uploads where id = ?").get(id);
    return r ? this.decode(r) : null;
  }
  async allTimesheets() {
    return (this.db.prepare("select * from recent_uploads order by created_at").all() as any[]).map((r) => this.decode(r));
  }
  private insertSync(row: TimesheetWrite) {
    const now = new Date().toISOString();
    const data = this.encode({ ...row, id: row.id ?? randomUUID(), created_at: row.created_at ?? now }) as any;
    data.updated_at = now;
    const cols = Object.keys(data);
    this.db.prepare(`insert or replace into recent_uploads (${cols.join(",")}) values (${cols.map((c) => "@" + c).join(",")})`).run(data);
    return toSummary({ ...this.decode(data), status: row.meta_json?.status, deleted_at: row.meta_json?.deletedAt });
  }
  async insertTimesheet(row: TimesheetWrite) {
    return this.insertSync(row);
  }
  async updateTimesheet(id: string, row: Partial<TimesheetWrite>) {
    const data = this.encode(row);
    delete data.id;
    data.updated_at = new Date().toISOString();
    const cols = Object.keys(data);
    const res = this.db.prepare(`update recent_uploads set ${cols.map((c) => `${c} = @${c}`).join(", ")} where id = @__id`).run({ ...data, __id: id });
    if (!res.changes) return null;
    const r = await this.getTimesheet(id);
    return r ? toSummary({ ...r, status: r.meta_json?.status, deleted_at: r.meta_json?.deletedAt }) : null;
  }
  async deleteTimesheet(id: string) {
    return this.db.prepare("delete from recent_uploads where id = ?").run(id).changes > 0;
  }
  async importAll(data: ImportData, opts: ImportOptions = {}) {
    const keep = opts.keepSetting ?? (() => false);
    const settings = data.settings.filter((x) => !keep(x.key));
    this.db.transaction(() => {
      if (opts.replace) {
        const del = this.db.prepare("delete from app_settings where key = ?");
        for (const r of this.db.prepare("select key from app_settings").all() as { key: string }[]) if (!keep(r.key)) del.run(r.key);
        this.db.prepare("delete from recent_uploads").run();
        if (data.punches) this.db.prepare("delete from punches").run();
      }
      for (const s of settings) this.setSettingSync(s.key, s.value);
      for (const t of data.timesheets) this.insertSync(t);
      if (data.punches) {
        const verb = opts.replace ? "insert or replace" : "insert or ignore";
        for (const p of data.punches) {
          const row = this.punchRow(p);
          const cols = Object.keys(row);
          this.db.prepare(`${verb} into punches (${cols.join(",")}) values (${cols.map((c) => "@" + c).join(",")})`).run(row);
        }
      }
    })();
    return { settings: settings.length, timesheets: data.timesheets.length, punches: data.punches?.length ?? 0 };
  }
  // ── Punches ────────────────────────────────────────────────────────────────
  private punchRow(p: Punch) {
    const r: any = punchToRow(p);
    r.meta_json = JSON.stringify(r.meta_json);
    return r;
  }
  async listPunches(q: PunchQuery) {
    const where: string[] = [];
    const args: any[] = [];
    if (q.siteId) { where.push("site_id = ?"); args.push(q.siteId); }
    if (q.employeeId) { where.push("employee_id = ?"); args.push(q.employeeId); }
    if (q.from) { where.push("at >= ?"); args.push(q.from); }
    if (q.to) { where.push("at < ?"); args.push(q.to); }
    const sql = `select * from punches ${where.length ? `where ${where.join(" and ")}` : ""} order by at, id limit ${Math.max(1, Math.min(q.limit ?? 20000, MAX_PUNCH_QUERY + 1))}`;
    return (this.db.prepare(sql).all(...args) as any[]).map(rowToPunch);
  }
  async getPunch(id: string) {
    const r = this.db.prepare("select * from punches where id = ?").get(id);
    return r ? rowToPunch(r) : null;
  }
  async insertPunch(p: Punch) {
    const row = this.punchRow(p);
    const cols = Object.keys(row);
    const res = this.db.prepare(`insert or ignore into punches (${cols.join(",")}) values (${cols.map((c) => "@" + c).join(",")})`).run(row);
    if (res.changes) return { punch: rowToPunch(row), created: true };
    return { punch: (await this.getPunch(p.id))!, created: false };
  }
  async updatePunch(id: string, patch: PunchPatch) {
    const data: any = patchToRow(patch);
    if ("meta_json" in data) data.meta_json = JSON.stringify(data.meta_json);
    const cols = Object.keys(data);
    if (cols.length) this.db.prepare(`update punches set ${cols.map((c) => `${c} = @${c}`).join(", ")} where id = @__id`).run({ ...data, __id: id });
    return this.getPunch(id);
  }
  async deletePunch(id: string) {
    return this.db.prepare("delete from punches where id = ?").run(id).changes > 0;
  }
  async allPunches() {
    return (this.db.prepare("select * from punches order by at, id").all() as any[]).map(rowToPunch);
  }

  async *punchPages() {
    // Keyset paging, so no statement stays open between pages.
    const stmt = this.db.prepare("select * from punches where at > @at or (at = @at and id > @id) order by at, id limit 2000");
    let cur = { at: "", id: "" };
    for (;;) {
      const rows = stmt.all(cur) as any[];
      if (!rows.length) return;
      yield rows.map(rowToPunch);
      cur = { at: rows[rows.length - 1].at, id: rows[rows.length - 1].id };
      if (rows.length < 2000) return;
    }
  }

  async snapshotTo(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await this.db.backup(file);
    try { fs.chmodSync(file, 0o600); } catch { /* not supported here */ }
  }
  async health(): Promise<DatabaseHealth> {
    const t = Date.now();
    try {
      const c = this.db.prepare("select count(*) as n from recent_uploads").get() as { n: number };
      return { ok: true, kind: "sqlite", label: this.label, latencyMs: Date.now() - t, error: null, missingTables: [], missingColumns: [], timesheetCount: c.n };
    } catch (err: any) {
      return { ok: false, kind: "sqlite", label: this.label, latencyMs: null, error: err.message, missingTables: [], missingColumns: [], timesheetCount: null };
    }
  }
  close() {
    try {
      if (this.db?.open) {
        this.db.pragma("wal_checkpoint(TRUNCATE)");
        this.db.close();
      }
    } catch { /* ignore */ }
  }
}
