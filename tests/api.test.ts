// End-to-end API tests against a real server on a temporary SQLite database.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-api-"));
process.env.DATA_DIR = dir;
process.env.BACKUPS = "off";
delete process.env.SETUP_CODE;
delete process.env.SUPABASE_URL;

let base = "";
let server: Server;
let token = "";
let purgeTrash: (now?: number) => Promise<number>;

async function call(method: string, url: string, body?: unknown, auth = true) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

function sampleDoc(siteId: string, label = "Week 1") {
  return {
    version: 2, siteId, label, filename: "week1.csv", source: "csv", status: "draft", notes: "",
    periodStart: "2026-01-05", periodEnd: "2026-01-06",
    shifts: [
      { id: "s1", employee: "Ana Ruiz", date: "2026-01-05", start: 600, end: 1260, breakMinutes: 0, role: "", source: "csv", note: "" },
      { id: "s2", employee: "Ana Ruiz", date: "2026-01-06", start: 600, end: 900, breakMinutes: 0, role: "", source: "csv", note: "" },
    ],
    employees: [{ name: "Ana Ruiz", categoryId: "custom", payBasis: "day_rate", fullDayRate: 120, halfDayRate: 60, hourlyRate: 0, isNetPay: true, excluded: false, adjustments: {}, bonuses: [], deductions: [] }],
    manualEmployees: [],
    rules: {},
  };
}

before(async () => {
  const express = (await import("express")).default;
  const { createServer } = await import("node:http");
  const routes = await import("../server/routes");
  const { initDatabase } = await import("../server/db");
  const { securityHeaders } = await import("../server/security");
  purgeTrash = routes.purgeTrash;
  await initDatabase();
  const app = express();
  app.use(securityHeaders(true));
  app.use((req, res, next) => (req.path.startsWith("/api/backup/restore") ? next() : express.json({ limit: "8mb" })(req, res, next)));
  routes.registerRoutes(app);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  const { closeDatabase } = await import("../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("first-run setup requires the setup code", async () => {
  const st = await call("GET", "/api/auth/status", undefined, false);
  assert.equal(st.body.setupRequired, true);

  const noCode = await call("POST", "/api/auth/setup", { password: "correct horse" }, false);
  assert.equal(noCode.status, 403);
  const wrong = await call("POST", "/api/auth/setup", { password: "correct horse", setupCode: "AAAAA-AAAAA" }, false);
  assert.equal(wrong.status, 403);
  const short = await call("POST", "/api/auth/setup", { password: "short", setupCode: "x" }, false);
  assert.equal(short.status, 400);

  const code = fs.readFileSync(path.join(dir, "setup-code.txt"), "utf8").trim();
  const ok = await call("POST", "/api/auth/setup", { password: "correct horse", setupCode: code.toLowerCase() }, false);
  assert.equal(ok.status, 200);
  token = ok.body.token;
  assert.ok(token);
  assert.equal(fs.existsSync(path.join(dir, "setup-code.txt")), false, "setup code file is removed after use");

  const again = await call("POST", "/api/auth/setup", { password: "another one", setupCode: code }, false);
  assert.equal(again.status, 409);
});

test("API requires a session and is never cached", async () => {
  const r = await call("GET", "/api/bootstrap", undefined, false);
  assert.equal(r.status, 401);
  const ok = await call("GET", "/api/bootstrap");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.match(ok.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(ok.headers.get("x-frame-options"), "DENY");
  // No hard-coded business names on a fresh install
  assert.equal(ok.body.sites[0].name, "Main Location");
});

test("login throttles repeated failures", async () => {
  let last = 0;
  for (let i = 0; i < 9; i++) last = (await call("POST", "/api/auth/login", { password: "wrong" }, false)).status;
  assert.equal(last, 429);
});

test("timesheets: create, edit, conflict, trash, restore, purge", async () => {
  const boot = await call("GET", "/api/bootstrap");
  const siteId = boot.body.sites[0].id;
  const created = await call("POST", "/api/timesheets", { doc: sampleDoc(siteId) });
  assert.equal(created.status, 200);
  const id = created.body.id;
  assert.equal(created.body.totalPay, 180); // full day + half day

  const got = await call("GET", `/api/timesheets/${id}`);
  assert.equal(got.body.doc.label, "Week 1");
  const put = await call("PUT", `/api/timesheets/${id}`, { doc: { ...got.body.doc, label: "Renamed" }, baseUpdatedAt: got.body.updatedAt });
  assert.equal(put.status, 200);
  const stale = await call("PUT", `/api/timesheets/${id}`, { doc: got.body.doc, baseUpdatedAt: "2000-01-01T00:00:00.000Z" });
  assert.equal(stale.status, 409);

  // Permanent delete refuses a timesheet that is not in the Trash
  assert.equal((await call("DELETE", `/api/timesheets/${id}?permanent=1`)).status, 409);

  const del = await call("DELETE", `/api/timesheets/${id}`);
  assert.equal(del.body.trashed, true);
  assert.equal((await call("GET", "/api/timesheets")).body.some((t: any) => t.id === id), false);
  const trash = await call("GET", "/api/timesheets?trash=1");
  assert.equal(trash.body.length, 1);
  assert.ok(trash.body[0].deletedAt);
  assert.equal((await call("PUT", `/api/timesheets/${id}`, { doc: got.body.doc, force: true })).status, 410);

  await call("POST", `/api/timesheets/${id}/restore`);
  const list = await call("GET", "/api/timesheets");
  const row = list.body.find((t: any) => t.id === id);
  assert.ok(row);
  assert.equal(row.deletedAt, null);
  assert.equal(row.customLabel, "Renamed");

  // Purge only removes items older than the trash window
  await call("DELETE", `/api/timesheets/${id}`);
  assert.equal(await purgeTrash(), 0);
  assert.equal(await purgeTrash(Date.now() + 31 * 86_400_000), 1);
  assert.equal((await call("GET", `/api/timesheets/${id}`)).status, 404);
});

test("retention moves old drafts to the Trash instead of deleting", async () => {
  const boot = await call("GET", "/api/bootstrap");
  const siteId = boot.body.sites[0].id;
  await call("PUT", "/api/prefs", { retentionPerSite: 2 });
  for (let i = 0; i < 4; i++) {
    await call("POST", "/api/timesheets", { doc: sampleDoc(siteId, `R${i}`) });
    await new Promise((r) => setTimeout(r, 5));
  }
  const live = (await call("GET", "/api/timesheets")).body;
  const trashed = (await call("GET", "/api/timesheets?trash=1")).body;
  assert.equal(live.length, 2);
  assert.equal(trashed.length, 2);
  await call("PUT", "/api/prefs", { retentionPerSite: 0 });
});

test("restore is all-or-nothing, keeps the password, and backs up first", async () => {
  const before = (await call("GET", "/api/timesheets")).body.length;
  const bad = await call("POST", "/api/backup/restore", {
    app: "payroll-admin",
    settings: [{ key: "password_hash", value: "scrypt$evil$evil" }],
    timesheets: [{ id: "ok-1", filename: "a" }, { id: "bad", filename: "b", employee_count: "not a number at all", total_pay: {} }],
  });
  assert.equal(bad.status, 400);
  assert.equal((await call("GET", "/api/timesheets")).body.length, before, "nothing was written");

  // Unknown columns are ignored, not written into SQL
  const ok = await call("POST", "/api/backup/restore", {
    app: "payroll-admin",
    settings: [{ key: "password_hash", value: "scrypt$evil$evil" }, { key: "custom_flag", value: "1" }],
    timesheets: [{ id: "restored-1", filename: "restored.csv", "evil) values (1); drop table app_settings; --": 1 }],
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.timesheets, 1);
  assert.equal((await call("GET", "/api/bootstrap")).status, 200, "still signed in: password unchanged");
  const login = await call("POST", "/api/auth/login", { password: "correct horse" }, false);
  assert.ok(login.status === 200 || login.status === 429);

  const backups = await call("GET", "/api/backups");
  assert.ok(backups.body.some((b: any) => b.reason === "pre-restore"));
});

test("manual server backup can be listed, downloaded, and restored", async () => {
  const run = await call("POST", "/api/backups");
  assert.equal(run.status, 200);
  const name = run.body.find((b: any) => b.kind === "export").name;
  const dl = await fetch(`${base}/api/backups/${name}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(dl.status, 200);
  assert.equal((await call("GET", "/api/backups/..%2Fconfig.json")).status, 404);
  const res = await call("POST", `/api/backups/${name}/restore`);
  assert.equal(res.status, 200);
});
