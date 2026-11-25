import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseHealth } from "@shared/schema";
import { type DataStore, type TimesheetRow, type TimesheetWrite, toSummary } from "./types";

const JSON_COLS = ["result_json", "wages_json", "manual_employees_json", "meta_json"] as const;

export class SqliteStore implements DataStore {
  readonly kind = "sqlite" as const;
  readonly label: string;
  private db!: Database.Database;

  constructor(private file: string) {
    this.label = `Local file (${path.basename(file)})`;
  }

  async init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new Database(this.file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      create table if not exists app_settings (key text primary key, value text not null, updated_at text);
      create table if not exists recent_uploads (
        id text primary key, filename text not null default '', custom_label text, period_start text, period_end text,
        employee_count integer not null default 0, total_pay real not null default 0,
        result_json text, wages_json text, manual_employees_json text, csv_data text, site_id text, meta_json text,
        created_at text not null, updated_at text
      );
      create index if not exists recent_uploads_site_idx on recent_uploads (site_id, updated_at);
    `);
  }

  private decode(r: any): TimesheetRow {
    const out = { ...r };
    for (const c of JSON_COLS) {
      try { out[c] = r[c] == null ? null : JSON.parse(r[c]); } catch { out[c] = null; }
    }
    return out;
  }

  private encode(row: Partial<TimesheetWrite>) {
    const out: Record<string, any> = { ...row };
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
  async setSetting(key: string, value: string) {
    this.db.prepare("insert into app_settings (key, value, updated_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at")
      .run(key, value, new Date().toISOString());
  }
  async deleteSetting(key: string) {
    this.db.prepare("delete from app_settings where key = ?").run(key);
  }
  async listTimesheets() {
    const rows = this.db.prepare(`select id, site_id, filename, custom_label, period_start, period_end, employee_count, total_pay, created_at, updated_at,
      json_extract(meta_json, '$.status') as status from recent_uploads order by coalesce(updated_at, created_at) desc`).all();
    return rows.map(toSummary);
  }
  async getTimesheet(id: string) {
    const r = this.db.prepare("select * from recent_uploads where id = ?").get(id);
    return r ? this.decode(r) : null;
  }
  async allTimesheets() {
    return (this.db.prepare("select * from recent_uploads order by created_at").all() as any[]).map((r) => this.decode(r));
  }
  async insertTimesheet(row: TimesheetWrite) {
    const now = new Date().toISOString();
    const data = this.encode({ ...row, id: row.id ?? randomUUID(), created_at: row.created_at ?? now }) as any;
    data.updated_at = now;
    const cols = Object.keys(data);
    this.db.prepare(`insert or replace into recent_uploads (${cols.join(",")}) values (${cols.map((c) => "@" + c).join(",")})`).run(data);
    return toSummary({ ...this.decode(data), status: row.meta_json?.status });
  }
  async updateTimesheet(id: string, row: Partial<TimesheetWrite>) {
    const data = this.encode(row);
    delete data.id;
    data.updated_at = new Date().toISOString();
    const cols = Object.keys(data);
    const res = this.db.prepare(`update recent_uploads set ${cols.map((c) => `${c} = @${c}`).join(", ")} where id = @__id`).run({ ...data, __id: id });
    if (!res.changes) return null;
    const r = await this.getTimesheet(id);
    return r ? toSummary({ ...r, status: r.meta_json?.status }) : null;
  }
  async deleteTimesheet(id: string) {
    return this.db.prepare("delete from recent_uploads where id = ?").run(id).changes > 0;
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
    try { this.db?.close(); } catch { /* ignore */ }
  }
}
