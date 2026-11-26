// Time-card CSV importer. Auto-detects Square, Toast (TimeEntries.csv), Sling,
// 7shifts, Homebase and this app's own export. Falls back to a column mapping
// chosen by the user.
import Papa from "papaparse";
import type { Shift, ShiftSource } from "../schema";
import { detectDayFirst, hasMeridiem, parseDateToISO, parseTimeToMinutes } from "../dates";
import { normalizeName } from "../engine";
import { neutralizeFormula, unneutralize } from "../csvSafe";

export type CsvField = "name" | "firstName" | "lastName" | "date" | "start" | "endDate" | "end" | "breakMinutes" | "breakHours" | "role";
export type CsvMapping = Partial<Record<CsvField, string>>;

const CANDIDATES: Record<CsvField, string[]> = {
  name: ["team member", "employee", "employee name", "name", "staff", "staff name", "full name", "team member name", "worker"],
  firstName: ["first name", "first", "given name"],
  lastName: ["last name", "last", "surname", "family name"],
  date: ["clockin date", "clock in date", "clock-in date", "in date", "shift date", "date", "start date", "work date", "punch in date"],
  start: ["clockin time", "clock in time", "clock-in time", "clock in", "time in", "in time", "start time", "punch in", "start", "in"],
  endDate: ["clockout date", "clock out date", "clock-out date", "out date", "end date", "punch out date"],
  end: ["clockout time", "clock out time", "clock-out time", "clock out", "time out", "out time", "end time", "punch out", "end", "out"],
  breakMinutes: ["break minutes", "unpaid break minutes", "break (minutes)", "break (mins)", "break (min)", "break mins", "break min", "unpaid break (minutes)", "breaks"],
  breakHours: ["unpaid break time", "unpaid break hours", "break hours", "break (hours)", "break (hrs)", "break hrs", "break duration"],
  role: ["job title", "job", "role", "position", "wage title", "department"],
};

export const CSV_FIELD_LABELS: Record<CsvField, string> = {
  name: "Employee name", firstName: "First name", lastName: "Last name", date: "Clock-in date (or date + time)",
  start: "Clock-in time", endDate: "Clock-out date (or date + time)", end: "Clock-out time",
  breakMinutes: "Break (minutes)", breakHours: "Break (hours)", role: "Role / job",
};

export interface CsvParseResult {
  shifts: Shift[];
  headers: string[];
  mapping: CsvMapping;
  format: string;
  warnings: string[];
  skipped: number;
  needsMapping: boolean;
  sampleRows: Record<string, string>[];
}

const norm = (h: string) => h.trim().toLowerCase().replace(/\s+/g, " ").replace(/[_]/g, " ");

export function detectMapping(headers: string[]): CsvMapping {
  const mapping: CsvMapping = {};
  const used = new Set<string>();
  const lookup = new Map(headers.map((h) => [norm(h), h]));
  for (const field of Object.keys(CANDIDATES) as CsvField[]) {
    for (const cand of CANDIDATES[field]) {
      const h = lookup.get(cand);
      if (h && !used.has(h)) { mapping[field] = h; used.add(h); break; }
    }
  }
  return mapping;
}

export function mappingIsUsable(m: CsvMapping): boolean {
  return !!(m.name || (m.firstName && m.lastName)) && !!m.date && (!!m.end || !!m.endDate);
}

function detectFormat(headers: string[]): string {
  const h = headers.map(norm);
  if (h.includes("team member") && h.includes("clockin date")) return "Square timecards";
  if (h.includes("in date") && h.includes("out date") && (h.includes("job title") || h.includes("payable hours"))) return "Toast time entries";
  if (h.includes("shift id") && h.includes("break minutes")) return "Payroll Admin export";
  if (h.some((x) => x.includes("sling"))) return "Sling";
  return "Time-card CSV";
}

let counter = 0;
export function newShiftId(prefix = "s"): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}${counter.toString(36)}`;
}

export function parseCsvText(text: string, opts: { mapping?: CsvMapping; source?: ShiftSource; defaultYear?: number; dayFirst?: boolean; today?: string } = {}): CsvParseResult {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ""), { header: true, skipEmptyLines: "greedy", transformHeader: (h) => h.trim() });
  const headers = (parsed.meta.fields ?? []).filter(Boolean);
  const mapping = opts.mapping ?? detectMapping(headers);
  const format = detectFormat(headers);
  const base: CsvParseResult = { shifts: [], headers, mapping, format, warnings: [], skipped: 0, needsMapping: false, sampleRows: parsed.data.slice(0, 5) };
  if (!headers.length) return { ...base, warnings: ["The file has no header row."], needsMapping: true };
  if (!mappingIsUsable(mapping)) return { ...base, needsMapping: true };

  const shifts: Shift[] = [];
  let skipped = 0;
  let zeroLength = 0;
  let duplicates = 0;
  let outOfRangeCount = 0;
  const outOfRange: string[] = [];
  const clamped: string[] = [];
  const seen = new Set<string>();
  // Dates more than about a year from today are almost always a typo (1926, 2099).
  const todayMs = Date.parse((opts.today ?? new Date().toISOString().slice(0, 10)) + "T00:00:00Z");
  const YEAR_MS = 366 * 86400000;
  // Slash dates: the file decides when it can (13/11 is clearly day-first),
  // otherwise the date-format preference does.
  const dateValues = mapping.date ? parsed.data.map((r) => String(r[mapping.date!] ?? "")) : [];
  const detected = detectDayFirst(dateValues);
  // Square timecards (and this app's own Shifts CSV, which uses Square's
  // columns) are always month-first, whatever the preference says.
  const prefDayFirst = format.startsWith("Square") ? false : !!opts.dayFirst;
  const dayFirst = detected ?? prefDayFirst;
  if (detected != null && detected !== prefDayFirst && dateValues.some((v) => /\d\/\d/.test(v))) {
    base.warnings.push(detected ? "Dates in this file are day-first (D/M/Y), so they were read that way." : "Dates in this file are month-first (M/D/Y), so they were read that way.");
  }
  const dateOpts = { defaultYear: opts.defaultYear, dayFirst };
  const source = opts.source ?? (format.startsWith("Toast") ? "toast" : format.startsWith("Square") ? "square" : "csv");
  for (const row of parsed.data) {
    const get = (f: CsvField) => (mapping[f] ? unneutralize(String(row[mapping[f]!] ?? "").trim()) : "");
    let name = get("name");
    if (!name && (mapping.firstName || mapping.lastName)) name = `${get("firstName")} ${get("lastName")}`;
    name = normalizeName(name);
    if (!name || /^(grand )?totals?$/i.test(name)) { skipped++; continue; }

    const dateRaw = get("date");
    const date = parseDateToISO(dateRaw, dateOpts);
    const startRaw = get("start") || (hasTime(dateRaw) ? dateRaw.replace(/^[^ ]*\d[^ ]*\s+/, "") : "");
    const endDateRaw = get("endDate");
    const endRaw = get("end") || (hasTime(endDateRaw) ? endDateRaw.replace(/^[^ ]*\d[^ ]*\s+/, "") : "");
    const start = parseTimeToMinutes(startRaw);
    const endT = parseTimeToMinutes(endRaw);
    if (!date || start == null || endT == null) { skipped++; continue; }

    const endDate = parseDateToISO(endDateRaw, dateOpts) ?? date;
    // Same clock-in and clock-out on the same day is an empty shift, not 24 hours.
    if (endT === start && endDate === date) { zeroLength++; continue; }
    let end = endT + Math.max(0, dayDiff(date, endDate)) * 1440;
    if (end <= start) end += 1440; // overnight without an explicit out-date
    if (Math.abs(Date.parse(date + "T00:00:00Z") - todayMs) > YEAR_MS) { if (outOfRange.length < 3) outOfRange.push(`${name} ${date}`); outOfRangeCount++; continue; }
    const dupKey = `${name.toLowerCase()}|${date}|${start}|${end}`;
    if (seen.has(dupKey)) { duplicates++; continue; }
    seen.add(dupKey);
    if (end > 4320) clamped.push(`${name} ${date}`);
    let brk = 0;
    if (mapping.breakMinutes) brk = Math.round(Number(get("breakMinutes")) || 0);
    else if (mapping.breakHours) brk = Math.round((Number(get("breakHours")) || 0) * 60);

    shifts.push({
      id: unneutralize(row["Shift ID"]?.trim() ?? "") || newShiftId(), employee: name, date, start, end: Math.min(end, 4320),
      breakMinutes: Math.max(0, Math.min(brk, 1440)), role: get("role"), source, note: "",
    });
  }
  if (zeroLength) base.warnings.push(`${zeroLength} row${zeroLength === 1 ? "" : "s"} skipped: clock-in and clock-out are the same time.`);
  if (skipped) base.warnings.push(`${skipped} row${skipped === 1 ? "" : "s"} skipped (missing name, date, or clock times).`);
  if (outOfRangeCount) base.warnings.push(`${outOfRangeCount} row${outOfRangeCount === 1 ? "" : "s"} skipped: the date is more than a year from today (${outOfRange.join(", ")}${outOfRangeCount > outOfRange.length ? ", ..." : ""}). Check for a typo in the year.`);
  if (duplicates) base.warnings.push(`${duplicates} duplicate row${duplicates === 1 ? "" : "s"} skipped (same employee, start and end).`);
  if (clamped.length) base.warnings.push(`${clamped.length === 1 ? "A shift was" : `${clamped.length} shifts were`} longer than 72 hours and cut to 72 hours: ${clamped.slice(0, 3).join(", ")}${clamped.length > 3 ? ", ..." : ""}. Check the clock-out date.`);
  if (!shifts.length) base.warnings.push("No complete shifts were found. Check the column mapping.");
  return { ...base, shifts, skipped, needsMapping: shifts.length === 0 };
}

function hasTime(s: string): boolean {
  return /\d{1,2}:\d{2}/.test(s);
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000) || 0;
}

/** Canonical CSV stored alongside each timesheet. Old app versions can still read it. */
export function shiftsToCsv(shifts: Shift[]): string {
  const rows = [...shifts].sort((a, b) => a.employee.localeCompare(b.employee) || a.date.localeCompare(b.date) || a.start - b.start);
  const fmtT = (min: number) => {
    const t = ((min % 1440) + 1440) % 1440;
    const h = Math.floor(t / 60), m = t % 60;
    return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")}:00 ${h < 12 ? "AM" : "PM"}`;
  };
  const legacyDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${m}/${d}/${String(y).slice(2)}`; };
  const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
  return Papa.unparse({
    fields: ["Team Member", "Clockin date", "Clockin time", "Clockout time", "Clockout date", "Break minutes", "Role", "Source", "Shift ID"],
    data: rows.map((s) => [
      neutralizeFormula(s.employee), legacyDate(s.date), fmtT(s.start), fmtT(s.end), legacyDate(addDays(s.date, Math.floor(s.end / 1440))),
      s.breakMinutes, neutralizeFormula(s.role), neutralizeFormula(s.source), neutralizeFormula(s.id),
    ]),
  });
}
