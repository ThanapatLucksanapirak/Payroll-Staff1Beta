// Pay extras: holiday premiums, standing bonuses/deductions, tip pooling and
// advance repayments, applied as post-processing on the engine's output so the
// core engine stays as it is. Plus the pure helpers around them (advance
// ledger, cash denominations, YTD, period comparison, accounting journal).
//
// Everything here is pure and deterministic. Money is rounded to cents.
import type {
  AnalysisResult, BonusEntry, Category, DeductionEntry, EmployeeConfig, EmployeeSummary, ExtraLine, ManualEmployee, PayExtrasSummary,
  PayrollWarning, SiteRules, TimesheetDoc,
} from "./schema";
import { DEFAULT_RULES } from "./schema";
import { computePayroll, employeeKey, normalizeName, paymentFor, round2, shiftEmployeeNames, totalsOf } from "./engine";
import type {
  Accounts, Advance, AdvanceSchedule, CashConfig, DocAdvance, DocPayExtras, DocRecurring, Holiday, PayContext, RateSegment, Repayment, Tips,
} from "./payTypes";
import { accountsSchema } from "./payTypes";

export * from "./payTypes";

const cents = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Extras id prefix on bonus / deduction entries the engine output gets from here. */
export const EXTRA_ID_PREFIX = "x:";

// ─────────────────────────────────────────────────────────────────────────────
// Splitting money exactly
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Split `total` in proportion to the weights, in whole cents, so the parts add
 * up exactly to the total (largest remainder; ties go to the earlier key).
 * Zero total weight splits evenly. Returns dollars.
 */
export function allocateCents(total: number, weights: { key: string; w: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  const T = cents(total);
  const ws = weights.map((x) => ({ key: x.key, w: Number.isFinite(x.w) && x.w > 0 ? x.w : 0 }));
  if (!ws.length || T <= 0) { for (const x of ws) out.set(x.key, 0); return out; }
  let W = sum(ws.map((x) => x.w));
  const even = W <= 0;
  if (even) { ws.forEach((x) => { x.w = 1; }); W = ws.length; }
  const parts = ws.map((x, i) => {
    const raw = (T * x.w) / W;
    const fl = Math.floor(raw + 1e-9);
    return { key: x.key, i, c: fl, frac: raw - fl };
  });
  let left = T - sum(parts.map((p) => p.c));
  const order = [...parts].sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && order.length; k = (k + 1) % order.length, left--) order[k].c++;
  for (const p of parts) out.set(p.key, (out.get(p.key) ?? 0) + p.c / 100);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tips
// ─────────────────────────────────────────────────────────────────────────────
export function tipsTotal(t: Tips | null | undefined): number {
  if (!t) return 0;
  return t.mode === "per_day" ? round2(sum(Object.values(t.perDay).map((v) => Math.max(0, Number(v) || 0)))) : round2(Math.max(0, t.total || 0));
}

/**
 * Share tips among the people who worked (not manual, not left out).
 * Weight = hours (× category points when split by points). Per-day tips go to
 * whoever worked that day. Returns each person's share and any amount that
 * could not be given to anyone (a day nobody worked).
 */
export function splitTips(employees: EmployeeSummary[], tips: Tips, cfgByKey: Map<string, EmployeeConfig>): { shares: Map<string, number>; unallocated: { date: string; amount: number }[] } {
  const shares = new Map<string, number>();
  const unallocated: { date: string; amount: number }[] = [];
  const pool = employees.filter((e) => !e.isManual && !e.excluded);
  const pts = (e: EmployeeSummary) => {
    if (tips.split !== "points") return 1;
    const cat = cfgByKey.get(employeeKey(e.name))?.categoryId || "custom";
    const p = tips.points[cat];
    return p == null ? 1 : Math.max(0, Number(p) || 0);
  };
  const add = (m: Map<string, number>) => { for (const [k, v] of m) shares.set(k, round2((shares.get(k) ?? 0) + v)); };
  const worked = (d: EmployeeSummary["days"][number]) => d.punches > 0 && !d.cancelled && d.dayType !== "absent";
  if (tips.mode === "per_day") {
    for (const [date, amt] of Object.entries(tips.perDay).sort(([a], [b]) => a.localeCompare(b))) {
      if (!(amt > 0)) continue;
      const ws = pool
        .map((e) => ({ key: employeeKey(e.name), w: sum(e.days.filter((d) => d.date === date && worked(d)).map((d) => d.hours)) * pts(e), any: e.days.some((d) => d.date === date && worked(d)) }))
        .filter((x) => x.any);
      if (!ws.length) { unallocated.push({ date, amount: round2(amt) }); continue; }
      add(allocateCents(amt, ws));
    }
  } else {
    const amt = tipsTotal(tips);
    if (amt > 0) {
      const ws = pool.filter((e) => e.days.some(worked)).map((e) => ({ key: employeeKey(e.name), w: e.hoursWorked * pts(e) }));
      if (!ws.length) unallocated.push({ date: "", amount: amt });
      else add(allocateCents(amt, ws));
    }
  }
  return { shares, unallocated };
}

// ─────────────────────────────────────────────────────────────────────────────
// Applying extras to the engine output
// ─────────────────────────────────────────────────────────────────────────────
export interface ExtrasInput {
  employees: EmployeeConfig[];
  manualEmployees: ManualEmployee[];
  rules?: SiteRules;
  payExtras?: DocPayExtras | null;
}

function hasExtras(x: DocPayExtras | null | undefined): boolean {
  return !!x && (x.holidays.length > 0 || x.recurring.length > 0 || x.advances.length > 0 || tipsTotal(x.tips) > 0);
}

const emptySummary = (): PayExtrasSummary => ({ lines: [], holiday: 0, tips: 0, recurringBonus: 0, recurringDeduction: 0, advance: 0 });

/**
 * Add holiday premiums, standing items, tips and advance repayments to an
 * engine result. Returns the same object when there is nothing to apply, so
 * timesheets without extras are exactly what the engine produced.
 */
export function applyPayExtras(result: AnalysisResult, input: ExtrasInput): AnalysisResult {
  const x = input.payExtras;
  if (!x || !hasExtras(x)) return result;
  const rules = { ...DEFAULT_RULES, ...(input.rules ?? {}) };
  const cfgByKey = new Map(input.employees.map((e) => [employeeKey(e.name), e]));
  const manualByKey = new Map(input.manualEmployees.map((m) => [employeeKey(normalizeName(m.name)), m]));
  const warnings: PayrollWarning[] = [...result.warnings];
  const holidays = new Map<string, Holiday>();
  for (const h of x.holidays) if (!holidays.has(h.date)) holidays.set(h.date, h);
  const tipShares = x.tips && tipsTotal(x.tips) > 0 ? splitTips(result.employees, x.tips, cfgByKey) : null;
  for (const u of tipShares?.unallocated ?? []) {
    warnings.push({ level: "warn", message: `${u.date ? `Tips for ${u.date}` : "Tips"} (${u.amount.toFixed(2)}) could not be shared: nobody worked${u.date ? " that day" : ""}` });
  }

  const employees = result.employees.map((e): EmployeeSummary => {
    if (e.excluded) return e;
    const k = employeeKey(e.name);
    const s = emptySummary();
    let days = e.days;
    const bonuses: BonusEntry[] = [];
    const deductions: DeductionEntry[] = [];

    // Holiday premiums (worked, paid days only), shown as a bonus on that day
    if (!e.isManual && holidays.size) {
      days = e.days.map((d) => {
        const h = holidays.get(d.date);
        if (!h || d.key !== d.date || d.punches <= 0 || d.cancelled || d.dayType === "absent") return d;
        const amount = h.kind === "flat" ? round2(h.flatBonus) : round2(d.pay * (h.multiplier - 1));
        if (!(amount > 0)) return d;
        const description = `Holiday premium · ${h.name || "Holiday"}${h.kind === "multiplier" ? ` (${h.multiplier}×)` : ""}`;
        s.lines.push({ kind: "holiday", description, amount, date: d.date, sourceId: h.id });
        s.holiday = round2(s.holiday + amount);
        return { ...d, bonuses: [...d.bonuses, { id: `${EXTRA_ID_PREFIX}holiday:${h.id}`, date: d.date, description, amount }] };
      });
    }

    // Standing bonuses and deductions
    for (const r of x.recurring) {
      if (employeeKey(r.employee) !== k || !(r.amount > 0)) continue;
      const amount = round2(r.amount);
      const description = r.description || (r.kind === "bonus" ? "Standing bonus" : "Standing deduction");
      if (r.kind === "bonus") {
        bonuses.push({ id: `${EXTRA_ID_PREFIX}rec:${r.sourceId}`, description, amount });
        s.lines.push({ kind: "recurring_bonus", description, amount, sourceId: r.sourceId });
        s.recurringBonus = round2(s.recurringBonus + amount);
      } else {
        deductions.push({ id: `${EXTRA_ID_PREFIX}rec:${r.sourceId}`, description, amount });
        s.lines.push({ kind: "recurring_deduction", description, amount, sourceId: r.sourceId });
        s.recurringDeduction = round2(s.recurringDeduction + amount);
      }
    }

    // Tips
    const tip = tipShares?.shares.get(k) ?? 0;
    if (tip > 0) {
      bonuses.push({ id: `${EXTRA_ID_PREFIX}tips`, description: "Tips", amount: tip });
      s.lines.push({ kind: "tips", description: "Tips", amount: tip });
      s.tips = tip;
    }

    const totalBonuses = round2(e.totalBonuses + s.holiday + s.recurringBonus + s.tips);
    let totalDeductions = round2(e.totalDeductions + s.recurringDeduction);
    let available = round2(e.totalBasePay + totalBonuses - totalDeductions);

    // Advance repayments: never more than what is left to pay this period
    for (const a of x.advances) {
      if (employeeKey(a.employee) !== k) continue;
      const amount = round2(Math.max(0, Math.min(a.scheduled, a.remaining, available)));
      if (!(amount > 0)) continue;
      const description = a.description || "Advance repayment";
      deductions.push({ id: `${EXTRA_ID_PREFIX}adv:${a.advanceId}`, description, amount });
      s.lines.push({ kind: "advance", description, amount, sourceId: a.advanceId });
      s.advance = round2(s.advance + amount);
      available = round2(available - amount);
    }
    totalDeductions = round2(totalDeductions + s.advance);

    if (!s.lines.length) return e;
    const totalPay = round2(e.totalBasePay + totalBonuses - totalDeductions);
    const cfg: { paymentMethod?: EmployeeConfig["paymentMethod"]; splitCashAmount?: number } | undefined = e.isManual
      ? input.manualEmployees.find((m) => `manual:${m.id}` === e.sourceId) ?? manualByKey.get(k)
      : cfgByKey.get(k);
    return {
      ...e,
      days,
      generalBonuses: [...e.generalBonuses, ...bonuses],
      generalDeductions: [...e.generalDeductions, ...deductions],
      totalBonuses,
      totalDeductions,
      totalPay,
      payment: paymentFor(cfg?.paymentMethod, cfg?.splitCashAmount, totalPay, rules),
      extras: s,
    };
  });

  const inc = employees.filter((e) => !e.excluded);
  const tot = (f: (s: PayExtrasSummary) => number) => round2(sum(inc.map((e) => (e.extras ? f(e.extras) : 0))));
  return {
    ...result,
    employees,
    warnings,
    totals: {
      ...totalsOf(employees),
      tips: tot((s) => s.tips),
      holidayPremium: tot((s) => s.holiday),
      advanceRepayments: tot((s) => s.advance),
      recurringBonuses: tot((s) => s.recurringBonus),
      recurringDeductions: tot((s) => s.recurringDeduction),
    },
  };
}

/** The whole calculation for a timesheet: the engine, then the extras. Used by the workspace and the server. */
export function computeTimesheet(doc: Pick<TimesheetDoc, "shifts" | "employees" | "manualEmployees" | "rules" | "payExtras">, categories: Category[]): AnalysisResult {
  const base = computePayroll({ shifts: doc.shifts, employees: doc.employees, manualEmployees: doc.manualEmployees, categories, rules: doc.rules });
  return applyPayExtras(base, { employees: doc.employees, manualEmployees: doc.manualEmployees, rules: doc.rules, payExtras: doc.payExtras });
}

// ─────────────────────────────────────────────────────────────────────────────
// Syncing a draft timesheet with the location's settings
// ─────────────────────────────────────────────────────────────────────────────
export const emptyDocExtras = (): DocPayExtras => ({ holidays: [], recurring: [], skippedRecurring: [], advances: [], tips: null });

/** Names (by key) a timesheet pays: people with shifts and manual employees. */
export function docEmployeeKeys(doc: Pick<TimesheetDoc, "shifts" | "manualEmployees" | "employees">): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of shiftEmployeeNames(doc.shifts)) out.set(employeeKey(n), n);
  for (const m of doc.manualEmployees) { const n = normalizeName(m.name); if (n && !out.has(employeeKey(n))) out.set(employeeKey(n), n); }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Bring a draft timesheet's extras up to date with the location: holidays in
 * the period, standing items (unless removed from this timesheet), advance
 * repayments due, and each person's rate history. Tips are left as entered.
 * Returns the same document when nothing changes.
 */
export function syncPayExtras(doc: TimesheetDoc, ctx: PayContext, period: { start: string; end: string }): TimesheetDoc {
  const cur = doc.payExtras ?? emptyDocExtras();
  const names = docEmployeeKeys(doc);
  const { start, end } = period;
  const holidays = start && end ? ctx.holidays.filter((h) => h.date >= start && h.date <= end).sort((a, b) => a.date.localeCompare(b.date)) : [];
  const skipped = new Set(cur.skippedRecurring);
  const recurring: DocRecurring[] = ctx.recurring
    .filter((r) => r.active && r.amount > 0 && names.has(employeeKey(r.employee)) && !skipped.has(r.id))
    .map((r) => ({ sourceId: r.id, employee: names.get(employeeKey(r.employee))!, kind: r.kind, description: r.description, amount: round2(r.amount) }));
  const advances: DocAdvance[] = ctx.advances
    .filter((a) => a.remaining > 0 && names.has(employeeKey(a.employee)) && (!end || a.date <= end))
    .map((a) => ({ advanceId: a.advanceId, employee: names.get(employeeKey(a.employee))!, description: a.note ? `Advance repayment · ${a.note}` : "Advance repayment", scheduled: round2(Math.min(a.installment, a.remaining)), remaining: round2(a.remaining) }));
  const next: DocPayExtras = { holidays, recurring, skippedRecurring: cur.skippedRecurring.filter((id) => ctx.recurring.some((r) => r.id === id)), advances, tips: cur.tips };

  let employees = doc.employees;
  let changedRates = false;
  const mapped = doc.employees.map((e) => {
    const segs = (ctx.rates[employeeKey(e.name)] ?? []).filter((s) => !start || s.until > start).sort((a, b) => a.until.localeCompare(b.until));
    if (segs.length) {
      if (same(e.rateHistory, segs)) return e;
      changedRates = true;
      return { ...e, rateHistory: segs };
    }
    if (e.rateHistory === undefined) return e;
    changedRates = true;
    const { rateHistory: _drop, ...rest } = e;
    return rest as EmployeeConfig;
  });
  if (changedRates) employees = mapped;

  const nothing = !hasExtras(next) && !next.skippedRecurring.length && !next.tips;
  const payExtras = nothing && !doc.payExtras ? undefined : next;
  if (!changedRates && same(payExtras, doc.payExtras)) return doc;
  const out: TimesheetDoc = { ...doc, employees };
  if (payExtras) out.payExtras = payExtras; else delete out.payExtras;
  return out;
}

/** Remove one standing item from this timesheet only. */
export function skipRecurring(doc: TimesheetDoc, sourceId: string): TimesheetDoc {
  const cur = doc.payExtras ?? emptyDocExtras();
  return { ...doc, payExtras: { ...cur, recurring: cur.recurring.filter((r) => r.sourceId !== sourceId), skippedRecurring: [...new Set([...cur.skippedRecurring, sourceId])] } };
}
/** Put a removed standing item back (it returns on the next sync). */
export function unskipRecurring(doc: TimesheetDoc, sourceId: string): TimesheetDoc {
  const cur = doc.payExtras ?? emptyDocExtras();
  return { ...doc, payExtras: { ...cur, skippedRecurring: cur.skippedRecurring.filter((id) => id !== sourceId) } };
}
export function setTips(doc: TimesheetDoc, tips: Tips | null): TimesheetDoc {
  const cur = doc.payExtras ?? emptyDocExtras();
  return { ...doc, payExtras: { ...cur, tips } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate history
// ─────────────────────────────────────────────────────────────────────────────
type RateFields = Pick<EmployeeConfig, "categoryId" | "payBasis" | "fullDayRate" | "halfDayRate" | "hourlyRate">;
export interface RateHistoryEntry { name: string; /** When the current saved rate started ("" = always). */ currentFrom: string; history: RateSegment[] }

/** Resolved, explicit rates (a category's current rates are copied, so the old amount is kept exactly). */
export function explicitRates(e: RateFields, categories: Category[]): Omit<RateSegment, "until"> {
  const cat = e.categoryId && e.categoryId !== "custom" ? categories.find((c) => c.id === e.categoryId) : undefined;
  const r = cat ?? e;
  return { categoryId: "custom", payBasis: r.payBasis, fullDayRate: round2(r.fullDayRate), halfDayRate: round2(r.halfDayRate), hourlyRate: round2(r.hourlyRate) };
}

const sameRates = (a: Omit<RateSegment, "until">, b: Omit<RateSegment, "until">) =>
  a.payBasis === b.payBasis && a.fullDayRate === b.fullDayRate && a.halfDayRate === b.halfDayRate && a.hourlyRate === b.hourlyRate;

/**
 * Saving new default rates effective from `from`: the old saved rate becomes a
 * history segment ending at `from`. Saving the same rate changes nothing.
 * Saving with a date before the last change trims history after that date.
 */
export function recordRateChange(entry: RateHistoryEntry | undefined, name: string, oldRates: Omit<RateSegment, "until"> | null, newRates: Omit<RateSegment, "until">, from: string): RateHistoryEntry {
  const e: RateHistoryEntry = entry ? { ...entry, history: [...entry.history] } : { name, currentFrom: "", history: [] };
  e.name = name;
  if (!oldRates || sameRates(oldRates, newRates) || !from) return e;
  // Anything recorded after `from` is replaced by the new rate; the segment that
  // spans `from` (or the old current rate) now ends at `from`.
  const sorted = [...e.history].sort((a, b) => a.until.localeCompare(b.until));
  const spanning = sorted.find((h) => h.until > from);
  e.history = sorted.filter((h) => h.until <= from);
  const { until: _u, ...spanRates } = spanning ?? { until: "", ...oldRates };
  if (!e.history.some((h) => h.until === from)) e.history.push({ until: from, ...spanRates });
  // Drop trailing segments that equal the new rate (they are just the current rate).
  while (e.history.length && sameRates(e.history[e.history.length - 1], newRates)) e.history.pop();
  e.currentFrom = e.history.length ? from : "";
  return e;
}

// ─────────────────────────────────────────────────────────────────────────────
// Advances ledger
// ─────────────────────────────────────────────────────────────────────────────
export function installmentOf(a: Pick<Advance, "amount" | "mode" | "perPeriod" | "periods">): number {
  if (a.mode === "periods") return Math.ceil(cents(a.amount) / Math.max(1, a.periods)) / 100;
  return round2(Math.max(0, a.perPeriod) || a.amount);
}

export function advanceBalance(a: Advance, excludeTimesheetId?: string): { repaid: number; remaining: number } {
  const repaid = round2(sum(a.repayments.filter((r) => r.timesheetId !== excludeTimesheetId).map((r) => r.amount)));
  return { repaid, remaining: a.cancelledAt ? 0 : round2(Math.max(0, a.amount - repaid)) };
}

/** What is still due, as seen by one timesheet (its own committed repayment does not count against it). */
export function advanceSchedules(advances: Advance[], timesheetId?: string): AdvanceSchedule[] {
  return advances
    .map((a) => ({ a, bal: advanceBalance(a, timesheetId) }))
    .filter(({ bal }) => bal.remaining > 0)
    .map(({ a, bal }) => ({ advanceId: a.id, employee: a.employee, date: a.date, installment: installmentOf(a), remaining: bal.remaining, note: a.note }));
}

/** Record this timesheet's repayments (replacing any it had), never more than what is owed. */
export function commitRepayments(advances: Advance[], timesheetId: string, periodEnd: string, lines: { advanceId: string; amount: number }[], at: string): Advance[] {
  return advances.map((a) => {
    const kept = a.repayments.filter((r) => r.timesheetId !== timesheetId);
    const owed = a.cancelledAt ? 0 : round2(Math.max(0, a.amount - sum(kept.map((r) => r.amount))));
    const amount = round2(Math.min(owed, sum(lines.filter((l) => l.advanceId === a.id).map((l) => l.amount))));
    const repayments: Repayment[] = amount > 0 ? [...kept, { timesheetId, amount, periodEnd, at }] : kept;
    return repayments.length === a.repayments.length && kept.length === a.repayments.length ? a : { ...a, repayments };
  });
}

export function reverseRepayments(advances: Advance[], timesheetId: string): Advance[] {
  return advances.map((a) => (a.repayments.some((r) => r.timesheetId === timesheetId) ? { ...a, repayments: a.repayments.filter((r) => r.timesheetId !== timesheetId) } : a));
}

/** Repayment lines in a computed result (what finalizing commits). */
export function repaymentLines(result: AnalysisResult): { advanceId: string; amount: number }[] {
  return result.employees.filter((e) => !e.excluded).flatMap((e) => (e.extras?.lines ?? []).filter((l) => l.kind === "advance" && l.sourceId).map((l) => ({ advanceId: l.sourceId!, amount: l.amount })));
}

// ─────────────────────────────────────────────────────────────────────────────
// Cash denominations
// ─────────────────────────────────────────────────────────────────────────────
export interface DenomCount { value: number; count: number }

/** Bills and coins for one amount: greedy (exact for USD-like sets), with an exact fallback for odd sets. */
export function breakdownCash(amount: number, denominations: number[]): { counts: DenomCount[]; leftover: number } {
  const ds = [...new Set(denominations.map(cents).filter((d) => d > 0))].sort((a, b) => b - a);
  let left = Math.max(0, cents(amount));
  const counts = new Map<number, number>();
  for (const d of ds) { const n = Math.floor(left / d); if (n) { counts.set(d, n); left -= n * d; } }
  if (left > 0 && cents(amount) <= 2_000_000) {
    const exact = exactChange(cents(amount), ds);
    if (exact) return { counts: ds.map((d) => ({ value: d / 100, count: exact.get(d) ?? 0 })).filter((c) => c.count > 0), leftover: 0 };
  }
  return { counts: ds.map((d) => ({ value: d / 100, count: counts.get(d) ?? 0 })).filter((c) => c.count > 0), leftover: left / 100 };
}

/** Fewest pieces that make exactly `target` cents, or null. */
function exactChange(target: number, ds: number[]): Map<number, number> | null {
  const INF = 1e9;
  const best = new Int32Array(target + 1).fill(INF);
  const pick = new Int32Array(target + 1).fill(-1);
  best[0] = 0;
  for (let v = 1; v <= target; v++) {
    for (let i = 0; i < ds.length; i++) {
      const d = ds[i];
      if (d <= v && best[v - d] + 1 < best[v]) { best[v] = best[v - d] + 1; pick[v] = i; }
    }
  }
  if (best[target] >= INF) return null;
  const out = new Map<number, number>();
  for (let v = target; v > 0; v -= ds[pick[v]]) out.set(ds[pick[v]], (out.get(ds[pick[v]]) ?? 0) + 1);
  return out;
}

export interface CashPlan {
  rows: { name: string; owed: number; amount: number; counts: DenomCount[]; leftover: number }[];
  totals: DenomCount[];
  total: number;
  owed: number;
  /** amount − owed (positive: rounding pays a little more). */
  rounding: number;
  leftover: number;
}

/** What to pull from the bank: per person and in total. */
export function cashPlan(people: { name: string; cash: number }[], cfg: Pick<CashConfig, "denominations" | "roundCash">): CashPlan {
  const tally = new Map<number, number>();
  const rows = people.filter((p) => p.cash > 0).map((p) => {
    const owed = round2(p.cash);
    const amount = cfg.roundCash ? Math.round(owed) : owed;
    const b = breakdownCash(amount, cfg.denominations);
    for (const c of b.counts) tally.set(c.value, (tally.get(c.value) ?? 0) + c.count);
    return { name: p.name, owed, amount: round2(amount), counts: b.counts, leftover: b.leftover };
  });
  const total = round2(sum(rows.map((r) => r.amount)));
  const owed = round2(sum(rows.map((r) => r.owed)));
  return {
    rows,
    totals: [...tally.entries()].sort((a, b) => b[0] - a[0]).map(([value, count]) => ({ value, count })),
    total, owed, rounding: round2(total - owed), leftover: round2(sum(rows.map((r) => r.leftover))),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Year to date
// ─────────────────────────────────────────────────────────────────────────────
export interface YtdRow { key: string; name: string; gross: number; deductions: number; net: number; tips: number; timesheets: number }

/**
 * Totals per person across results. Gross = earnings before deductions
 * (base pay, bonuses, premiums, tips); net = what was paid after deductions.
 */
export function ytdTotals(results: AnalysisResult[]): YtdRow[] {
  const map = new Map<string, YtdRow>();
  for (const r of results) {
    for (const e of r.employees) {
      if (e.excluded) continue;
      const key = employeeKey(e.name);
      const row = map.get(key) ?? { key, name: e.name, gross: 0, deductions: 0, net: 0, tips: 0, timesheets: 0 };
      row.gross = round2(row.gross + e.totalBasePay + e.totalBonuses);
      row.deductions = round2(row.deductions + e.totalDeductions);
      row.net = round2(row.net + e.totalPay);
      row.tips = round2(row.tips + (e.extras?.tips ?? 0));
      row.timesheets++;
      map.set(key, row);
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** YTD for statements: earlier finalized totals (rows) plus this run, by employee key. */
export function ytdStatementMap(rows: YtdRow[], current: AnalysisResult): Record<string, { gross: number; net: number }> {
  const out: Record<string, { gross: number; net: number }> = {};
  for (const r of rows) out[r.key] = { gross: r.gross, net: r.net };
  for (const c of ytdTotals([current])) {
    const o = out[c.key] ?? { gross: 0, net: 0 };
    out[c.key] = { gross: round2(o.gross + c.gross), net: round2(o.net + c.net) };
  }
  return out;
}

const csvCell = (v: unknown) => { const s = String(v ?? ""); return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCsv = (rows: (string | number)[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n");

export function ytdCsv(rows: YtdRow[], year: number | string): string {
  return toCsv([
    ["Employee", "Year", "Timesheets", "Gross (earnings)", "Deductions", "Net (paid)", "Tips"],
    ...rows.map((r) => [r.name, String(year), r.timesheets, r.gross.toFixed(2), r.deductions.toFixed(2), r.net.toFixed(2), r.tips.toFixed(2)]),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Period over period
// ─────────────────────────────────────────────────────────────────────────────
export interface PeriodSnapshot { totalPay: number; employees: { name: string; totalPay: number }[] }
export interface Variance {
  current: number; previous: number; diff: number;
  /** Percent change, or null when the previous total was zero. */
  pct: number | null;
  drivers: { name: string; current: number; previous: number; diff: number }[];
}

export function snapshotOf(r: AnalysisResult): PeriodSnapshot {
  return { totalPay: r.totals.totalPay, employees: r.employees.filter((e) => !e.excluded).map((e) => ({ name: e.name, totalPay: e.totalPay })) };
}

/** Compare with the previous period; drivers are the people whose pay changed most. */
export function comparePeriods(cur: PeriodSnapshot, prev: PeriodSnapshot, maxDrivers = 5): Variance {
  const diff = round2(cur.totalPay - prev.totalPay);
  const pct = prev.totalPay > 0 ? Math.round((diff / prev.totalPay) * 1000) / 10 : null;
  const map = new Map<string, { name: string; current: number; previous: number }>();
  for (const e of prev.employees) { const k = employeeKey(e.name); const m = map.get(k) ?? { name: e.name, current: 0, previous: 0 }; m.previous = round2(m.previous + e.totalPay); map.set(k, m); }
  for (const e of cur.employees) { const k = employeeKey(e.name); const m = map.get(k) ?? { name: e.name, current: 0, previous: 0 }; m.name = e.name; m.current = round2(m.current + e.totalPay); map.set(k, m); }
  const drivers = [...map.values()]
    .map((m) => ({ ...m, diff: round2(m.current - m.previous) }))
    .filter((m) => Math.abs(m.diff) >= 0.01 && Math.sign(m.diff) === Math.sign(diff || m.diff))
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.name.localeCompare(b.name))
    .slice(0, maxDrivers);
  return { current: round2(cur.totalPay), previous: round2(prev.totalPay), diff, pct, drivers };
}

// ─────────────────────────────────────────────────────────────────────────────
// Accounting journal (QuickBooks / Xero import)
// ─────────────────────────────────────────────────────────────────────────────
export interface JournalLine { account: string; debit: number; credit: number; memo: string }

/**
 * One balanced journal entry for a pay run. Debits: wages (earnings) and tips
 * paid out of the tips liability. Credits: deductions, advance repayments, and
 * cash / bank / check paid. Any gap (someone owing money back) goes to clearing.
 */
export function journalLines(result: AnalysisResult, accountsIn: Partial<Accounts>, memo: string): JournalLine[] {
  const a = accountsSchema.parse(accountsIn ?? {});
  const inc = result.employees.filter((e) => !e.excluded);
  const tips = round2(sum(inc.map((e) => e.extras?.tips ?? 0)));
  const advances = round2(sum(inc.map((e) => e.extras?.advance ?? 0)));
  const earnings = round2(sum(inc.map((e) => e.totalBasePay + e.totalBonuses)) - tips);
  const deductions = round2(sum(inc.map((e) => e.totalDeductions)) - advances);
  const cash = round2(sum(inc.map((e) => e.payment.cash)));
  const bank = round2(sum(inc.map((e) => e.payment.bank)));
  const check = round2(sum(inc.map((e) => e.payment.check)));
  const m = (s: string) => (memo ? `${memo} · ${s}` : s);
  const lines: JournalLine[] = [];
  const dr = (account: string, v: number, what: string) => { if (v > 0) lines.push({ account, debit: round2(v), credit: 0, memo: m(what) }); else if (v < 0) lines.push({ account, debit: 0, credit: round2(-v), memo: m(what) }); };
  const cr = (account: string, v: number, what: string) => dr(account, -v, what);
  dr(a.wages, earnings, "Wages and bonuses");
  dr(a.tips, tips, "Tips paid out");
  cr(a.deductions, deductions, "Deductions");
  cr(a.advances, advances, "Advance repayments");
  cr(a.cash, cash, "Paid in cash");
  cr(a.bank, bank, "Paid by bank transfer");
  cr(a.check, check, "Paid by check");
  const gap = round2(sum(lines.map((l) => l.debit - l.credit)));
  if (Math.abs(gap) >= 0.01) cr(a.clearing, gap, "Balance owed / rounding");
  return lines;
}

export function formatJournalDate(iso: string, style: Accounts["dateStyle"]): string {
  const [y, mo, d] = (iso || "").split("-");
  if (!y || !mo || !d) return iso;
  if (style === "YYYY-MM-DD") return iso;
  return style === "DD/MM/YYYY" ? `${d}/${mo}/${y}` : `${mo}/${d}/${y}`;
}

/** CSV: Journal No, Date, Account, Debit, Credit, Memo. */
export function journalCsv(result: AnalysisResult, accountsIn: Partial<Accounts>, opts: { date: string; memo: string; journalNo?: string }): string {
  const a = accountsSchema.parse(accountsIn ?? {});
  const no = opts.journalNo || `${a.journalPrefix}${(opts.date || "").replace(/-/g, "")}`;
  const date = formatJournalDate(opts.date, a.dateStyle);
  const lines = journalLines(result, a, opts.memo);
  return toCsv([
    ["Journal No", "Date", "Account", "Debit", "Credit", "Memo"],
    ...lines.map((l) => [no, date, l.account, l.debit ? l.debit.toFixed(2) : "", l.credit ? l.credit.toFixed(2) : "", l.memo]),
  ]);
}

/** Small helper for the UI: the extra lines of one person by kind. */
export function linesOf(e: EmployeeSummary, kind?: ExtraLine["kind"]): ExtraLine[] {
  return (e.extras?.lines ?? []).filter((l) => !kind || l.kind === kind);
}
