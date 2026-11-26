// Employee self-service portal (/me): off by default, sign-in lockout, cookie
// isolation from the admin session, data isolation between employees, session
// revocation, time-off requests, schedule and pay statements. Runs a real
// server on a temporary SQLite database, plus unit tests of shared/portal.ts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { addDays, todayISO } from "../shared/dates";
import { weekStartOf } from "../shared/schedule";
import {
  checkTimeOffRequest, isEmployee, lockRemaining, matchName, recordAttempt, statementResult,
} from "../shared/portal";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-portal-"));
process.env.DATA_DIR = dir;
process.env.BACKUPS = "off";
process.env.PORTAL_LOCK_MS = "400";
delete process.env.SETUP_CODE;
delete process.env.SUPABASE_URL;
delete process.env.KIOSK_HOST;

let base = "";
let server: Server;
let admin = "";
let siteId = "";
let site2 = "";
const emp: Record<string, string> = {};
let resetLocks: () => void = () => undefined;
const TZ = "America/New_York";

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const hs: Record<string, string> = { ...headers };
  if (body !== undefined) hs["Content-Type"] = "application/json";
  const res = await fetch(base + url, { method, headers: hs, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const CSRF = { "X-Requested-With": "payroll" };
const A = (method: string, url: string, body?: unknown) => call(method, url, body, { Cookie: admin, ...CSRF });
/** Portal call with a portal cookie ("payroll_portal=..."). */
const P = (cookie: string, method: string, url: string, body?: unknown) => call(method, url, body, { Cookie: cookie, ...CSRF });
const login = (name: string, pin: string, site = siteId) => call("POST", "/api/portal/login", { siteId: site, name, pin }, CSRF);
const cookieOf = (r: { headers: Headers }) => (r.headers.get("set-cookie") ?? "").split(";")[0];
async function signIn(name: string, pin: string) {
  const r = await login(name, pin);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return cookieOf(r);
}

before(async () => {
  const express = (await import("express")).default;
  const { createServer } = await import("node:http");
  const routes = await import("../server/routes");
  const { initDatabase } = await import("../server/db");
  resetLocks = (await import("../server/portal")).resetPortalLocks;
  await initDatabase();
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  routes.registerRoutes(app);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const code = (await import("../server/auth")).getSetupCode();
  const setup = await call("POST", "/api/auth/setup", { username: "owner", password: "correct horse", setupCode: code }, CSRF);
  admin = cookieOf(setup);
  const boot = await A("GET", "/api/bootstrap");
  siteId = boot.body.sites[0].id;
  assert.equal((await A("PUT", `/api/sites/${siteId}`, { timeSource: "kiosk", rules: { ...boot.body.sites[0].rules, timezone: TZ } })).status, 200);
  site2 = (await A("POST", "/api/sites", { name: "Uptown" })).body.id;
  for (const [name, pin, s] of [["Ana Ruiz", "1234", siteId], ["Ben Lee", "5678", siteId], ["Cara Diaz", "2468", siteId], ["Zoe Uptown", "1234", site2]] as const) {
    const r = await A("POST", `/api/sites/${s}/employees`, { name, pin });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    emp[name.split(" ")[0]] = r.body.id;
  }
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  const { closeDatabase } = await import("../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Pure helpers ─────────────────────────────────────────────────────────────
test("lockout: every 5 wrong tries lock, doubling, success clears", () => {
  const p = { maxFails: 5, baseMs: 1000, maxMs: 3000, resetMs: 60_000 };
  let s: ReturnType<typeof recordAttempt>;
  for (let i = 0; i < 4; i++) s = recordAttempt(s, false, 0, p);
  assert.equal(lockRemaining(s, 0), 0);
  s = recordAttempt(s, false, 0, p);
  assert.equal(lockRemaining(s, 0), 1000);
  for (let i = 0; i < 5; i++) s = recordAttempt(s, false, 2000, p);
  assert.equal(lockRemaining(s, 2000), 2000, "second lock doubles");
  for (let i = 0; i < 10; i++) s = recordAttempt(s, false, 5000, p);
  assert.equal(lockRemaining(s, 5000), 3000, "capped");
  assert.equal(recordAttempt(s, true, 6000, p), undefined);
  // History is forgotten after resetMs without a wrong try
  const old = recordAttempt({ n: 4, lockedUntil: 0, locks: 3, last: 0 }, false, 100_000, p)!;
  assert.equal(old.n, 1);
  assert.equal(old.locks, 0);
});

test("matching: names, ids and statements", () => {
  const list = [{ id: "a", name: "Ana Ruiz", active: true }, { id: "b", name: "Ana Bell", active: true }, { id: "c", name: "Ben Lee", active: true }, { id: "d", name: "Old Timer", active: false }];
  assert.equal(matchName(list, "  ana   RUIZ ")?.id, "a");
  assert.equal(matchName(list, "ana"), null, "ambiguous first name");
  assert.equal(matchName(list, "ben")?.id, "c", "unique first name");
  assert.equal(matchName(list, "old timer"), null, "inactive");
  assert.ok(isEmployee({ employeeId: "a", employeeName: "Whoever" }, { id: "a", name: "Ana Ruiz" }));
  assert.ok(!isEmployee({ employeeId: "x", employeeName: "Ana Ruiz" }, { id: "a", name: "Ana Ruiz" }), "an id wins over the name");
  assert.ok(isEmployee({ employeeId: "", employeeName: "ana ruiz" }, { id: "a", name: "Ana Ruiz" }));
  const e = (name: string, totalPay: number, excluded = false) => ({ name, totalPay, excluded, isNetPay: true, totalBasePay: totalPay, totalBonuses: 0, totalDeductions: 0, totalDocked: 0, fullDays: 1, halfDays: 0, flaggedDays: 0, hoursWorked: 8, overtimeHours: 0, payment: { method: "cash", cash: totalPay, bank: 0, check: 0 } }) as any;
  const result = { periodStart: "2026-01-01", periodEnd: "2026-01-14", employees: [e("Ana Ruiz", 100), e("Ben Lee", 999), e("Cara Diaz", 5, true)], warnings: [{ level: "warn", employee: "Ben Lee", message: "x" }], totals: {} } as any;
  const s = statementResult(result, "ana ruiz")!;
  assert.deepEqual(s.employees.map((x) => x.name), ["Ana Ruiz"]);
  assert.equal(s.totals.totalPay, 100);
  assert.deepEqual(s.warnings, []);
  assert.equal(statementResult(result, "Cara Diaz"), null, "excluded people have no statement");
  assert.equal(statementResult(result, "Nobody"), null);
});

test("time-off request rules", () => {
  const today = "2026-05-10";
  assert.equal(checkTimeOffRequest({ start: "2026-05-12", end: "2026-05-14" }, today, []), null);
  assert.match(checkTimeOffRequest({ start: "2026-05-09", end: "2026-05-10" }, today, [])!, /today or a later day/);
  assert.match(checkTimeOffRequest({ start: "2026-05-12", end: "2026-05-11" }, today, [])!, /before the first day/);
  assert.match(checkTimeOffRequest({ start: "2026-05-12", end: "2026-08-30" }, today, [])!, /60 days/);
  const mine = [{ id: "t", employeeId: "a", employeeName: "Ana", start: "2026-05-13", end: "2026-05-13", reason: "", status: "pending", requestedBy: "employee", createdAt: "", decidedAt: null, decidedBy: null }] as any;
  assert.match(checkTimeOffRequest({ start: "2026-05-12", end: "2026-05-14" }, today, mine)!, /already have/);
  assert.equal(checkTimeOffRequest({ start: "2026-05-12", end: "2026-05-14" }, today, [{ ...mine[0], status: "declined" }]), null, "declined days can be asked again");
});

// ── Server ───────────────────────────────────────────────────────────────────
test("portal is off by default", async () => {
  assert.deepEqual((await call("GET", "/api/portal/sites")).body, []);
  assert.deepEqual((await A("GET", `/api/sites/${siteId}/portal`)).body, { enabled: false });
  const r = await login("Ana Ruiz", "1234");
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "off");
  assert.equal((await call("GET", "/api/portal/me")).status, 401);

  assert.equal((await A("PUT", `/api/sites/${siteId}/portal`, { enabled: true })).status, 200);
  const sites = (await call("GET", "/api/portal/sites")).body;
  assert.deepEqual(sites.map((s: any) => s.id), [siteId], "only locations with the portal on are listed");
  assert.deepEqual(Object.keys(sites[0]).sort(), ["color", "id", "name"]);
  assert.equal((await login("Zoe Uptown", "1234", site2)).status, 403, "still off at the other location");
});

test("portal settings are owner/admin only", async () => {
  assert.equal((await A("POST", "/api/users", { username: "mgr", password: "password-123", role: "manager" })).status, 200);
  const r = await call("POST", "/api/auth/login", { username: "mgr", password: "password-123" }, CSRF);
  const mgr = cookieOf(r);
  assert.equal((await call("PUT", `/api/sites/${siteId}/portal`, { enabled: false }, { Cookie: mgr, ...CSRF })).status, 403);
  assert.equal((await call("GET", `/api/sites/${siteId}/portal`, undefined, { Cookie: mgr })).status, 403);
});

test("sign-in: cookie flags, wrong PIN lockout per employee, same answer for unknown names", async () => {
  resetLocks();
  const ok = await login("ana ruiz", "1234");
  assert.equal(ok.status, 200);
  const set = ok.headers.get("set-cookie") ?? "";
  assert.match(set, /^payroll_portal=/);
  assert.match(set, /HttpOnly/i);
  assert.match(set, /SameSite=Strict/i);
  assert.match(set, /Path=\/api\/portal/);
  assert.match(set, /Max-Age=43200/);
  assert.equal((await P(cookieOf(ok), "GET", "/api/portal/me")).body.employee.name, "Ana Ruiz");

  // Wrong PIN and unknown name look the same
  const wrong = await login("Ben Lee", "0000");
  const ghost = await login("Nobody Here", "0000");
  assert.equal(wrong.status, 401);
  assert.equal(ghost.status, 401);
  assert.equal(wrong.body.error, ghost.body.error);
  assert.equal((await login("Ben Lee", "1234")).status, 401, "another person's PIN doesn't work");
  // Without the CSRF header the login is refused
  assert.equal((await call("POST", "/api/portal/login", { siteId, name: "Ben Lee", pin: "5678" })).status, 403);

  // 5 wrong tries lock Ben, even with the right PIN; others are not affected
  await login("Ben Lee", "0001");
  await login("Ben Lee", "0002");
  const fifth = await login("Ben Lee", "0003");
  assert.equal(fifth.status, 429);
  assert.equal(fifth.body.code, "locked");
  assert.ok(Number(fifth.headers.get("retry-after")) >= 1);
  assert.equal((await login("Ben Lee", "5678")).status, 429, "locked even with the right PIN");
  assert.equal((await login("Cara Diaz", "2468")).status, 200, "other employees can still sign in");
  await new Promise((r) => setTimeout(r, 450));
  assert.equal((await login("Ben Lee", "5678")).status, 200, "unlocked after the wait");

  // Parallel guesses can't slip past the lock
  resetLocks();
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => login("Cara Diaz", String(1000 + i))));
  assert.equal(burst.filter((r) => r.status === 401).length, 4);
  assert.equal(burst.filter((r) => r.status === 429).length, 8);
  resetLocks();
});

test("sign-in: per-address lockout across many names", async () => {
  resetLocks();
  for (let i = 0; i < 14; i++) assert.equal((await login(`Guess ${i}`, "1111")).status, 401);
  assert.equal((await login("Guess 99", "1111")).status, 429, "15th wrong try from one address locks it");
  assert.equal((await login("Ana Ruiz", "1234")).status, 429, "everything from that address waits");
  resetLocks();
  assert.equal((await login("Ana Ruiz", "1234")).status, 200);
});

test("cookie isolation: portal and admin sessions never cross", async () => {
  const ana = await signIn("Ana Ruiz", "1234");
  const token = ana.split("=")[1];
  for (const url of ["/api/bootstrap", "/api/auth/me", `/api/sites/${siteId}/employees`, `/api/sites/${siteId}/time-off`, "/api/timesheets"]) {
    assert.equal((await call("GET", url, undefined, { Cookie: ana })).status, 401, `${url} with the portal cookie`);
    assert.equal((await call("GET", url, undefined, { Cookie: `payroll_session=${token}` })).status, 401, `${url} with the portal token as the admin cookie`);
    assert.equal((await call("GET", url, undefined, { Authorization: `Bearer ${token}` })).status, 401, `${url} with the portal token as a bearer`);
  }
  assert.equal((await call("PUT", `/api/sites/${siteId}/portal`, { enabled: false }, { Cookie: ana, ...CSRF })).status, 401);
  // The admin session doesn't open the portal
  const adminToken = admin.split("=")[1];
  assert.equal((await call("GET", "/api/portal/me", undefined, { Cookie: admin })).status, 401);
  assert.equal((await call("GET", "/api/portal/me", undefined, { Cookie: `payroll_portal=${adminToken}` })).status, 401);
  // A tampered token is refused
  const [payload, sig] = token.split(".");
  const forged = JSON.parse(Buffer.from(payload, "base64url").toString());
  forged.e = emp.Ben;
  const bad = `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`;
  assert.equal((await call("GET", "/api/portal/me", undefined, { Cookie: `payroll_portal=${bad}` })).status, 401);
  // Unknown portal paths never fall through to the admin API
  assert.equal((await P(ana, "GET", "/api/portal/../bootstrap")).status, 401);
  assert.equal((await P(ana, "GET", "/api/portal/nothing")).status, 404);
});

test("hours: only my punches, day by day with status", async () => {
  const now = Date.now();
  const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  for (const [who, type, ago] of [["Ana", "in", 40], ["Ana", "out", 20], ["Ben", "in", 25]] as const) {
    const r = await A("POST", `/api/sites/${siteId}/punches`, { employeeId: emp[who], type, at: at(ago), note: "test" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const ana = await signIn("Ana Ruiz", "1234");
  const h = await P(ana, "GET", "/api/portal/hours");
  assert.equal(h.status, 200);
  assert.equal(h.body.status, "out");
  assert.equal(h.body.days.length, 1);
  assert.equal(h.body.days[0].status, "worked");
  assert.equal(h.body.days[0].workedMinutes, 20);
  assert.equal(h.body.totalMinutes, 20);
  assert.ok(h.body.period.start <= h.body.days[0].date && h.body.days[0].date <= h.body.period.end);
  const ben = await signIn("Ben Lee", "5678");
  const hb = await P(ben, "GET", "/api/portal/hours");
  assert.equal(hb.body.status, "in");
  assert.equal(hb.body.days[0].status, "working");
  assert.ok(!JSON.stringify(h.body).includes(emp.Ben) && !JSON.stringify(h.body).includes("Ben"), "nothing about Ben in Ana's hours");
  // The manager approves the day
  const day = h.body.days[0].date;
  assert.equal((await A("POST", `/api/sites/${siteId}/timeclock/approvals`, { days: [{ employeeId: emp.Ana, date: day }] })).status, 200);
  assert.equal((await P(ana, "GET", "/api/portal/hours")).body.days[0].status, "approved");
  // A double tap (very short shift) shows as flagged until approved
  await A("POST", `/api/sites/${siteId}/punches`, { employeeId: emp.Cara, type: "in", at: at(10), note: "t" });
  await A("POST", `/api/sites/${siteId}/punches`, { employeeId: emp.Cara, type: "out", at: at(9), note: "t" });
  const cara = await P(await signIn("Cara Diaz", "2468"), "GET", "/api/portal/hours");
  assert.equal(cara.body.days[0].status, "flagged");
  assert.equal(cara.body.days[0].note, "Very short shift");
  assert.equal((await P(ana, "GET", "/api/portal/hours?offset=-1")).status, 200);
  assert.equal((await P(ana, "GET", "/api/portal/hours?offset=5")).status, 400);
  assert.equal((await P(ana, "GET", `/api/portal/hours?employeeId=${emp.Ben}`)).body.totalMinutes, 20, "query ids are ignored");
});

test("pay statements: finalized only, my own data only", async () => {
  const people = (names: string[]) => names.map((name) => ({ name, categoryId: "custom", payBasis: "day_rate", fullDayRate: name === "Ana Ruiz" ? 100 : 250, halfDayRate: 50, hourlyRate: 0, isNetPay: true, excluded: false, adjustments: {}, bonuses: [], deductions: [] }));
  const doc = (label: string, names: string[], dates: string[], site = siteId) => ({
    siteId: site, label, filename: `${label}.csv`, source: "csv", status: "draft", notes: "", periodStart: dates[0], periodEnd: dates.at(-1),
    shifts: names.flatMap((n, j) => dates.map((d, i) => ({ id: `s${j}_${i}`, employee: n, date: d, start: 600, end: 1260, breakMinutes: 0, role: "", source: "csv", note: "" }))),
    employees: people(names), manualEmployees: [], rules: {},
  });
  const make = async (label: string, names: string[], dates: string[], final: boolean, site = siteId) => {
    const r = await A("POST", "/api/timesheets", { doc: doc(label, names, dates, site) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (final) assert.equal((await A("PATCH", `/api/timesheets/${r.body.id}`, { status: "final" })).status, 200);
    return r.body.id as string;
  };
  const both = await make("Both", ["Ana Ruiz", "Ben Lee"], ["2026-03-02", "2026-03-03"], true);
  const both2 = await make("Both later", ["Ana Ruiz", "Ben Lee"], ["2026-03-16"], true);
  const benOnly = await make("Ben only", ["Ben Lee"], ["2026-03-04"], true);
  const draft = await make("Draft", ["Ana Ruiz"], ["2026-03-05"], false);
  const other = await make("Other site", ["Ana Ruiz"], ["2026-03-06"], true, site2);

  const ana = await signIn("Ana Ruiz", "1234");
  const list = await P(ana, "GET", "/api/portal/statements");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((s: any) => s.id), [both2, both], "finalized, mine, this location, newest first");
  assert.equal(list.body[1].totalPay, 200);

  const st = await P(ana, "GET", `/api/portal/statements/${both}`);
  assert.equal(st.status, 200);
  assert.deepEqual(st.body.result.employees.map((e: any) => e.name), ["Ana Ruiz"]);
  assert.equal(st.body.result.totals.totalPay, 200);
  assert.ok(!JSON.stringify(st.body).includes("Ben"), "nothing about Ben in Ana's statement");
  assert.deepEqual(Object.keys(st.body.ytd), ["ana ruiz"]);
  assert.equal(st.body.ytd["ana ruiz"].net, 200, "YTD counts only periods up to this one");
  assert.equal((await P(ana, "GET", `/api/portal/statements/${both2}`)).body.ytd["ana ruiz"].net, 300);
  for (const id of [benOnly, draft, other, "../timesheets", "nope"]) {
    assert.equal((await P(ana, "GET", `/api/portal/statements/${encodeURIComponent(id)}`)).status, 404, `statement ${id}`);
  }
  assert.equal(list.body[1].minutes, 22 * 60, "hours on the statement row (2 days of 10:00–21:00)");

  // Hours that came from a spreadsheet (no time-clock punches) still show under My hours for the period.
  const today = todayISO(TZ);
  const now = await make("This period", ["Ana Ruiz", "Ben Lee"], [today], true);
  const hours = await P(ana, "GET", "/api/portal/hours");
  assert.equal(hours.status, 200);
  const mine = hours.body.timesheets.find((t: any) => t.id === now);
  assert.ok(mine, JSON.stringify(hours.body.timesheets));
  assert.equal(mine.minutes, 11 * 60);
  assert.ok(!hours.body.timesheets.some((t: any) => t.id === both), "only timesheets overlapping this period");
  assert.ok(!JSON.stringify(hours.body.timesheets).includes("Ben"), "nothing about Ben");
  assert.equal(mine.partial, false);
  assert.equal((await A("POST", `/api/timesheets/${now}/reopen`, { reason: "tidy" })).status, 200);

  // A sheet that straddles two pay periods counts only its days inside the one being viewed.
  const ps = hours.body.period.start as string;
  const pe = hours.body.period.end as string;
  const straddle = await make("Straddle", ["Ana Ruiz"], [addDays(ps, -2), addDays(ps, -1), ps], true);
  const cur = (await P(ana, "GET", "/api/portal/hours")).body.timesheets.find((t: any) => t.id === straddle);
  assert.ok(cur, "overlapping sheet is listed");
  assert.equal(cur.minutes, 11 * 60, "only the one day inside this period");
  assert.equal(cur.partial, true);
  const last = await P(ana, "GET", "/api/portal/hours?offset=-1");
  const prev = last.body.timesheets.find((t: any) => t.id === straddle);
  assert.ok(prev && last.body.period.end < ps, JSON.stringify(last.body.period));
  assert.equal(prev.minutes, 22 * 60, "the other two days show under last period");
  const after = await make("After", ["Ana Ruiz"], [addDays(pe, 1)], true);
  assert.ok(!(await P(ana, "GET", "/api/portal/hours")).body.timesheets.some((t: any) => t.id === after), "a sheet wholly outside isn't listed");
  for (const id of [straddle, after]) assert.equal((await A("POST", `/api/timesheets/${id}/reopen`, { reason: "tidy" })).status, 200);
  assert.ok(!(await P(ana, "GET", "/api/portal/hours")).body.timesheets.some((t: any) => t.id === now), "drafts don't count");

  // Reopened (no longer final) timesheets disappear
  assert.equal((await A("POST", `/api/timesheets/${both2}/reopen`, { reason: "fix it" })).status, 200);
  assert.equal((await P(ana, "GET", `/api/portal/statements/${both2}`)).status, 404);
});

test("schedule: published weeks only, my shifts only, approved time off", async () => {
  const today = todayISO(TZ);
  const ws = weekStartOf(today, 1);
  const week = await A("PUT", `/api/sites/${siteId}/schedule/week/${ws}`, {
    shifts: [
      { employeeId: emp.Ana, employeeName: "Ana Ruiz", date: today, start: 540, end: 1020, station: "Grill" },
      { employeeId: emp.Ben, employeeName: "Ben Lee", date: today, start: 600, end: 900 },
    ],
  });
  assert.equal(week.status, 200, JSON.stringify(week.body));
  const ana = await signIn("Ana Ruiz", "1234");
  const before = await P(ana, "GET", "/api/portal/schedule");
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.shifts, [], "draft weeks are hidden");
  assert.ok(before.body.unpublishedWeeks.includes(ws));
  assert.equal((await A("POST", `/api/sites/${siteId}/schedule/week/${ws}/publish`, { publish: true })).status, 200);
  const after = await P(ana, "GET", "/api/portal/schedule");
  assert.equal(after.body.shifts.length, 1);
  assert.equal(after.body.shifts[0].station, "Grill");
  assert.equal(after.body.from, today);
  assert.equal(after.body.to, addDays(today, 13));
  assert.ok(!JSON.stringify(after.body).includes("Ben"));
});

test("time off: request, owner approves or declines, cancel only pending", async () => {
  const today = todayISO(TZ);
  const ana = await signIn("Ana Ruiz", "1234");
  const ben = await signIn("Ben Lee", "5678");
  const d1 = addDays(today, 20);
  const req = await P(ana, "POST", "/api/portal/time-off", { start: d1, end: addDays(d1, 2), note: "Wedding" });
  assert.equal(req.status, 200, JSON.stringify(req.body));
  assert.equal(req.body.status, "pending");
  assert.equal(req.body.requestedBy, "employee");
  assert.equal((await P(ana, "POST", "/api/portal/time-off", { start: d1, end: d1 })).status, 400, "overlaps a request");
  assert.equal((await P(ana, "POST", "/api/portal/time-off", { start: addDays(today, -1), end: today })).status, 400, "past days");
  assert.equal((await call("POST", "/api/portal/time-off", { start: d1, end: d1 }, { Cookie: ana })).status, 403, "CSRF header required");

  // The owner sees it as pending on the Schedule page's data
  const list = (await A("GET", `/api/sites/${siteId}/time-off`)).body;
  const entry = list.find((t: any) => t.id === req.body.id);
  assert.equal(entry.status, "pending");
  assert.equal(entry.employeeId, emp.Ana);
  assert.equal(entry.reason, "Wedding");

  // Ben can't see or cancel Ana's request
  assert.ok(!(await P(ben, "GET", "/api/portal/time-off")).body.some((t: any) => t.id === req.body.id));
  assert.equal((await P(ben, "DELETE", `/api/portal/time-off/${req.body.id}`)).status, 404);

  // Approve: it is now ordinary approved time off and shows on Ana's schedule if in range
  const ok = await A("PUT", `/api/sites/${siteId}/time-off/${req.body.id}`, { status: "approved" });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.decidedBy);
  const mine = (await P(ana, "GET", "/api/portal/time-off")).body;
  assert.equal(mine.find((t: any) => t.id === req.body.id).status, "approved");
  assert.equal((await P(ana, "DELETE", `/api/portal/time-off/${req.body.id}`)).status, 409, "approved can't be cancelled here");

  const soon = await P(ana, "POST", "/api/portal/time-off", { start: addDays(today, 1), end: addDays(today, 1) });
  assert.equal((await A("PUT", `/api/sites/${siteId}/time-off/${soon.body.id}`, { status: "approved" })).status, 200);
  const sched = (await P(ana, "GET", "/api/portal/schedule")).body;
  assert.deepEqual(sched.timeOff.map((t: any) => t.id), [soon.body.id]);

  // Decline: stays visible as declined; cancel a pending one
  const two = await P(ana, "POST", "/api/portal/time-off", { start: addDays(today, 40), end: addDays(today, 40) });
  assert.equal((await A("PUT", `/api/sites/${siteId}/time-off/${two.body.id}`, { status: "declined" })).status, 200);
  assert.equal((await P(ana, "GET", "/api/portal/time-off")).body.find((t: any) => t.id === two.body.id).status, "declined");
  const three = await P(ana, "POST", "/api/portal/time-off", { start: addDays(today, 50), end: addDays(today, 51) });
  assert.equal((await P(ana, "DELETE", `/api/portal/time-off/${three.body.id}`)).status, 200);
  assert.ok(!(await A("GET", `/api/sites/${siteId}/time-off`)).body.some((t: any) => t.id === three.body.id));
});

test("sessions end on sign-out, PIN change, deactivation and portal off", async () => {
  // Sign out ends all of this employee's portal sessions
  const a1 = await signIn("Ana Ruiz", "1234");
  await new Promise((r) => setTimeout(r, 5));
  const a2 = await signIn("Ana Ruiz", "1234");
  assert.equal((await P(a2, "POST", "/api/portal/logout")).status, 200);
  assert.equal((await P(a1, "GET", "/api/portal/me")).status, 401);
  assert.equal((await P(a2, "GET", "/api/portal/me")).status, 401);
  await new Promise((r) => setTimeout(r, 5));

  // PIN change
  const a3 = await signIn("Ana Ruiz", "1234");
  assert.equal((await P(a3, "GET", "/api/portal/me")).status, 200);
  assert.equal((await A("PUT", `/api/sites/${siteId}/employees/${emp.Ana}`, { pin: "4321" })).status, 200);
  assert.equal((await P(a3, "GET", "/api/portal/me")).status, 401);
  assert.equal((await login("Ana Ruiz", "1234")).status, 401);

  // Deactivated
  const a4 = await signIn("Ana Ruiz", "4321");
  assert.equal((await A("PUT", `/api/sites/${siteId}/employees/${emp.Ana}`, { active: false })).status, 200);
  assert.equal((await P(a4, "GET", "/api/portal/me")).status, 401);
  assert.equal((await login("Ana Ruiz", "4321")).status, 401);

  // Portal turned off for the location
  const b = await signIn("Ben Lee", "5678");
  assert.equal((await A("PUT", `/api/sites/${siteId}/portal`, { enabled: false })).status, 200);
  assert.equal((await P(b, "GET", "/api/portal/me")).status, 401);
});
