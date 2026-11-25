import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SqliteStore, SCHEMA_VERSION } from "../server/db/sqlite";

test("an existing v1 database is upgraded in place, with a copy saved first", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-mig-"));
  const file = path.join(dir, "payroll.db");
  const old = new Database(file);
  old.exec(`create table app_settings (key text primary key, value text not null, updated_at text);
    create table recent_uploads (id text primary key, filename text not null default '', custom_label text, period_start text, period_end text,
      employee_count integer not null default 0, total_pay real not null default 0, result_json text, wages_json text, manual_employees_json text,
      csv_data text, created_at text not null, updated_at text);
    insert into recent_uploads (id, filename, period_start, created_at) values ('old-1', 'v1.csv', '1/5/26', '2026-01-01T00:00:00Z');`);
  old.close();

  const store = new SqliteStore(file);
  await store.init();
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  const row = await store.getTimesheet("old-1");
  assert.equal(row?.filename, "v1.csv");
  assert.equal(row?.site_id, null);
  const copies = fs.readdirSync(path.join(dir, "backups")).filter((f) => f.startsWith("before-migration-v0"));
  assert.equal(copies.length, 1);
  store.close();

  // Opening again does nothing further
  const again = new SqliteStore(file);
  await again.init();
  assert.equal(fs.readdirSync(path.join(dir, "backups")).length, 1);
  again.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("importAll is atomic on SQLite", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-mig-"));
  const store = new SqliteStore(path.join(dir, "payroll.db"));
  await store.init();
  await assert.rejects(store.importAll({
    settings: [{ key: "a", value: "1" }],
    timesheets: [{ id: "ok", filename: "fine" } as any, { id: "x", csv_data: { not: "bindable" } } as any],
  }));
  assert.equal(await store.getSetting("a"), null);
  assert.equal(await store.getTimesheet("ok"), null);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
