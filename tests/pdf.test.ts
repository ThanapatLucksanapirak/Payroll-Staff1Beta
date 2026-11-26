import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import type { jsPDF } from "jspdf";
import { buildPayrollPdf } from "../client/src/lib/pdf/report";
import { buildPayStatementsPdf, earningsLines } from "../client/src/lib/pdf/statements";
import { buildSummaryPdf } from "../client/src/lib/pdf/summary";
import { isPdfSafeChar, makeFmt, pdfCurrencyPrefix, pdfText } from "../client/src/lib/pdf/format";
import type { PdfOptions } from "../client/src/lib/pdf/kit";
import { DATE_FORMATS, prefsSchema } from "../shared/schema";
import { TINY_PNG, bigResult, edgeResult, emptyResult, prefs, realisticResult, site } from "./pdf-fixture";

/** Pull the drawn strings out of a jsPDF document (inflates content streams, decodes PDF string escapes). */
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
    const data = raw.subarray(start, end);
    try { chunks.push(inflateSync(data).toString("latin1")); } catch { chunks.push(data.toString("latin1")); }
    re.lastIndex = end + "endstream".length;
  }
  const out: string[] = [];
  for (const c of chunks) {
    for (const s of c.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj/g)) {
      const body = s[0].replace(/\)\s*Tj$/, "").slice(1);
      out.push(body.replace(/\\([0-7]{1,3}|.)/g, (_, e: string) => (/^[0-7]+$/.test(e) ? String.fromCharCode(parseInt(e, 8)) : e === "n" ? "\n" : e)));
    }
  }
  // jsPDF writes standard-font text as WinAnsi (Windows-1252) bytes
  return new TextDecoder("windows-1252").decode(Buffer.from(out.join("\n"), "latin1"));
}

const AT = new Date(2026, 10, 16, 9, 41);
const opts = (extra: Partial<PdfOptions> = {}): PdfOptions => ({
  result: realisticResult(), prefs: prefs(), site: site(), title: "Payroll Nov 2 – Nov 15", notes: "Approved by Sam", generatedAt: AT, ...extra,
});
const pages = (pdf: jsPDF) => pdf.getNumberOfPages();
const sizePt = (pdf: jsPDF) => ({ w: pdf.internal.pageSize.getWidth(), h: pdf.internal.pageSize.getHeight() });

test("fixture covers the cases the PDFs must handle", () => {
  const r = realisticResult();
  const by = (n: string) => r.employees.find((e) => e.name === n)!;
  assert.ok(by("James O'Connor").overtimeHours > 0, "hourly overtime");
  assert.ok(by("Aiko Tanaka").days.some((d) => (d.end ?? 0) > 1440), "overnight shift");
  assert.ok(by("Maria Santos").totalDocked > 0 && by("Maria Santos").days.some((d) => d.cancelled), "dock + cancelled");
  assert.ok(by("Grace Kim (bookkeeping)").isManual && by("Luis Fernández").isManual);
  assert.ok(by("Excluded Person").excluded && by("Left Out Manual").excluded);
});

test("full report: overview + detail, key text, excluded employees left out", () => {
  const o = opts();
  const pdf = buildPayrollPdf(o);
  const text = pdfStrings(pdf);
  assert.ok(pages(pdf) >= 3, `expected ≥3 pages, got ${pages(pdf)}`);
  for (const s of ["Harbor Lane Kitchen", "Payroll Nov 2 – Nov 15", "Summary", "Employee detail", "Maria Santos", "James O'Connor", "Aiko Tanaka", "Dev Patel", "Grace Kim (bookkeeping)", "Luis Fernández", "Catering event", "Cash advance", "Uniform", "Approved by Sam", "Confidential — for internal use only", "Generated 11/16/26 at 9:41 AM"]) {
    assert.ok(text.includes(s), `missing "${s}"`);
  }
  assert.ok(text.includes(`Page 1 of ${pages(pdf)}`) && text.includes(`Page ${pages(pdf)} of ${pages(pdf)}`));
  const total = o.result.employees.filter((e) => !e.excluded).reduce((s, e) => s + e.totalPay, 0);
  assert.ok(text.includes(makeFmt(o.prefs).money(total)), "grand total shown");
  assert.equal(makeFmt(o.prefs).money(total), makeFmt(o.prefs).money(o.result.totals.totalPay));
  assert.ok(!text.includes("Excluded Person") && !text.includes("Left Out Manual"), "excluded employees are left out");
  // Weekday on day rows, shift times shown by default
  assert.match(text, /Mon 11\/2\/26/);
  assert.match(text, /10:00 AM/);
});

test("report honours pdfShowShiftTimes, pdfPagePerEmployee and 24h time", () => {
  const withTimes = pdfStrings(buildPayrollPdf(opts({ prefs: prefs({ timeFormat: "24h" }) })));
  assert.match(withTimes, /18:00/);
  assert.ok(!/\d:\d\d [AP]M/.test(withTimes.replace(/Generated[^\n]*/g, "")), "engine notes rewritten to 24h");
  const noTimes = buildPayrollPdf(opts({ prefs: prefs({ pdfShowShiftTimes: false }) }));
  assert.ok(!pdfStrings(noTimes).includes("10:00 AM"));
  const perPage = buildPayrollPdf(opts({ prefs: prefs({ pdfPagePerEmployee: true }) }));
  assert.ok(pages(perPage) >= 7, "overview + one page per employee");
});

test("orientation and page size prefs", () => {
  const land = sizePt(buildPayrollPdf(opts()));
  assert.ok(land.w > land.h, "default is landscape");
  assert.ok(Math.abs(land.w - 279.4) < 0.5, "default is US Letter");
  const a4p = sizePt(buildPayrollPdf(opts({ prefs: prefs({ pdfOrientation: "portrait", pdfPageSize: "a4" }) })));
  assert.ok(Math.abs(a4p.w - 210) < 0.5 && Math.abs(a4p.h - 297) < 0.5);
  const sum = sizePt(buildSummaryPdf(opts({ prefs: prefs({ pdfOrientation: "portrait" }) })));
  assert.ok(sum.h > sum.w);
  // Pay statements are always portrait
  const st = sizePt(buildPayStatementsPdf(opts({ prefs: prefs({ pdfOrientation: "landscape", pdfPageSize: "a4" }) })));
  assert.ok(Math.abs(st.w - 210) < 0.5 && st.h > st.w);
});

test("manager summary fits on one page, even with 150 employees", () => {
  const pdf = buildSummaryPdf(opts());
  assert.equal(pages(pdf), 1);
  const text = pdfStrings(pdf);
  for (const s of ["Harbor Lane Kitchen", "Maria Santos", "Luis Fernández", "Page 1 of 1"]) assert.ok(text.includes(s), `missing "${s}"`);
  assert.ok(!text.includes("Excluded Person"));
  for (const orientation of ["portrait", "landscape"] as const) {
    const big = buildSummaryPdf(opts({ result: bigResult(150, 14), prefs: prefs({ pdfOrientation: orientation }) }));
    assert.equal(pages(big), 1, `150 employees ${orientation}`);
    assert.match(pdfStrings(big), /\+ \d+ more employees/);
  }
  const forty = buildSummaryPdf(opts({ result: bigResult(40, 14), prefs: prefs({ pdfOrientation: "portrait" }) }));
  assert.equal(pages(forty), 1);
  assert.ok(!pdfStrings(forty).includes("more employee"), "40 employees fit without truncation in portrait");
});

test("pay statements: one page per included employee, totals and details", () => {
  const o = opts({ payDate: "2026-11-20", prefs: prefs({ pdfSignatureLine: true }) });
  const pdf = buildPayStatementsPdf(o);
  const included = o.result.employees.filter((e) => !e.excluded);
  assert.equal(pages(pdf), included.length);
  const text = pdfStrings(pdf);
  for (const s of ["Pay date 11/20/26", "Total net pay", "Total gross pay", "Regular hours", "Overtime hours", "Full days", "Half days", "Docked", "Catering event", "Perfect attendance", "Received by Maria Santos", "Maria Santos · Page 1 of 1"]) {
    assert.ok(text.includes(s), `missing "${s}"`);
  }
  assert.ok(!text.includes("Excluded Person"));
  assert.ok(text.includes("Pay statement for Maria Santos"), "statements say whose they are in the footer");
  assert.ok(!text.includes("for internal use only"), "not the internal-use footer staff found confusing");
});

test("earnings lines reconcile to total pay", () => {
  const r = realisticResult();
  const fmt = makeFmt(prefs());
  for (const e of r.employees) {
    const earn = earningsLines(e, fmt).reduce((s, l) => s + (l.amount ?? 0), 0);
    const bonuses = e.days.reduce((s, d) => s + d.bonuses.reduce((a, b) => a + b.amount, 0), 0) + e.generalBonuses.reduce((s, b) => s + b.amount, 0);
    const deds = e.generalDeductions.reduce((s, d) => s + d.amount, 0);
    assert.ok(Math.abs(earn + bonuses - deds - e.totalPay) < 0.011, `${e.name}: ${earn} + ${bonuses} - ${deds} ≠ ${e.totalPay}`);
  }
});

test("single employee statement from `only`", () => {
  const r = realisticResult();
  const target = r.employees.find((e) => e.name === "James O'Connor")!;
  const pdf = buildPayStatementsPdf(opts({ result: r, only: [target.sourceId] }));
  assert.equal(pages(pdf), 1);
  const text = pdfStrings(pdf);
  assert.ok(text.includes("James O'Connor") && !text.includes("Maria Santos"));
  assert.ok(text.includes("Page 1 of 1"));
});

test("a month of days still fits a statement on one page", () => {
  const pdf = buildPayStatementsPdf(opts({ result: bigResult(3, 31), prefs: prefs({ pdfSignatureLine: true }) }));
  assert.equal(pages(pdf), 3);
});

test("edge cases build without errors", () => {
  const cases: [string, PdfOptions][] = [
    ["empty", opts({ result: emptyResult(), notes: "" })],
    ["zero/negative", opts({ result: edgeResult() })],
    ["150 employees", opts({ result: bigResult(150, 14) })],
    ["long names", opts({ result: bigResult(3, 31, (i) => `${"Maximiliana Alexandrina Wolfeschlegelsteinhausen-Bergerdorff ".repeat(i + 2)}${i}`) })],
    ["all excluded via only=[]", opts({ only: [] })],
    ["blank business + site address", opts({ prefs: prefs({ businessName: "", pdfFooter: "" }), site: site({ address: "" }) })],
    ["very long title + notes", opts({ title: "Payroll ".repeat(30), notes: "Note line. ".repeat(200) })],
  ];
  for (const [name, o] of cases) {
    for (const build of [buildPayrollPdf, buildSummaryPdf, buildPayStatementsPdf]) {
      let pdf: jsPDF | undefined;
      assert.doesNotThrow(() => { pdf = build(o); }, `${name} / ${build.name}`);
      assert.ok(pages(pdf!) >= 1);
      assert.ok(Buffer.from(pdf!.output("arraybuffer")).subarray(0, 5).toString() === "%PDF-");
    }
  }
  assert.equal(pages(buildSummaryPdf(cases[2][1])), 1);
  assert.equal(pages(buildPayrollPdf(cases[0][1])), 1);
  assert.match(pdfStrings(buildPayrollPdf(cases[0][1])), /No employees to report/);
  const neg = pdfStrings(buildPayStatementsPdf(opts({ result: edgeResult() })));
  assert.ok(neg.includes("–$300.00"), "negative total uses a minus sign");
});

test("every date and time format renders", () => {
  for (const dateFormat of DATE_FORMATS) {
    for (const timeFormat of ["12h", "24h"] as const) {
      const o = opts({ prefs: prefs({ dateFormat, timeFormat }) });
      assert.doesNotThrow(() => { buildPayrollPdf(o); buildSummaryPdf(o); buildPayStatementsPdf(o); }, `${dateFormat} ${timeFormat}`);
    }
  }
  const text = pdfStrings(buildPayrollPdf(opts({ prefs: prefs({ dateFormat: "MMM D, YYYY" }) })));
  assert.ok(text.includes("Nov 2, 2026 – Nov 14, 2026"), "long month format uses the right month");
  assert.ok(text.includes("Mon Nov 2"));
});

test("currency symbols: drawable ones kept, others fall back to ISO codes", () => {
  assert.equal(pdfCurrencyPrefix("$"), "$");
  assert.equal(pdfCurrencyPrefix("€"), "€");
  assert.equal(pdfCurrencyPrefix("£"), "£");
  assert.equal(pdfCurrencyPrefix("¥"), "¥");
  assert.equal(pdfCurrencyPrefix("R$"), "R$");
  assert.equal(pdfCurrencyPrefix("CHF"), "CHF ");
  assert.equal(pdfCurrencyPrefix("₱"), "PHP ");
  assert.equal(pdfCurrencyPrefix("₹"), "INR ");
  assert.equal(pdfCurrencyPrefix("₩"), "KRW ");
  assert.equal(pdfCurrencyPrefix("฿"), "THB ");
  assert.equal(pdfCurrencyPrefix(""), "");
  for (const [sym, expect] of [["€", "€1,268.67"], ["£", "£1,268.67"], ["¥", "¥1,268.67"], ["₱", "PHP 1,268.67"], ["₹", "INR 1,268.67"], ["₩", "KRW 1,268.67"], ["฿", "THB 1,268.67"]]) {
    const o = opts({ prefs: prefs({ currencySymbol: sym }) });
    for (const build of [buildPayrollPdf, buildSummaryPdf, buildPayStatementsPdf]) {
      const text = pdfStrings(build(o));
      assert.ok(text.includes(expect), `${sym} ${build.name}: expected ${expect}`);
      assert.ok([...text].every(isPdfSafeChar), `${sym} ${build.name}: undrawable characters leaked`);
      assert.ok(!text.includes(sym) || ["€", "£", "¥"].includes(sym));
    }
  }
});

test("pdfText makes any string drawable", () => {
  assert.equal(pdfText("Zoë Ñúñez"), "Zoë Ñúñez");
  assert.equal(pdfText("Łukasz Čech"), "Lukasz Cech");
  assert.equal(pdfText("a − b → c"), "a - b -> c");
  assert.equal(pdfText("สม"), "??");
  assert.equal(pdfText("€ — “quotes”"), "€ — “quotes”");
  const names = realisticResult();
  names.employees[0].name = "Nguyễn Văn Ánh 田中";
  assert.doesNotThrow(() => buildPayrollPdf(opts({ result: names })));
});

test("logo: valid PNG is embedded, invalid values are ignored", () => {
  const withLogo = Buffer.from(buildPayrollPdf(opts({ prefs: prefs({ pdfLogoDataUrl: TINY_PNG }) })).output("arraybuffer")).toString("latin1");
  assert.match(withLogo, /\/Subtype \/Image/);
  const statements = Buffer.from(buildPayStatementsPdf(opts({ prefs: prefs({ pdfLogoDataUrl: TINY_PNG }) })).output("arraybuffer")).toString("latin1");
  assert.match(statements, /\/Subtype \/Image/);
  const bad = { ...prefs(), pdfLogoDataUrl: "data:image/png;base64,AAAA" };
  assert.doesNotThrow(() => buildPayrollPdf(opts({ prefs: bad })));
  const none = Buffer.from(buildPayrollPdf(opts()).output("arraybuffer")).toString("latin1");
  assert.doesNotMatch(none, /\/Subtype \/Image/);
});

test("new PDF prefs: defaults and validation", () => {
  const p = prefsSchema.parse({});
  assert.equal(p.pdfOrientation, "landscape");
  assert.equal(p.pdfPageSize, "letter");
  assert.equal(p.pdfLogoDataUrl, "");
  assert.equal(p.pdfSignatureLine, false);
  assert.equal(prefsSchema.parse({ pdfLogoDataUrl: TINY_PNG }).pdfLogoDataUrl, TINY_PNG);
  assert.equal(prefsSchema.parse({ pdfLogoDataUrl: "javascript:alert(1)" }).pdfLogoDataUrl, "");
  assert.equal(prefsSchema.parse({ pdfLogoDataUrl: "data:image/svg+xml;base64,PHN2Zz4=" }).pdfLogoDataUrl, "");
  assert.equal(prefsSchema.parse({ pdfLogoDataUrl: `data:image/png;base64,${"A".repeat(500_000)}` }).pdfLogoDataUrl, "", "oversized logo dropped");
  assert.equal(prefsSchema.parse({ pdfOrientation: "sideways" }).pdfOrientation, "landscape");
  // A bad logo never wipes out the other prefs
  assert.equal(prefsSchema.parse({ businessName: "X", pdfLogoDataUrl: 42 }).businessName, "X");
});

test("a draft says so on every page; a final one doesn't", () => {
  for (const build of [buildPayrollPdf, buildSummaryPdf, buildPayStatementsPdf]) {
    const draft = build(opts({ draft: true }));
    const text = pdfStrings(draft);
    assert.ok(text.includes("DRAFT, not final"), `${build.name}: draft footer`);
    assert.equal(text.split("DRAFT, not final").length - 1, draft.getNumberOfPages(), `${build.name}: on every page`);
    assert.ok(!pdfStrings(build(opts())).includes("DRAFT"), `${build.name}: final has no draft mark`);
  }
});
