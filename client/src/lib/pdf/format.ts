// Text and number formatting for PDFs.
//
// jsPDF's built-in fonts (Helvetica) only cover the WinAnsi (Windows-1252)
// character set. Anything outside it renders as garbage, so every string that
// reaches the PDF goes through `pdfText`, and currency symbols that can't be
// drawn fall back to their ISO code ("PHP 1,200.00").
import { DAY_LABELS, type DayResult, type Prefs } from "@shared/schema";
import { WEEKDAYS_SHORT, dayOfWeek, formatDate, formatTime, isISODate } from "@shared/dates";

/** Characters 0x80–0x9F of Windows-1252 that map to Unicode outside Latin-1. */
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

/** Thai letters, vowels, tone marks, digits and ฿. */
export const THAI_RE = /[\u0E01-\u0E5B]/;
let thaiFont = false;
/** Set by createCtx while a document is built with the Thai-capable font. */
export function setThaiFont(on: boolean) { thaiFont = on; }

export function isPdfSafeChar(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.has(ch) || ch === "\n" || (thaiFont && c >= 0x0e01 && c <= 0x0e5b);
}

const CHAR_MAP: Record<string, string> = {
  "−": "-", "‐": "-", "‑": "-", "‒": "-", "―": "—", "′": "'", "″": '"',
  "→": "->", "←": "<-", "≤": "<=", "≥": ">=", "≠": "!=", "…": "…", " ": " ", " ": " ", "​": "",
  "✓": "v", "✔": "v", "✕": "x", "✗": "x", " ": " ", "\t": " ", "\r": "",
  Ł: "L", ł: "l", Đ: "D", đ: "d", ı: "i", Ħ: "H", ħ: "h", Ŀ: "L", ŀ: "l", Ŧ: "T", ŧ: "t", ĸ: "k", ŉ: "'n", Ŋ: "N", ŋ: "n",
  ẞ: "SS", Ș: "S", ș: "s", Ț: "T", ț: "t",
};

/** Make any string drawable with jsPDF's standard fonts. */
export function pdfText(input: unknown): string {
  const s = String(input ?? "").normalize("NFC");
  let out = "";
  for (const ch of s) {
    if (isPdfSafeChar(ch)) { out += ch; continue; }
    if (ch in CHAR_MAP) { out += CHAR_MAP[ch]; continue; }
    // Strip accents that Latin-1 has no precomposed form for (e.g. "č" → "c").
    const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (base && base !== ch && [...base].every(isPdfSafeChar)) { out += base; continue; }
    out += "?";
  }
  return out;
}

/** Symbols jsPDF can't draw → ISO 4217 code. */
const CURRENCY_CODES: Record<string, string> = {
  "₱": "PHP", "₹": "INR", "₩": "KRW", "฿": "THB", "₫": "VND", "₦": "NGN", "₺": "TRY", "₽": "RUB", "₴": "UAH", "₪": "ILS",
  "₡": "CRC", "₲": "PYG", "₵": "GHS", "₸": "KZT", "₭": "LAK", "₮": "MNT", "៛": "KHR", "₼": "AZN", "₾": "GEL", "₿": "BTC",
  "zł": "PLN", "Kč": "CZK", "лв": "BGN", "лв.": "BGN", "₨": "PKR", "৳": "BDT", "﷼": "SAR", "د.إ": "AED", "Ft": "HUF", "ден": "MKD",
  "₠": "ECU", "₣": "FRF", "₤": "ITL", "₧": "ESP", "₥": "MIL", "₰": "PF", "₳": "ARA", "₯": "GRD", "₶": "LTT", "₷": "SPM",
};

/**
 * The prefix used before amounts. Drawable symbols are used as-is ("$", "€",
 * "£", "¥", "R$", "CHF "), otherwise a known ISO code ("PHP ") or, failing
 * that, whatever part of the symbol can be drawn.
 */
export function pdfCurrencyPrefix(symbol: string): string {
  const s = (symbol ?? "").trim();
  if (!s) return "";
  if ([...s].every(isPdfSafeChar)) return /^[A-Za-z]{2,}$/.test(s) ? `${s} ` : s;
  if (CURRENCY_CODES[s]) return `${CURRENCY_CODES[s]} `;
  const safe = [...s].filter(isPdfSafeChar).join("").trim();
  return safe ? (/^[A-Za-z]{2,}$/.test(safe) ? `${safe} ` : safe) : "";
}

export const MINUS = "–"; // en dash reads better than a hyphen for negative money

const nf = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface Fmt {
  cur: string;
  /** "$1,234.50" / "–$20.00" */
  money(n: number): string;
  /** "+$20.00" / "–$20.00"; zero → "" */
  signed(n: number): string;
  /** Number of hours, two decimals. */
  hours(n: number): string;
  date(iso: string | null | undefined): string;
  /** "Mon 11/3/26" */
  day(iso: string): string;
  time(min: number | null | undefined): string;
  /** Pay period "11/2/26 – 11/15/26" */
  period(start: string, end: string): string;
  /** Rewrites "5:30 PM" inside engine notes to match the time-format pref. */
  note(s: string): string;
  text(s: unknown): string;
}

export function makeFmt(prefs: Pick<Prefs, "currencySymbol" | "dateFormat" | "timeFormat">): Fmt {
  const cur = pdfCurrencyPrefix(prefs.currencySymbol);
  const clean = (n: number) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);
  const money = (n: number) => {
    const v = clean(n);
    return `${v < 0 ? MINUS : ""}${cur}${nf.format(Math.abs(v))}`;
  };
  const date = (iso: string | null | undefined) => (iso ? pdfText(formatDate(iso, prefs.dateFormat)) : "—");
  return {
    cur,
    money,
    signed: (n) => { const v = clean(n); return v === 0 ? "" : `${v > 0 ? "+" : MINUS}${cur}${nf.format(Math.abs(v))}`; },
    hours: (n) => (Number.isFinite(n) ? n : 0).toFixed(2),
    date,
    // Weekday + date; the long month format drops the year (the period header has it).
    day: (iso) => (isISODate(iso) ? `${WEEKDAYS_SHORT[dayOfWeek(iso)]} ${prefs.dateFormat === "MMM D, YYYY" ? date(iso).replace(/, \d{4}$/, "") : date(iso)}` : date(iso)),
    time: (m) => (m == null ? "—" : formatTime(m, prefs.timeFormat)),
    period: (a, b) => (!a && !b ? "No dates yet" : a === b || !b ? date(a) : `${date(a)} – ${date(b)}`),
    note: (s) => pdfText(prefs.timeFormat === "24h"
      ? String(s ?? "").replace(/\b(\d{1,2}):(\d{2}) ?(AM|PM)\b/g, (_, h, m, ap) => `${String(((+h % 12) + (ap === "PM" ? 12 : 0))).padStart(2, "0")}:${m}`)
      : s),
    text: pdfText,
  };
}

/** The note text worth printing for a day (engine notes that only repeat the status are dropped). */
export function dayNote(d: DayResult, fmt: Fmt, opts: { includeMoney?: boolean } = {}): string {
  const parts: string[] = [];
  const n = (d.notes || "").trim();
  if (n && n !== DAY_LABELS[d.dayType] && n !== DAY_LABELS[d.originalDayType] && !/^(Full day|Half day)( · \d+ punches)?$/.test(n)) parts.push(fmt.note(n));
  else if (d.punches > 1) parts.push(`${d.punches} punches`);
  if (d.cancelled) parts.push("Not paid");
  if (opts.includeMoney && d.dockAmount) parts.push(`Docked ${fmt.money(d.dockAmount)}`);
  for (const b of d.bonuses) if (b.description) parts.push(fmt.text(b.description));
  if (d.adjustmentNote) parts.push(fmt.text(d.adjustmentNote));
  return parts.join(" · ");
}

/** Local "today" as ISO plus minutes after midnight. */
export function localStamp(at: Date): { iso: string; minutes: number } {
  const p = (n: number) => String(n).padStart(2, "0");
  return { iso: `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`, minutes: at.getHours() * 60 + at.getMinutes() };
}
