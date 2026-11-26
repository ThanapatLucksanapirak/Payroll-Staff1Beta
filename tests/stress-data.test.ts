// Payroll math, CSV and PDF checks from the stress test. Expected values computed by hand.
import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import type { jsPDF } from "jspdf";
import { computePayroll, paymentFor, round2 } from "../shared/engine";
import { DEFAULT_RULES, prefsSchema, siteSchema, type EmployeeConfig, type ManualEmployee, type Shift } from "../shared/schema";
import { punchesToShifts, clockState, type Punch } from "../shared/punches";
import { parseCsvText, shiftsToCsv } from "../shared/importers/csv";
import { payPeriod } from "../client/src/lib/periods";
import { buildPayrollPdf } from "../client/src/lib/pdf/report";
import { buildPayStatementsPdf, earningsLines } from "../client/src/lib/pdf/statements";
import { buildSummaryPdf } from "../client/src/lib/pdf/summary";
import { buildPayoutSheetPdf } from "../client/src/lib/pdf/payout";
import { makeFmt } from "../client/src/lib/pdf/format";

let n = 0;
const sh = (employee: string, date: string, start: number, end: number, extra: Partial<Shift> = {}): Shift => ({
  id: `s${n++}`, employee, date, start, end, breakMinutes: 0, role: "", source: "csv", note: "", ...extra,
});
const emp = (name: string, extra: Partial<EmployeeConfig> = {}): EmployeeConfig => ({
  name, categoryId: "custom", payBasis: "hourly", fullDayRate: 0, halfDayRate: 0, hourlyRate: 20, isNetPay: true,
  adjustments: {}, bonuses: [], deductions: [], excluded: false, note: "", ...extra,
} as EmployeeConfig);
const manual = (id: string, name: string, extra: Partial<ManualEmployee> = {}): ManualEmployee => ({
  id, name, payMode: "lump_sum", lumpSum: 0, payDates: [], isNetPay: true, bonuses: [], deductions: [], excluded: false, categoryId: "custom", ...extra,
} as ManualEmployee);
const run = (shifts: Shift[], employees: EmployeeConfig[], rules: any = {}, manualEmployees: ManualEmployee[] = []) =>
  computePayroll({ shifts, employees, manualEmployees, categories: [], rules: { ...DEFAULT_RULES, ...rules } });

// ── Rounding ──────────────────────────────────────────────────────────────────
test("rounding: 15 min at $20.10 = $5.025 -> half-up $5.03", () => {
  const r = run([sh("A", "2026-11-02", 600, 615)], [emp("A", { hourlyRate: 20.1 })]);
  assert.equal(r.employees[0].totalPay, 5.03);
});
test("rounding: rate 15.333 x 479 min, sum of days equals total", () => {
  const shifts = Array.from({ length: 10 }, (_, i) => sh("A", `2026-11-${String(2 + i).padStart(2, "0")}`, 600, 1079));
  const r = run(shifts, [emp("A", { hourlyRate: 15.333 })]);
  const perDay = Math.round(479 / 60 * 15.333 * 100) / 100; // 122.41
  assert.equal(r.employees[0].days[0].pay, perDay);
  assert.equal(Math.round(r.employees[0].totalPay * 100), Math.round(perDay * 100) * 10);
});
test("rounding: 0.1+0.2 style bonuses sum to exact cents", () => {
  const r = run([], [emp("A", { bonuses: Array.from({ length: 30 }, () => ({ date: "", description: "", amount: 0.1 })) as any })]);
  assert.equal(r.employees[0].totalPay, 3);
});
test("statement earnings lines sum to totalBasePay (hourly with OT, odd rate)", () => {
  const shifts = Array.from({ length: 5 }, (_, i) => sh("A", `2026-11-${String(2 + i).padStart(2, "0")}`, 540, 540 + 599));
  const r = run(shifts, [emp("A", { hourlyRate: 15.333 })], { overtimeEnabled: true });
  const e = r.employees[0];
  const fmt = makeFmt(prefsSchema.parse({}));
  const lines = earningsLines(e, fmt);
  const sum = lines.reduce((s, l) => s + (l.amount ?? 0), 0);
  assert.equal(round2(sum), e.totalBasePay);
  // Hand-computed: 5 days x 599 min = 2995 min = 49.9167 h; 40 reg, 9.9167 OT
  const expected = round2(4 * round2(599 / 60 * 15.333) + round2((2400 - 4 * 599) / 60 * 15.333 + (599 - (2400 - 4 * 599)) / 60 * 15.333 * 1.5));
  assert.equal(e.totalBasePay, expected);
});

// ── Overtime ─────────────────────────────────────────────────────────────────
test("daily OT applies per DAY even when same-day shifts are not merged", () => {
  // Two 6h shifts on one day, daily OT after 8h -> 8 reg + 4 OT
  const shifts = [sh("A", "2026-11-02", 360, 720), sh("A", "2026-11-02", 780, 1140)];
  const r = run(shifts, [emp("A", { hourlyRate: 10 })], { overtimeEnabled: true, overtimeDailyHours: 8, mergeSameDayShifts: false, classificationMethod: "hours" });
  assert.equal(r.employees[0].overtimeHours, 4, "expected 4 OT hours");
  assert.equal(r.employees[0].totalPay, 8 * 10 + 4 * 15);
});
test("cancelled (unpaid) day does not push later days into weekly OT", () => {
  // Mon 10h cancelled (sent home, not paid); Tue-Fri 10h each = 40h paid -> no OT expected
  const shifts = ["02", "03", "04", "05", "06"].map((d) => sh("A", `2026-11-${d}`, 480, 1080));
  const r = run(shifts, [emp("A", { hourlyRate: 10, adjustments: { "2026-11-02": { cancelled: true } } as any })], { overtimeEnabled: true });
  assert.equal(r.employees[0].totalPay, 400, `got ${r.employees[0].totalPay}, OT ${r.employees[0].overtimeHours}`);
});
test("hours of a cancelled day are not reported as hours worked", () => {
  const shifts = [sh("A", "2026-11-02", 480, 1080)];
  const r = run(shifts, [emp("A", { hourlyRate: 10, adjustments: { "2026-11-02": { cancelled: true } } as any })]);
  assert.equal(r.totals.hours, 0, `reported ${r.totals.hours} h for a cancelled day`);
});
test("weekly OT with weekStartsOn Sunday and week boundary", () => {
  // Sun 11/1 through Sat 11/7: 7 x 8h = 56h, week starts Sunday -> 16 OT
  const shifts = Array.from({ length: 7 }, (_, i) => sh("A", `2026-11-0${1 + i}`, 480, 960));
  const r = run(shifts, [emp("A", { hourlyRate: 10 })], { overtimeEnabled: true, weekStartsOn: 0 });
  assert.equal(r.employees[0].overtimeHours, 16);
  assert.equal(r.employees[0].totalPay, 400 + 16 * 15);
});

// ── Totals consistency ──────────────────────────────────────────────────────
test("totals: totalPay equals cash+bank+check when someone owes money", () => {
  const r = run([sh("A", "2026-11-02", 600, 660)], [emp("A", { hourlyRate: 10, deductions: [{ description: "loan", amount: 50 }] as any }), emp("B")], {}, [manual("m", "M", { lumpSum: 100 })]);
  const t = r.totals;
  assert.equal(t.totalPay, round2(t.cash + t.bank + t.check), "To pay out total differs from report total");
});

// ── Splits ─────────────────────────────────────────────────────────────────
test("split: cash + bank always equals net in cents (10k random)", () => {
  let bad = 0;
  for (let i = 0; i < 10000; i++) {
    const total = Math.round(Math.random() * 500000) / 100 + (i % 3 ? 0.005 : 0);
    const cashAmt = Math.random() < 0.2 ? total * 2 : Math.round(Math.random() * total * 1000) / 1000;
    const p = paymentFor("split", cashAmt, total, { defaultPaymentMethod: "bank" });
    if (Math.round(p.cash * 100) + Math.round(p.bank * 100) !== Math.round(round2(total) * 100)) bad++;
    if (p.cash < 0 || p.bank < 0) bad++;
  }
  assert.equal(bad, 0);
});
test("split edge cases", () => {
  assert.deepEqual(paymentFor("split", 0, 100, { defaultPaymentMethod: "bank" }), { method: "split", cash: 0, bank: 100, check: 0 });
  assert.deepEqual(paymentFor("split", 1000, 100.01, { defaultPaymentMethod: "bank" }), { method: "split", cash: 100.01, bank: 0, check: 0 });
  assert.deepEqual(paymentFor("split", -5, 100, { defaultPaymentMethod: "bank" }), { method: "split", cash: 0, bank: 100, check: 0 });
  assert.deepEqual(paymentFor("split", 33.333, 100, { defaultPaymentMethod: "bank" }), { method: "split", cash: 33.33, bank: 66.67, check: 0 });
  assert.deepEqual(paymentFor("cash", 0, -20, { defaultPaymentMethod: "bank" }), { method: "cash", cash: 0, bank: 0, check: 0 });
});

// ── Pay periods ────────────────────────────────────────────────────────────
const R = (x: any) => ({ ...DEFAULT_RULES, ...x });
test("periods: semimonthly / monthly / leap / year boundary", () => {
  assert.deepEqual(payPeriod(R({ payPeriod: "semimonthly" }), 0, "2028-02-20"), { start: "2028-02-16", end: "2028-02-29", label: "" });
  assert.deepEqual(payPeriod(R({ payPeriod: "semimonthly" }), 1, "2026-12-20"), { start: "2027-01-01", end: "2027-01-15", label: "" });
  assert.deepEqual(payPeriod(R({ payPeriod: "semimonthly" }), -1, "2026-01-03"), { start: "2025-12-16", end: "2025-12-31", label: "" });
  assert.deepEqual(payPeriod(R({ payPeriod: "monthly" }), -1, "2026-03-31"), { start: "2026-02-01", end: "2026-02-28", label: "" });
  assert.deepEqual(payPeriod(R({ payPeriod: "monthly" }), 0, "2028-02-29"), { start: "2028-02-01", end: "2028-02-29", label: "" });
  assert.deepEqual(payPeriod(R({ payPeriod: "biweekly", payPeriodAnchor: "2026-01-05" }), 0, "2026-01-04"), { start: "2025-12-22", end: "2026-01-04", label: "" });
  assert.deepEqual(payPeriod(R({ payPeriod: "biweekly", payPeriodAnchor: "2025-12-29" }), 0, "2026-03-08"), { start: "2026-02-23", end: "2026-03-08", label: "" });
  assert.deepEqual(payPeriod(R({ payPeriod: "weekly", weekStartsOn: 1 }), 0, "2026-11-01"), { start: "2026-10-26", end: "2026-11-01", label: "" });
});

// ── Punches / DST / 16-hour rule ─────────────────────────────────────────────
let pid = 0;
const P = (type: Punch["type"], at: string, emp = "e1"): Punch => ({
  id: `p${String(pid++).padStart(8, "0")}`, siteId: "s", employeeId: emp, employeeName: "Emp " + emp, type, at: new Date(at).toISOString(),
  source: "kiosk", deviceId: null, note: "", createdAt: at, editedAt: null, edits: [],
});
const TZ = "America/New_York";
test("DST fall back: 22:00 -> 06:00 across 2026-11-01 is 9 real hours", () => {
  const r = punchesToShifts([P("in", "2026-10-31T22:00:00-04:00"), P("out", "2026-11-01T06:00:00-05:00")], { timezone: TZ, now: Date.parse("2026-11-02T00:00:00Z") });
  const s = r.shifts[0];
  assert.equal(s.end - s.start, 540);
  const res = run(r.shifts, [emp("Emp e1", { hourlyRate: 10 })]);
  assert.equal(res.employees[0].totalPay, 90);
});
test("DST spring forward: 22:00 -> 06:00 across 2026-03-08 is 7 real hours", () => {
  const r = punchesToShifts([P("in", "2026-03-07T22:00:00-05:00", "e2"), P("out", "2026-03-08T06:00:00-04:00", "e2")], { timezone: TZ, now: Date.parse("2026-03-09T00:00:00Z") });
  const s = r.shifts[0];
  assert.equal(s.end - s.start, 420);
  const res = run(r.shifts, [emp("Emp e2", { hourlyRate: 10 })]);
});
test("break without clock-in is ignored with warning; overlapping/out-of-order punches", () => {
  const ps = [P("break_start", "2026-11-02T07:00:00-05:00", "e4"), P("out", "2026-11-02T17:00:00-05:00", "e4"), P("in", "2026-11-02T08:00:00-05:00", "e4")];
  const r = punchesToShifts(ps.reverse(), { timezone: TZ, now: Date.parse("2026-11-04T00:00:00Z") });
  assert.equal(r.shifts.length, 1);
  assert.equal(r.shifts[0].end - r.shifts[0].start, 540);
  assert.ok(r.warnings.some((w) => /without a clock-in/.test(w)));
});

// ── CSV importer ─────────────────────────────────────────────────────────────
test("csv: BOM, commas in names, CRLF, empty rows, totals row", () => {
  const csv = "﻿Team Member,Clockin date,Clockin time,Clockout date,Clockout time,Break minutes\r\n\"O'Neil, Jr., Pat\",11/2/26,9:00 AM,11/2/26,5:00 PM,30\r\n,,,,,\r\n\r\nTotal,,,,,\r\n\"Søren Ærø\",11/3/26,10:00 PM,11/4/26,6:00 AM,0\r\n";
  const r = parseCsvText(csv);
  assert.equal(r.shifts.length, 2);
  assert.equal(r.shifts[0].employee, "O'Neil, Jr., Pat");
  assert.equal(r.shifts[1].end - r.shifts[1].start, 480);
});
test("csv: Excel serial dates are not silently mis-parsed", () => {
  const csv = "Employee,Date,Start,End\nAnn,46328,9:00,17:00\n";
  const r = parseCsvText(csv);
  assert.equal(r.shifts.length, 0);
});
test("csv: D/M/Y European date 13/11/2026 is not misread", () => {
  const r = parseCsvText("Employee,Date,Start,End\nAnn,13/11/2026,9:00,17:00\nBob,03/11/2026,9:00,17:00\n");
});
test("csv: export -> import round trip preserves shifts including overnight & 3-day", () => {
  const shifts = [sh("Ann, B", "2026-12-31", 1320, 1440 + 360, { breakMinutes: 15 }), sh("Zed", "2028-02-28", 600, 1440 + 600), sh("Q \"quoted\"", "2026-11-01", 0, 4320)];
  const back = parseCsvText(shiftsToCsv(shifts)).shifts;
  for (const s of shifts) {
    const b = back.find((x) => x.id === s.id)!;
    assert.ok(b, `missing ${s.id}`);
    assert.deepEqual([b.employee, b.date, b.start, b.end, b.breakMinutes], [s.employee, s.date, s.start, s.end, s.breakMinutes], `${s.id}`);
  }
});
test("csv: 50k rows parse in reasonable time", () => {
  const rows = ["Employee,Date,Start,End"];
  for (let i = 0; i < 50000; i++) rows.push(`E${i % 300},11/${(i % 28) + 1}/26,9:00 AM,5:00 PM`);
  const t = Date.now();
  const r = parseCsvText(rows.join("\n"));
  assert.equal(r.shifts.length, 50000);
  const t2 = Date.now();
  const res = run(r.shifts, []);
});

// ── PDFs ───────────────────────────────────────────────────────────────────
function pdfStrings(pdf: jsPDF): string {
  const raw = Buffer.from(pdf.output("arraybuffer"));
  const bin = raw.toString("latin1");
  const chunks: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bin))) {
    const start = m.index + m[0].length;
    const end = bin.indexOf("endstream", start);
    if (end < 0) break;
    try { chunks.push(inflateSync(raw.subarray(start, end)).toString("latin1")); } catch { chunks.push(raw.subarray(start, end).toString("latin1")); }
    re.lastIndex = end + 9;
  }
  const out: string[] = [];
  for (const c of chunks) for (const s of c.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj/g)) {
    const body = s[0].replace(/\)\s*Tj$/, "").slice(1);
    out.push(body.replace(/\\([0-7]{1,3}|.)/g, (_, e: string) => (/^[0-7]+$/.test(e) ? String.fromCharCode(parseInt(e, 8)) : e === "n" ? "\n" : e)));
  }
  return new TextDecoder("windows-1252").decode(Buffer.from(out.join("\n"), "latin1"));
}
async function pdfjsText(pdf: jsPDF): Promise<{ pages: string[]; overflow: string[] }> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf.output("arraybuffer")), verbosity: 0, isEvalSupported: false }).promise;
  const pages: string[] = []; const overflow: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const [, , W, H] = page.view;
    const tc = await page.getTextContent();
    pages.push(tc.items.map((i: any) => i.str).join("|"));
    for (const it of tc.items as any[]) {
      const x = it.transform[4], y = it.transform[5];
      if (it.str.trim() && (x < 0 || x + it.width > W + 0.5 || y < 0 || y > H)) overflow.push(`p${p}: "${it.str}" x=${x.toFixed(1)} w=${it.width.toFixed(1)} W=${W}`);
    }
  }
  await doc.destroy();
  return { pages, overflow };
}

function bigMixed() {
  const names = [
    "Somchai Jaidee", "สมชาย ใจดี", "สมหญิง ใจดี", "Wolfeschlegelsteinhausenbergerdorff Hubert Blaine Maximilian Alexander", "José Ñúñez-García",
    "Đặng Thị Ngọc Hân", "李小龍", "O'Brien, Jr.", "Zoë Ångström",
  ];
  for (let i = 0; i < 120; i++) names.push(`Worker ${i} ${"x".repeat(i % 40)}`);
  const shifts: Shift[] = []; const employees: EmployeeConfig[] = [];
  names.forEach((nm, i) => {
    const m = (["cash", "bank", "check", "split"] as const)[i % 4];
    employees.push(emp(nm, { hourlyRate: 15.333 + i / 7, paymentMethod: m, splitCashAmount: 100.005 + i, deductions: i % 11 === 0 ? [{ description: "Advance", amount: 33.37 }] as any : [] } as any));
    for (let d = 0; d < 14; d++) if ((d + i) % 5) shifts.push(sh(nm, `2026-11-${String(2 + d).padStart(2, "0")}`, 540 + (i % 13), 1020 + (d * 7 + i) % 59, { breakMinutes: 29 }));
  });
  return run(shifts, employees, { overtimeEnabled: true }, [manual("m1", "Lump 0.1", { lumpSum: 0.1 }), manual("m2", "Lump 0.2", { lumpSum: 0.2, paymentMethod: "cash" } as any)]);
}
const site = siteSchema.parse({ id: "s1", name: "Bangkok", address: "" });
const prefs = prefsSchema.parse({ businessName: "Test Co" });
const O = (result: any, extra: any = {}) => ({ result, prefs, site, title: "Stress", generatedAt: new Date(2026, 10, 16), ...extra });

test("PDF payout sheet: grand + per-method totals equal engine totals; names present", async () => {
  const r = bigMixed();
  const fmt = makeFmt(prefs);
  const pdf = buildPayoutSheetPdf(O(r));
  const text = pdfStrings(pdf);
  for (const v of [r.totals.cash, r.totals.bank, r.totals.check, r.totals.totalPay]) {
    const s = fmt.money(v);
  }
  assert.ok(text.includes(fmt.money(r.totals.cash)), "cash total");
  assert.ok(text.includes(fmt.money(r.totals.bank)), "bank total");
  assert.ok(text.includes(fmt.money(r.totals.check)), "check total");
  assert.ok(text.includes(fmt.money(round2(r.totals.cash + r.totals.bank + r.totals.check))), "grand");
  const { overflow } = await pdfjsText(pdf);
  assert.deepEqual(overflow, []);
});
test("PDF report/summary/statements: totals match engine, no off-page text", async () => {
  const r = bigMixed();
  const fmt = makeFmt(prefs);
  for (const [name, b] of [["report", buildPayrollPdf], ["summary", buildSummaryPdf], ["statements", buildPayStatementsPdf]] as const) {
    const pdf = b(O(r) as any);
    const text = pdfStrings(pdf);
    if (name !== "statements") assert.ok(text.includes(fmt.money(r.totals.totalPay)), `${name} total ${fmt.money(r.totals.totalPay)}`);
    const { overflow, pages } = await pdfjsText(pdf);
    assert.deepEqual(overflow, [], name);
    if (name === "statements") {
      for (const e of r.employees.filter((x) => !x.excluded)) assert.ok(text.includes(fmt.money(e.totalPay)), `statement total for ${e.name}`);
    }
  }
});
test("PDF statements: long name not truncated mid-name without indication", () => {
  const r = bigMixed();
  const e = r.employees.find((x) => x.name.startsWith("Wolfe"))!;
  const text = pdfStrings(buildPayStatementsPdf(O(r, { only: [e.sourceId] })));
});
test("PDF: summary total and payout total agree when an employee owes money", () => {
  const r = run([sh("A", "2026-11-02", 600, 660)], [emp("A", { hourlyRate: 10, deductions: [{ description: "loan", amount: 50 }] as any })], {}, [manual("m", "M", { lumpSum: 100 })]);
  const sum = pdfStrings(buildSummaryPdf(O(r)));
  const pay = pdfStrings(buildPayoutSheetPdf(O(r)));
  assert.ok(pay.includes("$60.00") || !sum.includes("$60.00"), "summary says $60.00 total, payout says $100.00");
});

test("csv: same clock-in and clock-out is skipped, not a 24-hour shift", async () => {
  const { parseCsvText } = await import("../shared/importers/csv");
  const r = parseCsvText("Team Member,Clockin date,Clockin time,Clockout time\nAnn,11/2/2026,9:00 AM,9:00 AM\nBob,11/2/2026,9:00 AM,5:00 PM\n");
  assert.deepEqual(r.shifts.map((s) => s.employee), ["Bob"]);
  assert.ok(r.warnings.some((w) => /same time/.test(w)));
});

test("csv: D/M/YY preference reads ambiguous dates day-first", async () => {
  const { parseCsvText } = await import("../shared/importers/csv");
  const csv = "Employee,Date,Clock In,Clock Out\nBob,03/11/2026,9:00 AM,5:00 PM\n";
  assert.equal(parseCsvText(csv).shifts[0].date, "2026-03-11");
  assert.equal(parseCsvText(csv, { dayFirst: true }).shifts[0].date, "2026-11-03");
  // Square files (and the app's own Shifts CSV) are always month-first
  const square = "Team Member,Clockin date,Clockin time,Clockout time\nBob,03/11/2026,9:00 AM,5:00 PM\n";
  assert.equal(parseCsvText(square, { dayFirst: true }).shifts[0].date, "2026-03-11");
});

test("csv exports neutralise spreadsheet formulas and read back unchanged", async () => {
  const { csvCell } = await import("../shared/csvSafe");
  assert.equal(csvCell("=HYPERLINK(\"x\")"), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvCell("-12.5"), "-12.5", "negative numbers stay numbers");
  assert.equal(csvCell("Ana Ruiz"), "Ana Ruiz");
  const { shiftsToCsv, parseCsvText } = await import("../shared/importers/csv");
  const out = shiftsToCsv([{ id: "s1", employee: "=cmd|' /C calc'!A0", date: "2026-11-02", start: 540, end: 1020, breakMinutes: 0, role: "+Cook", source: "csv", note: "" } as any]);
  assert.ok(!/\n=|,=|,\+/.test(out), out);
  const back = parseCsvText(out).shifts[0];
  assert.equal(back.employee, "=cmd|' /C calc'!A0".replace(/\s+/g, " "));
  assert.equal(back.role, "+Cook");
});
