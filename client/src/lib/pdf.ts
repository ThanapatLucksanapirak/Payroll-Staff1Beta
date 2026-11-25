import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { DAY_LABELS, type AnalysisResult, type DayType, type Prefs, type Site } from "@shared/schema";
import { formatDate, formatTime } from "@shared/dates";
import { downloadBlob, safeFilename } from "./doc";

type RGB = [number, number, number];
const INK: RGB = [17, 24, 39];
const MUTED: RGB = [100, 107, 117];
const RULE: RGB = [214, 218, 223];
const ZEBRA: RGB = [247, 248, 249];
const ACCENT: RGB = [15, 118, 110];
const DAY_COLOR: Record<DayType, RGB> = { full_day: [21, 101, 52], half_day: [146, 84, 0], flagged: [176, 40, 40], absent: [110, 110, 110] };

export interface PdfOptions {
  result: AnalysisResult;
  prefs: Prefs;
  site: Site;
  title: string;
  notes?: string;
  /** Only include these employee sourceIds (default: all included employees). */
  only?: string[];
}

export function buildPayrollPdf({ result, prefs, site, title, notes, only }: PdfOptions): jsPDF {
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "letter" });
  const W = pdf.internal.pageSize.getWidth();
  const H = pdf.internal.pageSize.getHeight();
  const M = 14;
  const money = (n: number) => `${n < 0 ? "-" : ""}${prefs.currencySymbol}${Math.abs(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const date = (iso: string) => (iso ? formatDate(iso, prefs.dateFormat) : "—");
  const time = (m: number | null) => (m == null ? "—" : formatTime(m, prefs.timeFormat));
  const heading = prefs.businessName || site.name || prefs.appName;

  const chromed = new Set<number>();
  const chrome = () => {
    const pg = pdf.getCurrentPageInfo().pageNumber;
    if (chromed.has(pg)) return;
    chromed.add(pg);
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(9); pdf.setTextColor(...INK);
    pdf.text(heading, M, 8);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(7); pdf.setTextColor(...MUTED);
    pdf.text(`${site.name !== heading ? `${site.name} · ` : ""}${title}`, W - M, 8, { align: "right" });
    pdf.setDrawColor(...RULE); pdf.setLineWidth(0.3); pdf.line(M, 10.5, W - M, 10.5);
    pdf.line(M, H - 9, W - M, H - 9);
    if (prefs.pdfFooter) pdf.text(prefs.pdfFooter, M, H - 5.5);
  };

  const people = result.employees.filter((e) => (only ? only.includes(e.sourceId) : !e.excluded));
  const t = people.reduce(
    (a, e) => ({ base: a.base + e.totalBasePay, dock: a.dock + e.totalDocked, pay: a.pay + e.totalPay, net: a.net + (e.isNetPay ? e.totalPay : 0), gross: a.gross + (e.isNetPay ? 0 : e.totalPay), bonus: a.bonus + e.totalBonuses, ded: a.ded + e.totalDeductions, hrs: a.hrs + e.hoursWorked }),
    { base: 0, dock: 0, pay: 0, net: 0, gross: 0, bonus: 0, ded: 0, hrs: 0 },
  );

  const sumOf = (f: (e: (typeof people)[number]) => number) => String(people.filter((e) => !e.isManual).reduce((s, e) => s + f(e), 0));

  // ── Title block ──
  chrome();
  let y = 20;
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(17); pdf.setTextColor(...INK);
  pdf.text(title, M, y);
  y += 6;
  pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.setTextColor(...MUTED);
  const genDate = formatDate(new Date().toISOString().slice(0, 10), prefs.dateFormat);
  pdf.text(`Pay period ${date(result.periodStart)} – ${date(result.periodEnd)}   ·   Generated ${genDate}`, M, y);
  y += 7;

  // ── KPI boxes ──
  const kpis: [string, string][] = [
    ["Total payroll", money(t.pay)], ["Employees", String(people.length)], ["Net pay", money(t.net)], ["Gross pay", money(t.gross)], ["Bonuses", money(t.bonus)], ["Hours", (Math.round(t.hrs * 100) / 100).toString()],
  ];
  const bw = (W - M * 2 - 5 * 4) / 6;
  kpis.forEach(([label, value], i) => {
    const x = M + i * (bw + 4);
    pdf.setFillColor(...ZEBRA); pdf.setDrawColor(...RULE); pdf.roundedRect(x, y, bw, 15, 1.5, 1.5, "FD");
    pdf.setFontSize(7); pdf.setTextColor(...MUTED); pdf.text(label.toUpperCase(), x + 3, y + 5);
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(11); pdf.setTextColor(...(i === 0 ? ACCENT : INK)); pdf.text(value, x + 3, y + 11.5);
    pdf.setFont("helvetica", "normal");
  });
  y += 21;

  if (notes?.trim()) {
    pdf.setFontSize(8); pdf.setTextColor(...MUTED);
    const lines = pdf.splitTextToSize(`Notes: ${notes.trim()}`, W - M * 2).slice(0, 4);
    pdf.text(lines, M, y);
    y += lines.length * 3.6 + 2;
  }

  const tableBase = {
    margin: { left: M, right: M, top: 15, bottom: 13 },
    styles: { font: "helvetica", fontSize: 8, cellPadding: 1.6, textColor: INK, lineColor: RULE, lineWidth: 0.1 },
    headStyles: { fillColor: [255, 255, 255] as RGB, textColor: MUTED, fontStyle: "bold" as const, fontSize: 7, lineWidth: { bottom: 0.4 } as any },
    alternateRowStyles: { fillColor: ZEBRA },
    didDrawPage: () => chrome(),
  };

  // ── Summary table ──
  autoTable(pdf, {
    ...tableBase,
    startY: y,
    head: [["Employee", "Category", "Basis", "Full", "Half", "Flagged", "Hours", "Base pay", "Docked", "Bonuses", "Deductions", "Total", "Type"]],
    body: people.map((e) => [
      e.name, e.isManual ? "Manual" : e.categoryName ?? "Custom", e.isManual ? "—" : e.payBasis === "hourly" ? `${money(e.hourlyRate)}/h` : `${money(e.fullDayRate)} / ${money(e.halfDayRate)}`,
      e.isManual ? "" : e.fullDays, e.isManual ? "" : e.halfDays, e.isManual ? "" : e.flaggedDays, e.isManual ? "" : e.hoursWorked,
      money(e.totalBasePay), e.totalDocked ? money(-e.totalDocked) : "", e.totalBonuses ? money(e.totalBonuses) : "", e.totalDeductions ? money(-e.totalDeductions) : "", money(e.totalPay), e.isNetPay ? "Net" : "Gross",
    ]),
    foot: [["Total", "", "", sumOf((e) => e.fullDays), sumOf((e) => e.halfDays), sumOf((e) => e.flaggedDays), String(Math.round(t.hrs * 100) / 100), money(t.base), t.dock ? money(-t.dock) : "", t.bonus ? money(t.bonus) : "", t.ded ? money(-t.ded) : "", money(t.pay), ""]],
    footStyles: { fillColor: [255, 255, 255] as RGB, textColor: INK, fontStyle: "bold", lineWidth: { top: 0.4 } as any },
    columnStyles: { 0: { fontStyle: "bold" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right" }, 7: { halign: "right" }, 8: { halign: "right" }, 9: { halign: "right" }, 10: { halign: "right" }, 11: { halign: "right", fontStyle: "bold" } },
  });

  // ── Per-employee detail ──
  let first = true;
  for (const e of people) {
    const prevEnd = (pdf as any).lastAutoTable?.finalY ?? 20;
    // Rough height of the block: heading + header row + one row per day/bonus line + total
    const est = 14 + (e.days.length + e.generalBonuses.length + e.generalDeductions.length + 2) * 6.2;
    let yy: number;
    if (prefs.pdfPagePerEmployee || first || prevEnd + 12 + Math.min(est, 60) > H - 13) {
      pdf.addPage();
      chrome();
      yy = 20;
    } else {
      yy = prevEnd + 12;
    }
    first = false;
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(13); pdf.setTextColor(...INK);
    pdf.text(e.name, M, yy);
    pdf.setFontSize(13); pdf.setTextColor(...ACCENT);
    pdf.text(money(e.totalPay), W - M, yy, { align: "right" });
    yy += 5;
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(8); pdf.setTextColor(...MUTED);
    const sub = e.isManual
      ? `Manual pay · ${e.isNetPay ? "Net" : "Gross"}`
      : [e.categoryName ?? "Custom rate", e.payBasis === "hourly" ? `${money(e.hourlyRate)}/h · ${e.hoursWorked} h${e.overtimeHours ? ` (${e.overtimeHours} OT)` : ""}` : `Full ${money(e.fullDayRate)} · Half ${money(e.halfDayRate)} · ${e.fullDays} full, ${e.halfDays} half${e.flaggedDays ? `, ${e.flaggedDays} flagged` : ""}`, e.isNetPay ? "Net" : "Gross"].join(" · ");
    pdf.text(sub, M, yy);
    yy += 4;

    const showTimes = prefs.pdfShowShiftTimes && !e.isManual;
    const head = showTimes ? ["Date", "In", "Out", "Hours", "Day type", "Notes", "Pay"] : ["Date", "Day type", "Notes", "Pay"];
    const body: any[] = e.days.map((d) => {
      const note = [d.notes && d.notes !== DAY_LABELS[d.dayType] && d.notes !== DAY_LABELS[d.originalDayType] ? d.notes : "", d.cancelled ? "Not paid" : "", d.dockAmount ? `Docked ${money(d.dockAmount)}` : "", d.adjustmentNote ?? "", ...d.bonuses.map((b) => `Bonus ${money(b.amount)}${b.description ? ` (${b.description})` : ""}`)].filter(Boolean).join(" · ");
      const type = d.punches ? `${DAY_LABELS[d.dayType]}${d.dayType !== d.originalDayType ? "*" : ""}` : e.isManual ? "Manual" : "—";
      const pay = money(d.pay + d.bonuses.reduce((s, b) => s + b.amount, 0));
      return showTimes ? [date(d.date), time(d.start), time(d.end), d.punches ? d.hours : "", type, note, pay] : [d.date ? date(d.date) : "Period", type, note, pay];
    });
    const pad = (cells: string[]) => [...Array(head.length - cells.length).fill(""), ...cells];
    for (const b of e.generalBonuses) body.push(pad(["Bonus", b.description || "", money(b.amount)]));
    for (const d of e.generalDeductions) body.push(pad(["Deduction", d.description || "", money(-d.amount)]));
    const typeCol = showTimes ? 4 : 1;
    const payCol = head.length - 1;

    autoTable(pdf, {
      ...tableBase,
      startY: yy,
      head: [head],
      body,
      foot: [pad(["Total", money(e.totalPay)])],
      footStyles: { fillColor: [255, 255, 255] as RGB, textColor: INK, fontStyle: "bold", lineWidth: { top: 0.4 } as any },
      columnStyles: showTimes
        ? { 0: { cellWidth: 24 }, 1: { cellWidth: 20 }, 2: { cellWidth: 20 }, 3: { cellWidth: 14, halign: "right" }, 4: { cellWidth: 22 }, 6: { cellWidth: 26, halign: "right" } }
        : { 0: { cellWidth: 28 }, 1: { cellWidth: 26 }, 3: { cellWidth: 28, halign: "right" } },
      didParseCell: (c: any) => {
        if (c.section !== "body") return;
        if (c.column.index === typeCol) {
          const key = (Object.keys(DAY_LABELS) as DayType[]).find((k) => String(c.cell.raw).startsWith(DAY_LABELS[k]));
          if (key) { c.cell.styles.textColor = DAY_COLOR[key]; c.cell.styles.fontStyle = "bold"; }
        }
        if (c.column.index === payCol && String(c.cell.raw).startsWith("-")) c.cell.styles.textColor = DAY_COLOR.flagged;
      },
    });
    if (e.days.some((d) => d.dayType !== d.originalDayType && d.punches)) {
      const fy = (pdf as any).lastAutoTable?.finalY ?? yy;
      if (fy + 6 < H - 12) { pdf.setFontSize(7); pdf.setTextColor(...MUTED); pdf.text("* Day type changed by hand", M, fy + 4); }
    }
  }

  // Page numbers
  const n = pdf.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    pdf.setPage(i);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(7); pdf.setTextColor(...MUTED);
    pdf.text(`Page ${i} of ${n}`, W - M, H - 5.5, { align: "right" });
  }
  return pdf;
}

export function downloadPayrollPdf(o: PdfOptions & { fileBase?: string }) {
  const pdf = buildPayrollPdf(o);
  downloadBlob(pdf.output("arraybuffer"), `${safeFilename(o.fileBase || o.title)}.pdf`, "application/pdf");
}

/** Summary CSV (one row per employee) — opens cleanly in Excel / Sheets. */
export function payrollSummaryCsv(result: AnalysisResult): string {
  const esc = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [["Employee", "Category", "Pay basis", "Full days", "Half days", "Flagged days", "Hours", "Overtime hours", "Base pay", "Docked", "Bonuses", "Deductions", "Total pay", "Net/Gross", "Included"]];
  for (const e of result.employees) {
    rows.push([e.name, e.isManual ? "Manual" : e.categoryName ?? "Custom", e.payBasis, e.fullDays, e.halfDays, e.flaggedDays, e.hoursWorked, e.overtimeHours, e.totalBasePay, e.totalDocked, e.totalBonuses, e.totalDeductions, e.totalPay, e.isNetPay ? "Net" : "Gross", e.excluded ? "No" : "Yes"].map(String));
  }
  return rows.map((r) => r.map(esc).join(",")).join("\r\n");
}
