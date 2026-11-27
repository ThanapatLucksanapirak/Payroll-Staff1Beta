// Small server fixes: private file modes, separate pre-restore pruning, empty or
// newer database files, bad switch paths, clearing a sign-in lock.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-lows-"));
process.env.DATA_DIR = dir;
process.env.BACKUP_DIR = path.join(dir, "backups");
process.env.BACKUPS = "off";
process.env.SETUP_CODE = "ABCDE-FGHJK";
delete process.env.SUPABASE_URL;

let base = "";
let server: Server;
let cookie = "";

async function call(method: string, url: string, body?: unknown, auth = true) {
  const headers: Record<string, string> = { "X-Requested-With": "payroll" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const mode = (f: string) => fs.statSync(f).mode & 0o777;

before(async () => {
  const express = (await import("express")).default;
  const { createServer } = await import("node:http");
  const routes = await import("../server/routes");
  const { initDatabase } = await import("../server/db");
  await initDatabase();
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  routes.registerRoutes(app);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ok = await call("POST", "/api/auth/setup", { password: "correct horse", setupCode: "ABCDE-FGHJK" }, false);
  assert.equal(ok.status, 200);
  cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0];
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  const { closeDatabase } = await import("../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("old backup and audit files are made private at start, new audit files are 0600", async () => {
  const { BACKUP_DIR, hardenBackupFiles } = await import("../server/backup");
  const { hardenAuditFiles, audit, flushAudit } = await import("../server/audit");
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const old = path.join(BACKUP_DIR, "payroll-2025-01-01T00-00-00-auto.json.gz");
  fs.writeFileSync(old, "x");
  fs.chmodSync(old, 0o644);
  fs.chmodSync(BACKUP_DIR, 0o755);
  hardenBackupFiles();
  assert.equal(mode(old), 0o600);
  assert.equal(mode(BACKUP_DIR), 0o700);

  const auditDir = path.join(dir, "audit");
  fs.mkdirSync(auditDir, { recursive: true });
  const oldAudit = path.join(auditDir, "2020-01.jsonl");
  fs.writeFileSync(oldAudit, "");
  fs.chmodSync(oldAudit, 0o644);
  hardenAuditFiles();
  assert.equal(mode(oldAudit), 0o600);

  audit({ userId: null, userName: "t", ip: "1.1.1.1", action: "test.mode", at: "2031-03-04T00:00:00.000Z" });
  await flushAudit();
  const fresh = fs.readdirSync(auditDir).filter((f) => f !== "2020-01.jsonl");
  assert.ok(fresh.length >= 1);
  for (const f of fresh) assert.equal(mode(path.join(auditDir, f)), 0o600);
});

test("pre-restore backups are pruned on their own and never push out other backups", async () => {
  const { runBackup, listBackups } = await import("../server/backup");
  await runBackup("manual");
  for (let i = 0; i < 13; i++) await runBackup("pre-restore");
  const list = listBackups().filter((b) => b.kind === "export");
  assert.equal(list.filter((b) => b.reason === "pre-restore").length, 10);
  assert.equal(list.filter((b) => b.reason === "manual").length, 1);
  assert.ok(list.some((b) => b.reason === "auto"), "the older automatic one is still there");
});

test("an empty database file is an error, a missing one starts fresh, a newer schema warns", async () => {
  const { SqliteStore, SCHEMA_VERSION } = await import("../server/db/sqlite");
  const empty = path.join(dir, "empty.db");
  fs.writeFileSync(empty, "");
  const s1 = new SqliteStore(empty);
  await assert.rejects(() => s1.init(), (e: any) => e.status === 503 && /database file is empty/.test(e.message));
  assert.equal(fs.statSync(empty).size, 0, "left as it was");

  const fresh = new SqliteStore(path.join(dir, "fresh.db"));
  await fresh.init();
  assert.equal(fresh.schemaVersion(), SCHEMA_VERSION);
  fresh.close();

  const newer = path.join(dir, "newer.db");
  const seed = new SqliteStore(newer);
  await seed.init();
  (seed as any).db.pragma(`user_version = ${SCHEMA_VERSION + 5}`);
  seed.close();
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.join(" ")); };
  try {
    const again = new SqliteStore(newer);
    await again.init();
    again.close();
  } finally { console.warn = orig; }
  assert.ok(warnings.some((w) => /newer version of the app/.test(w)));
});

test("switching to a path that can't be opened says so", async () => {
  fs.writeFileSync(path.join(dir, "afile"), "not a folder");
  const bad = await call("POST", "/api/database/switch", { config: { kind: "sqlite", path: "afile/inside.db" }, copyData: false });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /^Couldn't open a database at that path: /);
  assert.doesNotMatch(bad.body.error, /prepare/);
  fs.writeFileSync(path.join(dir, "zero.db"), "");
  const e = await call("POST", "/api/database/switch", { config: { kind: "sqlite", path: "zero.db" }, copyData: false });
  assert.equal(e.status, 400);
  assert.match(e.body.error, /database file is empty/);
});

test("an owner can clear a user's sign-in lock", async () => {
  const mk = await call("POST", "/api/users", { username: "locked", password: "password-123", role: "viewer" });
  assert.equal(mk.status, 200, JSON.stringify(mk.body));
  const id = mk.body.id;
  for (let i = 0; i < 8; i++) await call("POST", "/api/auth/login", { username: "locked", password: "wrong-pass" }, false);
  const blocked = await call("POST", "/api/auth/login", { username: "locked", password: "password-123" }, false);
  assert.equal(blocked.status, 429);
  assert.equal((await call("POST", `/api/users/${id}/clear-lock`, {})).status, 200);
  const ok = await call("POST", "/api/auth/login", { username: "locked", password: "password-123" }, false);
  assert.equal(ok.status, 200);
  assert.equal((await call("POST", `/api/users/nope/clear-lock`, {})).status, 404);
  const { queryAudit, flushAudit } = await import("../server/audit");
  await flushAudit();
  assert.ok((await queryAudit({ action: "user.clear-lock" })).entries.length >= 1);
});

test("a restore too big for the free memory is refused with a clear message, nothing restored", async () => {
  const { restoreMemory, gzipSize, restoreMemoryProblem } = await import("../server/memoryGuard");
  const { runBackup, listBackups, BACKUP_DIR } = await import("../server/backup");
  const backup = (await call("GET", "/api/backup")).body;
  const before = JSON.stringify((await call("GET", "/api/backup")).body.settings);
  restoreMemory.available = { system: 1024 * 1024, heap: 512 * 1024 * 1024 }; // 1 MB "free"
  try {
    const r = await call("POST", "/api/backup/restore", { ...backup, settings: [...backup.settings, { key: "pad", value: "x".repeat(200_000) }] });
    assert.equal(r.status, 413, JSON.stringify(r.body));
    assert.equal(r.body.code, "memory");
    assert.match(r.body.error, /too big to restore on this server right now.*Nothing was restored/);
    assert.equal(JSON.stringify((await call("GET", "/api/backup")).body.settings), before, "nothing changed");
    // A saved backup is checked by its uncompressed size
    await runBackup("manual");
    const saved = listBackups().find((b) => b.name.endsWith(".json.gz"))!;
    assert.ok(gzipSize(path.join(BACKUP_DIR, saved.name)) > 100);
    restoreMemory.available = { system: 10, heap: 10 };
    const r2 = await call("POST", `/api/backups/${saved.name}/restore`);
    assert.equal(r2.status, 413);
    assert.equal(r2.body.code, "memory");
  } finally { restoreMemory.available = null; }
  assert.equal(restoreMemoryProblem(1024), null, "small restores fit with the real measurement");
  assert.equal((await call("POST", "/api/backup/restore", backup)).status, 200);
});
