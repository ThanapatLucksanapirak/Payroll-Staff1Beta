// Full payroll report: overview page (header, total, KPIs, summary table) then
// a detail block per employee.
import type { jsPDF } from "jspdf";
import { autoTable, type CellHookData, type RowInput } from "jspdf-autotable";
import { DAY_LABELS, type DayResult, type DayType, type EmployeeSummary } from "@shared/schema";
import { dayNote, pdfText } from "./format";
import {
  C, type Ctx, type PdfOptions, basisText, brandHeader, createCtx, finishPages, fitText, flushEdges, font, hero, lastY, newPage,
  fitColumns, notesBlock, paymentText, payoutLine, people, sectionTitle, statusCell, summaryTable, tableBase, totalsOf, workedText, wrapText,
} from "./kit";

export function buildPayrollPdf(o: PdfOptions): jsPDF {
  const ctx = createCtx(o);
  const list = people(o);
  const t = totalsOf(list);

  let y = brandHeader(ctx, "Payroll report", [{ text: o.title, bold: true }, { text: o.result.periodStart ? `Pay period ${ctx.periodText}` : "No shifts yet" }]);
  y = hero(ctx, y, t);
  y = notesBlock(ctx, y, o.notes);
  y = sectionTitle(ctx, y + 2, "Summary", list.length ? plainCount(list) : undefined);
  if (!list.length) {
    font(ctx, 9, "normal", C.muted);
    ctx.pdf.text("No employees to report for this period.", ctx.M, y + 8);
  } else {
    summaryTable(ctx, list, y + 1, t);
    const line = payoutLine(list, ctx.fmt);
    const fy = lastY(ctx, y);
    if (line && fy + 8 < ctx.bottom) {
      font(ctx, 8, "bold", C.ink);
      ctx.pdf.text("Pay out", ctx.M, fy + 6);
      font(ctx, 8, "normal", C.body);
      ctx.pdf.text(fitText(ctx, line, ctx.W - 2 * ctx.M - 18), ctx.M + 14, fy + 6);
      (ctx.pdf as any).lastAutoTable.finalY = fy + 6;
    }
  }
  markContinuation(ctx, 2, "Summary");

  // ── Employee detail ──
  let first = true;
  for (const e of list) {
    const est = blockStart(ctx, e);
    let yy: number;
    if (first || ctx.o.prefs.pdfPagePerEmployee) {
      yy = newPage(ctx) + 6;
      if (first) { yy = sectionTitle(ctx, yy, "Employee detail") + 9; }
    } else {
      yy = lastY(ctx, ctx.top) + 12;
      if (yy + est > ctx.bottom) yy = newPage(ctx) + 6;
    }
    first = false;
    employeeBlock(ctx, e, yy);
  }

  finishPages(ctx);
  return ctx.pdf;
}

function plainCount(list: EmployeeSummary[]): string {
  const manual = list.filter((e) => e.isManual).length;
  return `${list.length} employee${list.length === 1 ? "" : "s"}${manual ? ` · ${manual} manual` : ""}`;
}

/** Give every page from `from` onward that autoTable added a running header. */
function markContinuation(ctx: Ctx, from: number, sub: string) {
  for (let i = from; i <= ctx.pdf.getNumberOfPages(); i++) if (!ctx.running.has(i)) ctx.running.set(i, sub);
}

/** Space needed to keep the employee header with its table head and first rows. */
function blockStart(ctx: Ctx, e: EmployeeSummary): number {
  const rows = Math.min(3, Math.max(1, e.days.length + e.generalBonuses.length + e.generalDeductions.length));
  return 16 + 7 + rows * 6.5 + (rows === e.days.length + e.generalBonuses.length + e.generalDeductions.length ? 8 : 0);
}

interface RowMeta { status: DayType | null; cancelled?: boolean; edited?: boolean; kind: "day" | "extra" }

function employeeBlock(ctx: Ctx, e: EmployeeSummary, y: number) {
  const { pdf, M, W, fmt, o } = ctx;
  const startPage = pdf.getCurrentPageInfo().pageNumber;

  // Header: name (wraps to 2 lines) + total on the right
  const total = fmt.money(e.totalPay);
  font(ctx, 13, "bold", C.ink);
  const totalW = pdf.getTextWidth(total);
  pdf.text(total, W - M, y, { align: "right" });
  const nameLines = wrapText(ctx, pdfText(e.name), W - 2 * M - totalW - 10, 2);
  pdf.text(nameLines, M, y);
  y += (nameLines.length - 1) * 5.4 + 5;
  font(ctx, 8.5, "normal", C.muted);
  const rates = e.isManual ? basisText(e, fmt) : [basisText(e, fmt), workedText(e, fmt)].filter((s) => s && s !== "—").join("  ·  ");
  const paid = paymentText(e, fmt);
  pdf.text(fitText(ctx, `${rates}  ·  ${e.isNetPay ? "Net pay" : "Gross pay"}${paid ? `  ·  Paid by ${paid.charAt(0).toLowerCase()}${paid.slice(1)}` : ""}`, W - 2 * M - totalW - 10), M, y);
  y += 3.5;

  const showTimes = o.prefs.pdfShowShiftTimes && !e.isManual;
  const anyDock = e.days.some((d) => d.dockAmount > 0 || (d.cancelled && d.basePay > 0));
  const anyBonus = e.days.some((d) => d.bonuses.length > 0);
  const anyEdited = e.days.some((d) => d.punches > 0 && d.dayType !== d.originalDayType);

  type Col = { key: string; label: string; right?: boolean; wrap?: boolean };
  const cols: Col[] = e.isManual
    ? [{ key: "date", label: "Date" }, { key: "note", label: "Description" }, { key: "pay", label: "Pay", right: true }]
    : [
      { key: "date", label: "Date" },
      ...(showTimes ? [{ key: "in", label: "In" }, { key: "out", label: "Out" }] : []),
      { key: "hours", label: "Hours", right: true },
      { key: "status", label: "Status" },
      { key: "note", label: "Note" },
      ...(anyDock ? [{ key: "base", label: "Base", right: true }, { key: "dock", label: "Docked", right: true }] : []),
      ...(anyBonus ? [{ key: "bonus", label: "Bonus", right: true }] : []),
      { key: "pay", label: "Pay", right: true },
    ];
  const idx = (k: string) => cols.findIndex((c) => c.key === k);
  const meta: RowMeta[] = [];
  const body: RowInput[] = [];

  for (const d of e.days) {
    const bonus = d.bonuses.reduce((s, b) => s + b.amount, 0);
    const cells: Record<string, string> = {
      date: d.date ? fmt.day(d.date) : e.isManual ? "Period" : "—",
      in: d.punches ? fmt.time(d.start) : "",
      out: d.punches ? fmt.time(d.end) : "",
      hours: d.punches ? fmt.hours(d.hours) + (d.overtimeHours ? `*` : "") : "",
      status: d.punches ? `${DAY_LABELS[d.dayType]}${d.dayType !== d.originalDayType ? " *" : ""}` : "",
      note: e.isManual ? pdfText(d.notes || "Manual pay") : d.punches ? dayNote(d, fmt) : dayNote(d, fmt) || pdfText(d.notes),
      base: d.punches ? fmt.money(d.basePay) : "",
      dock: d.dockAmount ? fmt.money(-d.dockAmount) : d.cancelled && d.basePay ? fmt.money(-d.basePay) : "",
      bonus: bonus ? `+${fmt.money(bonus)}` : "",
      pay: fmt.money(d.pay + bonus),
    };
    if (d.overtimeHours) cells.note = [`${fmt.hours(d.overtimeHours)} h overtime`, cells.note].filter(Boolean).join(" · ");
    body.push(cols.map((c) => cells[c.key] ?? ""));
    meta.push({ status: d.punches ? d.dayType : null, cancelled: d.cancelled, edited: d.punches > 0 && d.dayType !== d.originalDayType, kind: "day" });
  }
  const span = cols.length - 1;
  for (const b of e.generalBonuses) {
    body.push([{ content: `Bonus${b.description ? ` — ${pdfText(b.description)}` : ""}`, colSpan: span }, `+${fmt.money(b.amount)}`]);
    meta.push({ status: null, kind: "extra" });
  }
  for (const d of e.generalDeductions) {
    body.push([{ content: `Deduction${d.description ? ` — ${pdfText(d.description)}` : ""}`, colSpan: span }, fmt.money(-d.amount)]);
    meta.push({ status: null, kind: "extra" });
  }
  if (!body.length) {
    body.push([{ content: "No days in this period", colSpan: cols.length }]);
    meta.push({ status: null, kind: "extra" });
  }

  const breakdown = [
    `Base ${fmt.money(e.totalBasePay + e.totalDocked)}`,
    e.totalDocked ? `Docked ${fmt.money(-e.totalDocked)}` : "",
    e.totalBonuses ? `Bonuses +${fmt.money(e.totalBonuses)}` : "",
    e.totalDeductions ? `Deductions ${fmt.money(-e.totalDeductions)}` : "",
  ].filter(Boolean).join("   ·   ");
  const foot: RowInput[] = [[
    { content: breakdown, colSpan: Math.max(1, cols.length - 2), styles: { fontStyle: "normal", textColor: C.muted, fontSize: 7.5 } },
    { content: "Total", styles: { halign: "right" } },
    { content: fmt.money(e.totalPay), styles: { halign: "right" } },
  ]];
  if (cols.length < 3) foot[0] = [{ content: "Total", styles: { halign: "right" } }, fmt.money(e.totalPay)] as any;

  const fs = ctx.W > 250 ? 8 : 7.5;
  const columnStyles: Record<number, any> = {};
  cols.forEach((c, i) => {
    columnStyles[i] = c.key === "note"
      ? { cellWidth: "auto", textColor: C.muted, fontSize: fs - 0.5 }
      : { cellWidth: "wrap", halign: c.right ? "right" : "left" };
    if (c.key === "pay") columnStyles[i] = { ...columnStyles[i], textColor: C.ink, fontStyle: "bold" };
    if (c.key === "status") columnStyles[i] = { ...columnStyles[i], minCellWidth: 19 };
    if (c.key === "date") columnStyles[i] = { ...columnStyles[i], textColor: C.ink };
  });

  const widths = fitColumns(ctx, fs, cols.map((c) => c.label), body as unknown[][], idx("note") >= 0 ? idx("note") : 1, { bold: [idx("pay")], extra: { [idx("status")]: 3 } });
  if (widths) for (const [i, w] of Object.entries(widths)) columnStyles[+i] = { ...columnStyles[+i], cellWidth: w };
  const sub = fitText(ctx, pdfText(e.name), 60);
  autoTable(pdf, {
    ...tableBase(ctx, fs, 1.7),
    startY: y + 1.5,
    head: [cols.map((c) => ({ content: c.label, styles: { halign: c.right ? "right" : "left" } }))],
    body,
    foot,
    columnStyles,
    didParseCell: (d: CellHookData) => {
      flushEdges(d);
      if (d.section !== "body") return;
      const m = meta[d.row.index];
      if (!m) return;
      if (m.kind === "extra") {
        d.cell.styles.textColor = d.column.index === 0 ? C.body : String(d.cell.raw).startsWith("–") ? C.negative : C.ink;
        if (d.column.index > 0) { d.cell.styles.halign = "right"; d.cell.styles.fontStyle = "bold"; }
        return;
      }
      const key = cols[d.column.index]?.key;
      if (key === "status") statusCell.parse(d, m.status, m);
      if (key === "dock" && d.cell.raw) d.cell.styles.textColor = C.negative;
      if (key === "bonus" && d.cell.raw) d.cell.styles.textColor = C.accent;
      if (m.cancelled && (key === "pay" || key === "date" || key === "hours")) d.cell.styles.textColor = C.faint;
    },
    didDrawCell: (d: CellHookData) => {
      if (d.section !== "body" || cols[d.column.index]?.key !== "status") return;
      const m = meta[d.row.index];
      if (m?.kind === "day") statusCell.draw(d, m.status, m);
    },
    didDrawPage: (d) => {
      if (d.pageNumber > 1 && !ctx.running.has(pdf.getCurrentPageInfo().pageNumber)) ctx.running.set(pdf.getCurrentPageInfo().pageNumber, `${sub} (continued)`);
    },
  });
  void startPage;

  const notes: string[] = [];
  if (anyEdited) notes.push("* Status changed by hand");
  if (e.days.some((d) => d.overtimeHours)) notes.push("Hours marked * include overtime");
  if (notes.length) {
    const fy = lastY(ctx, y);
    if (fy + 5 < ctx.bottom) { font(ctx, 7, "normal", C.faint); pdf.text(notes.join("   ·   "), M, fy + 4); (pdf as any).lastAutoTable.finalY = fy + 4; }
  }
}

export type { DayResult };
