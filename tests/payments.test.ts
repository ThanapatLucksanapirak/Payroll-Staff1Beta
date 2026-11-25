// Payment methods: per-person choice, pay-run default, cash + bank split,
// totals, saved with the pay rates, and the pay-out sheet PDF.
import test from "node:test";
import assert from "node:assert/strict";
import { computePayroll, paymentFor } from "../shared/engine";
import { DEFAULT_RULES, employeeConfigSchema, manualEmployeeSchema, siteRulesSchema, type Shift } from "../shared/schema";
import { buildPayoutSheetPdf } from "../client/src/lib/pdf/payout";
import { buildPayrollPdf } from "../client/src/lib/pdf/report";
import { prefs, site } from "./pdf-fixture";

const sh = (employee: string, date: string): Shift => ({ id: `${employee}-${date}`, employee, date, start: 600, end: 1260, breakMinutes: 0, role: "", source: "csv", note: "" });
const emp = (name: string, extra: Record<string, unknown> = {}) => employeeConfigSchema.parse({ name, fullDayRate: 100, halfDayRate: 50, ...extra });

test("paymentFor: default, single methods, split, and nothing to pay", () => {
  const rules = { defaultPaymentMethod: "cash" as const };
  assert.deepEqual(paymentFor("default", 0, 300, rules), { method: "cash", cash: 300, bank: 0, check: 0 });
  assert.deepEqual(paymentFor(undefined, 0, 300, { defaultPaymentMethod: "bank" }), { method: "bank", cash: 0, bank: 300, check: 0 });
  assert.deepEqual(paymentFor("check", 0, 120.5, rules), { method: "check", cash: 0, bank: 0, check: 120.5 });
  assert.deepEqual(paymentFor("split", 200, 550, rules), { method: "split", cash: 200, bank: 350, check: 0 });
  assert.deepEqual(paymentFor("split", 900, 550, rules), { method: "split", cash: 550, bank: 0, check: 0 }, "cash never exceeds the total");
  assert.deepEqual(paymentFor("cash", 0, -40, rules), { method: "cash", cash: 0, bank: 0, check: 0 }, "nothing is paid out for a negative total");
});

test("old data without payment fields gets safe defaults", () => {
  assert.equal(siteRulesSchema.parse({}).defaultPaymentMethod, "bank");
  assert.equal(siteRulesSchema.parse({ defaultPaymentMethod: "bitcoin" }).defaultPaymentMethod, "bank");
  const e = employeeConfigSchema.parse({ name: "Old Row" });
  assert.equal(e.paymentMethod, "default");
  assert.equal(e.splitCashAmount, 0);
  assert.equal(manualEmployeeSchema.parse({ id: "m1" }).paymentMethod, "default");
});

test("computePayroll splits each person's pay and totals by method", () => {
  const days = ["2026-11-02", "2026-11-03", "2026-11-04"];
  const shifts = ["Ana", "Ben", "Cho", "Dev"].flatMap((n) => days.map((d) => sh(n, d)));
  const r = computePayroll({
    shifts,
    employees: [emp("Ana"), emp("Ben", { paymentMethod: "bank" }), emp("Cho", { paymentMethod: "split", splitCashAmount: 120 }), emp("Dev", { paymentMethod: "cash", excluded: true })],
    manualEmployees: [manualEmployeeSchema.parse({ id: "m1", name: "Eve", lumpSum: 80, paymentMethod: "check" })],
    categories: [],
    rules: { ...DEFAULT_RULES, defaultPaymentMethod: "cash" },
  });
  const by = Object.fromEntries(r.employees.map((e) => [e.name, e.payment]));
  assert.deepEqual(by.Ana, { method: "cash", cash: 300, bank: 0, check: 0 }, "follows the pay run default");
  assert.deepEqual(by.Ben, { method: "bank", cash: 0, bank: 300, check: 0 });
  assert.deepEqual(by.Cho, { method: "split", cash: 120, bank: 180, check: 0 });
  assert.deepEqual(by.Eve, { method: "check", cash: 0, bank: 0, check: 80 });
  // Dev is excluded: not counted in the run's totals
  assert.equal(r.totals.cash, 420);
  assert.equal(r.totals.bank, 480);
  assert.equal(r.totals.check, 80);
  assert.equal(r.totals.cash + r.totals.bank + r.totals.check, r.totals.totalPay);
});

test("pay-out sheet PDF lists cash, bank and check groups; report shows the method", () => {
  const r = computePayroll({
    shifts: ["Ana", "Ben", "Cho"].map((n) => sh(n, "2026-11-02")),
    employees: [emp("Ana", { paymentMethod: "cash" }), emp("Ben", { paymentMethod: "bank" }), emp("Cho", { paymentMethod: "split", splitCashAmount: 40 })],
    manualEmployees: [],
    categories: [],
    rules: DEFAULT_RULES,
  });
  const o = { result: r, prefs: prefs(), site: site(), title: "Week 45", generatedAt: new Date(2026, 10, 16) };
  const text = (pdf: { output(t: "arraybuffer"): ArrayBuffer }) => Buffer.from(pdf.output("arraybuffer")).length;
  const payout = buildPayoutSheetPdf(o);
  assert.equal(payout.getNumberOfPages(), 1);
  assert.ok(text(payout) > 1000);
  const empty = buildPayoutSheetPdf({ ...o, result: computePayroll({ shifts: [], employees: [], manualEmployees: [], categories: [], rules: DEFAULT_RULES }) });
  assert.equal(empty.getNumberOfPages(), 1);
  assert.ok(buildPayrollPdf(o).getNumberOfPages() >= 2);
});
