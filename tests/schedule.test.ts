// Schedule: pure rules (alerts, early clock-in, copying, time off) and the API
// on a real server with a temporary SQLite database.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Punch } from "../shared/punches";
import type { Shift } from "../shared/schema";
import { addDays, instantToLocal, localToInstant, todayISO } from "../shared/dates";
import {
  type ScheduledShift, type TimeOff, applyEarlyClockIn, copyShifts, parseWeek, scheduleAlerts, scheduledHours, scheduledShiftSchema,
  timeOffOn, weekStartOf, weeksCovering,
} from "../shared/schedule";

const TZ = "America/New_York";
const sched = (p: Partial<ScheduledShift> & { employeeName: string; start: number; end: number }): ScheduledShift =>
  ({ id: `sh_${p.employeeName}_${p.start}`, employeeId: "", date: "2026-11-25", station: "", note: "", ...p });
const punch = (employeeId: string, employeeName: string, type: Punch["type"], date: string, minutes: number): Punch => ({
  id: `p_${employeeId}_${type}_${minutes}`, siteId: "s", employeeId, employeeName, type, at: localToInstant(date, minutes, TZ), source: "kiosk",
  deviceId: null, note: "", createdAt: "", editedAt: null, edits: [],
});
const at = (date: string, minutes: number) => Date.parse(localToInstant(date, minutes, TZ));
const D = "2026-11-25";

// ── Pure ─────────────────────────────────────────────────────────────────────
test("shift validation: end after start, at most 24 hours, overnight allowed", () => {
  assert.ok(scheduledShiftSchema.safeParse(sched({ employeeName: "Ana", start: 1320, end: 1800 })).success, "10 PM to 6 AM");
  assert.ok(!scheduledShiftSchema.safeParse(sched({ employeeName: "Ana", start: 600, end: 600 })).success);
  assert.ok(!scheduledShiftSchema.safeParse(sched({ employeeName: "Ana", start: 0, end: 1500 })).success);
});

test("parseWeek drops bad shifts and keeps the rest sorted", () => {
  const w = parseWeek({ shifts: [sched({ employeeName: "Zed", start: 600, end: 700 }), { nope: 1 }, sched({ employeeName: "Ana", start: 540, end: 700 })], publishedAt: "2026-11-20T00:00:00Z" }, "s", "2026-11-23");
  assert.deepEqual(w.shifts.map((s) => s.employeeName), ["Ana", "Zed"]);
  assert.equal(w.publishedAt, "2026-11-20T00:00:00Z");
  assert.deepEqual(parseWeek("garbage", "s", "2026-11-23").shifts, []);
});

test("weeks, copying and hours", () => {
  assert.equal(weekStartOf("2026-11-25", 1), "2026-11-23");
  assert.equal(weekStartOf("2026-11-25", 0), "2026-11-22");
  assert.deepEqual(weeksCovering("2026-11-25", "2026-12-08", 1), ["2026-11-23", "2026-11-30", "2026-12-07"]);
  let n = 0;
  const copied = copyShifts([sched({ employeeName: "Ana", date: "2026-11-18", start: 540, end: 1020 })], "2026-11-16", "2026-11-23", () => `new${++n}`);
  assert.equal(copied[0].date, "2026-11-25");
  assert.equal(copied[0].id, "new1");
  const h = scheduledHours([sched({ employeeName: "Ana", start: 540, end: 1020 }), sched({ employeeName: "ana", start: 1080, end: 1140 })]);
  assert.equal(h.total, 9);
  assert.equal(h.byPerson["name:ana"], 9);
});

test("time off: only approved entries cover a day", () => {
  const base: TimeOff = { id: "t", employeeId: "emp_1", employeeName: "Ana", start: "2026-11-24", end: "2026-11-26", reason: "", status: "approved", requestedBy: "owner", createdAt: "", decidedAt: null, decidedBy: null };
  assert.ok(timeOffOn([base], { employeeId: "emp_1", employeeName: "Ana" }, D));
  assert.ok(timeOffOn([base], { employeeName: "ana" }, D), "matches by name too");
  assert.ok(!timeOffOn([base], { employeeId: "emp_1", employeeName: "Ana" }, "2026-11-27"));
  assert.ok(!timeOffOn([{ ...base, status: "pending" }], { employeeId: "emp_1", employeeName: "Ana" }, D));
});

test("alerts: late, no-show, arrived late, on time and time off", () => {
  const shifts = [
    sched({ employeeId: "k", employeeName: "Kenji Sato", start: 540, end: 1020 }), // 9:00
    sched({ employeeId: "a", employeeName: "Ana Ruiz", start: 540, end: 1020 }),
    sched({ employeeId: "m", employeeName: "Mia", start: 480, end: 960 }), // came in 8:20, late
    sched({ employeeId: "o", employeeName: "Omar", start: 540, end: 1020 }), // on time (early)
    sched({ employeeId: "t", employeeName: "Tess", start: 540, end: 1020 }), // time off
    sched({ employeeId: "l", employeeName: "Lou", start: 720, end: 1020 }), // not due yet
  ];
  const punches = [punch("m", "Mia", "in", D, 500), punch("o", "Omar", "in", D, 530)];
  const timeOff: TimeOff[] = [{ id: "x", employeeId: "t", employeeName: "Tess", start: D, end: D, reason: "", status: "approved", requestedBy: "owner", createdAt: "", decidedAt: null, decidedBy: null }];

  // 9:15: Kenji and Ana are 15 min late (grace 5), no-show after 60.
  const a1 = scheduleAlerts({ date: D, timezone: TZ, now: at(D, 555), shifts, punches, timeOff, settings: { lateGraceMinutes: 5, noShowAfterMinutes: 60 } });
  assert.deepEqual(a1.map((a) => [a.kind, a.employeeName, a.minutesLate]), [
    ["late", "Ana Ruiz", 15], ["late", "Kenji Sato", 15], ["arrived_late", "Mia", 20],
  ]);
  assert.equal(a1.find((a) => a.employeeId === "k")!.message, "Kenji is 15 min late");
  assert.equal(a1.find((a) => a.employeeId === "m")!.message, "Mia clocked in 20 min late");

  // 10:05 with Kenji clocked in at 9:20: Ana is a no-show, Kenji arrived late.
  const a2 = scheduleAlerts({ date: D, timezone: TZ, now: at(D, 605), shifts, punches: [...punches, punch("k", "Kenji Sato", "in", D, 560)], timeOff, settings: { lateGraceMinutes: 5, noShowAfterMinutes: 60 } });
  const ana = a2.find((a) => a.employeeId === "a")!;
  assert.equal(ana.kind, "no_show");
  assert.equal(ana.message, "No-show: Ana (scheduled 9:00 AM)");
  assert.equal(a2.find((a) => a.employeeId === "k")!.kind, "arrived_late");
  assert.ok(!a2.some((a) => a.employeeId === "t" || a.employeeId === "o" || a.employeeId === "l"));

  // Within grace: nothing yet.
  assert.deepEqual(scheduleAlerts({ date: D, timezone: TZ, now: at(D, 543), shifts: [shifts[0]], punches: [], settings: { lateGraceMinutes: 5 } }), []);
  // 24-hour messages
  const a3 = scheduleAlerts({ date: D, timezone: TZ, now: at(D, 1030), shifts: [shifts[1]], punches: [], timeFormat: "24h" });
  assert.equal(a3[0].message, "No-show: Ana (scheduled 09:00)");
});

test("alerts: a split shift needs its own clock-in", () => {
  const shifts = [
    sched({ id: "lunch", employeeId: "k", employeeName: "Kenji", start: 660, end: 840 }), // 11-14
    sched({ id: "dinner", employeeId: "k", employeeName: "Kenji", start: 1020, end: 1320 }), // 17-22
  ];
  const punches = [punch("k", "Kenji", "in", D, 655), punch("k", "Kenji", "out", D, 845)];
  const a = scheduleAlerts({ date: D, timezone: TZ, now: at(D, 1050), shifts, punches, settings: { lateGraceMinutes: 5, noShowAfterMinutes: 60 } });
  assert.deepEqual(a.map((x) => [x.shiftId, x.kind]), [["dinner", "late"]]);
});

const kshift = (employee: string, start: number, end: number, extra: Partial<Shift> = {}): Shift =>
  ({ id: `ki_${employee}_${start}`, employee, date: D, start, end, breakMinutes: 0, role: "", source: "kiosk", note: "", ...extra });

test("early clock-in rule: off by default, start and cap modes, only scheduled days", () => {
  const shifts = [kshift("Kenji", 500, 1020), kshift("Ana", 535, 1020), kshift("Lee", 480, 1020), kshift("Mia", 480, 1020, { source: "square" })];
  const scheduled = [{ employeeName: "kenji", date: D, start: 540 }, { employeeName: "Ana", date: D, start: 540 }, { employeeName: "Mia", date: D, start: 540 }];

  const off = applyEarlyClockIn(shifts, scheduled, undefined);
  assert.equal(off.shifts, shifts, "no rule: the very same array");
  assert.equal(applyEarlyClockIn(shifts, scheduled, { enabled: false, minutes: 10, mode: "start" }).adjusted, 0);

  const start = applyEarlyClockIn(shifts, scheduled, { enabled: true, minutes: 10, mode: "start" });
  assert.equal(start.adjusted, 1);
  assert.equal(start.shifts[0].start, 540, "Kenji came 40 min early: counted from 9:00");
  assert.match(start.shifts[0].note, /Clocked in 8:20 AM, counted from 9:00 AM/);
  assert.equal(start.shifts[1].start, 535, "Ana is within 10 minutes: unchanged");
  assert.equal(start.shifts[2].start, 480, "Lee has no schedule: unchanged");
  assert.equal(start.shifts[3].start, 480, "only kiosk shifts are touched");
  assert.equal(start.warnings.length, 1);

  const cap = applyEarlyClockIn(shifts, scheduled, { enabled: true, minutes: 10, mode: "cap" });
  assert.equal(cap.shifts[0].start, 530, "counted from 10 minutes before the start");

  // Break minutes never exceed the shortened shift; a shift that ends before the start is left alone.
  const odd = applyEarlyClockIn([kshift("Kenji", 300, 560, { breakMinutes: 60 }), kshift("Ana", 300, 400)], scheduled, { enabled: true, minutes: 0, mode: "start" });
  assert.equal(odd.shifts[0].start, 540);
  assert.equal(odd.shifts[0].breakMinutes, 20);
  assert.equal(odd.shifts[1].start, 300);
});

test("schedule PDF builds in Node with shifts, time off and odd characters", async () => {
  const { buildSchedulePdf } = await import("../client/src/lib/pdf/schedule");
  const { prefsSchema, siteSchema } = await import("../shared/schema");
  const week = parseWeek({
    shifts: [
      sched({ employeeId: "a", employeeName: "Ana Ruiz", date: "2026-11-23", start: 540, end: 1020, station: "Grill" }),
      sched({ employeeId: "a", employeeName: "Ana Ruiz", date: "2026-11-24", start: 1320, end: 1800, note: "Close ✓" }),
      sched({ employeeId: "k", employeeName: "Kenji Satō", date: "2026-11-25", start: 600, end: 900 }),
    ],
    publishedAt: "2026-11-20T10:00:00Z",
  }, "s", "2026-11-23");
  const timeOff: TimeOff[] = [{ id: "t", employeeId: "k", employeeName: "Kenji Satō", start: "2026-11-27", end: "2026-11-28", reason: "Trip", status: "approved", requestedBy: "owner", createdAt: "", decidedAt: null, decidedBy: null }];
  const people = [{ employeeId: "a", employeeName: "Ana Ruiz", role: "Cook" }, { employeeId: "k", employeeName: "Kenji Satō" }];
  const pdf = buildSchedulePdf({ week, people, timeOff, prefs: prefsSchema.parse({ businessName: "Noodle Bar" }), site: siteSchema.parse({ id: "s", name: "Main" }), generatedAt: new Date("2026-11-21T12:00:00") });
  assert.equal(pdf.getNumberOfPages(), 1);
  assert.ok(pdf.output("arraybuffer").byteLength > 1000);
  const many = Array.from({ length: 60 }, (_, i) => ({ employeeId: `e${i}`, employeeName: `Person ${i}` }));
  const big = buildSchedulePdf({ week: parseWeek({ shifts: many.map((p, i) => sched({ ...p, id: `x${i}`, date: "2026-11-23", start: 540, end: 1020 })) }, "s", "2026-11-23"), people: many, timeOff: [], prefs: prefsSchema.parse({}), site: siteSchema.parse({ id: "s", name: "Main" }) });
  assert.ok(big.getNumberOfPages() >= 2, "long teams flow onto more pages");
  const empty = buildSchedulePdf({ week: parseWeek(null, "s", "2026-11-23"), people: [], timeOff: [], prefs: prefsSchema.parse({}), site: siteSchema.parse({ id: "s", name: "Main" }) });
  assert.equal(empty.getNumberOfPages(), 1);
});

// ── API ──────────────────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-schedule-"));
let base = "";
let server: Server;
let admin = "";
let viewer = "";
let siteId = "";

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const hs: Record<string, string> = { ...headers };
  if (body !== undefined) hs["Content-Type"] = "application/json";
  const res = await fetch(base + url, { method, headers: hs, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const A = (method: string, url: string, body?: unknown) => call(method, url, body, { Cookie: admin, "X-Requested-With": "payroll" });
const V = (method: string, url: string, body?: unknown) => call(method, url, body, { Cookie: viewer, "X-Requested-With": "payroll" });

before(async () => {
  process.env.DATA_DIR = dir;
  process.env.BACKUPS = "off";
  delete process.env.SETUP_CODE;
  delete process.env.SUPABASE_URL;
  delete process.env.KIOSK_HOST;
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
  const setup = await call("POST", "/api/auth/setup", { username: "owner", password: "correct horse", setupCode: code }, { "X-Requested-With": "payroll" });
  admin = (setup.headers.get("set-cookie") ?? "").split(";")[0];
  const boot = await A("GET", "/api/bootstrap");
  siteId = boot.body.sites[0].id;
  await A("PUT", `/api/sites/${siteId}`, { timeSource: "kiosk", rules: { timezone: TZ, weekStartsOn: 1 } });
  const u = await A("POST", "/api/users", { username: "viewer", password: "viewer pass 1", role: "viewer", displayName: "Vee" });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  const login = await call("POST", "/api/auth/login", { username: "viewer", password: "viewer pass 1" }, { "X-Requested-With": "payroll" });
  viewer = (login.headers.get("set-cookie") ?? "").split(";")[0];
  assert.ok(viewer, "viewer signed in");
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  const { closeDatabase } = await import("../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("api: save, copy, publish and read a week; viewers read only", async () => {
  const ana = (await A("POST", `/api/sites/${siteId}/employees`, { name: "Ana Ruiz", pin: "1234" })).body;
  const week = "2026-11-16";
  const empty = await A("GET", `/api/sites/${siteId}/schedule/week?start=2026-11-18`);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.week.weekStart, week, "any date maps to its week");
  assert.equal(empty.body.employees[0].name, "Ana Ruiz");

  const bad = await A("PUT", `/api/sites/${siteId}/schedule/week/${week}`, { shifts: [{ employeeId: ana.id, employeeName: "Ana Ruiz", date: "2026-11-30", start: 540, end: 1020 }] });
  assert.equal(bad.status, 400, "a shift outside the week is refused");
  const notStart = await A("PUT", `/api/sites/${siteId}/schedule/week/2026-11-18`, { shifts: [] });
  assert.equal(notStart.status, 400);

  const saved = await A("PUT", `/api/sites/${siteId}/schedule/week/${week}`, {
    baseUpdatedAt: null,
    shifts: [{ employeeId: ana.id, employeeName: "Ana Ruiz", date: "2026-11-18", start: 540, end: 1020, station: "Grill" }],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.shifts.length, 1);
  const stale = await A("PUT", `/api/sites/${siteId}/schedule/week/${week}`, { baseUpdatedAt: null, shifts: [] });
  assert.equal(stale.status, 409, "edits from an old copy are refused");

  const v = await V("PUT", `/api/sites/${siteId}/schedule/week/${week}`, { shifts: [] });
  assert.equal(v.status, 403);
  assert.equal((await V("GET", `/api/sites/${siteId}/schedule/week?start=${week}`)).status, 200);

  const next = "2026-11-23";
  const copied = await A("POST", `/api/sites/${siteId}/schedule/week/${next}/copy-previous`, {});
  assert.equal(copied.status, 200, JSON.stringify(copied.body));
  assert.equal(copied.body.shifts[0].date, "2026-11-25");
  assert.notEqual(copied.body.shifts[0].id, saved.body.shifts[0].id);
  assert.equal((await A("POST", `/api/sites/${siteId}/schedule/week/${next}/copy-previous`, {})).status, 409, "asks before replacing");

  const pub = await A("POST", `/api/sites/${siteId}/schedule/week/${next}/publish`, {});
  assert.ok(pub.body.publishedAt);
  const api = await V("GET", `/api/schedule?siteId=${siteId}&from=2026-11-16&to=2026-11-29`);
  assert.equal(api.status, 200, JSON.stringify(api.body));
  assert.equal(api.body.shifts.length, 2);
  assert.deepEqual(api.body.shifts.map((s: any) => s.published), [false, true]);
  assert.equal(api.body.timezone, TZ);
  assert.equal((await A("GET", `/api/schedule?siteId=nope&from=2026-11-16&to=2026-11-29`)).status, 404);
  assert.equal((await A("GET", `/api/schedule?siteId=${siteId}&from=2026-11-29&to=2026-11-16`)).status, 400);

  // Activity log
  const log = await A("GET", "/api/audit?action=schedule");
  if (log.status === 200) assert.ok(log.body.entries.some((e: any) => e.action === "schedule.publish"));
});

test("api: time off is stored per site with a status, and settings are owner-only", async () => {
  const to = await A("POST", `/api/sites/${siteId}/time-off`, { employeeName: "Ana Ruiz", start: "2026-12-01", end: "2026-12-03", reason: "Trip" });
  assert.equal(to.status, 200, JSON.stringify(to.body));
  assert.equal(to.body.status, "approved");
  assert.equal(to.body.requestedBy, "owner");
  const upd = await A("PUT", `/api/sites/${siteId}/time-off/${to.body.id}`, { status: "declined" });
  assert.equal(upd.body.status, "declined");
  assert.ok(upd.body.decidedAt);
  assert.equal((await A("GET", `/api/sites/${siteId}/time-off`)).body.length, 1);
  assert.equal((await V("POST", `/api/sites/${siteId}/time-off`, { employeeName: "X", start: "2026-12-01", end: "2026-12-01" })).status, 403);
  assert.equal((await A("POST", `/api/sites/${siteId}/time-off`, { employeeName: "X", start: "2026-12-03", end: "2026-12-01" })).status, 400);
  assert.equal((await A("DELETE", `/api/sites/${siteId}/time-off/${to.body.id}`)).body.ok, true);

  const st = await A("GET", `/api/sites/${siteId}/schedule/settings`);
  assert.deepEqual(st.body, { lateGraceMinutes: 5, noShowAfterMinutes: 60, earlyClockIn: { enabled: false, minutes: 10, mode: "start" } });
  assert.equal((await V("PUT", `/api/sites/${siteId}/schedule/settings`, { lateGraceMinutes: 9 })).status, 403);
  const put = await A("PUT", `/api/sites/${siteId}/schedule/settings`, { lateGraceMinutes: 9, earlyClockIn: { enabled: true } });
  assert.equal(put.body.lateGraceMinutes, 9);
  assert.deepEqual(put.body.earlyClockIn, { enabled: true, minutes: 10, mode: "start" });

  // Backups include the schedule (not secret).
  const backup = await A("GET", "/api/backup");
  const keys = backup.body.settings.map((s: any) => s.key);
  assert.ok(keys.includes(`schedule-settings:${siteId}`));
  assert.ok(keys.includes(`schedule:${siteId}:2026-11-23`));
});

test("api: early clock-in rule applies to the time-clock import only on scheduled days", async () => {
  const emp = (await A("POST", `/api/sites/${siteId}/employees`, { name: "Kenji Sato", pin: "4321" })).body;
  const day = addDays(todayISO(TZ), -2);
  const wk = weekStartOf(day, 1);
  const cur = (await A("GET", `/api/sites/${siteId}/schedule/week?start=${wk}`)).body.week;
  const r = await A("PUT", `/api/sites/${siteId}/schedule/week/${wk}`, { shifts: [...cur.shifts, { employeeId: emp.id, employeeName: "Kenji Sato", date: day, start: 540, end: 1020 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const add = async (type: string, minutes: number, d = day) => {
    const res = await A("POST", `/api/sites/${siteId}/punches`, { employeeId: emp.id, type, at: localToInstant(d, minutes, TZ), note: "test" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  };
  await add("in", 500); // 8:20, 40 min early
  await add("out", 1020);
  const other = addDays(day, -1); // no schedule that day
  await add("in", 480, other);
  await add("out", 1000, other);

  const shifts = await A("GET", `/api/sites/${siteId}/punches/shifts?start=${other}&end=${day}`);
  assert.equal(shifts.status, 200);
  const k = shifts.body.shifts.filter((s: any) => s.employee === "Kenji Sato");
  assert.equal(k.find((s: any) => s.date === day).start, 540, "counted from the scheduled start");
  assert.equal(k.find((s: any) => s.date === other).start, 480, "no schedule: unchanged");
  assert.ok(shifts.body.warnings.some((w: string) => /early clock-in/.test(w)));

  await A("PUT", `/api/sites/${siteId}/schedule/settings`, { earlyClockIn: { enabled: false } });
  const off = await A("GET", `/api/sites/${siteId}/punches/shifts?start=${other}&end=${day}`);
  assert.equal(off.body.shifts.find((s: any) => s.employee === "Kenji Sato" && s.date === day).start, 500, "rule off: as punched");

  // Labor vs sales: saved rate + manual sales.
  await A("PUT", `/api/sites/${siteId}/wages`, [{ name: "Kenji Sato", payBasis: "hourly", hourlyRate: 20 }]);
  assert.equal((await V("PUT", `/api/sites/${siteId}/sales`, { date: day, amount: 1000 })).status, 403);
  assert.equal((await A("PUT", `/api/sites/${siteId}/sales`, { date: day, amount: 1000 })).status, 200);
  const labor = await V("GET", `/api/sites/${siteId}/labor?from=${other}&to=${day}`);
  assert.equal(labor.status, 200, JSON.stringify(labor.body));
  const d = labor.body.days.find((x: any) => x.date === day);
  assert.equal(d.sales, 1000);
  assert.equal(d.salesSource, "manual");
  assert.ok(Math.abs(d.labor - (1020 - 500) / 60 * 20) < 0.01, `labor ${d.labor}`);
  assert.equal(labor.body.square.connected, false);
  assert.equal((await A("GET", `/api/sites/${siteId}/sales?from=${day}&to=${day}`)).body[day], 1000);
  await A("PUT", `/api/sites/${siteId}/sales`, { date: day, amount: null });
  assert.equal((await A("GET", `/api/sites/${siteId}/sales?from=${day}&to=${day}`)).body[day], undefined);

  // Forecast over a period that includes those days.
  const f = await V("GET", `/api/sites/${siteId}/forecast?start=${other}&end=${addDays(day, 7)}`);
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.ok(f.body.paidSoFar > 0);
  assert.ok(f.body.projected >= f.body.paidSoFar);
});

test("api: late alerts for today", async () => {
  const tz = TZ;
  const today = todayISO(tz);
  const nowMin = instantToLocal(new Date(), tz).minutes;
  const emp = (await A("POST", `/api/sites/${siteId}/employees`, { name: "Omar Late", pin: "5555" })).body;
  const wk = weekStartOf(today, 1);
  const cur = (await A("GET", `/api/sites/${siteId}/schedule/week?start=${wk}`)).body.week;
  // Started 30 minutes ago (or at midnight just after it), ends later today.
  const start = Math.max(0, nowMin - 30);
  const end = Math.min(1439 + 1, Math.max(start + 120, nowMin + 60));
  await A("PUT", `/api/sites/${siteId}/schedule/week/${wk}`, { shifts: [...cur.shifts, { employeeId: emp.id, employeeName: "Omar Late", date: today, start, end }] });
  const res = await V("GET", `/api/sites/${siteId}/schedule/alerts`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.hasSchedule, true);
  if (nowMin - start > 9) {
    const a = res.body.alerts.find((x: any) => x.employeeId === emp.id);
    assert.ok(a, JSON.stringify(res.body.alerts));
    assert.equal(a.kind, "late");
  }
});
