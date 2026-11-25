// Individual pay statements: one portrait page per employee, suitable to hand out.
import type { jsPDF } from "jspdf";
import { autoTable, type CellHookData, type RowInput } from "jspdf-autotable";
import type { DayType, EmployeeSummary } from "@shared/schema";
import { DAY_LABELS } from "@shared/schema";
import { type Fmt, dayNote, pdfText } from "./format";
import {
  C, type Ctx, type PdfOptions, basisText, brandHeader, createCtx, daysText, eyebrow, finishPages, fitColumns, fitText, flushEdges, font,
  hairline, lastY, people, plural, sectionTitle, shrinkToFit, statusCell, tableBase, wrapText,
} from "./kit";

type Line = { desc: string; detail: string; amount: number | null };

/** Earnings lines that add up (with bonuses and deductions) to totalPay. */
export function earningsLines(e: EmployeeSummary, fmt: Fmt): Line[] {
  const out: Line[] = [];
  if (e.isManual) {
    for (const d of e.days) out.push({ desc: pdfText(d.notes || "Manual pay"), detail: d.date ? fmt.date(d.date) : "This pay period", amount: d.basePay });
    if (!e.days.length) out.push({ desc: "Manual pay", detail: "", amount: 0 });
    return out;
  }
  const live = e.days.filter((d) => d.punches > 0 && !d.cancelled);
  if (e.payBasis === "hourly") {
    const worked = live.filter((d) => d.dayType !== "absent");
    const base = worked.reduce((s, d) => s + d.basePay, 0);
    const ot = worked.reduce((s, d) => s + d.overtimeHours, 0);
    const reg = worked.reduce((s, d) => s + d.hours, 0) - ot;
    const regPay = ot ? Math.round(reg * e.hourlyRate * 100) / 100 : base;
    out.push({ desc: "Regular hours", detail: `${fmt.hours(reg)} h × ${fmt.money(e.hourlyRate)}`, amount: regPay });
    if (ot) out.push({ desc: "Overtime hours", detail: `${fmt.hours(ot)} h × ${fmt.money((base - regPay) / ot)}`, amount: base - regPay });
  } else {
    const types: DayType[] = ["full_day", "half_day", "flagged"];
    for (const type of types) {
      const ds = live.filter((d) => d.dayType === type);
      if (!ds.length) continue;
      const sum = ds.reduce((s, d) => s + d.basePay, 0);
      const same = ds.every((d) => d.basePay === ds[0].basePay);
      const label = type === "flagged" ? (sum ? "Flagged days" : "Flagged days (unpaid)") : `${DAY_LABELS[type]}s`;
      out.push({ desc: label, detail: same ? `${ds.length} × ${fmt.money(ds[0].basePay)}` : plural(ds.length, "day"), amount: sum });
    }
    if (!out.length) out.push({ desc: "Days worked", detail: "None this period", amount: 0 });
  }
  if (e.totalDocked) out.push({ desc: "Docked", detail: plural(e.days.filter((d) => d.dockAmount > 0).length, "day"), amount: -e.totalDocked });
  const cancelled = e.days.filter((d) => d.cancelled).length;
  if (cancelled) out.push({ desc: "Not paid", detail: `${plural(cancelled, "day")} cancelled`, amount: null });
  return out;
}

export function buildPayStatementsPdf(o: PdfOptions): jsPDF {
  const ctx = createCtx(o, { orientation: "portrait" });
  const list = people(o);
  if (!list.length) {
    const y = brandHeader(ctx, "Pay statement", [{ text: ctx.periodText, bold: true }]);
    font(ctx, 10, "normal", C.muted);
    ctx.pdf.text("No employees to include for this period.", ctx.M, y + 6);
  }
  list.forEach((e, i) => {
    if (i > 0) ctx.pdf.addPage();
    const first = ctx.pdf.getCurrentPageInfo().pageNumber;
    statement(ctx, e);
    const last = ctx.pdf.getNumberOfPages();
    // Number pages per statement so each one stands alone when handed out.
    for (let p = first; p <= last; p++) ctx.pageLabels.set(p, `${list.length > 1 ? `${fitText(ctx, pdfText(e.name), 45)} · ` : ""}Page ${p - first + 1} of ${last - first + 1}`);
  });
  finishPages(ctx);
  return ctx.pdf;
}

function statement(ctx: Ctx, e: EmployeeSummary) {
  const { pdf, M, W, fmt, o } = ctx;
  const right = [{ text: ctx.periodText, bold: true }, { text: o.payDate ? `Pay date ${fmt.date(o.payDate)}` : "Pay period" }];
  let y = brandHeader(ctx, "Pay statement", right);
  const firstPage = pdf.getCurrentPageInfo().pageNumber;
  const name = pdfText(e.name);

  // ── Employee + total box ──
  const boxW = 66;
  const boxH = 27;
  const leftW = W - 2 * M - boxW - 10;
  eyebrow(ctx, "Employee", M, y + 1);
  font(ctx, 18, "bold", C.ink);
  const nl = wrapText(ctx, name, leftW, 2);
  pdf.text(nl, M, y + 9);
  let ly = y + 9 + (nl.length - 1) * 7.2 + 5.5;
  font(ctx, 9, "normal", C.muted);
  pdf.text(fitText(ctx, basisText(e, fmt), leftW), M, ly);
  ly += 4.4;
  pdf.text(fitText(ctx, [pdfText(o.site.name), e.isNetPay ? "Net pay" : "Gross pay"].filter(Boolean).join("  ·  "), leftW), M, ly);

  const bx = W - M - boxW;
  pdf.setFillColor(...C.accentWash);
  pdf.roundedRect(bx, y - 2, boxW, boxH, 2.5, 2.5, "F");
  eyebrow(ctx, "Total pay", bx + 6, y + 4.5, { color: C.accent });
  const amt = fmt.money(e.totalPay);
  font(ctx, 21, "bold", e.totalPay < 0 ? C.negative : C.ink);
  shrinkToFit(ctx, amt, 21, boxW - 12, 11);
  pdf.text(amt, bx + 6, y + 14);
  font(ctx, 7.5, "normal", C.muted);
  pdf.text(e.isNetPay ? "Net pay · take-home amount" : "Gross pay · before tax", bx + 6, y + 20.5);
  y = Math.max(ly, y + boxH - 2) + 8;

  // ── Stat strip ──
  hairline(ctx, y);
  const stats: [string, string][] = e.isManual
    ? [["Pay type", e.days.some((d) => d.key !== "lump") ? "By date" : "Lump sum"], ["Payments", String(e.days.length)], ["Bonuses", e.totalBonuses ? fmt.money(e.totalBonuses) : "—"], ["Deductions", e.totalDeductions ? fmt.money(-e.totalDeductions) : "—"]]
    : [
      ["Days worked", String(e.fullDays + e.halfDays + e.flaggedDays)],
      [e.payBasis === "hourly" ? "Hours" : "Full · half · flagged", e.payBasis === "hourly" ? fmt.hours(e.hoursWorked) : `${e.fullDays} · ${e.halfDays} · ${e.flaggedDays}`],
      [e.payBasis === "hourly" ? "Overtime" : "Hours", e.payBasis === "hourly" ? (e.overtimeHours ? fmt.hours(e.overtimeHours) : "—") : e.hoursWorked ? fmt.hours(e.hoursWorked) : "—"],
      ["Bonuses", e.totalBonuses ? fmt.money(e.totalBonuses) : "—"],
    ];
  const sw = (W - 2 * M) / stats.length;
  stats.forEach(([label, value], i) => {
    const x = M + i * sw;
    font(ctx, 7.5, "normal", C.muted);
    pdf.text(label, x, y + 5.5);
    font(ctx, 11.5, "bold", C.ink);
    pdf.text(fitText(ctx, value, sw - 4), x, y + 11.5);
  });
  y += 15.5;
  hairline(ctx, y);
  y += 9;

  // ── Earnings / bonuses / deductions ──
  y = sectionTitle(ctx, y, "Earnings");
  const body: RowInput[] = [];
  const kinds: ("section" | "line")[] = [];
  const push = (cells: RowInput, kind: "section" | "line") => { body.push(cells); kinds.push(kind); };
  for (const l of earningsLines(e, fmt)) push([l.desc, l.detail, l.amount == null ? "—" : fmt.money(l.amount)], "line");
  const bonuses = [
    ...e.days.flatMap((d) => d.bonuses.map((b) => ({ desc: pdfText(b.description || "Bonus"), detail: d.date ? fmt.date(d.date) : "", amount: b.amount }))),
    ...e.generalBonuses.map((b) => ({ desc: pdfText(b.description || "Bonus"), detail: "", amount: b.amount })),
  ];
  if (bonuses.length) {
    push([{ content: "Bonuses", colSpan: 3 }], "section");
    for (const b of bonuses) push([b.desc, b.detail, `+${fmt.money(b.amount)}`], "line");
  }
  if (e.generalDeductions.length) {
    push([{ content: "Deductions", colSpan: 3 }], "section");
    for (const d of e.generalDeductions) push([pdfText(d.description || "Deduction"), "", fmt.money(-d.amount)], "line");
  }
  autoTable(pdf, {
    ...tableBase(ctx, 9, 1.75),
    startY: y + 1,
    head: [["Description", "Details", { content: "Amount", styles: { halign: "right" } }]],
    body,
    foot: [[{ content: e.isNetPay ? "Total net pay" : "Total gross pay", colSpan: 2 }, { content: fmt.money(e.totalPay), styles: { halign: "right" } }]],
    columnStyles: { 0: { textColor: C.ink, cellWidth: "auto" }, 1: { textColor: C.muted, cellWidth: "auto" }, 2: { halign: "right", cellWidth: 38 } },
    didParseCell: (d: CellHookData) => {
      flushEdges(d);
      if (d.section === "foot") { d.cell.styles.fontSize = 10.5; d.cell.styles.cellPadding = { ...(d.cell.styles.cellPadding as any), top: 3, bottom: 3 }; }
      if (d.section !== "body") return;
      if (kinds[d.row.index] === "section") {
        d.cell.styles.fontStyle = "bold"; d.cell.styles.fontSize = 7; d.cell.styles.textColor = C.muted;
        d.cell.styles.cellPadding = { top: 3.6, bottom: 1.2, left: 0, right: 0 };
      } else if (d.column.index === 2) {
        const raw = String(d.cell.raw);
        d.cell.styles.textColor = raw.startsWith("–") ? C.negative : raw.startsWith("+") ? C.accent : raw === "—" ? C.faint : C.ink;
      }
    },
    didDrawPage: () => { const pg = pdf.getCurrentPageInfo().pageNumber; if (pg > firstPage) ctx.running.set(pg, `${fitText(ctx, name, 50)} (continued)`); },
  });
  y = lastY(ctx, y) + 10;

  // ── Day-by-day ──
  if (e.days.length && !e.isManual) {
    if (y + 20 > ctx.bottom) { pdf.addPage(); ctx.running.set(pdf.getCurrentPageInfo().pageNumber, `${fitText(ctx, name, 50)} (continued)`); y = ctx.top + 2; }
    y = sectionTitle(ctx, y, "Daily detail", plural(e.days.filter((d) => d.punches).length, "day"));
    y = dailyDetail(ctx, e, y + 1, o.prefs.pdfSignatureLine ? 16 : 0, (pg) => { if (pg > firstPage) ctx.running.set(pg, `${fitText(ctx, name, 50)} (continued)`); });
  }

  // ── Signature ──
  if (o.prefs.pdfSignatureLine) {
    if (y + 14 > ctx.bottom) { pdf.addPage(); ctx.running.set(pdf.getCurrentPageInfo().pageNumber, `${fitText(ctx, name, 50)} (continued)`); y = ctx.top; }
    const sy = Math.max(y + 10, ctx.bottom - 8);
    const sigW = (W - 2 * M) * 0.55;
    hairline(ctx, sy, M, M + sigW, C.ruleStrong, 0.25);
    hairline(ctx, sy, M + sigW + 12, W - M, C.ruleStrong, 0.25);
    font(ctx, 7.5, "normal", C.muted);
    pdf.text(`Received by ${fitText(ctx, name, sigW - 30)}`, M, sy + 4);
    pdf.text("Date", M + sigW + 12, sy + 4);
  }
}

/**
 * Compact day table. Picks the roomiest layout that still fits on the page:
 * normal rows, tighter rows, then two side-by-side half-width tables (no notes).
 */
function dailyDetail(ctx: Ctx, e: EmployeeSummary, y: number, reserve: number, onPage: (pg: number) => void): number {
  const { pdf, M, W, fmt, o } = ctx;
  const showTimes = o.prefs.pdfShowShiftTimes;
  const meta = e.days.map((d) => ({ status: d.punches ? d.dayType : null, cancelled: d.cancelled, edited: d.punches > 0 && d.dayType !== d.originalDayType }));
  const status = (i: number) => (meta[i].status ? `${DAY_LABELS[meta[i].status!]}${meta[i].edited ? " *" : ""}` : "");
  const cells = (withNote: boolean) => e.days.map((d, i) => {
    const pay = fmt.money(d.pay + d.bonuses.reduce((s, b) => s + b.amount, 0));
    const note = dayNote(d, fmt, { includeMoney: true }) || (d.punches ? "" : pdfText(d.notes));
    const hrs = d.punches ? fmt.hours(d.hours) : "";
    const times = showTimes ? [d.punches ? fmt.time(d.start) : "", d.punches ? fmt.time(d.end) : ""] : [];
    return [fmt.day(d.date), ...times, hrs, status(i), ...(withNote ? [note] : []), pay];
  });
  const headFor = (withNote: boolean) => ["Date", ...(showTimes ? ["In", "Out"] : []), "Hours", "Status", ...(withNote ? ["Note"] : []), "Pay"];

  const avail = ctx.bottom - reserve - y - 8;
  const rowH = (fs: number, pad: number) => fs * 0.3528 * 1.2 + 2 * pad;
  const layouts = [
    { fs: 7.5, pad: 1.15, split: false },
    { fs: 7, pad: 0.75, split: false },
    { fs: 7, pad: 0.8, split: true },
  ];
  const n = e.days.length;
  const pick = layouts.find((l) => (l.split ? Math.ceil(n / 2) : n) * rowH(l.fs, l.pad) <= avail) ?? layouts[0];

  const draw = (rows: string[][], rowMeta: typeof meta, head: string[], left: number, width: number, startY: number) => {
    const statusIdx = head.indexOf("Status");
    const flex = head.includes("Note") ? head.indexOf("Note") : statusIdx;
    const columnStyles: Record<number, any> = {};
    head.forEach((h, i) => { columnStyles[i] = { cellWidth: "wrap", halign: h === "Hours" || h === "Pay" ? "right" : "left", textColor: h === "Note" ? C.muted : h === "Date" || h === "Pay" ? C.ink : C.body, overflow: h === "Note" ? "ellipsize" : "visible" }; });
    const widths = fitColumns(ctx, pick.fs, head, rows, flex, { extra: { [statusIdx]: 3 }, avail: width, gap: pick.split ? 2.5 : 4 });
    if (widths) for (const [i, w] of Object.entries(widths)) columnStyles[+i] = { ...columnStyles[+i], cellWidth: w };
    autoTable(pdf, {
      ...tableBase(ctx, pick.fs, pick.pad),
      startY,
      margin: { left, right: W - left - width, top: ctx.top, bottom: ctx.H - ctx.bottom },
      tableWidth: width,
      head: [head.map((h) => ({ content: h, styles: { halign: h === "Hours" || h === "Pay" ? "right" : "left" } }))],
      body: rows,
      columnStyles,
      didParseCell: (d: CellHookData) => {
        flushEdges(d);
        if (d.section !== "body") return;
        const m = rowMeta[d.row.index];
        if (d.column.index === statusIdx) statusCell.parse(d, m.status, m);
        else if (m.cancelled) d.cell.styles.textColor = C.faint;
      },
      didDrawCell: (d: CellHookData) => { if (d.section === "body" && d.column.index === statusIdx) statusCell.draw(d, rowMeta[d.row.index].status, rowMeta[d.row.index]); },
      didDrawPage: () => onPage(pdf.getCurrentPageInfo().pageNumber),
    });
    return lastY(ctx, startY);
  };

  let end: number;
  if (pick.split) {
    const rows = cells(false);
    const head = headFor(false);
    const half = Math.ceil(n / 2);
    const gap = 8;
    const colW = (W - 2 * M - gap) / 2;
    const page = pdf.getCurrentPageInfo().pageNumber;
    const a = draw(rows.slice(0, half), meta.slice(0, half), head, M, colW, y);
    pdf.setPage(page);
    const b = draw(rows.slice(half), meta.slice(half), head, M + colW + gap, colW, y);
    end = Math.max(a, b);
  } else {
    end = draw(cells(true), meta, headFor(true), M, W - 2 * M, y);
  }
  y = end + 4;
  if (meta.some((m) => m.edited)) { font(ctx, 7, "normal", C.faint); pdf.text("* Status changed by a manager", M, y + 1); y += 4; }
  return y;
}
