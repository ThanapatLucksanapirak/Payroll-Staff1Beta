// Date & time helpers. Internally every date is an ISO "YYYY-MM-DD" string and
// every time is "minutes after midnight of the shift date" (may exceed 1440 for
// overnight shifts). Parsing is lenient so that Square, Toast, Sling and legacy
// records all normalise to the same representation.

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const pad = (n: number) => String(n).padStart(2, "0");

export function isISODate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function toISO(y: number, m: number, d: number): string | null {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function expandYear(y: number): number {
  if (y >= 100) return y;
  return y + 2000;
}

/**
 * Whether slash dates like 03/11/2026 are day-first, judged from the values
 * themselves: a first number over 12 means D/M, a second over 12 means M/D.
 * Returns null when every date could be either.
 */
export function detectDayFirst(values: string[]): boolean | null {
  let dm = false, md = false;
  for (const v of values) {
    const m = String(v).match(/(?<![\d-])(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?/);
    if (!m) continue;
    if (+m[1] > 12 && +m[2] <= 12) dm = true;
    else if (+m[2] > 12 && +m[1] <= 12) md = true;
    if (dm && md) return null;
  }
  return dm ? true : md ? false : null;
}

/** Parse many date spellings into ISO. Returns null if no date is found. */
export function parseDateToISO(input: unknown, opts: { defaultYear?: number; dayFirst?: boolean } = {}): string | null {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;
  const fallbackYear = opts.defaultYear ?? new Date().getFullYear();

  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return toISO(+m[1], +m[2], +m[3]);

  m = s.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (m) {
    const y = m[3] ? expandYear(+m[3]) : fallbackYear;
    return opts.dayFirst ? toISO(y, +m[2], +m[1]) : toISO(y, +m[1], +m[2]);
  }

  // "Nov 3, 2026", "November 3", "Mon, Nov 3"
  m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/);
  if (m && MONTHS[m[1].slice(0, m[1].toLowerCase().startsWith("sept") ? 4 : 3).toLowerCase()]) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return toISO(m[3] ? +m[3] : fallbackYear, mon, +m[2]);
  }
  // "3 Nov 2026"
  m = s.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?(?:,?\s+(\d{4}))?/);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
    return toISO(m[3] ? +m[3] : fallbackYear, MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
  }
  return null;
}

/** Parse "10:09:00 AM", "10:09am", "10a", "9p", "22:15" into minutes after midnight. */
export function parseTimeToMinutes(input: unknown): number | null {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(a|p)?\.?\s*(m)?\.?/);
  if (!m) return null;
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  const mer = m[4];
  if (!m[2] && !mer) return null; // bare number is not a time
  if (min > 59) return null;
  if (mer) {
    if (h < 1 || h > 12) return null;
    if (mer === "a") h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  } else if (h > 24) return null;
  return (h % 24) * 60 + min;
}

export function hasMeridiem(s: string): boolean {
  return /\d\s*[ap]\.?\s*m?\.?\b/i.test(s) || /\d\s*[ap]$/i.test(s.trim());
}

/** "10:09 AM" from minutes (wraps past midnight). */
export function formatTime(min: number | null | undefined, style: "12h" | "24h" = "12h"): string {
  if (min == null || !Number.isFinite(min)) return "—";
  const total = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (style === "24h") return `${pad(h)}:${pad(m)}`;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}

/** "HH:MM" for <input type="time"> */
export function minutesToInput(min: number | null | undefined): string {
  if (min == null) return "";
  return formatTime(min, "24h");
}

export function inputToMinutes(v: string): number | null {
  const m = v.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return +m[1] * 60 + +m[2];
}

export function isoParts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split("-").map(Number);
  return [y, m, d];
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = isoParts(iso);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function dayOfWeek(iso: string): number {
  const [y, m, d] = isoParts(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = isoParts(a);
  const [y2, m2, d2] = isoParts(b);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

export function startOfWeek(iso: string, weekStartsOn: number): string {
  const diff = (dayOfWeek(iso) - weekStartsOn + 7) % 7;
  return addDays(iso, -diff);
}

export function todayISO(timeZone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    if (isISODate(parts)) return parts;
  } catch { /* fall through */ }
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export type DateFormat = "M/D/YY" | "MM/DD/YYYY" | "D/M/YY" | "YYYY-MM-DD" | "MMM D, YYYY";

export function formatDate(iso: string | null | undefined, fmt: DateFormat = "M/D/YY"): string {
  if (!iso) return "—";
  if (!isISODate(iso)) {
    const parsed = parseDateToISO(iso);
    if (!parsed) return String(iso);
    iso = parsed;
  }
  const [y, m, d] = isoParts(iso);
  switch (fmt) {
    case "MM/DD/YYYY": return `${pad(m)}/${pad(d)}/${y}`;
    case "D/M/YY": return `${d}/${m}/${String(y).slice(2)}`;
    case "YYYY-MM-DD": return iso;
    case "MMM D, YYYY": return `${MONTHS_SHORT[m - 1]} ${d}, ${y}`;
    default: return `${m}/${d}/${String(y).slice(2)}`;
  }
}

/** Short weekday + date, e.g. "Mon 11/3" */
export function formatDayLabel(iso: string, fmt: DateFormat = "M/D/YY"): string {
  return `${WEEKDAYS_SHORT[dayOfWeek(iso)]} ${formatDate(iso, fmt)}`;
}

export function legacyDate(iso: string): string {
  const [y, m, d] = isoParts(iso);
  return `${m}/${d}/${String(y).slice(2)}`;
}

// Building an Intl.DateTimeFormat is slow (~0.1 ms); big imports call this
// hundreds of thousands of times, so keep one per time zone.
const tzFormatters = new Map<string, Intl.DateTimeFormat>();
function tzFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = tzFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    if (tzFormatters.size > 200) tzFormatters.clear();
    tzFormatters.set(timeZone, f);
  }
  return f;
}

/** Offset in minutes of `timeZone` from UTC at the given UTC instant. */
export function tzOffsetMinutes(timeZone: string, at: Date): number {
  try {
    const dtf = tzFormatter(timeZone);
    const p: Record<string, number> = {};
    for (const part of dtf.formatToParts(at)) if (part.type !== "literal") p[part.type] = +part.value;
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
    return Math.round((asUTC - at.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/** Convert an instant to local {date, minutes} in a time zone. */
export function instantToLocal(instant: string | Date, timeZone: string): { date: string; minutes: number } {
  const at = typeof instant === "string" ? new Date(instant) : instant;
  const off = tzOffsetMinutes(timeZone, at);
  const local = new Date(at.getTime() + off * 60000);
  return {
    date: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

/** RFC3339 timestamp for local midnight (+ minutes) of `iso` in `timeZone`. */
export function localToInstant(iso: string, minutes: number, timeZone: string): string {
  const [y, m, d] = isoParts(iso);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let off = tzOffsetMinutes(timeZone, new Date(guess));
  off = tzOffsetMinutes(timeZone, new Date(guess - off * 60000));
  return new Date(guess - off * 60000).toISOString();
}

export const COMMON_TIMEZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles",
  "America/Anchorage", "Pacific/Honolulu", "America/Toronto", "America/Vancouver", "Europe/London",
  "Europe/Paris", "Asia/Bangkok", "Asia/Tokyo", "Australia/Sydney", "UTC",
];
