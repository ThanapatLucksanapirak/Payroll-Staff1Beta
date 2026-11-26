// Labor vs. sales and the forecast for a location that tracks time in Square:
// before any timesheet is saved, labor is estimated from Square timecards at
// the saved rates (it used to read $0.00 / 0.0% all week). Square is stubbed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { addDays, localToInstant, startOfWeek, todayISO } from "../shared/dates";
import { laborReport } from "../shared/labor";

const TZ = "America/New_York";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-labor-square-"));
let base = "";
let server: Server;
let admin = "";
let siteId = "";
let timecardsMode: "ok" | "forbidden" = "ok";
let timecardCalls = 0;
const today = todayISO(TZ);
const weekStart = startOfWeek(today, 1);

const realFetch = globalThis.fetch;
function stubSquare(url: string, init?: RequestInit): Response | null {
  if (!url.startsWith("https://connect.squareup.com/")) return null;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  if (url.endsWith("/locations")) return json({ locations: [{ id: "L1", name: "Main", timezone: TZ, status: "ACTIVE" }] });
  if (url.endsWith("/orders/search")) {
    return json({ orders: [{ closed_at: localToInstant(today, 600, TZ), net_amounts: { total_money: { amount: 100000, currency: "USD" }, tax_money: { amount: 0, currency: "USD" }, tip_money: { amount: 0, currency: "USD" } } }] });
  }
  if (url.endsWith("/labor/timecards/search")) {
    timecardCalls++;
    if (timecardsMode === "forbidden") return json({ errors: [{ code: "INSUFFICIENT_SCOPES", detail: "nope" }] }, 403);
    const body = JSON.parse(String(init?.body ?? "{}"));
    assert.deepEqual(body.query.filter.location_ids, ["L1"]);
    // 9:00 to 17:00 today, and one still clocked in (skipped).
    return json({ timecards: [
      { id: "tc1", team_member_id: "tm1", start_at: localToInstant(today, 540, TZ), end_at: localToInstant(today, 1020, TZ), breaks: [] },
      { id: "tc2", team_member_id: "tm1", start_at: localToInstant(today, 1080, TZ) },
    ] });
  }
  if (url.endsWith("/team-members/search")) return json({ team_members: [{ id: "tm1", given_name: "Ana", family_name: "Ruiz" }] });
  return json({ errors: [{ code: "NOT_FOUND", detail: url }] }, 404);
}

async function call(method: string, url: string, body?: unknown) {
  const hs: Record<string, string> = { Cookie: admin, "X-Requested-With": "payroll" };
  if (body !== undefined) hs["Content-Type"] = "application/json";
  const res = await fetch(base + url, { method, headers: hs, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

before(async () => {
  globalThis.fetch = (async (input: any, init?: RequestInit) => stubSquare(String(input?.url ?? input), init) ?? realFetch(input, init)) as typeof fetch;
  process.env.DATA_DIR = dir;
  process.env.BACKUPS = "off";
  delete process.env.SETUP_CODE;
  delete process.env.SUPABASE_URL;
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
  const code = (await import("../server/auth")).getSetupCode();
  const setup = await fetch(`${base}/api/auth/setup`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "payroll" }, body: JSON.stringify({ username: "owner", password: "correct horse", setupCode: code }) });
  admin = (setup.headers.get("set-cookie") ?? "").split(";")[0];
  siteId = (await call("GET", "/api/bootstrap")).body.sites[0].id;
  assert.equal((await call("PUT", `/api/sites/${siteId}`, { timeSource: "square", rules: { timezone: TZ, weekStartsOn: 1 } })).status, 200);
  assert.equal((await call("PUT", `/api/sites/${siteId}/square`, { token: "EAAA-test-token-123" })).status, 200);
  await call("PUT", `/api/sites/${siteId}/wages`, [{ name: "Ana Ruiz", payBasis: "hourly", hourlyRate: 20 }]);
});

after(async () => {
  globalThis.fetch = realFetch;
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  const { closeDatabase } = await import("../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("laborReport labels estimates by where they came from", () => {
  const r = laborReport({ from: "2026-11-23", to: "2026-11-23", fromTimesheets: {}, fromPunches: { "2026-11-23": { cost: 80, hours: 4 } }, estimateSource: "square", sales: {} });
  assert.equal(r.days[0].laborSource, "square");
  const p = laborReport({ from: "2026-11-23", to: "2026-11-23", fromTimesheets: {}, fromPunches: { "2026-11-23": { cost: 80, hours: 4 } }, sales: {} });
  assert.equal(p.days[0].laborSource, "punches", "punches stay the default");
});

test("square site: labor this week comes from Square timecards at saved rates", async () => {
  const r = await call("GET", `/api/sites/${siteId}/labor?from=${weekStart}&to=${today}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.days.find((x: any) => x.date === today);
  assert.equal(d.sales, 1000);
  assert.equal(d.laborSource, "square");
  assert.equal(d.hours, 8, "the open timecard is skipped");
  assert.equal(d.labor, 160);
  assert.ok(Math.abs(r.body.totals.pct - 0.16) < 1e-9, `pct ${r.body.totals.pct}`);
  assert.equal(r.body.laborMessage, null);
  assert.deepEqual(r.body.missingRates, []);

  // Cached: a second read doesn't call Square again.
  const before = timecardCalls;
  await call("GET", `/api/sites/${siteId}/labor?from=${weekStart}&to=${today}`);
  assert.equal(timecardCalls, before);
});

test("square site: the forecast counts Square timecards for days without a timesheet", async () => {
  const f = await call("GET", `/api/sites/${siteId}/forecast?start=${weekStart}&end=${addDays(weekStart, 13)}`);
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(f.body.basis, "square");
  assert.equal(f.body.paidSoFar, 160);
  assert.equal(f.body.actualHours, 8);
});

test("square site: a token without timecard access says so and labor stays at saved timesheets", async () => {
  timecardsMode = "forbidden";
  const from = addDays(weekStart, -7); // a new range, so not cached
  const r = await call("GET", `/api/sites/${siteId}/labor?from=${from}&to=${today}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.laborMessage, /Timecards \(read\)/);
  assert.equal(r.body.totals.labor, 0);
  timecardsMode = "ok";
});
