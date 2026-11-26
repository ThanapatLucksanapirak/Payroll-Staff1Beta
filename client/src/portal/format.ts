// Formatting for the portal: times in the location's time zone, short dates,
// hours and money. Plain and short.
import { formatTime } from "@shared/dates";
import type { Me } from "./api";

export const firstName = (n: string) => n.trim().split(/\s+/)[0] || n;

function dtf(tz: string | undefined, opts: Intl.DateTimeFormatOptions) {
  try { return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: tz }); } catch { return new Intl.DateTimeFormat(undefined, opts); }
}
const utcDate = (iso: string) => new Date(`${iso}T12:00:00Z`);

/** "Mon, Nov 24" for an ISO date. */
export const dayLabel = (iso: string) => dtf("UTC", { weekday: "short", month: "short", day: "numeric" }).format(utcDate(iso));
/** "Nov 24" for an ISO date. */
export const shortDate = (iso: string) => dtf("UTC", { month: "short", day: "numeric" }).format(utcDate(iso));
/** "Nov 17 – Nov 30" (one date when start = end). */
export const range = (a: string, b: string) => (a === b ? shortDate(a) : `${shortDate(a)} – ${shortDate(b)}`);

/** Clock time of an instant in the location. */
export function clock(at: string, me: Me): string {
  return dtf(me.site.timezone, { hour: "numeric", minute: "2-digit", hourCycle: me.prefs.timeFormat === "24h" ? "h23" : "h12" }).format(new Date(at));
}
/** Minutes after midnight as a clock time (schedule shifts). */
export const minutesClock = (min: number, me: Me) => formatTime(min % 1440, me.prefs.timeFormat);

/** "7h 38m" / "45m". */
export function hm(min: number): string {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export function money(n: number, me: Me): string {
  const abs = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "−" : ""}${me.prefs.currencySymbol || "$"}${abs}`;
}

/**
 * What My hours shows for a period: time-clock days, hours from finalized pay
 * statements (when the time clock saw nothing), or nothing. The "doesn't use the
 * time clock" note only goes with nothing, so it can't sit above hours it contradicts.
 */
export function hoursView(d: { days: unknown[]; timesheets?: { minutes: number }[] }, timeClock: boolean) {
  const sheets = d.timesheets ?? [];
  const fromSheets = !d.days.length && sheets.length > 0;
  return {
    fromSheets,
    sheetMinutes: sheets.reduce((a, t) => a + t.minutes, 0),
    noClockNote: !timeClock && !d.days.length && !fromSheets,
  };
}
