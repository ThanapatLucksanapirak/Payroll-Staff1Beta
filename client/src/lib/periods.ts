import type { SiteRules } from "@shared/schema";
import { addDays, daysBetween, isISODate, isoParts, startOfWeek, toISO, todayISO } from "@shared/dates";

export interface Period { start: string; end: string; label: string }

function lastDayOfMonth(y: number, m: number) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Pay period containing `day`, shifted by `offset` periods. */
export function payPeriod(rules: SiteRules, offset = 0, day = todayISO(rules.timezone)): Period {
  const kind = rules.payPeriod;
  if (kind === "weekly" || kind === "biweekly") {
    const len = kind === "weekly" ? 7 : 14;
    const anchor = isISODate(rules.payPeriodAnchor) ? rules.payPeriodAnchor : startOfWeek(day, rules.weekStartsOn);
    const diff = daysBetween(anchor, day);
    const idx = Math.floor(diff / len) + offset;
    const start = addDays(anchor, idx * len);
    return { start, end: addDays(start, len - 1), label: "" };
  }
  const [y, m, d] = isoParts(day);
  if (kind === "monthly") {
    const dt = new Date(Date.UTC(y, m - 1 + offset, 1));
    const yy = dt.getUTCFullYear(), mm = dt.getUTCMonth() + 1;
    return { start: toISO(yy, mm, 1)!, end: toISO(yy, mm, lastDayOfMonth(yy, mm))!, label: "" };
  }
  // semimonthly
  let half = (y * 12 + (m - 1)) * 2 + (d > 15 ? 1 : 0) + offset;
  const mi = Math.floor(half / 2);
  const yy = Math.floor(mi / 12), mm = (mi % 12) + 1;
  half = half % 2;
  return half === 0
    ? { start: toISO(yy, mm, 1)!, end: toISO(yy, mm, 15)!, label: "" }
    : { start: toISO(yy, mm, 16)!, end: toISO(yy, mm, lastDayOfMonth(yy, mm))!, label: "" };
}

export const PERIOD_LABELS: Record<SiteRules["payPeriod"], string> = {
  weekly: "Weekly", biweekly: "Every 2 weeks", semimonthly: "Twice a month (1–15, 16–end)", monthly: "Monthly",
};
