// Labor cost vs. sales and payroll forecasting (pure logic).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RULES, type EmployeeConfig, type Shift, employeeConfigSchema } from "../shared/schema";
import { dailyFromEmployees, dateRange, forecastPayroll, laborFromShifts, laborPercent, laborReport, mergeSales } from "../shared/labor";
import type { ScheduledShift } from "../shared/schedule";

const rules = { ...DEFAULT_RULES, timezone: "UTC", classificationMethod: "hours" as const, fullDayMinHours: 8, halfDayMinHours: 4 };
const hourly = (name: string, rate: number): EmployeeConfig => employeeConfigSchema.parse({ name, payBasis: "hourly", hourlyRate: rate });
const daily = (name: string, full: number, half: number): EmployeeConfig => employeeConfigSchema.parse({ name, payBasis: "day_rate", fullDayRate: full, halfDayRate: half });
const shift = (employee: string, date: string, start: number, end: number, extra: Partial<Shift> = {}): Shift =>
  ({ id: `s_${employee}_${date}_${start}`, employee, date, start, end, breakMinutes: 0, role: "", source: "kiosk", note: "", ...extra });
const sched = (employeeName: string, date: string, start: number, end: number, id = `${employeeName}-${date}-${start}`): ScheduledShift =>
  ({ id, employeeId: "", employeeName, date, start, end, station: "", note: "" });

test("dateRange is inclusive and rejects bad input", () => {
  assert.deepEqual(dateRange("2026-11-29", "2026-12-02"), ["2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02"]);
  assert.deepEqual(dateRange("2026-12-02", "2026-11-29"), []);
  assert.deepEqual(dateRange("nope", "2026-11-29"), []);
});

test("laborPercent needs positive sales", () => {
  assert.equal(laborPercent(250, 1000), 0.25);
  assert.equal(laborPercent(250, 0), null);
  assert.equal(laborPercent(250, null), null);
});

test("labor from shifts uses saved rates through the payroll engine", () => {
  const shifts = [
    shift("Kenji", "2026-11-23", 540, 1020), // 8 h hourly
    shift("Ana", "2026-11-23", 600, 900), // 5 h -> half day
    shift("Ana", "2026-11-24", 540, 1080), // 9 h -> full day
    shift("Ghost", "2026-11-24", 540, 600), // no rate
    shift("Kenji", "2026-11-30", 540, 600), // out of range
  ];
  const r = laborFromShifts(shifts, { employees: [hourly("Kenji", 20), daily("Ana", 120, 60)], categories: [], rules }, "2026-11-23", "2026-11-29");
  assert.equal(r.days["2026-11-23"].cost, 160 + 60);
  assert.equal(r.days["2026-11-23"].hours, 13);
  assert.equal(r.days["2026-11-24"].cost, 120);
  assert.equal(r.days["2026-11-30"], undefined);
  assert.deepEqual(r.missingRates, ["Ghost"]);
});

test("dailyFromEmployees skips excluded people and dates out of range", () => {
  const days = dailyFromEmployees([
    { excluded: false, days: [{ date: "2026-11-23", pay: 100, hours: 5 }, { date: "2026-12-01", pay: 50, hours: 2 }] as any },
    { excluded: true, days: [{ date: "2026-11-23", pay: 999, hours: 9 }] as any },
  ], "2026-11-01", "2026-11-30");
  assert.deepEqual(days, { "2026-11-23": { cost: 100, hours: 5 } });
});

test("labor report: timesheets beat punch estimates, manual sales beat Square", () => {
  const sales = mergeSales({ "2026-11-23": 1000, "2026-11-24": 800 }, { "2026-11-24": 500 });
  assert.deepEqual(sales["2026-11-24"], { amount: 500, source: "manual" });
  const r = laborReport({
    from: "2026-11-23",
    to: "2026-11-25",
    fromTimesheets: { "2026-11-23": { cost: 300, hours: 20 } },
    fromPunches: { "2026-11-23": { cost: 999, hours: 99 }, "2026-11-24": { cost: 100, hours: 6 }, "2026-11-25": { cost: 50, hours: 3 } },
    sales,
  });
  assert.equal(r.days.length, 3);
  assert.deepEqual(r.days[0], { date: "2026-11-23", sales: 1000, salesSource: "square", labor: 300, hours: 20, laborSource: "timesheet", pct: 0.3 });
  assert.equal(r.days[1].pct, 0.2);
  assert.equal(r.days[2].pct, null, "no sales, no percentage");
  assert.equal(r.totals.labor, 450);
  assert.equal(r.totals.sales, 1500);
  // Only days with sales count toward the total percentage: (300 + 100) / 1500
  assert.ok(Math.abs((r.totals.pct ?? 0) - 400 / 1500) < 1e-9);
  assert.equal(r.totals.daysWithSales, 2);
});

test("forecast: paid so far from punches plus remaining scheduled hours", () => {
  const f = forecastPayroll({
    period: { start: "2026-11-23", end: "2026-11-29" },
    today: "2026-11-25",
    nowMinutes: 12 * 60,
    actual: [shift("Kenji", "2026-11-23", 540, 1020), shift("Kenji", "2026-11-24", 540, 1020), shift("Kenji", "2026-11-20", 540, 1020)],
    open: [{ employee: "Kenji", date: "2026-11-25", start: 540 }], // in since 9:00, scheduled until 17:00
    scheduled: [
      sched("Kenji", "2026-11-25", 540, 1020),
      sched("Kenji", "2026-11-26", 540, 1020),
      sched("Ana", "2026-11-25", 600, 720), // ended before now? no: ends 12:00 = now, so skipped
      sched("Ana", "2026-11-25", 780, 1020), // 13:00-17:00 still to come
      sched("Ana", "2026-11-22", 540, 1020), // before the period
    ],
    employees: [hourly("Kenji", 20), hourly("Ana", 15)],
    categories: [],
    rules,
  });
  // Paid: 8 h + 8 h + 3 h open (9:00-12:00) = 19 h × 20
  assert.equal(f.paidSoFar, 380);
  // Projected: Kenji 8+8+8+8 = 32 h × 20 = 640; Ana 4 h × 15 = 60
  assert.equal(f.projected, 700);
  assert.equal(f.remaining, 320);
  assert.equal(f.scheduledHoursRemaining, 12); // Kenji Thu 8 h + Ana 4 h (Kenji today is already clocked in)
  assert.equal(f.hasSchedule, true);
  assert.deepEqual(f.missingRates, []);
});

test("forecast: approved time off and missing rates", () => {
  const f = forecastPayroll({
    period: { start: "2026-11-23", end: "2026-11-29" },
    today: "2026-11-23",
    nowMinutes: 0,
    actual: [],
    scheduled: [sched("Ana", "2026-11-24", 540, 1020), sched("Lee", "2026-11-24", 540, 1020)],
    timeOff: [{ id: "t1", employeeId: "", employeeName: "Ana", start: "2026-11-24", end: "2026-11-24", reason: "", status: "approved", requestedBy: "owner", createdAt: "", decidedAt: null, decidedBy: null }],
    employees: [hourly("Ana", 15)],
    categories: [],
    rules,
  });
  assert.equal(f.paidSoFar, 0);
  assert.equal(f.projected, 0);
  assert.deepEqual(f.missingRates, ["Lee"]);
  assert.equal(f.scheduledHoursRemaining, 8);
});

test("forecast: today's late starters only count the rest of their shift", () => {
  const f = forecastPayroll({
    period: { start: "2026-11-23", end: "2026-11-29" },
    today: "2026-11-23",
    nowMinutes: 600, // 10:00, Ana was due at 9:00 and hasn't clocked in
    actual: [],
    scheduled: [sched("Ana", "2026-11-23", 540, 1020)],
    employees: [hourly("Ana", 10)],
    categories: [],
    rules,
  });
  assert.equal(f.projected, 70); // 10:00-17:00
});
