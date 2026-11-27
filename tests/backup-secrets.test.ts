// Stability run 3: saved server backups are owner-only downloads (they hold
// password hashes, the owner's two-factor secret and email secrets), and an
// admin's backup leaves employee PIN hashes out without breaking a restore.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-bksecrets-"));
process.env.DATA_DIR = dir;
process.env.BACKUPS = "off";
process.env.SETUP_CODE = "ABCDE-FGHJK";
delete process.env.SUPABASE_URL;
delete process.env.KIOSK_HOST;

let base = "";
let server: Server;
let owner = "";
let admin = "";
let siteId = "";

async function call(method: string, url: string, body?: unknown, cookie = owner) {
  const headers: Record<string, string> = { "X-Requested-With": "payroll" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

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
  const post = (url: string, body: unknown, cookie = "") => fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "payroll", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const setup = await post("/api/auth/setup", { username: "owner", password: "correct horse", setupCode: "ABCDE-FGHJK" });
  owner = (setup.headers.get("set-cookie") ?? "").split(";")[0];
  assert.equal((await post("/api/users", { username: "adm", password: "password-123", role: "admin" }, owner)).status, 200);
  const login = await post("/api/auth/login", { username: "adm", password: "password-123" });
  admin = (login.headers.get("set-cookie") ?? "").split(";")[0];
  siteId = (await call("GET", "/api/bootstrap")).body.sites[0].id;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  const { closeDatabase } = await import("../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});


test("an admin can't download a saved server backup, an owner can", async () => {
  const saved = await call("POST", "/api/backups");
  assert.equal(saved.status, 200);
  const name = saved.body.find((f: any) => f.kind === "export").name;
  const dbFile = saved.body.find((f: any) => f.kind === "database")?.name;
  const denied = await call("GET", `/api/backups/${name}`, undefined, admin);
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /Only an owner/);
  if (dbFile) assert.equal((await call("GET", `/api/backups/${dbFile}`, undefined, admin)).status, 403);
  assert.equal((await call("GET", `/api/backups/${name}`)).status, 200);
  // Admins can still list and restore them.
  assert.equal((await call("GET", "/api/backups", undefined, admin)).status, 200);
});

test("an admin's backup withholds PIN hashes, and restoring it keeps today's PINs", async () => {
  const { findByPin, invalidateEmployeeCache } = await import("../server/employees");
  const a = await call("POST", `/api/sites/${siteId}/employees`, { name: "Ana", pin: "4821" });
  assert.equal(a.status, 200);
  const b = await call("POST", `/api/sites/${siteId}/employees`, { name: "Bo" });
  assert.equal(b.status, 200);

  const adminCopy = await call("GET", "/api/backup", undefined, admin);
  assert.equal(adminCopy.status, 200);
  const dirRow = adminCopy.body.settings.find((s: any) => s.key === `employees:${siteId}`);
  const dir = JSON.parse(dirRow.value);
  const ana = dir.employees.find((e: any) => e.name === "Ana");
  assert.equal(ana.pinHash, null);
  assert.equal(ana.pinEnc, null);
  assert.equal(ana.pinWithheld, true);
  assert.ok(!JSON.stringify(adminCopy.body).includes("pinHash\":\""), "no PIN hash anywhere in an admin's copy");

  const ownerCopy = await call("GET", "/api/backup");
  const ownerDir = JSON.parse(ownerCopy.body.settings.find((s: any) => s.key === `employees:${siteId}`).value);
  assert.ok(ownerDir.employees.find((e: any) => e.name === "Ana").pinHash, "an owner's copy keeps PIN hashes");

  // Restoring the admin's copy must not wipe Ana's PIN.
  const r = await call("POST", "/api/backup/restore", adminCopy.body, admin);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pinsCleared, undefined, "nobody lost a PIN");
  invalidateEmployeeCache();
  assert.equal((await findByPin(siteId, "4821"))?.name, "Ana");
  const after = await call("GET", `/api/sites/${siteId}/employees`);
  const view = after.body.find((e: any) => e.name === "Ana");
  assert.equal(view.hasPin, true);
  assert.equal(view.pinViewable, true, "the owner can still look the PIN up");
  assert.equal(after.body.find((e: any) => e.name === "Bo").hasPin, false);
  const stored = JSON.parse((await call("GET", "/api/backup")).body.settings.find((s: any) => s.key === `employees:${siteId}`).value);
  assert.ok(stored.employees.every((e: any) => !("pinWithheld" in e)), "the marker isn't stored");
});

test("a withheld PIN for someone no longer here comes back without a PIN", async () => {
  const { restoreWithheldPins } = await import("../server/employees");
  const file = JSON.stringify({ salt: "s1", employees: [{ id: "x", name: "X", pinHash: null, pinEnc: null, pinWithheld: true }] });
  const goneR = restoreWithheldPins(file, JSON.stringify({ salt: "s1", employees: [] }));
  assert.deepEqual(goneR.lost, ["X"]);
  const gone = JSON.parse(goneR.value);
  assert.equal(gone.employees[0].pinHash, null);
  assert.ok(!("pinWithheld" in gone.employees[0]));
  // A different salt means today's hash wouldn't match: don't carry it.
  const otherR = restoreWithheldPins(file, JSON.stringify({ salt: "s2", employees: [{ id: "x", pinHash: "h", pinEnc: "e" }] }));
  assert.deepEqual(otherR.lost, ["X"]);
  const otherSalt = JSON.parse(otherR.value);
  assert.equal(otherSalt.employees[0].pinHash, null);
  const sameR = restoreWithheldPins(file, JSON.stringify({ salt: "s1", employees: [{ id: "x", pinHash: "h", pinEnc: "e" }] }));
  assert.deepEqual(sameR.lost, []);
  const same = JSON.parse(sameR.value);
  assert.equal(same.employees[0].pinHash, "h");
  assert.equal(same.employees[0].pinEnc, "e");
  assert.deepEqual(restoreWithheldPins("not json", null), { value: "not json", lost: [] });
});

test("restoring an admin copy after the PIN salt changed names who lost their PIN", async () => {
  const { invalidateEmployeeCache } = await import("../server/employees");
  const { db } = await import("../server/db");
  const copy = (await call("GET", "/api/backup", undefined, admin)).body;
  const k = `employees:${siteId}`;
  const store = await db();
  const dir = JSON.parse((await store.getSetting(k))!);
  await store.setSetting(k, JSON.stringify({ ...dir, salt: "a-different-salt" }));
  invalidateEmployeeCache();
  const r = await call("POST", "/api/backup/restore", copy, admin);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.pinsCleared, ["Ana"]);
});

test("Give everyone a PIN pressed twice at once hands out one working set", async () => {
  const { findByPin, invalidateEmployeeCache } = await import("../server/employees");
  for (const name of ["Cy", "Di", "Ed"]) assert.equal((await call("POST", `/api/sites/${siteId}/employees`, { name })).status, 200);
  const [a, b] = await Promise.all([
    call("POST", `/api/sites/${siteId}/employee-pins/generate`, {}),
    call("POST", `/api/sites/${siteId}/employee-pins/generate`, {}, admin),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const handed = [...a.body.pins, ...b.body.pins];
  const ids = handed.map((p: any) => p.id);
  assert.equal(new Set(ids).size, ids.length, "nobody got two PINs");
  assert.equal(a.body.skipped + b.body.skipped, 0);
  invalidateEmployeeCache();
  for (const p of handed) assert.equal((await findByPin(siteId, p.pin))?.id, p.id, `${p.name}'s handed-out PIN works`);
  const again = await call("POST", `/api/sites/${siteId}/employee-pins/generate`, {});
  assert.deepEqual(again.body, { pins: [], skipped: 0 });
});
