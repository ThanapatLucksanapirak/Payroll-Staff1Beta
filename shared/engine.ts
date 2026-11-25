// The single payroll engine. Pure and deterministic: the client runs it as
// derived state (every edit recomputes instantly) and the server uses the same
// code when it needs totals. There is no other copy of the pay math.
import {
  type AnalysisResult, type BonusEntry, type Category, type DayResult, type DayType, type EmployeeConfig,
  type EmployeeSummary, type ManualEmployee, type PaymentMethod, type PaymentSplit, type PayrollWarning, type Shift, type SiteRules, DEFAULT_RULES,
} from "./schema";
import { dayOfWeek, formatTime, isISODate, parseDateToISO, startOfWeek } from "./dates";

export const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function employeeKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeName(name: string): string {
  return String(name ?? "").trim().replace(/\s+/g, " ");
}

export interface ResolvedRates {
  payBasis: "day_rate" | "hourly";
  fullDayRate: number;
  halfDayRate: number;
  hourlyRate: number;
  isNetPay: boolean;
  categoryName: string | null;
}

export function resolveRates(cfg: EmployeeConfig | undefined, categories: Category[]): ResolvedRates {
  if (!cfg) return { payBasis: "day_rate", fullDayRate: 0, halfDayRate: 0, hourlyRate: 0, isNetPay: true, categoryName: null };
  const cat = cfg.categoryId && cfg.categoryId !== "custom" ? categories.find((c) => c.id === cfg.categoryId) : undefined;
  if (cat) {
    return {
      payBasis: cat.payBasis, fullDayRate: cat.fullDayRate, halfDayRate: cat.halfDayRate, hourlyRate: cat.hourlyRate,
      isNetPay: cfg.isNetPay, categoryName: cat.name,
    };
  }
  return {
    payBasis: cfg.payBasis, fullDayRate: Number(cfg.fullDayRate) || 0, halfDayRate: Number(cfg.halfDayRate) || 0,
    hourlyRate: Number(cfg.hourlyRate) || 0, isNetPay: cfg.isNetPay, categoryName: null,
  };
}

export function cutoffsFor(rules: SiteRules, iso: string): { inCut: number; outCut: number } {
  const ov = rules.weekdayOverrides?.[String(dayOfWeek(iso))];
  const inCut = ov ? ov.clockInCutoff : rules.clockInCutoff;
  let outCut = ov ? ov.clockOutCutoff : rules.clockOutCutoff;
  if (outCut <= inCut) outCut += 1440; // closing time after midnight
  return { inCut, outCut };
}

function shiftPaidMinutes(s: Shift, rules: SiteRules): number {
  let mins = Math.max(0, s.end - s.start);
  if (rules.deductUnpaidBreaks) mins = Math.max(0, mins - (s.breakMinutes || 0));
  if (rules.roundingMinutes > 0) mins = Math.round(mins / rules.roundingMinutes) * rules.roundingMinutes;
  return mins;
}

interface DayGroup { key: string; date: string; shifts: Shift[] }

function groupDays(shifts: Shift[], rules: SiteRules): DayGroup[] {
  const sorted = [...shifts].sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start);
  const out: DayGroup[] = [];
  const byDate = new Map<string, DayGroup>();
  const counter = new Map<string, number>();
  for (const s of sorted) {
    if (rules.mergeSameDayShifts) {
      let g = byDate.get(s.date);
      if (!g) { g = { key: s.date, date: s.date, shifts: [] }; byDate.set(s.date, g); out.push(g); }
      g.shifts.push(s);
    } else {
      const n = (counter.get(s.date) ?? 0) + 1;
      counter.set(s.date, n);
      out.push({ key: n === 1 ? s.date : `${s.date}#${n}`, date: s.date, shifts: [s] });
    }
  }
  return out;
}

export function classifyDay(group: { date: string; shifts: Shift[] }, rules: SiteRules): { dayType: DayType; notes: string; paidMinutes: number } {
  const start = Math.min(...group.shifts.map((s) => s.start));
  const end = Math.max(...group.shifts.map((s) => s.end));
  const paidMinutes = sum(group.shifts.map((s) => shiftPaidMinutes(s, rules)));
  const hrs = paidMinutes / 60;
  const punchNote = group.shifts.length > 1 ? ` · ${group.shifts.length} punches` : "";

  if (rules.classificationMethod === "hours") {
    const label = `${round2(hrs)} h worked`;
    if (hrs >= rules.fullDayMinHours) return { dayType: "full_day", notes: `Full day · ${label}${punchNote}`, paidMinutes };
    if (hrs >= rules.halfDayMinHours) return { dayType: "half_day", notes: `Half day · ${label}${punchNote}`, paidMinutes };
    return { dayType: "flagged", notes: `Short shift · ${label}${punchNote}`, paidMinutes };
  }

  const { inCut, outCut } = cutoffsFor(rules, group.date);
  const g = rules.graceMinutes || 0;
  const onTimeIn = start < inCut + g;
  const stayedLate = end >= outCut - g;
  if (onTimeIn && stayedLate) return { dayType: "full_day", notes: `Full day${punchNote}`, paidMinutes };
  if (onTimeIn) return { dayType: "half_day", notes: `Left at ${formatTime(end)} (before ${formatTime(outCut)})${punchNote}`, paidMinutes };
  if (stayedLate) return { dayType: "half_day", notes: `Started ${formatTime(start)} (after ${formatTime(inCut)})${punchNote}`, paidMinutes };
  return { dayType: "flagged", notes: `Started ${formatTime(start)} and left ${formatTime(end)}${punchNote}`, paidMinutes };
}

function dayRatePay(type: DayType, r: ResolvedRates, rules: SiteRules): number {
  if (type === "full_day") return r.fullDayRate;
  if (type === "half_day") return r.halfDayRate;
  if (type === "flagged") return rules.flaggedDayPay === "full" ? r.fullDayRate : rules.flaggedDayPay === "half" ? r.halfDayRate : 0;
  return 0;
}

/**
 * Split a person's total by payment method. "default" uses the pay run's
 * default. A split pays up to `splitCashAmount` in cash and the rest by bank.
 * Nothing is paid out for a total of zero or less.
 */
export function paymentFor(method: "default" | PaymentMethod | undefined, splitCashAmount: number | undefined, total: number, rules: Pick<SiteRules, "defaultPaymentMethod">): PaymentSplit {
  const m: PaymentMethod = !method || method === "default" ? rules.defaultPaymentMethod ?? "bank" : method;
  const t = Math.max(0, round2(total));
  if (m === "split") {
    const cash = round2(Math.min(t, Math.max(0, Number(splitCashAmount) || 0)));
    return { method: m, cash, bank: round2(t - cash), check: 0 };
  }
  return { method: m, cash: m === "cash" ? t : 0, bank: m === "bank" ? t : 0, check: m === "check" ? t : 0 };
}

/** Bonus dates may be legacy M/D/YY strings; normalise to ISO for matching. */
export function bonusDate(b: BonusEntry): string {
  if (!b.date) return "";
  return isISODate(b.date) ? b.date : parseDateToISO(b.date) ?? "";
}

export interface ComputeInput {
  shifts: Shift[];
  employees: EmployeeConfig[];
  manualEmployees: ManualEmployee[];
  categories: Category[];
  rules?: SiteRules;
}

export function computePayroll(input: ComputeInput): AnalysisResult {
  const rules = { ...DEFAULT_RULES, ...(input.rules ?? {}) };
  const warnings: PayrollWarning[] = [];
  const cfgByKey = new Map(input.employees.map((e) => [employeeKey(e.name), e]));

  // Bucket valid shifts per employee
  const perEmp = new Map<string, { name: string; shifts: Shift[] }>();
  for (const s of input.shifts) {
    const name = normalizeName(s.employee);
    if (!name || !isISODate(s.date)) continue;
    if (s.end <= s.start) {
      warnings.push({ level: "warn", employee: name, date: s.date, message: "Shift has no valid clock-out and was skipped" });
      continue;
    }
    const dur = s.end - s.start;
    if (rules.minShiftMinutes > 0 && dur < rules.minShiftMinutes) {
      warnings.push({ level: "info", employee: name, date: s.date, message: `Ignored a ${dur}-minute punch (shorter than the ${rules.minShiftMinutes}-minute minimum)` });
      continue;
    }
    if (rules.longShiftWarningHours > 0 && dur / 60 > rules.longShiftWarningHours) {
      warnings.push({ level: "warn", employee: name, date: s.date, message: `Unusually long shift (${round2(dur / 60)} h) — possible missed clock-out` });
    }
    const k = employeeKey(name);
    if (!perEmp.has(k)) perEmp.set(k, { name: cfgByKey.get(k)?.name ?? name, shifts: [] });
    perEmp.get(k)!.shifts.push(s);
  }
  // Employees configured but without shifts still appear (bonus-only / zero rows)
  for (const e of input.employees) {
    const k = employeeKey(e.name);
    if (!perEmp.has(k) && (e.bonuses.length || Object.keys(e.adjustments).length)) perEmp.set(k, { name: e.name, shifts: [] });
  }

  const employees: EmployeeSummary[] = [];
  let periodStart = "";
  let periodEnd = "";
  const touch = (d: string) => {
    if (!isISODate(d)) return;
    if (!periodStart || d < periodStart) periodStart = d;
    if (!periodEnd || d > periodEnd) periodEnd = d;
  };

  for (const [k, { name, shifts }] of perEmp) {
    const cfg = cfgByKey.get(k);
    const rates = resolveRates(cfg, input.categories);
    const adjustments = cfg?.adjustments ?? {};
    const bonuses = cfg?.bonuses ?? [];
    const deductions = (cfg?.deductions ?? []).filter((d) => d.amount > 0);
    if (!cfg || (rates.payBasis === "day_rate" ? rates.fullDayRate <= 0 && rates.halfDayRate <= 0 : rates.hourlyRate <= 0)) {
      if (!cfg?.excluded) warnings.push({ level: "warn", employee: name, message: "No pay rate set" });
    }

    const groups = groupDays(shifts, rules);
    const datedBonuses = new Map<string, BonusEntry[]>();
    const generalBonuses: BonusEntry[] = [];
    for (const b of bonuses) {
      if (!(b.amount > 0)) continue;
      const d = bonusDate(b);
      if (d) { if (!datedBonuses.has(d)) datedBonuses.set(d, []); datedBonuses.get(d)!.push(b); }
      else generalBonuses.push(b);
    }

    // Overtime bookkeeping (hourly only)
    const weekRegular = new Map<string, number>();
    const days: DayResult[] = [];
    const bonusUsed = new Set<string>();

    for (const g of groups) {
      const { dayType: orig, notes, paidMinutes } = classifyDay(g, rules);
      const adj = adjustments[g.key] ?? {};
      const dayType: DayType = adj.overrideStatus ?? orig;
      const hours = paidMinutes / 60;
      let base = 0;
      let otHours = 0;
      if (rates.payBasis === "hourly") {
        if (dayType !== "absent") {
          if (rules.overtimeEnabled) {
            const wk = startOfWeek(g.date, rules.weekStartsOn);
            const used = weekRegular.get(wk) ?? 0;
            const weeklyLeft = Math.max(0, rules.overtimeWeeklyHours - used);
            const dailyCap = rules.overtimeDailyHours > 0 ? rules.overtimeDailyHours : Infinity;
            const regular = Math.min(hours, weeklyLeft, dailyCap);
            otHours = Math.max(0, hours - regular);
            weekRegular.set(wk, used + regular);
            base = regular * rates.hourlyRate + otHours * rates.hourlyRate * rules.overtimeMultiplier;
          } else {
            base = hours * rates.hourlyRate;
          }
        }
      } else {
        base = dayRatePay(dayType, rates, rules);
      }
      base = round2(base);
      const cancelled = !!adj.cancelled;
      const dock = cancelled ? 0 : Math.min(Math.max(0, Number(adj.dockAmount) || 0), base);
      const dayBonuses = g.key === g.date ? (datedBonuses.get(g.date) ?? []) : [];
      if (dayBonuses.length) bonusUsed.add(g.date);
      const start = Math.min(...g.shifts.map((s) => s.start));
      const end = Math.max(...g.shifts.map((s) => s.end));
      touch(g.date);
      days.push({
        key: g.key, date: g.date,
        clockIn: formatTime(start), clockOut: formatTime(end), start, end,
        hours: round2(hours), overtimeHours: round2(otHours), punches: g.shifts.length,
        dayType, originalDayType: orig, notes,
        basePay: base, dockAmount: round2(dock), pay: cancelled ? 0 : round2(base - dock), cancelled,
        adjustmentNote: adj.note || undefined,
        bonuses: dayBonuses, shiftIds: g.shifts.map((s) => s.id), hasManualShift: g.shifts.some((s) => s.source === "manual"),
      });
    }
    // Bonuses on dates without a shift become their own rows
    for (const [d, list] of datedBonuses) {
      if (bonusUsed.has(d)) continue;
      touch(d);
      days.push({
        key: d, date: d, clockIn: "—", clockOut: "—", start: null, end: null, hours: 0, overtimeHours: 0, punches: 0,
        dayType: "absent", originalDayType: "absent", notes: "Bonus only", basePay: 0, dockAmount: 0, pay: 0,
        cancelled: false, bonuses: list, shiftIds: [], hasManualShift: false,
      });
    }
    days.sort((a, b) => a.key.localeCompare(b.key));

    const totalBasePay = round2(sum(days.map((d) => d.pay)));
    const totalBonuses = round2(sum(days.flatMap((d) => d.bonuses.map((b) => b.amount))) + sum(generalBonuses.map((b) => b.amount)));
    const totalDeductions = round2(sum(deductions.map((d) => d.amount)));
    const live = days.filter((d) => d.punches > 0);
    employees.push({
      sourceId: `shift:${k}`, name, payBasis: rates.payBasis, categoryName: rates.categoryName,
      fullDays: live.filter((d) => d.dayType === "full_day" && !d.cancelled).length,
      halfDays: live.filter((d) => d.dayType === "half_day" && !d.cancelled).length,
      flaggedDays: live.filter((d) => d.dayType === "flagged" && !d.cancelled).length,
      absentDays: live.filter((d) => d.dayType === "absent").length,
      cancelledDays: live.filter((d) => d.cancelled).length,
      hoursWorked: round2(sum(live.map((d) => d.hours))),
      overtimeHours: round2(sum(live.map((d) => d.overtimeHours))),
      totalBasePay, totalDocked: round2(sum(days.map((d) => d.dockAmount))), totalBonuses, totalDeductions,
      totalPay: round2(totalBasePay + totalBonuses - totalDeductions),
      payment: paymentFor(cfg?.paymentMethod, cfg?.splitCashAmount, totalBasePay + totalBonuses - totalDeductions, rules),
      fullDayRate: rates.fullDayRate, halfDayRate: rates.halfDayRate, hourlyRate: rates.hourlyRate, isNetPay: rates.isNetPay,
      days, generalBonuses, generalDeductions: deductions, isManual: false, excluded: !!cfg?.excluded,
    });
  }

  employees.sort((a, b) => a.name.localeCompare(b.name));

  // Manual employees (no timecards)
  for (const m of input.manualEmployees) {
    const name = normalizeName(m.name);
    if (!name) continue;
    const days: DayResult[] = [];
    let base = 0;
    if (m.payMode === "by_date") {
      for (const pd of m.payDates) {
        if (!(pd.amount > 0)) continue;
        const iso = isISODate(pd.date) ? pd.date : parseDateToISO(pd.date) ?? "";
        if (iso) touch(iso);
        base += pd.amount;
        days.push({
          key: iso || `manual-${days.length}`, date: iso, clockIn: "—", clockOut: "—", start: null, end: null, hours: 0, overtimeHours: 0,
          punches: 0, dayType: "full_day", originalDayType: "full_day", notes: pd.note || "Manual pay", basePay: pd.amount,
          dockAmount: 0, pay: pd.amount, cancelled: false, bonuses: [], shiftIds: [], hasManualShift: false,
        });
      }
    } else {
      base = m.lumpSum || 0;
      days.push({
        key: "lump", date: "", clockIn: "—", clockOut: "—", start: null, end: null, hours: 0, overtimeHours: 0, punches: 0,
        dayType: "full_day", originalDayType: "full_day", notes: "Lump sum for period", basePay: base, dockAmount: 0, pay: base,
        cancelled: false, bonuses: [], shiftIds: [], hasManualShift: false,
      });
    }
    const gb = m.bonuses.filter((b) => b.amount > 0);
    const dd = m.deductions.filter((d) => d.amount > 0);
    const totalBonuses = round2(sum(gb.map((b) => b.amount)));
    const totalDeductions = round2(sum(dd.map((d) => d.amount)));
    employees.push({
      sourceId: `manual:${m.id}`, name, payBasis: "day_rate", categoryName: null,
      fullDays: 0, halfDays: 0, flaggedDays: 0, absentDays: 0, cancelledDays: 0, hoursWorked: 0, overtimeHours: 0,
      totalBasePay: round2(base), totalDocked: 0, totalBonuses, totalDeductions,
      totalPay: round2(base + totalBonuses - totalDeductions),
      payment: paymentFor(m.paymentMethod, m.splitCashAmount, base + totalBonuses - totalDeductions, rules),
      fullDayRate: 0, halfDayRate: 0, hourlyRate: 0, isNetPay: m.isNetPay, days,
      generalBonuses: gb, generalDeductions: dd, isManual: true, excluded: m.excluded,
    });
  }

  const inc = employees.filter((e) => !e.excluded);
  return {
    periodStart, periodEnd, employees, warnings,
    totals: {
      employees: inc.length,
      totalPay: round2(sum(inc.map((e) => e.totalPay))),
      netPay: round2(sum(inc.filter((e) => e.isNetPay).map((e) => e.totalPay))),
      grossPay: round2(sum(inc.filter((e) => !e.isNetPay).map((e) => e.totalPay))),
      bonuses: round2(sum(inc.map((e) => e.totalBonuses))),
      deductions: round2(sum(inc.map((e) => e.totalDeductions))),
      docked: round2(sum(inc.map((e) => e.totalDocked))),
      fullDays: sum(inc.map((e) => e.fullDays)),
      halfDays: sum(inc.map((e) => e.halfDays)),
      flaggedDays: sum(inc.map((e) => e.flaggedDays)),
      hours: round2(sum(inc.map((e) => e.hoursWorked))),
      overtimeHours: round2(sum(inc.map((e) => e.overtimeHours))),
      cash: round2(sum(inc.map((e) => e.payment.cash))),
      bank: round2(sum(inc.map((e) => e.payment.bank))),
      check: round2(sum(inc.map((e) => e.payment.check))),
    },
  };
}

/** Distinct employee names (display casing) in shift order. */
export function shiftEmployeeNames(shifts: Shift[]): string[] {
  const seen = new Map<string, string>();
  for (const s of shifts) {
    const n = normalizeName(s.employee);
    if (n && !seen.has(employeeKey(n))) seen.set(employeeKey(n), n);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}
