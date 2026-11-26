// First-time user fixes: sensible default pay basis, flagged-day wording that
// matches how hourly and day-rate staff are paid.
import test from "node:test";
import assert from "node:assert/strict";
import { computePayroll } from "../shared/engine";
import { DEFAULT_RULES, employeeConfigSchema, type Shift } from "../shared/schema";
import { timesheetChecklist } from "../shared/payrollChecklist";
import { defaultPayBasis, newDoc, syncEmployees } from "../client/src/lib/doc";
import { site as makeSite } from "./pdf-fixture";
import { hoursView } from "../client/src/portal/format";

const site = makeSite();

const shift = (employee: string, date: string, start: number, end: number): Shift => ({ id: `${employee}-${date}`, employee, date, start, end, breakMinutes: 0, role: "", source: "csv", note: "" });
const cfg = (name: string, payBasis: "hourly" | "day_rate", rate = 10) => employeeConfigSchema.parse({ name, payBasis, hourlyRate: payBasis === "hourly" ? rate : 0, fullDayRate: payBasis === "day_rate" ? rate : 0 });

test("new people default to Hourly, so a fresh upload isn't Day rate with blank boxes", () => {
  const doc = newDoc(site, [shift("Ana Ruiz", "2026-01-05", 540, 1020), shift("Ben Lee", "2026-01-05", 540, 1020)], { source: "csv", filename: "x.csv" });
  assert.deepEqual(doc.employees.map((e) => e.payBasis), ["hourly", "hourly"]);
});

test("the default follows what most people here already use", () => {
  assert.equal(defaultPayBasis([]), "hourly");
  assert.equal(defaultPayBasis([cfg("A", "day_rate"), cfg("B", "day_rate"), cfg("C", "hourly")]), "day_rate");
  assert.equal(defaultPayBasis([cfg("A", "day_rate"), cfg("B", "hourly")]), "hourly", "a tie goes to Hourly");
  assert.equal(defaultPayBasis([cfg("A", "day_rate", 0)]), "hourly", "people with no rate yet don't count");
  // A business on day rates: someone new joins with the day-rate default; saved people keep their own.
  const out = syncEmployees([shift("New Person", "2026-01-05", 540, 1020), shift("A", "2026-01-05", 540, 1020)], [], site, [cfg("A", "day_rate"), cfg("B", "day_rate")]);
  assert.equal(out.find((e) => e.name === "New Person")!.payBasis, "day_rate");
  assert.equal(out.find((e) => e.name === "A")!.fullDayRate, 10);
});

test("flagged days: hourly staff are paid for the hours, and the checklist says so", () => {
  // A one-hour shift is flagged under the default rules.
  const shifts = [shift("Ana Ruiz", "2026-01-05", 13 * 60, 14 * 60), shift("Ben Lee", "2026-01-05", 13 * 60, 14 * 60)];
  const employees = [cfg("Ana Ruiz", "hourly", 20), cfg("Ben Lee", "day_rate", 100)];
  const result = computePayroll({ shifts, employees, manualEmployees: [], categories: [], rules: { ...DEFAULT_RULES, flaggedDayPay: "none" } });
  const ana = result.employees.find((e) => e.name === "Ana Ruiz")!;
  const ben = result.employees.find((e) => e.name === "Ben Lee")!;
  assert.equal(ana.flaggedDays, 1);
  assert.equal(ana.totalPay, 20, "hourly: the flagged hour is paid");
  assert.equal(ben.totalPay, 0, "day rate: flagged pays nothing under this rule");
  const item = timesheetChecklist(result).find((i) => i.id === "flagged")!;
  assert.equal(item.count, 2);
  assert.match(item.detail, /Day rate: Ben Lee\. Open a day on the Payroll tab/);
  assert.match(item.detail, /Hourly: Ana Ruiz\. Hourly staff are paid for the hours worked/);
  assert.doesNotMatch(item.detail, /Decide how to pay/);
});

test("portal My hours: the no-time-clock note never sits above hours", () => {
  const sheet = { minutes: 660 };
  assert.deepEqual(hoursView({ days: [], timesheets: [sheet] }, false), { fromSheets: true, sheetMinutes: 660, noClockNote: false }, "statement hours shown, no note");
  assert.equal(hoursView({ days: [], timesheets: [] }, false).noClockNote, true, "nothing to show: the note explains why");
  assert.equal(hoursView({ days: [{}] }, false).noClockNote, false, "time-clock days shown (location switched to Square later)");
  assert.equal(hoursView({ days: [] }, true).noClockNote, false, "uses the time clock: the empty text covers it");
  assert.equal(hoursView({ days: [{}], timesheets: [sheet] }, true).fromSheets, false, "time-clock days win over statement hours");
});
