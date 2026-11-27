// Data shapes for the pay extras (rate history, holidays, standing items,
// advances, tips, cash and accounting settings). Pure zod, no imports from the
// engine, so shared/schema.ts can use these without an import cycle.
import { z } from "zod";
import { isISODate } from "./dates";

const iso = z.string().refine(isISODate, "Use a real date (YYYY-MM-DD).");
const money = z.coerce.number().finite().min(0).max(10_000_000).catch(0);
const id = z.string().min(1).max(64);

// ── Rate history ─────────────────────────────────────────────────────────────
/** A rate that applied to every day before `until` (exclusive), back to the previous segment. */
export const rateSegmentSchema = z.object({
  until: iso,
  categoryId: z.string().max(64).default("custom"),
  payBasis: z.enum(["day_rate", "hourly"]).catch("day_rate").default("day_rate"),
  fullDayRate: money.default(0),
  halfDayRate: money.default(0),
  hourlyRate: money.default(0),
});
export type RateSegment = z.infer<typeof rateSegmentSchema>;

// ── Holidays ─────────────────────────────────────────────────────────────────
export const holidaySchema = z.object({
  id,
  date: iso,
  name: z.string().max(80).default("Holiday"),
  /** "multiplier": the day's pay × multiplier. "flat": a fixed amount on top. */
  kind: z.enum(["multiplier", "flat"]).catch("multiplier").default("multiplier"),
  multiplier: z.coerce.number().min(1).max(5).catch(1.5).default(1.5),
  flatBonus: money.default(0),
});
export type Holiday = z.infer<typeof holidaySchema>;

// ── Standing (recurring) bonuses and deductions ─────────────────────────────
export const RECURRING_KINDS = ["bonus", "deduction"] as const;
export type RecurringKind = (typeof RECURRING_KINDS)[number];
export const recurringItemSchema = z.object({
  id,
  employee: z.string().trim().min(1).max(120),
  kind: z.enum(RECURRING_KINDS),
  description: z.string().max(120).default(""),
  amount: money.default(0),
  active: z.boolean().default(true),
});
export type RecurringItem = z.infer<typeof recurringItemSchema>;

// ── Advances and loans ──────────────────────────────────────────────────────
export const repaymentSchema = z.object({
  timesheetId: z.string().min(1).max(64),
  amount: money,
  periodEnd: z.string().max(10).default(""),
  at: z.string().default(""),
});
export type Repayment = z.infer<typeof repaymentSchema>;
export const advanceSchema = z.object({
  id,
  employee: z.string().trim().min(1).max(120),
  amount: z.coerce.number().finite().positive().max(10_000_000),
  date: iso,
  /** Repay a fixed amount each period, or split evenly over a number of periods. */
  mode: z.enum(["per_period", "periods"]).catch("per_period").default("per_period"),
  perPeriod: money.default(0),
  periods: z.coerce.number().int().min(1).max(104).catch(1).default(1),
  note: z.string().max(200).default(""),
  createdAt: z.string().default(""),
  createdBy: z.string().max(200).default(""),
  /** Written off: no more repayments are taken. */
  cancelledAt: z.string().nullable().default(null),
  repayments: z.array(repaymentSchema).max(500).default([]),
});
export type Advance = z.infer<typeof advanceSchema>;
export const advanceInputSchema = advanceSchema.pick({ employee: true, amount: true, date: true, mode: true, perPeriod: true, periods: true, note: true });

// ── Tips ─────────────────────────────────────────────────────────────────────
export const tipsSchema = z.object({
  /** One amount for the whole period, or an amount per day. */
  mode: z.enum(["total", "per_day"]).catch("total").default("total"),
  total: money.default(0),
  perDay: z.record(z.string(), money).default({}),
  /** Share by hours worked, or by hours × points of the person's pay category. */
  split: z.enum(["hours", "points"]).catch("hours").default("hours"),
  /** Points per category id ("custom" = no category). Missing = 1. */
  points: z.record(z.string(), z.coerce.number().min(0).max(100).catch(1)).default({}),
});
export type Tips = z.infer<typeof tipsSchema>;

// ── What a timesheet keeps (a snapshot, so finalized periods never change) ──
export const docRecurringSchema = z.object({
  sourceId: z.string().min(1).max(64),
  employee: z.string().max(120),
  kind: z.enum(RECURRING_KINDS),
  description: z.string().max(120).default(""),
  amount: money.default(0),
});
export type DocRecurring = z.infer<typeof docRecurringSchema>;
export const docAdvanceSchema = z.object({
  advanceId: z.string().min(1).max(64),
  employee: z.string().max(120),
  description: z.string().max(200).default("Advance repayment"),
  /** Planned repayment this period (the engine never takes more than the person's pay). */
  scheduled: money.default(0),
  /** Balance still owed before this timesheet. */
  remaining: money.default(0),
});
export type DocAdvance = z.infer<typeof docAdvanceSchema>;
export const docPayExtrasSchema = z.object({
  holidays: z.array(holidaySchema).max(400).default([]),
  recurring: z.array(docRecurringSchema).max(2000).default([]),
  /** Standing items removed from this timesheet (not re-added on the next sync). */
  skippedRecurring: z.array(z.string().max(64)).max(2000).default([]),
  advances: z.array(docAdvanceSchema).max(2000).default([]),
  tips: tipsSchema.nullable().default(null),
});
export type DocPayExtras = z.infer<typeof docPayExtrasSchema>;

// ── Location settings ───────────────────────────────────────────────────────
export const DEFAULT_DENOMINATIONS = [100, 50, 20, 10, 5, 1, 0.25, 0.1, 0.05, 0.01];
export const cashConfigSchema = z.object({
  denominations: z.array(z.coerce.number().finite().positive().max(1_000_000)).min(1).max(24).catch(DEFAULT_DENOMINATIONS).default(DEFAULT_DENOMINATIONS),
  /** Round each person's cash to the nearest whole unit on the pay-out sheet. */
  roundCash: z.boolean().catch(false).default(false),
});
export type CashConfig = z.infer<typeof cashConfigSchema>;

export const JOURNAL_DATE_STYLES = ["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD"] as const;
const acct = (d: string) => z.string().trim().max(120).catch(d).default(d);
export const accountsSchema = z.object({
  wages: acct("Wages expense"),
  tips: acct("Tips payable"),
  deductions: acct("Payroll deductions"),
  advances: acct("Employee advances"),
  cash: acct("Cash on hand"),
  bank: acct("Checking account"),
  check: acct("Checks payable"),
  clearing: acct("Payroll clearing"),
  journalPrefix: z.string().trim().max(20).catch("PR").default("PR"),
  dateStyle: z.enum(JOURNAL_DATE_STYLES).catch("MM/DD/YYYY").default("MM/DD/YYYY"),
});
export type Accounts = z.infer<typeof accountsSchema>;

export const paySettingsSchema = z.object({
  cash: cashConfigSchema.catch(cashConfigSchema.parse({})).prefault({}),
  holidays: z.array(holidaySchema).max(400).catch([]).default([]),
  recurring: z.array(recurringItemSchema).max(2000).catch([]).default([]),
  accounts: accountsSchema.catch(accountsSchema.parse({})).prefault({}),
  tipPoints: z.record(z.string(), z.coerce.number().min(0).max(100).catch(1)).catch({}).default({}),
});
export type PaySettings = z.infer<typeof paySettingsSchema>;
export const DEFAULT_PAY_SETTINGS: PaySettings = paySettingsSchema.parse({});

/** Everything a draft timesheet needs from the location to sync its extras. */
export interface AdvanceSchedule { advanceId: string; employee: string; date: string; installment: number; remaining: number; note: string }
export interface PayContext {
  holidays: Holiday[];
  recurring: RecurringItem[];
  advances: AdvanceSchedule[];
  /** Rate history by employee key. */
  rates: Record<string, RateSegment[]>;
  tipPoints: Record<string, number>;
}
