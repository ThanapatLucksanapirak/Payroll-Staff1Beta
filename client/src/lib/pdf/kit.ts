// Shared page layout for every PDF: page setup, brand header, compact header,
// footer, KPI hero and the summary table. Pure (no DOM), so it runs in Node.
import { jsPDF } from "jspdf";
import { autoTable, type CellHookData, type RowInput, type UserOptions } from "jspdf-autotable";
import { DAY_LABELS, type AnalysisResult, type DayType, type EmployeeSummary, type Prefs, type Site } from "@shared/schema";
import { formatDate, formatTime } from "@shared/dates";
import { type Fmt, localStamp, makeFmt, pdfText } from "./format";

export type RGB = [number, number, number];

/** Palette: near-black ink, three greys, one accent. */
export const C = {
  ink: [29, 29, 31] as RGB,
  body: [52, 52, 56] as RGB,
  muted: [110, 110, 115] as RGB,
  faint: [150, 150, 155] as RGB,
  rule: [224, 224, 228] as RGB,
  ruleStrong: [60, 60, 64] as RGB,
  wash: [246, 246, 248] as RGB,
  accent: [0, 102, 204] as RGB,
  accentWash: [236, 244, 253] as RGB,
  negative: [196, 43, 28] as RGB,
};

export const STATUS_COLOR: Record<DayType, RGB> = {
  full_day: [40, 167, 69],
  half_day: [242, 153, 0],
  flagged: [220, 53, 45],
  absent: [160, 160, 165],
};

export interface PdfOptions {
  result: AnalysisResult;
  prefs: Prefs;
  site: Site;
  title: string;
  notes?: string;
  /** Only include these employee sourceIds (default: every included employee). Excluded employees are always left out. */
  only?: string[];
  /** Optional pay date shown on pay statements (ISO). */
  payDate?: string;
  /** Override the "generated" timestamp (tests). */
  generatedAt?: Date;
  /** Year-to-date gross / net by employee key, printed on pay statements. */
  ytd?: Record<string, { gross: number; net: number }>;
  ytdYear?: number;
  /** Bills and coins for the pay-out sheet (omit to leave the breakdown out). */
  cash?: { denominations: number[]; roundCash: boolean };
  /** Override pref orientation / size. */
  orientation?: "portrait" | "landscape";
  pageSize?: "letter" | "a4";
}

export interface Ctx {
  pdf: jsPDF;
  W: number;
  H: number;
  M: number;
  /** First usable y on pages with the compact header. */
  top: number;
  /** Last usable y before the footer. */
  bottom: number;
  fmt: Fmt;
  o: PdfOptions;
  heading: string;
  /** Pages that get the compact running header, with an optional subtitle. */
  running: Map<number, string>;
  /** Footer page label overrides (e.g. per-statement numbering). */
  pageLabels: Map<number, string>;
  periodText: string;
}

export function people(o: PdfOptions): EmployeeSummary[] {
  return o.result.employees.filter((e) => !e.excluded && (!o.only || o.only.includes(e.sourceId)));
}

export function createCtx(o: PdfOptions, force?: { orientation?: "portrait" | "landscape" }): Ctx {
  const orientation = force?.orientation ?? o.orientation ?? o.prefs.pdfOrientation ?? "landscape";
  const format = o.pageSize ?? o.prefs.pdfPageSize ?? "letter";
  const pdf = new jsPDF({ orientation, unit: "mm", format, compress: true });
  pdf.setProperties({ title: pdfText(o.title), creator: pdfText(o.prefs.appName || "Payroll Admin") });
  pdf.setLineHeightFactor(1.2);
  const W = pdf.internal.pageSize.getWidth();
  const H = pdf.internal.pageSize.getHeight();
  const M = orientation === "landscape" ? 15 : 16;
  const fmt = makeFmt(o.prefs);
  const heading = pdfText(o.prefs.businessName || o.site.name || o.prefs.appName);
  return { pdf, W, H, M, top: M + 13, bottom: H - 17, fmt, o, heading, running: new Map(), pageLabels: new Map(), periodText: fmt.period(o.result.periodStart, o.result.periodEnd) };
}

// ── Low-level text helpers ───────────────────────────────────────────────────
export function font(ctx: Ctx, size: number, style: "normal" | "bold" = "normal", color: RGB = C.ink) {
  ctx.pdf.setFont("helvetica", style);
  ctx.pdf.setFontSize(size);
  ctx.pdf.setTextColor(...color);
}

/** Fit a single line into `maxW` by trimming with an ellipsis. */
export function fitText(ctx: Ctx, s: string, maxW: number): string {
  const pdf = ctx.pdf;
  if (pdf.getTextWidth(s) <= maxW) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (pdf.getTextWidth(s.slice(0, mid).trimEnd() + "…") <= maxW) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo).trimEnd() + "…";
}

/** Wrap into at most `maxLines` lines, ellipsizing the last. */
export function wrapText(ctx: Ctx, s: string, maxW: number, maxLines: number): string[] {
  const lines: string[] = ctx.pdf.splitTextToSize(s, maxW);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = fitText(ctx, lines.slice(maxLines - 1).join(" "), maxW);
  return kept;
}

/** Largest font size ≤ `size` at which `s` fits in `maxW`. */
export function shrinkToFit(ctx: Ctx, s: string, size: number, maxW: number, min = 10): number {
  let fs = size;
  ctx.pdf.setFontSize(fs);
  while (fs > min && ctx.pdf.getTextWidth(s) > maxW) { fs -= 0.5; ctx.pdf.setFontSize(fs); }
  return fs;
}

export function hairline(ctx: Ctx, y: number, x1 = ctx.M, x2 = ctx.W - ctx.M, color: RGB = C.rule, w = 0.2) {
  ctx.pdf.setDrawColor(...color);
  ctx.pdf.setLineWidth(w);
  ctx.pdf.line(x1, y, x2, y);
}

/** Small spaced-out uppercase label. */
export function eyebrow(ctx: Ctx, s: string, x: number, y: number, opts: { align?: "left" | "right"; color?: RGB } = {}) {
  font(ctx, 7, "bold", opts.color ?? C.muted);
  const text = s.toUpperCase();
  const cs = 0.4;
  // Letter-spaced by hand: jsPDF's charSpace can't be measured or right-aligned reliably.
  const chars = [...text];
  const w = chars.reduce((s, ch) => s + ctx.pdf.getTextWidth(ch), 0) + cs * (chars.length - 1);
  let cx = opts.align === "right" ? x - w : x;
  for (const ch of chars) { if (ch !== " ") ctx.pdf.text(ch, cx, y); cx += ctx.pdf.getTextWidth(ch) + cs; }
}

// ── Logo ─────────────────────────────────────────────────────────────────────
export function isValidLogo(dataUrl: string | undefined): dataUrl is string {
  return !!dataUrl && /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=\s]+$/.test(dataUrl);
}

/** Draw the logo inside a box keeping its aspect ratio; returns drawn width (0 if none). */
export function drawLogo(ctx: Ctx, x: number, y: number, maxW: number, maxH: number): { w: number; h: number } {
  const url = ctx.o.prefs.pdfLogoDataUrl;
  if (!isValidLogo(url)) return { w: 0, h: 0 };
  try {
    const props = ctx.pdf.getImageProperties(url);
    if (!props.width || !props.height) return { w: 0, h: 0 };
    const k = Math.min(maxW / props.width, maxH / props.height);
    const w = props.width * k;
    const h = props.height * k;
    ctx.pdf.addImage(url, props.fileType === "PNG" ? "PNG" : "JPEG", x, y, w, h, "logo", "FAST");
    return { w, h };
  } catch {
    return { w: 0, h: 0 };
  }
}

// ── Headers & footer ─────────────────────────────────────────────────────────
/**
 * Full brand header for the first page of a document (or of a pay statement).
 * Left: logo, business name, location + address. Right: eyebrow + title lines.
 * Returns the y below the header rule.
 */
export function brandHeader(ctx: Ctx, eyebrowText: string, rightLines: { text: string; bold?: boolean }[]): number {
  const { pdf, M, W, o } = ctx;
  const y0 = M;
  const logo = drawLogo(ctx, M, y0 - 1, 42, 15);
  const textX = M + (logo.w ? logo.w + 5 : 0);
  const rightW = Math.min(95, (W - 2 * M) * 0.42);
  const leftW = W - M - rightW - 8 - textX;

  // Left block
  font(ctx, 15, "bold", C.ink);
  const nameLines = wrapText(ctx, ctx.heading, leftW, 2);
  let ly = y0 + 5;
  pdf.text(nameLines, textX, ly);
  ly += (nameLines.length - 1) * 6.2 + 5;
  font(ctx, 8.5, "normal", C.muted);
  const siteBits = [o.site.name && pdfText(o.site.name) !== ctx.heading ? pdfText(o.site.name) : "", ...pdfText(o.site.address || "").split(/\n+/)].map((s) => s.trim()).filter(Boolean);
  const addr = siteBits.length ? wrapText(ctx, siteBits.join(" · "), leftW, 2) : [];
  if (addr.length) { pdf.text(addr, textX, ly); ly += (addr.length - 1) * 3.8; }
  const leftBottom = Math.max(ly, y0 - 1 + logo.h);

  // Right block
  let ry = y0 + 1.5;
  eyebrow(ctx, eyebrowText, W - M, ry, { align: "right", color: C.accent });
  ry += 5.5;
  for (const line of rightLines) {
    if (line.bold) { font(ctx, 11, "bold", C.ink); } else { font(ctx, 8.5, "normal", C.muted); }
    const lines = wrapText(ctx, pdfText(line.text), rightW, 2);
    pdf.text(lines, W - M, ry, { align: "right" });
    ry += lines.length * (line.bold ? 4.8 : 4);
  }
  const bottom = Math.max(leftBottom, ry - 3) + 5;
  hairline(ctx, bottom);
  return bottom + 8;
}

/** Running header on continuation pages; drawn after the content is laid out. */
function runningHeader(ctx: Ctx, sub: string) {
  const { pdf, M, W } = ctx;
  const y = M + 2;
  font(ctx, 8, "bold", C.ink);
  const left = fitText(ctx, ctx.heading, (W - 2 * M) * 0.3);
  pdf.text(left, M, y);
  const lw = pdf.getTextWidth(left);
  font(ctx, 8, "normal", C.muted);
  pdf.text(fitText(ctx, `  ${pdfText(ctx.o.title)}`, (W - 2 * M) * 0.55 - lw), M + lw, y);
  const pw = pdf.getTextWidth(ctx.periodText);
  const subFit = sub ? fitText(ctx, sub, Math.max(10, (W - 2 * M) * 0.4 - pw)) : "";
  pdf.text(subFit ? `${subFit}  ·  ${ctx.periodText}` : ctx.periodText, W - M, y, { align: "right" });
  hairline(ctx, y + 3);
}

/** Footer + running headers on every page. Call once, after all content. */
export function finishPages(ctx: Ctx) {
  const { pdf, M, W, H, o } = ctx;
  const at = o.generatedAt ?? new Date();
  const st = localStamp(at);
  const gen = `Generated ${pdfText(formatDate(st.iso, o.prefs.dateFormat))} at ${formatTime(st.minutes, o.prefs.timeFormat)}`;
  const n = pdf.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    pdf.setPage(i);
    if (ctx.running.has(i)) runningHeader(ctx, ctx.running.get(i)!);
    const y = H - 9;
    hairline(ctx, y - 4.5);
    font(ctx, 7, "normal", C.faint);
    const third = (W - 2 * M) / 3;
    if (o.prefs.pdfFooter) pdf.text(fitText(ctx, pdfText(o.prefs.pdfFooter), third + 15), M, y);
    pdf.text(gen, W / 2, y, { align: "center" });
    pdf.text(ctx.pageLabels.get(i) ?? `Page ${i} of ${n}`, W - M, y, { align: "right" });
  }
}

/** Start a new page that carries the running header. */
export function newPage(ctx: Ctx, sub = ""): number {
  ctx.pdf.addPage();
  ctx.running.set(ctx.pdf.getCurrentPageInfo().pageNumber, sub);
  return ctx.top;
}

// ── Totals ───────────────────────────────────────────────────────────────────
export interface Totals {
  count: number; base: number; dock: number; pay: number; net: number; gross: number; bonus: number; ded: number;
  hrs: number; ot: number; full: number; half: number; flagged: number; hourly: number; daily: number;
}

export function totalsOf(list: EmployeeSummary[]): Totals {
  const t: Totals = { count: list.length, base: 0, dock: 0, pay: 0, net: 0, gross: 0, bonus: 0, ded: 0, hrs: 0, ot: 0, full: 0, half: 0, flagged: 0, hourly: 0, daily: 0 };
  for (const e of list) {
    t.base += e.totalBasePay + e.totalDocked; t.dock += e.totalDocked; t.pay += e.totalPay;
    if (e.isNetPay) t.net += e.totalPay; else t.gross += e.totalPay;
    t.bonus += e.totalBonuses; t.ded += e.totalDeductions; t.hrs += e.hoursWorked; t.ot += e.overtimeHours;
    t.full += e.fullDays; t.half += e.halfDays; t.flagged += e.flaggedDays;
    if (!e.isManual) { if (e.payBasis === "hourly") t.hourly++; else t.daily++; }
  }
  return t;
}

export function plural(n: number, one: string, many = `${one}s`) { return `${n} ${n === 1 ? one : many}`; }

export function daysText(full: number, half: number, flagged: number): string {
  return [full && `${full} full`, half && `${half} half`, flagged && `${flagged} flagged`].filter(Boolean).join(" · ");
}

// ── Hero + KPIs ──────────────────────────────────────────────────────────────
export function hero(ctx: Ctx, y: number, t: Totals, opts: { compact?: boolean } = {}): number {
  const { pdf, M, W, fmt } = ctx;
  const contentW = W - 2 * M;
  const heroW = Math.min(88, contentW * 0.38);
  const big = opts.compact ? 26 : 30;

  eyebrow(ctx, "Total payroll", M, y + 2);
  const amount = fmt.money(t.pay);
  font(ctx, big, "bold", C.ink);
  const fs = shrinkToFit(ctx, amount, big, heroW - 4, 14);
  pdf.text(amount, M, y + 4 + fs * 0.3528 * 0.9);
  const subY = y + 4 + fs * 0.3528 * 0.9 + 5.5;
  font(ctx, 8.5, "normal", C.muted);
  pdf.text(fitText(ctx, `${plural(t.count, "employee")} · ${ctx.periodText}`, heroW - 4), M, subY);

  // KPI grid (3 × 2) to the right, separated by hairlines
  const gx = M + heroW + 6;
  const gw = W - M - gx;
  const cols = 3;
  const cw = gw / cols;
  const rowH = 14.5;
  const hours = t.hrs ? `${fmt.hours(t.hrs)} h` : "—";
  const kpis: [string, string, string][] = [
    ["Employees", String(t.count), [t.daily && `${t.daily} day rate`, t.hourly && `${t.hourly} hourly`, (t.count - t.daily - t.hourly) && `${t.count - t.daily - t.hourly} manual`].filter(Boolean).join(" · ")],
    ["Net pay", fmt.money(t.net), "Paid as net"],
    ["Gross pay", fmt.money(t.gross), "Before tax"],
    ["Hours", hours, [daysText(t.full, t.half, t.flagged), t.ot ? `${fmt.hours(t.ot)} OT` : ""].filter(Boolean).join(" · ")],
    ["Bonuses", t.bonus ? fmt.money(t.bonus) : "—", ""],
    ["Deductions", t.ded || t.dock ? fmt.money(-(t.ded + t.dock)) : "—", t.dock ? `Incl. ${fmt.money(t.dock)} docked` : ""],
  ];
  kpis.forEach(([label, value, sub], i) => {
    const cx = gx + (i % cols) * cw + (i % cols ? 5 : 0);
    const cy = y + Math.floor(i / cols) * rowH;
    if (i % cols) { ctx.pdf.setDrawColor(...C.rule); ctx.pdf.setLineWidth(0.2); ctx.pdf.line(cx - 5, cy - 1, cx - 5, cy + rowH - 4); }
    const w = cw - 7;
    font(ctx, 7.5, "normal", C.muted);
    pdf.text(label, cx, cy + 2);
    font(ctx, 12.5, "bold", C.ink);
    const vfs = shrinkToFit(ctx, value, 12.5, w, 8);
    pdf.text(value, cx, cy + 7.6);
    void vfs;
    if (sub) { font(ctx, 7, "normal", C.faint); pdf.text(fitText(ctx, sub, w), cx, cy + 11.2); }
  });
  return Math.max(subY + 4, y + rowH * 2 - 1) + 6;
}

/** "Notes" paragraph under the hero. */
export function notesBlock(ctx: Ctx, y: number, notes: string | undefined, maxLines = 4): number {
  const s = pdfText((notes ?? "").trim());
  if (!s) return y;
  const { pdf, M, W } = ctx;
  eyebrow(ctx, "Notes", M, y);
  font(ctx, 8.5, "normal", C.body);
  const lines = wrapText(ctx, s.replace(/\s*\n\s*/g, " · "), W - 2 * M, maxLines);
  pdf.text(lines, M, y + 4.5);
  return y + 4.5 + lines.length * 3.9 + 5;
}

export function sectionTitle(ctx: Ctx, y: number, title: string, right?: string): number {
  font(ctx, 11, "bold", C.ink);
  ctx.pdf.text(title, ctx.M, y);
  if (right) { font(ctx, 8, "normal", C.muted); ctx.pdf.text(right, ctx.W - ctx.M, y, { align: "right" }); }
  return y + 3;
}

// ── Tables ───────────────────────────────────────────────────────────────────
export function lastY(ctx: Ctx, fallback: number): number {
  return (ctx.pdf as any).lastAutoTable?.finalY ?? fallback;
}

/** Base autotable options: plain white, hairline row rules, bold totals rule. */
export function tableBase(ctx: Ctx, fs = 8, padY = 1.9): Partial<UserOptions> {
  return {
    theme: "plain",
    margin: { left: ctx.M, right: ctx.M, top: ctx.top, bottom: ctx.H - ctx.bottom },
    rowPageBreak: "avoid",
    showHead: "everyPage",
    showFoot: "lastPage",
    styles: {
      font: "helvetica", fontSize: fs, textColor: C.body, cellPadding: { top: padY, bottom: padY, left: 1.6, right: 1.6 },
      lineColor: C.rule, lineWidth: { bottom: 0.15 }, valign: "middle", overflow: "linebreak", minCellHeight: 0,
    },
    headStyles: { fontSize: fs - 1, textColor: C.muted, fontStyle: "bold", lineColor: C.ruleStrong, lineWidth: { bottom: 0.3 }, cellPadding: { top: padY * 0.7, bottom: padY * 0.9, left: 1.6, right: 1.6 } },
    footStyles: { textColor: C.ink, fontStyle: "bold", lineColor: C.ruleStrong, lineWidth: { top: 0.35 }, cellPadding: { top: padY + 0.6, bottom: padY, left: 1.6, right: 1.6 } },
  };
}

/**
 * Size every column to its content (plus breathing room) and give the rest of
 * the width to the `flex` column, so short columns never balloon.
 */
export function fitColumns(ctx: Ctx, fs: number, head: string[], rows: unknown[][], flex: number, opts: { bold?: number[]; extra?: Record<number, number>; gap?: number; avail?: number; max?: Record<number, number> } = {}): Record<number, number> | null {
  const pdf = ctx.pdf;
  const avail = opts.avail ?? ctx.W - 2 * ctx.M;
  const gap = opts.gap ?? 4;
  const widths: number[] = head.map(() => 0);
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(fs - 1);
  head.forEach((h, i) => { widths[i] = pdf.getTextWidth(h); });
  for (const r of rows) {
    if (r.length !== head.length) continue; // spanning rows
    r.forEach((c, i) => {
      if (i === flex || typeof c !== "string") return;
      pdf.setFont("helvetica", opts.bold?.includes(i) ? "bold" : "normal"); pdf.setFontSize(fs);
      widths[i] = Math.max(widths[i], pdf.getTextWidth(c));
    });
  }
  const out: Record<number, number> = {};
  let used = 0;
  widths.forEach((w, i) => {
    if (i === flex) return;
    const edge = i === 0 || i === head.length - 1 ? 1.6 : 3.2;
    out[i] = Math.min(w + edge + gap + (opts.extra?.[i] ?? 0), opts.max?.[i] ?? Infinity);
    used += out[i];
  });
  if (avail - used < Math.min(30, avail * 0.15)) return null;
  out[flex] = avail - used;
  return out;
}

/** Pull first/last columns flush with the margins so tables align with the text above them. */
export function flushEdges(d: CellHookData) {
  const p = d.cell.styles.cellPadding as any;
  const pad = typeof p === "number" ? { top: p, bottom: p, left: p, right: p } : { ...p };
  if (d.column.index === 0) pad.left = 0;
  if (d.column.index === d.table.columns.length - 1) pad.right = 0;
  d.cell.styles.cellPadding = pad;
}

/** Coloured status dot + label (call from didParseCell / didDrawCell). */
export const statusCell = {
  parse(d: CellHookData, type: DayType | null, opts: { cancelled?: boolean; edited?: boolean } = {}) {
    if (!type) { d.cell.styles.textColor = C.faint; return; }
    d.cell.text = [`${DAY_LABELS[type]}${opts.edited ? " *" : ""}`];
    const p = d.cell.styles.cellPadding as any;
    d.cell.styles.cellPadding = { ...(typeof p === "number" ? { top: p, bottom: p, left: p, right: p } : p), left: (typeof p === "number" ? p : p.left) + 3 };
    d.cell.styles.textColor = opts.cancelled ? C.faint : C.ink;
  },
  draw(d: CellHookData, type: DayType | null, opts: { cancelled?: boolean } = {}) {
    if (!type) return;
    const pdf = d.doc as jsPDF;
    const p = d.cell.styles.cellPadding as any;
    const left = (typeof p === "number" ? p : p.left) - 3;
    const cx = d.cell.x + left + 1.1;
    const cy = d.cell.y + d.cell.height / 2 - 0.3;
    const col = STATUS_COLOR[type];
    if (opts.cancelled) { pdf.setDrawColor(...col); pdf.setLineWidth(0.3); pdf.circle(cx, cy, 0.95, "S"); }
    else { pdf.setFillColor(...col); pdf.circle(cx, cy, 1.05, "F"); }
  },
};

// ── Summary table ────────────────────────────────────────────────────────────
export function basisText(e: EmployeeSummary, fmt: Fmt): string {
  if (e.isManual) {
    const byDate = e.days.some((d) => d.key !== "lump");
    return byDate ? `Manual · ${plural(e.days.length, "payment")}` : "Manual · lump sum";
  }
  const cat = e.categoryName ? pdfText(e.categoryName) : e.payBasis === "hourly" ? "Hourly" : "Day rate";
  const rate = e.payBasis === "hourly" ? `${fmt.money(e.hourlyRate)}/h` : `${fmt.money(e.fullDayRate)} / ${fmt.money(e.halfDayRate)}`;
  return `${cat} · ${rate}`;
}

export function workedText(e: EmployeeSummary, fmt: Fmt): string {
  if (e.isManual) return "—";
  if (e.payBasis === "hourly") return `${fmt.hours(e.hoursWorked)} h${e.overtimeHours ? ` · ${fmt.hours(e.overtimeHours)} OT` : ""}`;
  return daysText(e.fullDays, e.halfDays, e.flaggedDays) || "—";
}

const PAY_SHORT = { cash: "Cash", bank: "Bank", check: "Check", split: "Cash+bank" } as const;

/** "Cash", "Bank transfer", or "Cash $200.00 + bank $350.00" for a split. */
export function paymentText(e: EmployeeSummary, fmt: Ctx["fmt"]): string {
  const p = e.payment;
  if (!p) return "";
  if (p.method === "split") return `Cash ${fmt.money(p.cash)} + bank ${fmt.money(p.bank)}`;
  return p.method === "bank" ? "Bank transfer" : p.method === "check" ? "Check" : "Cash";
}

/** One line with the run's pay-out totals by method (empty when nothing is paid). */
export function payoutLine(list: EmployeeSummary[], fmt: Ctx["fmt"]): string {
  const sum = (k: "cash" | "bank" | "check") => list.reduce((s, e) => s + (e.payment?.[k] ?? 0), 0);
  const count = (k: "cash" | "bank" | "check") => list.filter((e) => (e.payment?.[k] ?? 0) > 0).length;
  return ([["cash", "Cash"], ["bank", "Bank transfer"], ["check", "Check"]] as const)
    .filter(([k]) => sum(k) > 0)
    .map(([k, label]) => `${label} ${fmt.money(sum(k))} (${plural(count(k), "person", "people")})`)
    .join("   ·   ");
}

export interface SummaryTableOpts { fs?: number; padY?: number; singleLine?: boolean; showBasis?: boolean; extraRow?: RowInput }

export function summaryTable(ctx: Ctx, list: EmployeeSummary[], startY: number, t: Totals, opts: SummaryTableOpts = {}) {
  const { fmt } = ctx;
  const fs = opts.fs ?? 8.5;
  const head = ["Employee", "Pay basis", "Worked", "Base", "Adjustments", "Total", ""];
  const adj = (e: EmployeeSummary) => e.totalBonuses - e.totalDeductions - e.totalDocked;
  const body: RowInput[] = list.map((e) => [
    pdfText(e.name), basisText(e, fmt), workedText(e, fmt), fmt.money(e.totalBasePay + e.totalDocked),
    fmt.signed(adj(e)) || "—", fmt.money(e.totalPay), `${e.isNetPay ? "Net" : "Gross"}${e.payment ? ` · ${PAY_SHORT[e.payment.method]}` : ""}`,
  ]);
  if (opts.extraRow) body.push(opts.extraRow);
  const workedTotal = [daysText(t.full, t.half, t.flagged), t.hrs ? `${fmt.hours(t.hrs)} h` : ""].filter(Boolean).join(" · ") || "—";
  const base = tableBase(ctx, fs, opts.padY ?? 2.1);
  const overflow = opts.singleLine ? "ellipsize" : "linebreak";
  const avail = ctx.W - 2 * ctx.M;
  const widths = fitColumns(ctx, fs, head, body as unknown[][], 0, { bold: [5], max: { 1: avail * 0.22, 2: avail * 0.2 } });
  const columnStyles: Record<number, any> = {
    0: { fontStyle: "bold", textColor: C.ink, cellWidth: "auto", overflow },
    1: { textColor: C.muted, overflow },
    2: { overflow },
    3: { halign: "right", cellWidth: "wrap" },
    4: { halign: "right", cellWidth: "wrap" },
    5: { halign: "right", cellWidth: "wrap", fontStyle: "bold", textColor: C.ink },
    6: { halign: "right", cellWidth: 24, textColor: C.muted, fontSize: fs - 1 },
  };
  if (widths) for (const [i, w] of Object.entries(widths)) columnStyles[+i] = { ...columnStyles[+i], cellWidth: w };
  autoTable(ctx.pdf, {
    ...base,
    startY,
    head: [head],
    body,
    foot: [[`Total · ${plural(t.count, "employee")}`, "", workedTotal, fmt.money(t.base), fmt.signed(t.bonus - t.ded - t.dock) || "—", fmt.money(t.pay), ""]],
    columnStyles,
    didParseCell: (d) => {
      flushEdges(d);
      if (d.section === "foot" && d.column.index === 0) d.cell.styles.overflow = "visible";
      if (d.section === "body" && d.column.index === 4) {
        const raw = String(d.cell.raw);
        if (raw.startsWith("–")) d.cell.styles.textColor = C.negative;
        else if (raw === "—") d.cell.styles.textColor = C.faint;
      }
      if (d.section === "body" && d.column.index === 5 && String(d.cell.raw).startsWith("–")) d.cell.styles.textColor = C.negative;
      if (d.section !== "body" && d.column.index >= 3) d.cell.styles.halign = "right";
      if (d.section === "foot" && d.column.index === 4 && String(d.cell.raw).startsWith("–")) d.cell.styles.textColor = C.negative;
    },
  });
}
