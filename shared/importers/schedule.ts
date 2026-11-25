// Schedule PDF parser (Toast / Sling by Toast prints, plus most other schedule
// and time-entry PDFs). Works on positioned text items extracted from the PDF
// so it can read week grids (employees down the side, days across the top) as
// well as row-based lists (one shift per line, grouped by employee or date).
import type { Shift } from "../schema";
import { addDays, dayOfWeek, isoParts, parseDateToISO, startOfWeek, toISO } from "../dates";
import { normalizeName } from "../engine";
import { newShiftId } from "./csv";

export interface TextItem { str: string; x: number; y: number; w: number; h: number; page: number }

export interface ScheduleParseOptions {
  year?: number;
  /** ISO date of the first day shown when the PDF prints weekdays without dates. */
  weekStart?: string;
  weekStartsOn?: number;
}

export interface ScheduleParseResult {
  shifts: Shift[];
  format: "grid" | "list" | "none";
  warnings: string[];
  pages: number;
  needsWeekStart: boolean;
  unmatched: string[];
  periodStart: string;
  periodEnd: string;
}

interface Seg { s: number; e: number; x0: number; x1: number }
interface Line { page: number; y: number; h: number; text: string; segs: Seg[] }

const WEEKDAY_RE = /\b(sun|mon|tue|wed|thu|fri|sat)(?:day|sday|nesday|rsday|urday|s|t|r|rs|n)?\.?\b/gi;
const WD_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const TIME = String.raw`\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m?\.?)?`;
const RANGE_RE = new RegExp(String.raw`(?<![\d/:.$])(${TIME})\s*(?:-|–|—|to)\s*(${TIME})(?![\d/%])`, "gi");
const DATETIME_RE = /(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)/gi;
const DATE_RE = /\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)\b/gi;
const MONTH_YEAR_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})\b/i;

const STOP = new Set([
  "schedule", "schedules", "total", "totals", "hours", "hrs", "week", "weekly", "open", "shift", "shifts", "unassigned",
  "available", "unavailable", "time", "off", "page", "printed", "location", "locations", "position", "positions", "employee",
  "employees", "staff", "scheduled", "labor", "cost", "sales", "notes", "note", "request", "approved", "pending", "published",
  "draft", "am", "pm", "of", "by", "summary", "report", "date", "day", "days", "job", "title", "in", "out", "break", "breaks",
  "payable", "regular", "overtime", "wage", "tips", "team", "member", "members", "name", "generated", "sling", "toast",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "mon", "tue", "wed", "thu", "fri", "sat", "sun",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec", "budget", "forecast", "all", "view",
]);

export function buildLines(items: TextItem[]): Line[] {
  const lines: Line[] = [];
  const pages = [...new Set(items.map((i) => i.page))].sort((a, b) => a - b);
  for (const p of pages) {
    const its = items.filter((i) => i.page === p && i.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
    const groups: { y: number; h: number; items: TextItem[] }[] = [];
    for (const it of its) {
      const tol = Math.max(2, (it.h || 8) * 0.45);
      const g = groups.find((gr) => Math.abs(gr.y - it.y) <= tol);
      if (g) g.items.push(it);
      else groups.push({ y: it.y, h: it.h || 8, items: [it] });
    }
    groups.sort((a, b) => b.y - a.y);
    for (const g of groups) {
      g.items.sort((a, b) => a.x - b.x);
      let text = "";
      const segs: Seg[] = [];
      for (const it of g.items) {
        if (text) text += " ";
        const s = text.length;
        text += it.str.trim();
        segs.push({ s, e: text.length, x0: it.x, x1: it.x + (it.w || it.str.length * (it.h || 8) * 0.5) });
      }
      lines.push({ page: p, y: g.y, h: g.h, text, segs });
    }
  }
  return lines;
}

function xAt(line: Line, offset: number): number {
  for (const sg of line.segs) {
    if (offset >= sg.s && offset <= sg.e) {
      const frac = sg.e > sg.s ? (offset - sg.s) / (sg.e - sg.s) : 0;
      return sg.x0 + frac * (sg.x1 - sg.x0);
    }
  }
  return line.segs[line.segs.length - 1]?.x1 ?? 0;
}

function loose(t: string): { h: number; m: number; mer: "a" | "p" | null; colon: boolean } | null {
  const m = t.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])?/);
  if (!m) return null;
  const h = +m[1], mm = m[2] ? +m[2] : 0;
  if (mm > 59 || h > 24) return null;
  return { h, m: mm, mer: (m[3] as "a" | "p") ?? null, colon: !!m[2] };
}

function toMin(h: number, m: number, mer: "a" | "p" | null): number | null {
  if (mer) {
    if (h < 1 || h > 12) return null;
    return ((h % 12) + (mer === "p" ? 12 : 0)) * 60 + m;
  }
  return (h % 24) * 60 + m;
}

/** Parse a time range like "10a-9p", "10:00 AM - 9:30 PM", "16:00-23:00". */
export function parseRange(a: string, b: string): { start: number; end: number } | null {
  const A = loose(a), B = loose(b);
  if (!A || !B) return null;
  let start: number | null, end: number | null;
  if (A.mer && B.mer) { start = toMin(A.h, A.m, A.mer); end = toMin(B.h, B.m, B.mer); }
  else if (!A.mer && B.mer) {
    end = toMin(B.h, B.m, B.mer);
    start = toMin(A.h, A.m, B.mer);
    if (start != null && end != null && start >= end) start = toMin(A.h, A.m, B.mer === "a" ? "p" : "a");
  } else if (A.mer && !B.mer) {
    start = toMin(A.h, A.m, A.mer);
    end = toMin(B.h, B.m, A.mer);
    if (start != null && end != null && end <= start) end = toMin(B.h, B.m, A.mer === "a" ? "p" : "a");
  } else {
    if (!A.colon || !B.colon) return null;
    start = toMin(A.h, A.m, null);
    end = toMin(B.h, B.m, null);
    if (start != null && end != null && end <= start && B.h <= 12 && A.h <= 12) end += 720;
  }
  if (start == null || end == null) return null;
  if (end <= start) end += 1440;
  const dur = end - start;
  if (dur < 15 || dur > 20 * 60) return null;
  return { start, end };
}

function cleanName(raw: string): string {
  let s = raw
    .replace(/\$\s?[\d,.]+/g, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:h|hr|hrs|hours?)\b/gi, " ")
    .replace(/\(\s*\d[^)]*\)/g, " ")
    .replace(/[•|·]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/[,:;\-–]+$/, "").trim();
  return s;
}

export function isNameLike(raw: string): boolean {
  const s = cleanName(raw);
  if (s.length < 2 || s.length > 60) return false;
  if (/\d/.test(s)) return false;
  if (!/^[\p{L}][\p{L}.'’\-() ]*$/u.test(s)) return false;
  const words = s.toLowerCase().replace(/[().]/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 6) return false;
  if (words.every((w) => STOP.has(w))) return false;
  if (words.some((w) => ["schedule", "unassigned", "total", "totals", "page", "printed", "open", "summary", "report"].includes(w))) return false;
  return true;
}

function findYear(lines: Line[], opts: ScheduleParseOptions): number {
  if (opts.year) return opts.year;
  for (const l of lines) {
    const m = l.text.match(/\b(20\d{2})\b/);
    if (m) return +m[1];
  }
  return new Date().getFullYear();
}

interface Header { line: Line; cols: { x: number; wd: number; date: string | null; dayNum: number | null }[]; left: number; bounds: number[] }

function detectHeader(line: Line, next: Line | undefined, year: number): Header | null {
  const hits: { wd: number; off: number; end: number }[] = [];
  WEEKDAY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WEEKDAY_RE.exec(line.text))) hits.push({ wd: WD_INDEX[m[1].toLowerCase()], off: m.index, end: m.index + m[0].length });
  const distinct = new Set(hits.map((h) => h.wd));
  if (distinct.size < 3 || hits.length > 8) return null;
  const cols = hits.map((h, i) => {
    const tail = line.text.slice(h.end, hits[i + 1]?.off ?? line.text.length);
    const date = parseDateToISO(tail.match(DATE_RE)?.[0] ?? "", { defaultYear: year });
    const dn = tail.match(/^\W*(\d{1,2})\b(?!\s*[:/])/);
    return { x: xAt(line, (h.off + h.end) / 2), wd: h.wd, date, dayNum: date ? null : dn ? +dn[1] : null };
  });
  // Dates printed on the line below the weekday names
  if (next && next.page === line.page && line.y - next.y < line.h * 2.2 && cols.every((c) => !c.date && c.dayNum == null)) {
    DATE_RE.lastIndex = 0;
    const found: { x: number; date: string | null; dayNum: number | null }[] = [];
    let dm: RegExpExecArray | null;
    while ((dm = DATE_RE.exec(next.text))) found.push({ x: xAt(next, dm.index + dm[0].length / 2), date: parseDateToISO(dm[0], { defaultYear: year }), dayNum: null });
    if (!found.length) {
      const re = /\b(\d{1,2})\b/g;
      let nm: RegExpExecArray | null;
      while ((nm = re.exec(next.text))) found.push({ x: xAt(next, nm.index + nm[0].length / 2), date: null, dayNum: +nm[1] });
    }
    for (const f of found) {
      const c = cols.reduce((best, col) => (Math.abs(col.x - f.x) < Math.abs(best.x - f.x) ? col : best), cols[0]);
      if (Math.abs(c.x - f.x) < 60) { c.date = f.date; c.dayNum = f.dayNum; }
    }
  }
  const xs = cols.map((c) => c.x);
  const gap = xs.length > 1 ? (xs[xs.length - 1] - xs[0]) / (xs.length - 1) : 80;
  const bounds = xs.map((x, i) => (i === 0 ? x - gap / 2 : (xs[i - 1] + x) / 2));
  bounds.push(xs[xs.length - 1] + gap / 2);
  return { line, cols, left: bounds[0], bounds };
}

function resolveColumnDates(h: Header, lines: Line[], year: number, opts: ScheduleParseOptions): { ok: boolean } {
  const anchor = h.cols.find((c) => c.date);
  if (anchor) {
    const ai = h.cols.indexOf(anchor);
    h.cols.forEach((c, i) => { if (!c.date) c.date = addDays(anchor.date!, i - ai); });
    return { ok: true };
  }
  if (h.cols.some((c) => c.dayNum != null)) {
    let month: number | null = null;
    let y = year;
    for (const l of lines) {
      if (l.page !== h.line.page) continue;
      const my = l.text.match(MONTH_YEAR_RE) || l.text.match(DATE_RE);
      if (my) {
        const iso = parseDateToISO(my[0].includes(" ") && /\d{4}$/.test(my[0]) && !/\d{1,2},/.test(my[0]) ? my[0].replace(/(\w+)\s+(\d{4})/, "$1 1, $2") : my[0], { defaultYear: year });
        if (iso) { const p = isoParts(iso); month = p[1]; y = p[0]; break; }
      }
    }
    const first = h.cols.find((c) => c.dayNum != null)!;
    if (month) {
      const d0 = toISO(y, month, first.dayNum!);
      if (d0) {
        const fi = h.cols.indexOf(first);
        h.cols.forEach((c, i) => { c.date = addDays(d0, i - fi); });
        return { ok: true };
      }
    }
  }
  if (opts.weekStart) {
    const ws = opts.weekStart;
    h.cols.forEach((c) => { c.date = addDays(ws, (c.wd - dayOfWeek(ws) + 7) % 7); });
    return { ok: true };
  }
  return { ok: false };
}

function parseGrid(lines: Line[], year: number, opts: ScheduleParseOptions, out: ScheduleParseResult): boolean {
  let header: Header | null = null;
  let current: string | null = null;
  let any = false;
  let skippedUnassigned = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = detectHeader(line, lines[i + 1], year);
    if (h) {
      const res = resolveColumnDates(h, lines, year, opts);
      if (!res.ok) {
        out.needsWeekStart = true;
        const fallback = startOfWeek(new Date().toISOString().slice(0, 10), opts.weekStartsOn ?? 1);
        h.cols.forEach((c) => { c.date = addDays(fallback, (c.wd - dayOfWeek(fallback) + 7) % 7); });
      }
      header = h;
      current = null;
      any = true;
      continue;
    }
    if (!header || line.page < header.line.page) continue;
    // Name label in the left gutter starts a new row
    const leftText = line.segs.filter((sg) => sg.x1 <= header!.left + 4).map((sg) => line.text.slice(sg.s, sg.e)).join(" ");
    if (leftText) {
      if (isNameLike(leftText)) current = normalizeName(cleanName(leftText));
      else if (/unassigned|open shifts?/i.test(leftText)) current = null;
    }
    RANGE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RANGE_RE.exec(line.text))) {
      const r = parseRange(m[1], m[2]);
      if (!r) continue;
      const x = xAt(line, m.index);
      if (x < header.left - 2) continue;
      let ci = header.bounds.findIndex((b, k) => k < header!.cols.length && x >= b - 2 && x < header!.bounds[k + 1]);
      if (ci < 0) ci = header.cols.length - 1;
      const col = header.cols[ci];
      // Trailing text in the same cell can be the employee (position-grouped schedules)
      const cellEnd = header.bounds[ci + 1];
      const rest = line.segs
        .filter((sg) => sg.s >= m!.index + m![0].length && sg.x0 < cellEnd)
        .map((sg) => line.text.slice(sg.s, sg.e)).join(" ")
        .replace(new RegExp(RANGE_RE.source, "gi"), " ");
      let employee = current;
      let role = "";
      if (rest && isNameLike(rest) && cleanName(rest).split(" ").length >= 2) { employee = normalizeName(cleanName(rest)); role = current ?? ""; }
      if (!employee) { skippedUnassigned++; continue; }
      out.shifts.push({ id: newShiftId("pdf"), employee, date: col.date!, start: r.start, end: r.end, breakMinutes: 0, role, source: "toast", note: "Scheduled" });
    }
  }
  if (skippedUnassigned) out.warnings.push(`${skippedUnassigned} open/unassigned shift${skippedUnassigned === 1 ? " was" : "s were"} skipped.`);
  return any;
}

function parseList(lines: Line[], year: number, out: ScheduleParseResult) {
  let currentName: string | null = null;
  let currentDate: string | null = null;
  // Column header for name/job split (e.g. "Employee  Job Title  In Date  Out Date")
  let jobX: number | null = null;
  for (const line of lines) {
    const lower = line.text.toLowerCase();
    if (/(employee|name)/.test(lower) && /(job|role|position)/.test(lower) && /(in|date|start|time)/.test(lower)) {
      const idx = lower.search(/job|role|position/);
      jobX = xAt(line, idx) - 2;
      continue;
    }
    // Pattern A: "<name> <job> 11/3/26 10:02 AM 11/3/26 9:15 PM ..."
    DATETIME_RE.lastIndex = 0;
    const dts = [...line.text.matchAll(DATETIME_RE)];
    if (dts.length >= 2) {
      const d1 = parseDateToISO(dts[0][1], { defaultYear: year });
      const d2 = parseDateToISO(dts[1][1], { defaultYear: year });
      const s = loose(dts[0][2]), e = loose(dts[1][2]);
      if (d1 && d2 && s && e) {
        const start = toMin(s.h, s.m, s.mer);
        let end = toMin(e.h, e.m, e.mer);
        if (start != null && end != null) {
          end += Math.max(0, Math.round((Date.parse(d2) - Date.parse(d1)) / 86400000)) * 1440;
          if (end <= start) end += 1440;
          const before = line.text.slice(0, dts[0].index);
          let name = before, role = "";
          if (jobX != null) {
            name = line.segs.filter((sg) => sg.s < dts[0].index! && sg.x1 <= jobX! + 2).map((sg) => line.text.slice(sg.s, sg.e)).join(" ");
            role = line.segs.filter((sg) => sg.s < dts[0].index! && sg.x0 >= jobX!).map((sg) => line.text.slice(sg.s, sg.e)).join(" ");
          }
          const nm = cleanName(name);
          const emp = nm && isNameLike(nm) ? normalizeName(nm) : currentName;
          if (emp && end - start <= 24 * 60) {
            out.shifts.push({ id: newShiftId("pdf"), employee: emp, date: d1, start, end, breakMinutes: 0, role: cleanName(role), source: "toast", note: "" });
            continue;
          }
        }
      }
    }
    RANGE_RE.lastIndex = 0;
    const ranges = [...line.text.matchAll(RANGE_RE)].map((mm) => ({ mm, r: parseRange(mm[1], mm[2]) })).filter((x) => x.r);
    DATE_RE.lastIndex = 0;
    const dateMatch = line.text.match(DATE_RE);
    const lineDate = dateMatch ? parseDateToISO(dateMatch[0], { defaultYear: year }) : null;
    if (!ranges.length) {
      // Context lines: a name heading or a date heading
      if (lineDate && line.text.replace(DATE_RE, "").replace(WEEKDAY_RE, "").replace(/[\s,.-]/g, "").length < 3) { currentDate = lineDate; continue; }
      if (isNameLike(line.text)) currentName = normalizeName(cleanName(line.text));
      continue;
    }
    const date = lineDate ?? currentDate;
    let rest = line.text;
    for (const { mm } of ranges) rest = rest.replace(mm[0], " ");
    if (dateMatch) rest = rest.replace(dateMatch[0], " ");
    rest = rest.replace(WEEKDAY_RE, " ");
    const nameHere = cleanName(rest);
    let emp = currentName;
    let role = "";
    if (nameHere && isNameLike(nameHere)) {
      const words = nameHere.split(" ");
      if (currentName && words.length === 1) role = nameHere; else emp = normalizeName(nameHere);
    }
    if (!date || !emp) { if (out.unmatched.length < 12) out.unmatched.push(line.text.slice(0, 120)); continue; }
    for (const { r } of ranges) out.shifts.push({ id: newShiftId("pdf"), employee: emp, date, start: r!.start, end: r!.end, breakMinutes: 0, role, source: "toast", note: "Scheduled" });
  }
}

export function parseScheduleItems(items: TextItem[], opts: ScheduleParseOptions = {}): ScheduleParseResult {
  const lines = buildLines(items);
  const out: ScheduleParseResult = {
    shifts: [], format: "none", warnings: [], pages: new Set(items.map((i) => i.page)).size, needsWeekStart: false, unmatched: [], periodStart: "", periodEnd: "",
  };
  if (!lines.length) {
    out.warnings.push("No text was found in this PDF. If it is a scanned image, export the schedule again as a PDF or CSV from Toast/Sling.");
    return out;
  }
  const year = findYear(lines, opts);
  const grid = parseGrid(lines, year, opts, out);
  if (grid && out.shifts.length) out.format = "grid";
  else {
    out.shifts = [];
    out.needsWeekStart = false;
    parseList(lines, year, out);
    if (out.shifts.length) out.format = "list";
  }
  // De-duplicate
  const seen = new Set<string>();
  out.shifts = out.shifts.filter((s) => {
    const k = `${s.employee.toLowerCase()}|${s.date}|${s.start}|${s.end}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  out.shifts.sort((a, b) => a.employee.localeCompare(b.employee) || a.date.localeCompare(b.date) || a.start - b.start);
  for (const s of out.shifts) {
    if (!out.periodStart || s.date < out.periodStart) out.periodStart = s.date;
    if (!out.periodEnd || s.date > out.periodEnd) out.periodEnd = s.date;
  }
  if (!out.shifts.length) out.warnings.push("No shifts were recognised. Try printing the schedule in Week view (Sling: Schedule → Week → Print → Download PDF), or export a CSV instead.");
  if (out.needsWeekStart) out.warnings.push("The PDF shows weekdays without dates. Pick the first day of the week below.");
  return out;
}
