// Pay extras on the PDFs: cash denominations and tips on the pay-out sheet,
// extra lines and YTD on pay statements.
import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import type { jsPDF } from "jspdf";
import { buildPayoutSheetPdf } from "../client/src/lib/pdf/payout";
import { buildPayStatementsPdf } from "../client/src/lib/pdf/statements";
import { buildPayrollPdf } from "../client/src/lib/pdf/report";
import { DEFAULT_RULES, type EmployeeConfig, type Shift } from "../shared/schema";
import { computeTimesheet, emptyDocExtras, ytdStatementMap } from "../shared/payExtras";
import { prefs, site } from "./pdf-fixture";

function pdfStrings(pdf: jsPDF): string {
  const raw = Buffer.from(pdf.output("arraybuffer"));
  const bin = raw.toString("latin1");
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bin))) {
    const start = m.index + m[0].length;
    const end = bin.indexOf("endstream", start);
    if (end < 0) break;
    let text: string;
    try { text = inflateSync(raw.subarray(start, end)).toString("latin1"); } catch { text = raw.subarray(start, end).toString("latin1"); }
    for (const s of text.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj/g)) out.push(s[0].replace(/\)\s*Tj$/, "").slice(1).replace(/\\(.)/g, "$1"));
    re.lastIndex = end + "endstream".length;
  }
  return out.join("\n");
}

let n = 0;
const sh = (employee: string, date: string): Shift => ({ id: `s${n++}`, employee, date, start: 600, end: 1260, breakMinutes: 0, role: "", source: "csv", note: "" });
const emp = (name: string, extra: Partial<EmployeeConfig> = {}): EmployeeConfig => ({
  name, categoryId: "custom", payBasis: "day_rate", fullDayRate: 187.4, halfDayRate: 90, hourlyRate: 0, isNetPay: true,
  adjustments: {}, bonuses: [], deductions: [], excluded: false, note: "", paymentMethod: "cash", splitCashAmount: 0, ...extra,
});

const result = computeTimesheet({
  shifts: [sh("Maria Santos", "2026-11-26"), sh("Leo Park", "2026-11-26"), sh("Leo Park", "2026-11-27")],
  employees: [emp("Maria Santos"), emp("Leo Park", { paymentMethod: "bank" })],
  manualEmployees: [],
  rules: DEFAULT_RULES,
  payExtras: {
    ...emptyDocExtras(),
    holidays: [{ id: "h", date: "2026-11-26", name: "Thanksgiving", kind: "multiplier", multiplier: 2, flatBonus: 0 }],
    tips: { mode: "total", total: 60.02, perDay: {}, split: "hours", points: {} },
    recurring: [{ sourceId: "r", employee: "Maria Santos", kind: "deduction", description: "Uniform", amount: 10 }],
    advances: [{ advanceId: "a", employee: "Leo Park", description: "Advance repayment", scheduled: 50, remaining: 80 }],
  },
}, []);

const base = { result, prefs: prefs(), site: site(), title: "Thanksgiving week", generatedAt: new Date(2026, 10, 30, 9, 0) };

test("pay-out sheet lists bills and coins and the tips", () => {
  const maria = result.employees.find((e) => e.name === "Maria Santos")!;
  assert.equal(maria.payment.cash, maria.totalPay);
  const pdf = buildPayoutSheetPdf({ ...base, cash: { denominations: [100, 50, 20, 10, 5, 1, 0.25, 0.1, 0.05, 0.01], roundCash: false } });
  const s = pdfStrings(pdf);
  assert.match(s, /Bills and coins to pull/);
  assert.match(s, /Tips included above/);
  assert.match(s, /3 x \$100,  1 x \$50/);
  // Without the option the sheet is as before
  assert.doesNotMatch(pdfStrings(buildPayoutSheetPdf(base)), /Bills and coins/);
  // Rounded cash hand-outs
  const rounded = pdfStrings(buildPayoutSheetPdf({ ...base, cash: { denominations: [100, 20, 1], roundCash: true } }));
  assert.match(rounded, new RegExp(`\\$${Math.round(maria.payment.cash)}\\.00`));
});

test("pay statements show holiday, tips, standing items, advance and YTD", () => {
  const ytd = ytdStatementMap([{ key: "maria santos", name: "Maria Santos", gross: 1000, deductions: 0, net: 1000, tips: 0, timesheets: 2 }], result);
  const s = pdfStrings(buildPayStatementsPdf({ ...base, ytd, ytdYear: 2026 }));
  assert.match(s, /Holiday premium/);
  assert.match(s, /Tips/);
  assert.match(s, /Uniform/);
  assert.match(s, /Advance repayment/);
  assert.match(s, /Year to date \(2026\)/);
  const maria = result.employees.find((e) => e.name === "Maria Santos")!;
  assert.equal(ytd["maria santos"].net, Math.round((1000 + maria.totalPay) * 100) / 100);
  assert.doesNotMatch(pdfStrings(buildPayStatementsPdf(base)), /Year to date/);
  // The full report still renders with extras
  assert.ok(buildPayrollPdf(base).getNumberOfPages() >= 1);
});
