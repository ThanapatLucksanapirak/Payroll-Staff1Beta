// Stability-check fixes: backups with sign-in secrets are owner-only, the kiosk
// host guard ignores a trailing dot, impossible dates are refused everywhere
// they are accepted, and a break reminder under half an hour is refused.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-secdates-"));
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

test("only an owner can download a backup that includes sign-in secrets", async () => {
  const denied = await call("GET", "/api/backup?secrets=1", undefined, admin);
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /Only an owner/);
  assert.equal((await call("GET", "/api/backup?secrets=0", undefined, admin)).status, 200, "admins can still take a backup without secrets");
  assert.equal((await call("GET", "/api/backup?secrets=1", undefined, owner)).status, 200);
});

test("KIOSK_HOST matches a trailing dot, a port and any case", async () => {
  const get = (host: string) => new Promise<number>((resolve, reject) => {
    const u = new URL(base);
    const r = request({ host: u.hostname, port: u.port, path: "/api/users", headers: { Host: host, Cookie: owner, "X-Requested-With": "payroll" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    r.on("error", reject);
    r.end();
  });
  process.env.KIOSK_HOST = "kiosk.localhost";
  try {
    for (const h of ["kiosk.localhost", "kiosk.localhost:5107", "kiosk.localhost.:5107", "kiosk.localhost.", "KIOSK.Localhost.."]) assert.equal(await get(h), 404, h);
    assert.equal(await get("other.localhost"), 200);
  } finally {
    delete process.env.KIOSK_HOST;
  }
});

test("a date that is not on the calendar is refused with 400", async () => {
  const bad = "2026-13-45";
  const expect400 = async (r: Promise<{ status: number; body: any }>, what: string) => {
    const x = await r;
    assert.equal(x.status, 400, `${what}: ${JSON.stringify(x.body)}`);
    assert.match(x.body.error, /real date|YYYY-MM-DD/, what);
  };
  await expect400(call("PUT", `/api/sites/${siteId}/pay/rates`, { effectiveFrom: bad, entries: [] }), "pay rates");
  await expect400(call("POST", `/api/sites/${siteId}/pay/advances`, { employee: "Ana", amount: 50, date: bad, mode: "lump" }), "advance");
  await expect400(call("POST", `/api/sites/${siteId}/time-off`, { employeeId: "x", employeeName: "Ana", start: bad, end: bad }), "time off");
  await expect400(call("PUT", `/api/sites/${siteId}/sales`, { date: bad, amount: 10 }), "sales");
  await expect400(call("GET", `/api/sites/${siteId}/schedule/week?start=${bad}`), "schedule week");
  await expect400(call("GET", `/api/sites/${siteId}/schedule/week?start=2026-02-30`), "schedule week Feb 30");
  const doc = (periodStart: string, site = siteId) => ({ siteId: site, label: "t", filename: "t.csv", source: "csv", status: "draft", periodStart, periodEnd: periodStart, shifts: [], employees: [], manualEmployees: [], rules: {} });
  await expect400(call("POST", "/api/timesheets", { doc: doc(bad) }), "timesheet period");
  assert.equal((await call("POST", "/api/timesheets", { doc: doc("2026-01-05") })).status, 200, "a real date still works");
  assert.equal((await call("PUT", `/api/sites/${siteId}/pay/rates`, { effectiveFrom: "2026-02-28", entries: [] })).status, 200);
});

test("a timesheet for a location that doesn't exist is refused", async () => {
  const doc = { siteId: "no-such-site", label: "t", filename: "t.csv", source: "csv", status: "draft", periodStart: "2026-01-05", periodEnd: "2026-01-05", shifts: [], employees: [], manualEmployees: [], rules: {} };
  const count = (await call("GET", "/api/timesheets")).body.length;
  const r = await call("POST", "/api/timesheets", { doc });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /location/);
  assert.equal((await call("GET", "/api/timesheets")).body.length, count, "no orphan timesheet is left behind");
});

test("a break reminder under half an hour is refused, not saved as off", async () => {
  const put = (hours: number | null) => call("PUT", `/api/sites/${siteId}/kiosk-config`, { breakReminderHours: hours });
  for (const h of [0.01, 0.25, 0.49]) {
    const r = await put(h);
    assert.equal(r.status, 400, String(h));
    assert.match(r.body.error, /0\.5 to 16/);
  }
  assert.equal((await put(0.5)).body.breakReminderHours, 0.5);
  assert.equal((await put(0)).body.breakReminderHours, null, "0 still turns it off");
  assert.equal((await put(null)).status, 200);
  assert.equal((await put(17)).status, 400);
});
