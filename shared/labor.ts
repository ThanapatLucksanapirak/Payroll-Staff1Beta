// Labor cost vs. sales and payroll forecasting. Pure: the server gathers the
// punches, schedules, saved rates and sales, and these functions do the math
// with the same payroll engine as timesheets (day rates, overtime, rounding).
import type { Category, EmployeeConfig, EmployeeSummary, Shift, SiteRules } from "./schema";
import { computePayroll, round2 } from "./engine";
import { addDays, daysBetween, isISODate } from "./dates";
import { type ScheduledShift, type TimeOff, timeOffOn } from "./schedule";

export interface DayCost { cost: number; hours: number }

/** Every date from `from` to `to` (inclusive), capped at ~400 days. */
export function dateRange(from: string, to: string): string[] {
  if (!isISODate(from) || !isISODate(to) || to < from) return [];
  const n = Math.min(daysBetween(from, to), 400);
  return Array.from({ length: n + 1 }, (_, i) => addDays(from, i));
}

/** Pay and hours per date from engine output (excluded people are left out). */
export function dailyFromEmployees(employees: Pick<EmployeeSummary, "excluded" | "days">[], from: string, to: string): Record<string, DayCost> {
  const out: Record<string, DayCost> = {};
  for (const e of employees) {
    if (e.excluded || !Array.isArray(e.days)) continue;
    for (const d of e.days) {
      if (!d?.date || d.date < from || d.date > to) continue;
      const cur = out[d.date] ?? { cost: 0, hours: 0 };
      cur.cost += Number(d.pay) || 0;
      cur.hours += Number(d.hours) || 0;
      out[d.date] = cur;
    }
  }
  for (const k of Object.keys(out)) out[k] = { cost: round2(out[k].cost), hours: round2(out[k].hours) };
  return out;
}

export interface RateInput { employees: EmployeeConfig[]; categories: Category[]; rules: SiteRules }

/** Estimated labor cost per date: shifts × saved rates, through the payroll engine. */
export function laborFromShifts(shifts: Shift[], rates: RateInput, from: string, to: string): { days: Record<string, DayCost>; missingRates: string[] } {
  const inRange = shifts.filter((s) => s.date >= from && s.date <= to);
  if (!inRange.length) return { days: {}, missingRates: [] };
  const r = computePayroll({ shifts: inRange, employees: rates.employees, manualEmployees: [], categories: rates.categories, rules: rates.rules });
  return { days: dailyFromEmployees(r.employees, from, to), missingRates: missingRatesOf(r.warnings) };
}

const missingRatesOf = (warnings: { message: string; employee?: string }[]) =>
  [...new Set(warnings.filter((w) => w.message === "No pay rate set" && w.employee).map((w) => w.employee!))].sort();

// ── Labor vs. sales ──────────────────────────────────────────────────────────
export type SalesSource = "square" | "manual";
export type LaborSource = "timesheet" | "punches" | "square";

export interface LaborDay {
  date: string;
  sales: number | null;
  salesSource: SalesSource | null;
  labor: number;
  hours: number;
  laborSource: LaborSource | null;
  /** Labor as a share of sales (0.28 = 28%), or null without sales. */
  pct: number | null;
}

export interface LaborReport {
  from: string;
  to: string;
  days: LaborDay[];
  totals: { sales: number; labor: number; hours: number; pct: number | null; daysWithSales: number };
}

export function laborPercent(labor: number, sales: number | null | undefined): number | null {
  if (sales == null || !Number.isFinite(sales) || sales <= 0) return null;
  return labor / sales;
}

/** Manual entries win over Square for the same date. */
export function mergeSales(square: Record<string, number>, manual: Record<string, number>): Record<string, { amount: number; source: SalesSource }> {
  const out: Record<string, { amount: number; source: SalesSource }> = {};
  for (const [d, v] of Object.entries(square)) if (Number.isFinite(v)) out[d] = { amount: round2(v), source: "square" };
  for (const [d, v] of Object.entries(manual)) if (Number.isFinite(v)) out[d] = { amount: round2(v), source: "manual" };
  return out;
}

/**
 * Join labor and sales by date. Saved timesheet days win over estimates
 * from punches or Square timecards. The total percentage only counts days that have sales, so a
 * missing sales entry does not inflate it.
 */
export function laborReport(input: {
  from: string;
  to: string;
  fromTimesheets: Record<string, DayCost>;
  fromPunches: Record<string, DayCost>;
  /** Where the estimate in fromPunches came from: the app's time clock (default) or Square timecards. */
  estimateSource?: "punches" | "square";
  sales: Record<string, { amount: number; source: SalesSource }>;
}): LaborReport {
  const est = input.estimateSource ?? "punches";
  const days: LaborDay[] = dateRange(input.from, input.to).map((date) => {
    const ts = input.fromTimesheets[date];
    const pu = input.fromPunches[date];
    const labor = ts ?? pu;
    const s = input.sales[date];
    const cost = labor ? round2(labor.cost) : 0;
    return {
      date,
      sales: s ? s.amount : null,
      salesSource: s ? s.source : null,
      labor: cost,
      hours: labor ? round2(labor.hours) : 0,
      laborSource: ts ? "timesheet" : pu ? est : null,
      pct: laborPercent(cost, s?.amount),
    };
  });
  const withSales = days.filter((d) => d.sales != null && d.sales > 0);
  const sales = round2(withSales.reduce((a, d) => a + (d.sales ?? 0), 0));
  const laborWithSales = withSales.reduce((a, d) => a + d.labor, 0);
  return {
    from: input.from,
    to: input.to,
    days,
    totals: {
      sales,
      labor: round2(days.reduce((a, d) => a + d.labor, 0)),
      hours: round2(days.reduce((a, d) => a + d.hours, 0)),
      pct: laborPercent(laborWithSales, sales),
      daysWithSales: withSales.length,
    },
  };
}

// ── Payroll forecast ─────────────────────────────────────────────────────────
export interface OpenShift { employee: string; date: string; start: number }

export interface ForecastInput extends RateInput {
  period: { start: string; end: string };
  /** Local date and minutes after midnight right now. */
  today: string;
  nowMinutes: number;
  /** Finished shifts (from punches or saved timesheets). */
  actual: Shift[];
  /** People clocked in right now. */
  open?: OpenShift[];
  scheduled: ScheduledShift[];
  timeOff?: TimeOff[];
  /** Kiosk employee id → current name, so scheduled rows match punches. */
  names?: Record<string, string>;
}

export interface Forecast {
  start: string;
  end: string;
  /** Earned so far this period (finished shifts plus open shifts until now). */
  paidSoFar: number;
  /** Paid so far plus the rest of the schedule. */
  projected: number;
  remaining: number;
  actualHours: number;
  scheduledHoursRemaining: number;
  hasSchedule: boolean;
  missingRates: string[];
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

/**
 * Projected payroll for a pay period: what has been earned so far, plus the
 * scheduled hours still to come, all priced by the payroll engine in one pass
 * (so day rates and weekly overtime come out right). An estimate only.
 */
export function forecastPayroll(input: ForecastInput): Forecast {
  const { period, today } = input;
  const name = (s: ScheduledShift) => (s.employeeId && input.names?.[s.employeeId]) || s.employeeName;
  const key = (n: string) => n.trim().replace(/\s+/g, " ").toLowerCase();
  const actual = input.actual.filter((s) => s.date >= period.start && s.date <= period.end && s.date <= today);

  // Open shifts: counted until now, and (for the projection) until their scheduled end.
  const minutesNowOn = (date: string) => input.nowMinutes + daysBetween(date, today) * 1440;
  const openNow: Shift[] = [];
  const openProjected: Shift[] = [];
  for (const o of input.open ?? []) {
    if (o.date < period.start || o.date > period.end) continue;
    const now = Math.min(4320, minutesNowOn(o.date));
    if (now <= o.start) continue;
    const base: Shift = { id: `open_${key(o.employee)}_${o.date}_${o.start}`, employee: o.employee, date: o.date, start: o.start, end: now, breakMinutes: 0, role: "", source: "kiosk", note: "" };
    openNow.push(base);
    const sched = input.scheduled.find((s) => s.date === o.date && key(name(s)) === key(o.employee) && overlaps(s, { start: o.start, end: Math.max(now, o.start + 1) }));
    openProjected.push({ ...base, end: Math.max(now, sched ? Math.min(4320, sched.end) : now) });
  }

  // Scheduled shifts still to come.
  const future: Shift[] = [];
  let scheduledMinutes = 0;
  for (const s of input.scheduled) {
    if (s.date < period.start || s.date > period.end || s.date < today) continue;
    if (input.timeOff && timeOffOn(input.timeOff, s, s.date)) continue;
    const who = key(name(s));
    let start = s.start;
    if (s.date === today) {
      if (s.end <= input.nowMinutes) continue;
      const busy = [...actual, ...openProjected].some((a) => a.date === today && key(a.employee) === who && overlaps(a, s));
      if (busy) continue;
      start = Math.max(start, input.nowMinutes);
    }
    scheduledMinutes += s.end - start;
    future.push({ id: `sch_${s.id}`, employee: name(s), date: s.date, start, end: s.end, breakMinutes: 0, role: s.station, source: "manual", note: "Scheduled" });
  }

  const run = (shifts: Shift[]) => (shifts.length
    ? computePayroll({ shifts, employees: input.employees, manualEmployees: [], categories: input.categories, rules: input.rules })
    : null);
  const so = run([...actual, ...openNow]);
  const proj = run([...actual, ...openProjected, ...future]);
  const paidSoFar = so?.totals.totalPay ?? 0;
  // Never project less than what is already earned (e.g. a day rate that drops back once more shifts merge).
  const projected = Math.max(paidSoFar, proj?.totals.totalPay ?? 0);
  return {
    start: period.start,
    end: period.end,
    paidSoFar: round2(paidSoFar),
    projected: round2(projected),
    remaining: round2(projected - paidSoFar),
    actualHours: so?.totals.hours ?? 0,
    scheduledHoursRemaining: round2(scheduledMinutes / 60),
    hasSchedule: input.scheduled.some((s) => s.date >= period.start && s.date <= period.end),
    missingRates: missingRatesOf(proj?.warnings ?? []),
  };
}
