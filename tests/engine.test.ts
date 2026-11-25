import test from "node:test";
import assert from "node:assert/strict";
import { computePayroll } from "../shared/engine";
import { DEFAULT_RULES, type EmployeeConfig, type Shift } from "../shared/schema";
import { parseDateToISO, parseTimeToMinutes, formatDate, instantToLocal, localToInstant } from "../shared/dates";

const rules = { ...DEFAULT_RULES, clockInCutoff: 720, clockOutCutoff: 1200 };
const emp = (name: string, extra: Partial<EmployeeConfig> = {}): EmployeeConfig => ({
  name, categoryId: "custom", payBasis: "day_rate", fullDayRate: 200, halfDayRate: 100, hourlyRate: 0, isNetPay: false,
  adjustments: {}, bonuses: [], deductions: [], excluded: false, note: "", ...extra,
});
let n = 0;
const sh = (employee: string, date: string, start: number, end: number, extra: Partial<Shift> = {}): Shift => ({
  id: `t${n++}`, employee, date, start, end, breakMinutes: 0, role: "", source: "csv", note: "", ...extra,
});

test("dates parse and sort as ISO", () => {
  assert.equal(parseDateToISO("10/9/26"), "2026-10-09");
  assert.equal(parseDateToISO("10/10/2026"), "2026-10-10");
  assert.equal(parseDateToISO("Nov 3, 2026"), "2026-11-03");
  assert.equal(parseDateToISO("Mon, Nov 3", { defaultYear: 2026 }), "2026-11-03");
  assert.ok("2026-10-09" < "2026-10-10");
  assert.equal(formatDate("2026-11-03", "M/D/YY"), "11/3/26");
  assert.equal(parseTimeToMinutes("10:09:00 AM"), 609);
  assert.equal(parseTimeToMinutes("12:15 AM"), 15);
  assert.equal(parseTimeToMinutes("9p"), 21 * 60);
  assert.equal(parseTimeToMinutes("22:15"), 1335);
});

test("time zone conversion round-trips across DST", () => {
  const i = localToInstant("2026-11-01", 0, "America/New_York");
  assert.equal(i, "2026-11-01T04:00:00.000Z");
  assert.deepEqual(instantToLocal("2026-11-02T15:30:00Z", "America/New_York"), { date: "2026-11-02", minutes: 630 });
});

test("cutoff classification matches v1 rules (strict clock-in)", () => {
  const r = computePayroll({
    shifts: [sh("A", "2026-11-02", 600, 1230), sh("A", "2026-11-03", 720, 1230), sh("A", "2026-11-04", 600, 1100), sh("A", "2026-11-05", 750, 1100)],
    employees: [emp("A")], manualEmployees: [], categories: [], rules,
  });
  const d = r.employees[0].days.map((x) => x.dayType);
  assert.deepEqual(d, ["full_day", "half_day", "half_day", "flagged"]);
  assert.equal(r.employees[0].totalPay, 400);
});

test("overnight shift counts as staying late", () => {
  const r = computePayroll({ shifts: [sh("B", "2026-11-02", 600, 1440 + 60)], employees: [emp("B")], manualEmployees: [], categories: [], rules });
  assert.equal(r.employees[0].days[0].dayType, "full_day");
  assert.equal(r.employees[0].days[0].clockOut, "1:00 AM");
});

test("split shifts on one day are merged, not double-paid", () => {
  const r = computePayroll({ shifts: [sh("C", "2026-11-02", 600, 840), sh("C", "2026-11-02", 960, 1250)], employees: [emp("C")], manualEmployees: [], categories: [], rules });
  assert.equal(r.employees[0].days.length, 1);
  assert.equal(r.employees[0].days[0].punches, 2);
  assert.equal(r.employees[0].totalPay, 200);
});

test("adjustments, bonuses and deductions are applied once", () => {
  const r = computePayroll({
    shifts: [sh("D", "2026-11-02", 600, 1250), sh("D", "2026-11-03", 600, 1250)],
    employees: [emp("D", {
      adjustments: { "2026-11-02": { dockAmount: 50 }, "2026-11-03": { cancelled: true } },
      bonuses: [{ date: "2026-11-02", description: "Tips", amount: 30 }, { date: "", description: "Holiday", amount: 20 }, { date: "11/9/26", description: "Bonus day", amount: 10 }],
      deductions: [{ description: "Advance", amount: 25 }],
    })], manualEmployees: [], categories: [], rules,
  });
  const e = r.employees[0];
  assert.equal(e.totalBasePay, 150);
  assert.equal(e.totalBonuses, 60);
  assert.equal(e.totalDeductions, 25);
  assert.equal(e.totalPay, 185);
  assert.equal(e.days.find((d) => d.date === "2026-11-09")?.notes, "Bonus only");
});

test("hourly pay with weekly overtime", () => {
  const shifts = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"].map((d) => sh("E", d, 540, 540 + 9 * 60));
  const r = computePayroll({
    shifts, employees: [emp("E", { payBasis: "hourly", hourlyRate: 20 })], manualEmployees: [], categories: [],
    rules: { ...rules, overtimeEnabled: true, overtimeWeeklyHours: 40, overtimeMultiplier: 1.5 },
  });
  assert.equal(r.employees[0].hoursWorked, 45);
  assert.equal(r.employees[0].overtimeHours, 5);
  assert.equal(r.employees[0].totalPay, 40 * 20 + 5 * 30);
});

test("hours-based classification and flagged-day pay option", () => {
  const r = computePayroll({
    shifts: [sh("F", "2026-11-02", 600, 600 + 8 * 60), sh("F", "2026-11-03", 600, 600 + 5 * 60), sh("F", "2026-11-04", 600, 600 + 2 * 60)],
    employees: [emp("F")], manualEmployees: [], categories: [],
    rules: { ...rules, classificationMethod: "hours", fullDayMinHours: 8, halfDayMinHours: 4, flaggedDayPay: "half" },
  });
  assert.deepEqual(r.employees[0].days.map((d) => d.dayType), ["full_day", "half_day", "flagged"]);
  assert.equal(r.employees[0].totalPay, 400);
});

test("categories and manual employees; excluded employees leave totals", () => {
  const r = computePayroll({
    shifts: [sh("G", "2026-11-02", 600, 1250), sh("H", "2026-11-02", 600, 1250)],
    employees: [emp("G", { categoryId: "c1" }), emp("H", { excluded: true })],
    manualEmployees: [{ id: "m1", name: "Zoey", payMode: "lump_sum", lumpSum: 90, payDates: [], isNetPay: true, bonuses: [], deductions: [], excluded: false, categoryId: "custom" }],
    categories: [{ id: "c1", name: "Chef", siteId: null, payBasis: "day_rate", fullDayRate: 250, halfDayRate: 100, hourlyRate: 0, isNetPay: true }],
    rules,
  });
  assert.equal(r.employees.find((e) => e.name === "G")?.totalPay, 250);
  assert.equal(r.totals.totalPay, 340);
  assert.equal(r.totals.employees, 2);
});

test("weekday overrides and grace minutes", () => {
  // 2026-11-07 is a Saturday: later opening
  const r = computePayroll({
    shifts: [sh("I", "2026-11-07", 770, 1300), sh("I", "2026-11-06", 725, 1300)],
    employees: [emp("I")], manualEmployees: [], categories: [],
    rules: { ...rules, graceMinutes: 10, weekdayOverrides: { "6": { clockInCutoff: 780, clockOutCutoff: 1260 } } },
  });
  assert.deepEqual(r.employees[0].days.map((d) => d.dayType), ["full_day", "full_day"]);
});
