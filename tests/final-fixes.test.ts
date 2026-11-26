// Fixes from the final stress test: CSV formulas, day-first imports, pay
// redaction of YTD and tips, and finalized timesheets keeping what was paid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsvText, shiftsToCsv } from "../shared/importers/csv";
import { computeTimesheet, ytdCsv } from "../shared/payExtras";
import { rowToDoc } from "../shared/legacy";
import { DEFAULT_RULES, type Shift, type TimesheetDoc } from "../shared/schema";

const sh = (p: Partial<Shift>): Shift => ({ id: "s1", employee: "Ana", date: "2026-11-03", start: 540, end: 1020, breakMinutes: 0, role: "", source: "csv", note: "", ...p });

test("YTD CSV neutralizes formulas", () => {
  const csv = ytdCsv([{ key: "x", name: "=cmd|' /C calc'!A0", gross: 1, deductions: 0, net: 1, tips: 0, timesheets: 1 }], 2026);
  assert.ok(csv.includes("'=cmd"));
});

test("Shifts CSV neutralizes the Shift ID and reads it back", () => {
  const csv = shiftsToCsv([sh({ id: "=HYPERLINK(1)" })]);
  assert.ok(csv.includes("'=HYPERLINK(1)"));
  assert.equal(parseCsvText(csv).shifts[0].id, "=HYPERLINK(1)");
});

test("day-first preference doesn't swap dates in the app's own CSV or Square files", () => {
  const own = shiftsToCsv([sh({ date: "2026-11-03" })]);
  assert.equal(parseCsvText(own, { dayFirst: true }).shifts[0].date, "2026-11-03");
  const sq = "Team Member,Clockin date,Clockin time,Clockout time\nAna,1/11/26,9:00:00 AM,5:00:00 PM\n";
  assert.equal(parseCsvText(sq, { dayFirst: true }).shifts[0].date, "2026-01-11");
  // Other files still follow the preference
  const other = "Employee,Date,Clock In,Clock Out\nAna,1/11/26,9:00 AM,5:00 PM\n";
  assert.equal(parseCsvText(other, { dayFirst: true }).shifts[0].date, "2026-11-01");
});

test("pay redaction hides YTD gross/net/deductions and the tips pool", async () => {
  const { redactMoney } = await import("../server/permissions");
  const out: any = redactMoney({ rows: [{ name: "A", gross: 5, net: 4, deductions: 1, tips: 2, timesheets: 1 }], doc: { payExtras: { tips: { mode: "per_day", total: 100, perDay: { "2026-11-01": 40 }, points: { a: 2 } } } } });
  assert.deepEqual(out.rows[0], { name: "A", gross: 0, net: 0, deductions: 0, tips: 0, timesheets: 1 });
  assert.equal(out.doc.payExtras.tips.total, 0);
  assert.equal(out.doc.payExtras.tips.perDay["2026-11-01"], 0);
  assert.equal(out.doc.payExtras.tips.points.a, 2);
});

test("a finalized timesheet shows the totals it was paid with", () => {
  const doc: TimesheetDoc = {
    siteId: "main", label: "", filename: "", source: "manual", status: "final", notes: "", periodStart: "", periodEnd: "",
    rules: DEFAULT_RULES, shifts: [sh({})], manualEmployees: [],
    employees: [{ name: "Ana", categoryId: "custom", payBasis: "day_rate", fullDayRate: 100, halfDayRate: 50, hourlyRate: 0, isNetPay: true, adjustments: {}, bonuses: [], deductions: [], excluded: false, note: "", paymentMethod: "default", splitCashAmount: 0 } as any],
  };
  const now = computeTimesheet(doc, []);
  const paidEmp = { ...now.employees[0], totalPay: 150 };
  const row = { id: "t", filename: "", custom_label: "", period_start: now.periodStart, period_end: now.periodEnd, employee_count: 1, total_pay: 150, wages_json: doc.employees, manual_employees_json: [], csv_data: "", site_id: "main",
    result_json: { periodStart: now.periodStart, periodEnd: now.periodEnd, employees: [paidEmp], totals: { ...now.totals, totalPay: 150 } },
    meta_json: { version: 2, siteId: "main", status: "final", shifts: doc.shifts, rules: DEFAULT_RULES } } as any;
  const loaded = rowToDoc(row, { defaultSiteId: "main", rules: DEFAULT_RULES });
  const r = computeTimesheet(loaded, []);
  assert.equal(r.totals.totalPay, 150);
  assert.equal(r.employees[0].totalPay, 150);
  assert.ok(r.warnings.some((w) => /finalized/.test(w.message)));
  // Reopened (draft) recalculates
  assert.equal(computeTimesheet({ ...loaded, status: "draft" }, []).totals.totalPay, now.totals.totalPay);
});
