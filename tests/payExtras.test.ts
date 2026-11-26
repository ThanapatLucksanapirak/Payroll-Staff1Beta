// Pay extras: rate history, holidays, standing items, tips, advances, cash
// denominations, YTD, variance and the accounting journal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computePayroll } from "../shared/engine";
import { DEFAULT_RULES, timesheetDocSchema, type Category, type EmployeeConfig, type ManualEmployee, type Shift, type TimesheetDoc } from "../shared/schema";
import { docToMeta, rowToDoc } from "../shared/legacy";
import {
  type Advance, type DocPayExtras, type PayContext, advanceBalance, advanceSchedules, allocateCents, applyPayExtras, breakdownCash, cashPlan, commitRepayments,
  comparePeriods, computeTimesheet, emptyDocExtras, installmentOf, journalCsv, journalLines, recordRateChange, repaymentLines, reverseRepayments, skipRecurring,
  snapshotOf, splitTips, syncPayExtras, unskipRecurring, ytdCsv, ytdTotals, DEFAULT_DENOMINATIONS,
} from "../shared/payExtras";

let n = 0;
const sh = (employee: string, date: string, start = 600, end = 1260, extra: Partial<Shift> = {}): Shift => ({ id: `s${n++}`, employee, date, start, end, breakMinutes: 0, role: "", source: "csv", note: "", ...extra });
const emp = (name: string, extra: Partial<EmployeeConfig> = {}): EmployeeConfig => ({
  name, categoryId: "custom", payBasis: "day_rate", fullDayRate: 100, halfDayRate: 50, hourlyRate: 0, isNetPay: true,
  adjustments: {}, bonuses: [], deductions: [], excluded: false, note: "", paymentMethod: "default", splitCashAmount: 0, ...extra,
});
const manual = (id: string, name: string, extra: Partial<ManualEmployee> = {}): ManualEmployee => ({
  id, name, payMode: "lump_sum", lumpSum: 0, payDates: [], isNetPay: true, bonuses: [], deductions: [], excluded: false, categoryId: "custom", paymentMethod: "default", splitCashAmount: 0, ...extra,
});
const cats: Category[] = [{ id: "server", name: "Server", siteId: null, payBasis: "hourly", fullDayRate: 0, halfDayRate: 0, hourlyRate: 10, isNetPay: true }];
const x = (p: Partial<DocPayExtras>): DocPayExtras => ({ ...emptyDocExtras(), ...p });
const doc = (p: Partial<TimesheetDoc>): TimesheetDoc => ({
  siteId: "main", label: "", filename: "", source: "manual", status: "draft", notes: "", periodStart: "", periodEnd: "",
  rules: DEFAULT_RULES, shifts: [], employees: [], manualEmployees: [], ...p,
});

test("cents allocation always adds up exactly", () => {
  const m = allocateCents(100, [{ key: "a", w: 1 }, { key: "b", w: 1 }, { key: "c", w: 1 }]);
  assert.deepEqual([...m.values()], [33.34, 33.33, 33.33]);
  const m2 = allocateCents(10.01, [{ key: "a", w: 7.5 }, { key: "b", w: 2.25 }, { key: "c", w: 0.25 }]);
  assert.equal(Math.round([...m2.values()].reduce((s, v) => s + v, 0) * 100), 1001);
  assert.deepEqual([...allocateCents(5, [{ key: "a", w: 0 }, { key: "b", w: 0 }]).values()], [2.5, 2.5], "no weight → even split");
  assert.deepEqual([...allocateCents(0, [{ key: "a", w: 1 }]).values()], [0]);
});

test("no extras: the engine result comes back untouched", () => {
  const d = doc({ shifts: [sh("Ana", "2026-01-05")], employees: [emp("Ana")] });
  const base = computePayroll({ shifts: d.shifts, employees: d.employees, manualEmployees: [], categories: [], rules: d.rules });
  assert.equal(applyPayExtras(base, { employees: d.employees, manualEmployees: [], payExtras: undefined }), base);
  assert.equal(applyPayExtras(base, { employees: d.employees, manualEmployees: [], payExtras: emptyDocExtras() }), base);
  assert.deepEqual(computeTimesheet(d, []), base);
});

test("rate history: each day uses the rate in effect; no history = unchanged", () => {
  const shifts = [sh("Ana", "2026-01-05"), sh("Ana", "2026-01-06"), sh("Ana", "2026-01-07")];
  const plain = computePayroll({ shifts, employees: [emp("Ana", { fullDayRate: 120 })], manualEmployees: [], categories: [] });
  assert.equal(plain.employees[0].totalPay, 360);
  const withHist = computePayroll({
    shifts, manualEmployees: [], categories: [],
    employees: [emp("Ana", { fullDayRate: 120, rateHistory: [{ until: "2026-01-06", categoryId: "custom", payBasis: "day_rate", fullDayRate: 100, halfDayRate: 50, hourlyRate: 0 }] })],
  });
  assert.deepEqual(withHist.employees[0].days.map((d) => d.pay), [100, 120, 120]);
  assert.equal(withHist.employees[0].totalPay, 340);
  // Two segments: the earliest `until` after the day wins
  const two = computePayroll({
    shifts, manualEmployees: [], categories: [],
    employees: [emp("Ana", { fullDayRate: 120, rateHistory: [
      { until: "2026-01-07", categoryId: "custom", payBasis: "day_rate", fullDayRate: 110, halfDayRate: 55, hourlyRate: 0 },
      { until: "2026-01-06", categoryId: "custom", payBasis: "day_rate", fullDayRate: 100, halfDayRate: 50, hourlyRate: 0 },
    ] })],
  });
  assert.deepEqual(two.employees[0].days.map((d) => d.pay), [100, 110, 120]);
  // Hourly history, rounded to cents per day
  const hourly = computePayroll({
    shifts: [sh("Bo", "2026-01-05", 600, 1000), sh("Bo", "2026-01-06", 600, 1000)], manualEmployees: [], categories: [],
    employees: [emp("Bo", { payBasis: "hourly", hourlyRate: 15.55, rateHistory: [{ until: "2026-01-06", categoryId: "custom", payBasis: "hourly", fullDayRate: 0, halfDayRate: 0, hourlyRate: 13.33 }] })],
  });
  assert.deepEqual(hourly.employees[0].days.map((d) => d.pay), [88.87, 103.67]);
});

test("recording a rate change keeps the old rate until the effective date", () => {
  const r100 = { categoryId: "custom", payBasis: "day_rate" as const, fullDayRate: 100, halfDayRate: 50, hourlyRate: 0 };
  const r120 = { ...r100, fullDayRate: 120 };
  const r130 = { ...r100, fullDayRate: 130 };
  let h = recordRateChange(undefined, "Ana", null, r100, "2026-01-01");
  assert.deepEqual(h.history, [], "first save: effective since forever");
  h = recordRateChange(h, "Ana", r100, r100, "2026-02-01");
  assert.deepEqual(h.history, [], "same rate: nothing recorded");
  h = recordRateChange(h, "Ana", r100, r120, "2026-03-01");
  assert.deepEqual(h.history, [{ until: "2026-03-01", ...r100 }]);
  assert.equal(h.currentFrom, "2026-03-01");
  h = recordRateChange(h, "Ana", r120, r130, "2026-04-01");
  assert.deepEqual(h.history.map((s) => [s.until, s.fullDayRate]), [["2026-03-01", 100], ["2026-04-01", 120]]);
  // Back-dated correction replaces what came after it
  h = recordRateChange(h, "Ana", r130, r120, "2026-03-15");
  assert.deepEqual(h.history.map((s) => [s.until, s.fullDayRate]), [["2026-03-01", 100]]);
  h = recordRateChange(h, "Ana", r100, r120, "");
  assert.deepEqual(h.history.map((s) => s.until), ["2026-03-01"], "no date: no history change");
});

test("holiday premium: multiplier on the day's pay or a flat amount, shown as a day bonus", () => {
  const d = doc({
    shifts: [sh("Ana", "2026-07-03"), sh("Ana", "2026-07-04"), sh("Bo", "2026-07-04", 600, 900)],
    employees: [emp("Ana", { fullDayRate: 133.33 }), emp("Bo", { payBasis: "hourly", hourlyRate: 15 })],
    payExtras: x({ holidays: [{ id: "h1", date: "2026-07-04", name: "Independence Day", kind: "multiplier", multiplier: 1.5, flatBonus: 0 }] }),
  });
  const r = computeTimesheet(d, []);
  const ana = r.employees.find((e) => e.name === "Ana")!;
  assert.equal(ana.extras!.holiday, 66.67); // 133.33 × 0.5 = 66.665 → 66.67
  assert.equal(ana.totalPay, 333.33);
  assert.equal(ana.days.find((x) => x.date === "2026-07-04")!.bonuses[0].description, "Holiday premium · Independence Day (1.5×)");
  const bo = r.employees.find((e) => e.name === "Bo")!;
  assert.equal(bo.totalPay, 112.5);
  assert.equal(r.totals.holidayPremium, 104.17);
  assert.equal(r.totals.totalPay, 445.83);

  const flat = computeTimesheet({ ...d, payExtras: x({ holidays: [{ id: "h1", date: "2026-07-04", name: "July 4", kind: "flat", multiplier: 1.5, flatBonus: 25 }] }) }, []);
  assert.equal(flat.totals.holidayPremium, 50);
  // A cancelled day gets nothing
  const cancelled = computeTimesheet({ ...d, employees: [emp("Ana", { fullDayRate: 100, adjustments: { "2026-07-04": { cancelled: true } } }), emp("Bo", { excluded: true })] }, []);
  assert.equal(cancelled.employees.find((e) => e.name === "Ana")!.extras, undefined);
});

test("standing items: bonuses and deductions, removable per timesheet", () => {
  const base = doc({ shifts: [sh("Ana", "2026-01-05")], employees: [emp("Ana")], manualEmployees: [manual("m1", "Cleo", { lumpSum: 200 })] });
  const ctx: PayContext = {
    holidays: [], advances: [], rates: {}, tipPoints: {},
    recurring: [
      { id: "r1", employee: "ana", kind: "deduction", description: "Uniform", amount: 10, active: true },
      { id: "r2", employee: "Ana", kind: "bonus", description: "Attendance bonus", amount: 50, active: true },
      { id: "r3", employee: "Cleo", kind: "bonus", description: "Keys", amount: 5.555, active: true },
      { id: "r4", employee: "Ana", kind: "bonus", description: "Off", amount: 99, active: false },
      { id: "r5", employee: "Nobody", kind: "bonus", description: "Not here", amount: 99, active: true },
    ],
  };
  const synced = syncPayExtras(base, ctx, { start: "2026-01-05", end: "2026-01-05" });
  assert.deepEqual(synced.payExtras!.recurring.map((r) => r.sourceId), ["r1", "r2", "r3"]);
  assert.equal(synced.payExtras!.recurring[0].employee, "Ana", "display name from the timesheet");
  const r = computeTimesheet(synced, []);
  const ana = r.employees.find((e) => e.name === "Ana")!;
  assert.equal(ana.totalPay, 140);
  assert.deepEqual(ana.generalDeductions.map((d) => [d.description, d.amount]), [["Uniform", 10]]);
  assert.equal(r.employees.find((e) => e.name === "Cleo")!.totalPay, 205.56);
  assert.equal(r.totals.recurringBonuses, 55.56);
  assert.equal(r.totals.recurringDeductions, 10);

  const skipped = skipRecurring(synced, "r2");
  assert.equal(computeTimesheet(skipped, []).employees.find((e) => e.name === "Ana")!.totalPay, 90);
  const resynced = syncPayExtras(skipped, ctx, { start: "2026-01-05", end: "2026-01-05" });
  assert.ok(!resynced.payExtras!.recurring.some((r) => r.sourceId === "r2"), "a removed item stays removed");
  const back = syncPayExtras(unskipRecurring(resynced, "r2"), ctx, { start: "2026-01-05", end: "2026-01-05" });
  assert.ok(back.payExtras!.recurring.some((r) => r.sourceId === "r2"));
  assert.equal(syncPayExtras(back, ctx, { start: "2026-01-05", end: "2026-01-05" }), back, "already in sync: same object");
});

test("sync: holidays in the period only, rate history attached, no-op for plain docs", () => {
  const base = doc({ shifts: [sh("Ana", "2026-01-05"), sh("Ana", "2026-01-12")], employees: [emp("Ana"), emp("Gone")] });
  const empty: PayContext = { holidays: [], recurring: [], advances: [], rates: {}, tipPoints: {} };
  assert.equal(syncPayExtras(base, empty, { start: "2026-01-05", end: "2026-01-12" }), base);
  const ctx: PayContext = {
    ...empty,
    holidays: [
      { id: "a", date: "2025-12-25", name: "Xmas", kind: "multiplier", multiplier: 2, flatBonus: 0 },
      { id: "b", date: "2026-01-12", name: "Founders", kind: "flat", multiplier: 1.5, flatBonus: 20 },
    ],
    rates: { ana: [{ until: "2026-01-10", categoryId: "custom", payBasis: "day_rate", fullDayRate: 90, halfDayRate: 45, hourlyRate: 0 }, { until: "2025-06-01", categoryId: "custom", payBasis: "day_rate", fullDayRate: 80, halfDayRate: 40, hourlyRate: 0 }] },
  };
  const s = syncPayExtras(base, ctx, { start: "2026-01-05", end: "2026-01-12" });
  assert.deepEqual(s.payExtras!.holidays.map((h) => h.id), ["b"]);
  assert.deepEqual(s.employees[0].rateHistory!.map((h) => h.until), ["2026-01-10"], "segments that end before the period are dropped");
  assert.equal(s.employees[1].rateHistory, undefined);
  const r = computeTimesheet(s, []);
  assert.equal(r.employees[0].totalPay, 90 + 100 + 20);
  // Removing the history from settings removes it from the draft
  const s2 = syncPayExtras(s, empty, { start: "2026-01-05", end: "2026-01-12" });
  assert.equal(s2.employees[0].rateHistory, undefined);
  assert.equal(s2.payExtras!.holidays.length, 0);
});

test("tips: split by hours, by points, per day, with exact cents", () => {
  const employees = [emp("Ana", { categoryId: "server" }), emp("Bo", { payBasis: "hourly", hourlyRate: 12 }), emp("Cy", { excluded: true })];
  const shifts = [
    sh("Ana", "2026-01-05", 600, 1080), // 8 h
    sh("Bo", "2026-01-05", 600, 840), // 4 h
    sh("Bo", "2026-01-06", 600, 840), // 4 h
    sh("Cy", "2026-01-05", 600, 1080),
  ];
  const d = doc({ shifts, employees, manualEmployees: [manual("m", "Dee", { lumpSum: 50 })] });
  const byHours = computeTimesheet({ ...d, payExtras: x({ tips: { mode: "total", total: 100, perDay: {}, split: "hours", points: {} } }) }, cats);
  const tip = (r: typeof byHours, name: string) => r.employees.find((e) => e.name === name)!.extras?.tips ?? 0;
  assert.equal(tip(byHours, "Ana"), 50);
  assert.equal(tip(byHours, "Bo"), 50);
  assert.equal(tip(byHours, "Cy"), 0, "left-out people get no tips");
  assert.equal(tip(byHours, "Dee"), 0, "manual people get no tips");
  assert.equal(byHours.totals.tips, 100);
  const ana = byHours.employees.find((e) => e.name === "Ana")!;
  assert.equal(ana.totalPay, 80 + 50, "tips are added to pay");
  assert.ok(ana.generalBonuses.some((b) => b.description === "Tips" && b.amount === 50));

  const byPoints = computeTimesheet({ ...d, payExtras: x({ tips: { mode: "total", total: 100, perDay: {}, split: "points", points: { server: 2, custom: 1 } } }) }, cats);
  assert.equal(tip(byPoints, "Ana"), 66.67); // 8×2 : 8×1
  assert.equal(tip(byPoints, "Bo"), 33.33);

  const perDay = computeTimesheet({ ...d, payExtras: x({ tips: { mode: "per_day", total: 0, perDay: { "2026-01-05": 30.01, "2026-01-06": 10, "2026-01-07": 5 }, split: "hours", points: {} } }) }, cats);
  assert.equal(tip(perDay, "Ana"), 20.01); // 8/12 of 30.01 = 20.0066 → largest remainder
  assert.equal(tip(perDay, "Bo"), 10 + 10);
  assert.equal(perDay.totals.tips, 40.01);
  assert.ok(perDay.warnings.some((w) => /2026-01-07/.test(w.message)), "a day nobody worked is flagged");

  const shares = splitTips(byHours.employees, { mode: "total", total: 0.01, perDay: {}, split: "hours", points: {} }, new Map());
  assert.equal([...shares.shares.values()].reduce((s, v) => s + v, 0), 0.01);
});

test("advances: installments, never more than pay, commit and reverse", () => {
  const adv = (p: Partial<Advance>): Advance => ({ id: "a1", employee: "Ana", amount: 100, date: "2026-01-01", mode: "periods", perPeriod: 0, periods: 3, note: "", createdAt: "", createdBy: "", cancelledAt: null, repayments: [], ...p });
  assert.equal(installmentOf(adv({})), 33.34);
  assert.equal(installmentOf(adv({ mode: "per_period", perPeriod: 25 })), 25);
  assert.equal(installmentOf(adv({ mode: "per_period", perPeriod: 0 })), 100);

  let ledger = [adv({}), adv({ id: "a2", employee: "Bo", amount: 500, mode: "per_period", perPeriod: 400, date: "2026-02-01" })];
  const d = doc({ shifts: [sh("Ana", "2026-01-05"), sh("Bo", "2026-01-05", 600, 900)], employees: [emp("Ana"), emp("Bo")] });
  const ctx = (): PayContext => ({ holidays: [], recurring: [], rates: {}, tipPoints: {}, advances: advanceSchedules(ledger, "ts1") });
  const synced = syncPayExtras(d, ctx(), { start: "2026-01-05", end: "2026-01-05" });
  assert.deepEqual(synced.payExtras!.advances.map((a) => [a.advanceId, a.scheduled]), [["a1", 33.34]], "an advance dated after the period waits");
  const r = computeTimesheet(synced, []);
  assert.equal(r.employees.find((e) => e.name === "Ana")!.totalPay, 66.66);
  assert.equal(r.totals.advanceRepayments, 33.34);

  // Capped at what the person earns
  const big = computeTimesheet({ ...synced, payExtras: x({ advances: [{ advanceId: "a2", employee: "Bo", description: "Advance repayment", scheduled: 400, remaining: 500 }] }) }, []);
  const bo = big.employees.find((e) => e.name === "Bo")!;
  assert.equal(bo.totalPay, 0);
  assert.equal(bo.extras!.advance, 50);

  ledger = commitRepayments(ledger, "ts1", "2026-01-05", repaymentLines(r), "now");
  assert.deepEqual(advanceBalance(ledger[0]), { repaid: 33.34, remaining: 66.66 });
  ledger = commitRepayments(ledger, "ts1", "2026-01-05", repaymentLines(r), "again");
  assert.equal(ledger[0].repayments.length, 1, "committing twice is idempotent");
  assert.equal(advanceSchedules(ledger, "ts1")[0].remaining, 100, "the same timesheet sees its own repayment as not taken");
  assert.equal(advanceSchedules(ledger, "ts2")[0].remaining, 66.66);
  ledger = commitRepayments(ledger, "ts2", "", [{ advanceId: "a1", amount: 33.34 }], "");
  ledger = commitRepayments(ledger, "ts3", "", [{ advanceId: "a1", amount: 50 }], "");
  assert.deepEqual(advanceBalance(ledger[0]), { repaid: 100, remaining: 0 }, "the last installment is capped at the balance");
  assert.equal(ledger[0].repayments.at(-1)!.amount, 33.32);
  assert.equal(advanceSchedules(ledger).some((a) => a.advanceId === "a1"), false);
  ledger = reverseRepayments(ledger, "ts2");
  assert.deepEqual(advanceBalance(ledger[0]), { repaid: 66.66, remaining: 33.34 });
  assert.equal(advanceBalance({ ...ledger[0], cancelledAt: "x" }).remaining, 0, "written off");
});

test("payment split follows the extras", () => {
  const d = doc({
    shifts: [sh("Ana", "2026-01-05")],
    employees: [emp("Ana", { paymentMethod: "split", splitCashAmount: 60 })],
    payExtras: x({ tips: { mode: "total", total: 20, perDay: {}, split: "hours", points: {} } }),
  });
  const r = computeTimesheet(d, []);
  assert.deepEqual(r.employees[0].payment, { method: "split", cash: 60, bank: 60, check: 0 });
  assert.equal(r.totals.cash, 60);
  assert.equal(r.totals.bank, 60);
});

test("payExtras round-trips through storage and old rows have none", () => {
  const d = doc({ siteId: "main", shifts: [sh("Ana", "2026-01-05")], employees: [emp("Ana", { rateHistory: [{ until: "2026-01-02", categoryId: "custom", payBasis: "day_rate", fullDayRate: 1, halfDayRate: 1, hourlyRate: 0 }] })], payExtras: x({ tips: { mode: "total", total: 5, perDay: {}, split: "hours", points: {} } }) });
  const parsed = timesheetDocSchema.parse(JSON.parse(JSON.stringify(d)));
  assert.deepEqual(parsed.payExtras, d.payExtras);
  const back = rowToDoc({ wages_json: parsed.employees, manual_employees_json: [], meta_json: docToMeta(parsed) }, { defaultSiteId: "main", rules: DEFAULT_RULES });
  assert.deepEqual(back.payExtras, d.payExtras);
  assert.equal(back.employees[0].rateHistory?.length, 1);
  const old = rowToDoc({ wages_json: [], manual_employees_json: [], meta_json: { version: 2, shifts: [] } }, { defaultSiteId: "main", rules: DEFAULT_RULES });
  assert.equal("payExtras" in old, false);
  assert.equal("payExtras" in docToMeta(old), false);
});

test("cash denominations: per person, totals, rounding, odd sets", () => {
  assert.deepEqual(breakdownCash(187.41, DEFAULT_DENOMINATIONS).counts, [
    { value: 100, count: 1 }, { value: 50, count: 1 }, { value: 20, count: 1 }, { value: 10, count: 1 }, { value: 5, count: 1 }, { value: 1, count: 2 },
    { value: 0.25, count: 1 }, { value: 0.1, count: 1 }, { value: 0.05, count: 1 }, { value: 0.01, count: 1 },
  ]);
  assert.deepEqual(breakdownCash(60, [50, 20]), { counts: [{ value: 20, count: 3 }], leftover: 0 }, "greedy would fail; exact change is found");
  assert.deepEqual(breakdownCash(7, [5, 2]).leftover, 0);
  assert.equal(breakdownCash(3, [5, 2]).leftover, 1, "impossible amounts are reported, not invented");
  const plan = cashPlan([{ name: "Ana", cash: 120.6 }, { name: "Bo", cash: 49.4 }, { name: "Cy", cash: 0 }], { denominations: DEFAULT_DENOMINATIONS, roundCash: false });
  assert.equal(plan.rows.length, 2);
  assert.equal(plan.total, 170);
  assert.equal(plan.rounding, 0);
  const rounded = cashPlan([{ name: "Ana", cash: 120.6 }, { name: "Bo", cash: 49.4 }, { name: "Cy", cash: 10.5 }], { denominations: [1000, 500, 100, 50, 20], roundCash: true });
  assert.deepEqual(rounded.rows.map((r) => r.amount), [121, 49, 11]);
  assert.equal(rounded.rounding, 0.5);
  assert.equal(rounded.leftover, 1 + 9 + 11, "bills only: what the notes can't cover is left over");
  const tot = cashPlan([{ name: "A", cash: 40 }, { name: "B", cash: 25 }], { denominations: [20, 5, 1], roundCash: false }).totals;
  assert.deepEqual(tot, [{ value: 20, count: 3 }, { value: 5, count: 1 }]);
});

test("YTD totals and CSV", () => {
  const r1 = computeTimesheet(doc({ shifts: [sh("Ana", "2026-01-05")], employees: [emp("Ana", { deductions: [{ description: "x", amount: 10 }] })], payExtras: x({ tips: { mode: "total", total: 15.5, perDay: {}, split: "hours", points: {} } }) }), []);
  const r2 = computeTimesheet(doc({ shifts: [sh("ana", "2026-02-05"), sh("Bo", "2026-02-05")], employees: [emp("Ana"), emp("Bo", { excluded: true })] }), []);
  const rows = ytdTotals([r1, r2]);
  assert.deepEqual(rows, [{ key: "ana", name: "Ana", gross: 215.5, deductions: 10, net: 205.5, tips: 15.5, timesheets: 2 }]);
  const csv = ytdCsv(rows, 2026);
  assert.equal(csv.split("\r\n")[1], "Ana,2026,2,215.50,10.00,205.50,15.50");
  assert.equal(ytdCsv([{ ...rows[0], name: "=cmd" }], 2026).split("\r\n")[1].startsWith("'=cmd"), true, "formula-looking names are neutralized");
});

test("period over period variance names the drivers", () => {
  const v = comparePeriods(
    { totalPay: 1180, employees: [{ name: "Ana", totalPay: 600 }, { name: "Bo", totalPay: 400 }, { name: "Dee", totalPay: 180 }] },
    { totalPay: 1000, employees: [{ name: "ana", totalPay: 500 }, { name: "Bo", totalPay: 420 }, { name: "Cy", totalPay: 80 }] },
  );
  assert.equal(v.pct, 18);
  assert.equal(v.diff, 180);
  assert.deepEqual(v.drivers.map((d) => [d.name, d.diff]), [["Dee", 180], ["Ana", 100]], "only people moving the same way, biggest first");
  assert.equal(comparePeriods({ totalPay: 10, employees: [] }, { totalPay: 0, employees: [] }).pct, null);
  const r = computeTimesheet(doc({ shifts: [sh("Ana", "2026-01-05")], employees: [emp("Ana"), emp("Bo", { excluded: true })] }), []);
  assert.deepEqual(snapshotOf(r), { totalPay: 100, employees: [{ name: "Ana", totalPay: 100 }] });
});

test("accounting journal balances, to the cent", () => {
  const d = doc({
    shifts: [sh("Ana", "2026-01-05"), sh("Bo", "2026-01-05"), sh("Cy", "2026-01-05", 600, 900)],
    employees: [
      emp("Ana", { paymentMethod: "cash", fullDayRate: 100.01 }),
      emp("Bo", { paymentMethod: "split", splitCashAmount: 30 }),
      emp("Cy", { paymentMethod: "check", deductions: [{ description: "Meal", amount: 30 }] }),
    ],
    payExtras: x({
      tips: { mode: "total", total: 33.33, perDay: {}, split: "hours", points: {} },
      advances: [{ advanceId: "a", employee: "Ana", description: "Advance repayment", scheduled: 20, remaining: 50 }],
      recurring: [{ sourceId: "r", employee: "Bo", kind: "deduction", description: "Uniform", amount: 10 }],
    }),
  });
  const r = computeTimesheet(d, []);
  const lines = journalLines(r, {}, "Week 1");
  const dr = lines.reduce((s, l) => s + Math.round(l.debit * 100), 0);
  const cr = lines.reduce((s, l) => s + Math.round(l.credit * 100), 0);
  assert.equal(dr, cr);
  const by = Object.fromEntries(lines.map((l) => [l.account, l]));
  assert.equal(by["Tips payable"].debit, 33.33);
  assert.equal(by["Employee advances"].credit, 20);
  assert.equal(by["Payroll deductions"].credit, 40);
  assert.equal(by["Cash on hand"].credit, r.totals.cash);
  assert.ok(!by["Payroll clearing"], "balanced without a clearing line");

  // Someone owing money (negative pay) goes to clearing
  const neg = computeTimesheet(doc({ shifts: [sh("Ana", "2026-01-05", 600, 900)], employees: [emp("Ana", { deductions: [{ description: "Loan", amount: 80 }] })] }), []);
  const nl = journalLines(neg, { clearing: "Owed by staff" }, "");
  assert.equal(nl.find((l) => l.account === "Owed by staff")!.debit, 30);
  const csv = journalCsv(r, { dateStyle: "DD/MM/YYYY", journalPrefix: "PAY-" }, { date: "2026-01-11", memo: "Week 1" });
  const rows = csv.split("\r\n");
  assert.equal(rows[0], "Journal No,Date,Account,Debit,Credit,Memo");
  assert.ok(rows[1].startsWith("PAY-20260111,11/01/2026,Wages expense,"));
});
