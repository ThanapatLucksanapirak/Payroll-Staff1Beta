// Restore replaces data: timesheets, settings and punches match the backup exactly.
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
process.env.SETUP_CODE = "ABCDE-FGHJK";
delete process.env.SUPABASE_URL;

let base = "";
let server: Server;
let cookie = ""; // the session cookie ("payroll_session=...")
let purgeTrash: (now?: number) => Promise<number>;

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

test("setup", async () => {
  await call("GET", "/api/auth/status", undefined, false);
  const code = "ABCDE-FGHJK";
  const ok = await call("POST", "/api/auth/setup", { password: "correct horse", setupCode: code }, false);
  cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0];
  assert.equal(ok.status, 200);
});

test("backup -> change -> restore round trip", async () => {
  const boot = await call("GET", "/api/bootstrap");
  const siteId = boot.body.sites[0].id;
  const doc = sampleDoc(siteId, "สมชาย week ☃");
  doc.employees[0].name = "Ana Ruiz";
  (doc.employees[0] as any).paymentMethod = "split"; (doc.employees[0] as any).splitCashAmount = 33.33;
  doc.employees[0].bonuses = [{ date: "2026-01-05", description: "Tip 0.1", amount: 0.1 }, { date: "", description: "Tip 0.2", amount: 0.2 }] as any;
  doc.notes = "Line1\nLine2 \u0000? emoji 💸";
  const t1 = await call("POST", "/api/timesheets", { doc });
  assert.equal(t1.status, 200, JSON.stringify(t1.body));
  const seed = await call("POST", "/api/backup/restore", { ...(await call("GET", "/api/backup")).body, punches: [
    { id: "punch0001", siteId, employeeId: "e1", employeeName: "Ana Ruiz", type: "in", at: "2026-01-05T14:00:00Z", source: "kiosk" },
    { id: "punch0002", siteId, employeeId: "e1", employeeName: "Ana Ruiz", type: "out", at: "2026-01-05T22:00:00Z", source: "kiosk" },
  ] });
  assert.equal(seed.status, 200, JSON.stringify(seed.body));
  const snap = (await call("GET", "/api/backup")).body;
  const before1 = (await call("GET", `/api/timesheets/${t1.body.id}`)).body;

  // Changes after the backup
  const put = await call("PUT", `/api/timesheets/${t1.body.id}`, { doc: { ...before1.doc, label: "changed", notes: "changed" }, force: true });
  assert.equal(put.status, 200);
  const t2 = await call("POST", "/api/timesheets", { doc: sampleDoc(siteId, "created after backup") });
  const ed = await call("PATCH", "/api/punches/punch0002", { at: "2026-01-05T23:30:00Z", note: "fix", force: true });
  assert.equal(ed.status, 200, JSON.stringify(ed.body));

  const res = await call("POST", "/api/backup/restore", snap);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const after1 = (await call("GET", `/api/timesheets/${t1.body.id}`)).body;
  assert.deepEqual(after1.doc, before1.doc, "timesheet doc restored exactly");
  const list = (await call("GET", "/api/timesheets")).body;
  const punches = (await call("GET", `/api/sites/${siteId}/punches?start=2026-01-01&end=2026-01-10`)).body;
  const p2 = punches.find((p: any) => p.id === "punch0002");
  assert.equal(p2?.at, "2026-01-05T22:00:00.000Z", "edited punch reverted by restore");
  assert.ok(!list.some((t: any) => t.id === t2.body.id), "timesheet created after backup removed by restore");
  assert.equal((await call("GET", "/api/auth/status")).body.authenticated ?? true, true, "still signed in: accounts are kept");

  // A backup from before the time clock (no punches field) leaves punches alone
  const { punches: _p, ...noPunches } = snap;
  assert.equal((await call("POST", "/api/backup/restore", noPunches)).status, 200);
  const kept = (await call("GET", `/api/sites/${siteId}/punches?start=2026-01-01&end=2026-01-10`)).body;
  assert.equal(kept.length, 2);
});

test("restore keeps Square tokens and paired kiosk devices, and refuses incomplete files", async () => {
  const boot = await call("GET", "/api/bootstrap");
  const siteId = boot.body.sites[0].id;
  const { db } = await import("../server/db");
  const store = await db();
  await store.setSetting(`square_token:${siteId}`, "SECRET-TOKEN");

  // A kiosk device, then a backup without secrets, then the device is removed
  const dev = await call("POST", `/api/sites/${siteId}/kiosk-devices`, { name: "Door" });
  assert.equal(dev.status, 200, JSON.stringify(dev.body));
  const snap = (await call("GET", "/api/backup?secrets=0")).body;
  assert.ok(!snap.settings.some((s: any) => s.key.startsWith("square_token:")), "default download leaves tokens out");
  assert.equal((await call("DELETE", `/api/sites/${siteId}/kiosk-devices/${dev.body.device.id}`)).status, 200);

  assert.equal((await call("POST", "/api/backup/restore", snap)).status, 200);
  assert.equal(await store.getSetting(`square_token:${siteId}`), "SECRET-TOKEN", "Square stays connected");
  const devices = (await call("GET", `/api/sites/${siteId}/kiosk-devices`)).body;
  assert.ok(!devices.some((d: any) => d.id === dev.body.device.id), "a removed device stays removed");
  const k = await fetch(base + "/api/kiosk/state", { headers: { "X-Kiosk-Token": dev.body.token } });
  assert.equal(k.status, 401, "and its token doesn't work");

  // Nearly empty files are refused and change nothing
  const before = (await call("GET", "/api/timesheets")).body.length;
  for (const bad of [{ app: "payroll-admin" }, { app: "payroll-admin", settings: [], timesheets: [] }, { app: "payroll-admin", settings: snap.settings }]) {
    const r = await call("POST", "/api/backup/restore", bad);
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal((await call("GET", "/api/timesheets")).body.length, before);
});

test("a file with unreadable punches is refused and today's punches stay", async () => {
  const boot = await call("GET", "/api/bootstrap");
  const siteId = boot.body.sites[0].id;
  const range = `/api/sites/${siteId}/punches?start=2026-01-01&end=2026-01-10`;
  const before1 = (await call("GET", range)).body.length;
  assert.ok(before1 > 0);
  const snap = (await call("GET", "/api/backup")).body;
  const onlyBad = await call("POST", "/api/backup/restore", { ...snap, punches: [{ id: "x", type: "teleport" }, { nope: true }] });
  assert.equal(onlyBad.status, 400);
  assert.match(onlyBad.body.error, /2 of 2 time clock punches/);
  const someBad = await call("POST", "/api/backup/restore", { ...snap, punches: [...snap.punches, { id: "x", type: "teleport" }] });
  assert.equal(someBad.status, 400);
  assert.equal((await call("GET", range)).body.length, before1, "nothing was deleted");
});

test("restores in the same second each keep their own pre-restore backup", async () => {
  const { listBackups } = await import("../server/backup");
  const count = () => listBackups().filter((b) => b.reason === "pre-restore" && b.kind === "export").length;
  const n0 = count();
  const snap = (await call("GET", "/api/backup")).body;
  for (let i = 0; i < 3; i++) assert.equal((await call("POST", "/api/backup/restore", snap)).status, 200);
  assert.equal(count(), n0 + 3);
});

test("backup and restore keep a punch's face flags", async () => {
  const boot = await call("GET", "/api/bootstrap");
  const siteId = boot.body.sites[0].id;
  const snap = (await call("GET", "/api/backup")).body;
  const flagged = [
    { id: "face0001", siteId, employeeId: "e1", employeeName: "Ana Ruiz", type: "in", at: "2026-02-02T14:00:00Z", source: "kiosk", meta: { face: "missing", photo: "none" } },
    { id: "face0002", siteId, employeeId: "e1", employeeName: "Ana Ruiz", type: "out", at: "2026-02-02T22:00:00Z", source: "kiosk", meta: { face: "unchecked", photo: "saved" } },
  ];
  assert.equal((await call("POST", "/api/backup/restore", { ...snap, punches: [...snap.punches, ...flagged] })).status, 200);
  const again = (await call("GET", "/api/backup")).body;
  assert.equal((await call("POST", "/api/backup/restore", again)).status, 200, "round trip");
  const { db } = await import("../server/db");
  const store = await db();
  assert.deepEqual((await store.getPunch("face0001"))?.meta, { face: "missing", photo: "none" });
  assert.deepEqual((await store.getPunch("face0002"))?.meta, { face: "unchecked", photo: "saved" });
});
