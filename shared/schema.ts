import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Core value types
// ─────────────────────────────────────────────────────────────────────────────
export const DAY_TYPES = ["full_day", "half_day", "flagged", "absent"] as const;
export type DayType = (typeof DAY_TYPES)[number];
export const DAY_LABELS: Record<DayType, string> = {
  full_day: "Full day",
  half_day: "Half day",
  flagged: "Flagged",
  absent: "Absent",
};

const money = z.coerce.number().finite().catch(0);
const nonNegMoney = z.coerce.number().finite().min(0).catch(0);

// ─────────────────────────────────────────────────────────────────────────────
// Site (location) rules
// ─────────────────────────────────────────────────────────────────────────────
export const weekdayCutoffSchema = z.object({
  clockInCutoff: z.number().int().min(0).max(1439),
  clockOutCutoff: z.number().int().min(0).max(1439),
});

export const siteRulesSchema = z.object({
  classificationMethod: z.enum(["cutoffs", "hours"]).default("cutoffs"),
  clockInCutoff: z.number().int().min(0).max(1439).default(660),
  clockOutCutoff: z.number().int().min(0).max(1439).default(1230),
  graceMinutes: z.number().int().min(0).max(180).default(0),
  weekdayOverrides: z.record(z.string(), weekdayCutoffSchema).default({}),
  fullDayMinHours: z.number().min(0).max(24).default(8),
  halfDayMinHours: z.number().min(0).max(24).default(4),
  flaggedDayPay: z.enum(["none", "half", "full"]).default("none"),
  mergeSameDayShifts: z.boolean().default(true),
  minShiftMinutes: z.number().int().min(0).max(720).default(0),
  roundingMinutes: z.number().int().min(0).max(60).default(0),
  deductUnpaidBreaks: z.boolean().default(true),
  overtimeEnabled: z.boolean().default(false),
  overtimeWeeklyHours: z.number().min(0).max(168).default(40),
  overtimeDailyHours: z.number().min(0).max(24).default(0),
  overtimeMultiplier: z.number().min(1).max(4).default(1.5),
  weekStartsOn: z.number().int().min(0).max(6).default(1),
  timezone: z.string().default("America/New_York"),
  defaultNetPay: z.boolean().default(true),
  payPeriod: z.enum(["weekly", "biweekly", "semimonthly", "monthly"]).default("biweekly"),
  payPeriodAnchor: z.string().default(""),
  longShiftWarningHours: z.number().min(0).max(48).default(14),
});
export type SiteRules = z.infer<typeof siteRulesSchema>;
export const DEFAULT_RULES: SiteRules = siteRulesSchema.parse({});

export const TIME_SOURCES = ["square", "kiosk", "both"] as const;
export type TimeSource = (typeof TIME_SOURCES)[number];
export const KIOSK_LOGIN_MODES = ["pin", "name_pin"] as const;
export type KioskLoginMode = (typeof KIOSK_LOGIN_MODES)[number];

export const siteSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  color: z.string().default("#0f766e"),
  address: z.string().default(""),
  notes: z.string().default(""),
  archived: z.boolean().default(false),
  rules: siteRulesSchema.default({}),
  squareLocationId: z.string().default(""),
  squareLocationName: z.string().default(""),
  // Where this location's hours come from: Square timecards, the time-clock kiosk, or both.
  timeSource: z.enum(TIME_SOURCES).default("square"),
  // Kiosk sign-in: PIN only, or tap your name and then enter the PIN.
  kioskLoginMode: z.enum(KIOSK_LOGIN_MODES).default("pin"),
  createdAt: z.string().default(() => new Date().toISOString()),
});
export type Site = z.infer<typeof siteSchema>;
export const siteInputSchema = siteSchema.partial({ id: true, createdAt: true });

// ─────────────────────────────────────────────────────────────────────────────
// Pay categories
// ─────────────────────────────────────────────────────────────────────────────
export const PAY_BASES = ["day_rate", "hourly"] as const;
export type PayBasis = (typeof PAY_BASES)[number];

export const categorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(60),
  siteId: z.string().nullable().default(null), // null = available at every location
  payBasis: z.enum(PAY_BASES).default("day_rate"),
  fullDayRate: nonNegMoney.default(0),
  halfDayRate: nonNegMoney.default(0),
  hourlyRate: nonNegMoney.default(0),
  isNetPay: z.boolean().default(true),
});
export type Category = z.infer<typeof categorySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// App preferences
// ─────────────────────────────────────────────────────────────────────────────
/** 300 KB of image bytes ≈ 400K base64 characters (+ data-URL prefix). */
export const PDF_LOGO_MAX_BYTES = 300 * 1024;
export const PDF_LOGO_MAX_CHARS = Math.ceil(PDF_LOGO_MAX_BYTES / 3) * 4 + 32;
export const DATE_FORMATS =["M/D/YY", "MM/DD/YYYY", "D/M/YY", "YYYY-MM-DD", "MMM D, YYYY"] as const;
export const prefsSchema = z.object({
  appName: z.string().min(1).max(60).default("Payroll Admin"),
  businessName: z.string().max(80).default(""),
  dateFormat: z.enum(DATE_FORMATS).default("M/D/YY"),
  timeFormat: z.enum(["12h", "24h"]).default("12h"),
  currencySymbol: z.string().max(4).default("$"),
  theme: z.enum(["light", "dark", "system"]).default("system"),
  sessionDays: z.number().int().min(1).max(365).default(30),
  retentionPerSite: z.number().int().min(0).max(5000).default(0), // 0 = keep everything
  autosave: z.boolean().default(true),
  autoApplySavedRates: z.boolean().default(true),
  pdfShowShiftTimes: z.boolean().default(true),
  pdfPagePerEmployee: z.boolean().default(false),
  pdfFooter: z.string().max(120).default("Confidential — for internal use only"),
  pdfOrientation: z.enum(["portrait", "landscape"]).default("landscape").catch("landscape"),
  pdfPageSize: z.enum(["letter", "a4"]).default("letter").catch("letter"),
  /** PNG/JPEG data URL (≤ ~300 KB image) drawn top-left on PDFs; "" = none. Invalid values are dropped, never fatal. */
  pdfLogoDataUrl: z.string().max(PDF_LOGO_MAX_CHARS).regex(/^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=\s]+$/).or(z.literal("")).default("").catch(""),
  pdfSignatureLine: z.boolean().default(false).catch(false),
  defaultSiteId: z.string().default(""),
});
export type Prefs = z.infer<typeof prefsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Timesheet document
// ─────────────────────────────────────────────────────────────────────────────
export const SHIFT_SOURCES = ["square", "csv", "toast", "manual", "legacy", "kiosk"] as const;
export type ShiftSource = (typeof SHIFT_SOURCES)[number];

export const shiftSchema = z.object({
  id: z.string().min(1),
  employee: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.number().int().min(0).max(2880),
  end: z.number().int().min(0).max(4320),
  breakMinutes: z.number().int().min(0).max(1440).default(0),
  role: z.string().default(""),
  source: z.enum(SHIFT_SOURCES).default("manual"),
  note: z.string().default(""),
});
export type Shift = z.infer<typeof shiftSchema>;

export const dayAdjustmentSchema = z.object({
  overrideStatus: z.enum(DAY_TYPES).nullable().optional(),
  dockAmount: nonNegMoney.optional(),
  cancelled: z.boolean().optional(),
  note: z.string().optional(),
});
export type DayAdjustment = z.infer<typeof dayAdjustmentSchema>;

export const bonusSchema = z.object({
  id: z.string().optional(),
  date: z.string().optional(), // ISO; empty = general bonus
  description: z.string().default(""),
  amount: nonNegMoney.default(0),
});
export type BonusEntry = z.infer<typeof bonusSchema>;

export const deductionSchema = z.object({
  id: z.string().optional(),
  description: z.string().default(""),
  amount: nonNegMoney.default(0),
});
export type DeductionEntry = z.infer<typeof deductionSchema>;

export const employeeConfigSchema = z.object({
  name: z.string(),
  categoryId: z.string().default("custom"),
  payBasis: z.enum(PAY_BASES).default("day_rate"),
  fullDayRate: nonNegMoney.default(0),
  halfDayRate: nonNegMoney.default(0),
  hourlyRate: nonNegMoney.default(0),
  isNetPay: z.boolean().default(true),
  adjustments: z.record(z.string(), dayAdjustmentSchema).default({}),
  bonuses: z.array(bonusSchema).default([]),
  deductions: z.array(deductionSchema).default([]),
  excluded: z.boolean().default(false),
  note: z.string().default(""),
});
export type EmployeeConfig = z.infer<typeof employeeConfigSchema>;

export const manualPayDateSchema = z.object({
  date: z.string().default(""),
  amount: nonNegMoney.default(0),
  note: z.string().default(""),
});
export const manualEmployeeSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  payMode: z.enum(["lump_sum", "by_date"]).default("lump_sum"),
  lumpSum: nonNegMoney.default(0),
  payDates: z.array(manualPayDateSchema).default([]),
  isNetPay: z.boolean().default(true),
  bonuses: z.array(bonusSchema).default([]),
  deductions: z.array(deductionSchema).default([]),
  excluded: z.boolean().default(false),
  categoryId: z.string().default("custom"),
});
export type ManualEmployee = z.infer<typeof manualEmployeeSchema>;

export const TIMESHEET_STATUSES = ["draft", "final"] as const;
export const timesheetDocSchema = z.object({
  siteId: z.string(),
  label: z.string().default(""),
  filename: z.string().default(""),
  source: z.string().default("manual"),
  status: z.enum(TIMESHEET_STATUSES).default("draft"),
  notes: z.string().default(""),
  periodStart: z.string().default(""),
  periodEnd: z.string().default(""),
  rules: siteRulesSchema,
  shifts: z.array(shiftSchema),
  employees: z.array(employeeConfigSchema),
  manualEmployees: z.array(manualEmployeeSchema),
});
export type TimesheetDoc = z.infer<typeof timesheetDocSchema>;

export interface TimesheetSummary {
  id: string;
  siteId: string | null;
  filename: string;
  customLabel: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  employeeCount: number;
  totalPay: number;
  status: string;
  createdAt: string;
  updatedAt: string | null;
  /** Set when the timesheet is in the Trash (ISO timestamp). */
  deletedAt?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine output
// ─────────────────────────────────────────────────────────────────────────────
export interface DayResult {
  key: string;
  date: string;
  clockIn: string;
  clockOut: string;
  start: number | null;
  end: number | null;
  hours: number;
  overtimeHours: number;
  punches: number;
  dayType: DayType;
  originalDayType: DayType;
  notes: string;
  basePay: number;
  dockAmount: number;
  pay: number;
  cancelled: boolean;
  adjustmentNote?: string;
  bonuses: BonusEntry[];
  shiftIds: string[];
  hasManualShift: boolean;
}

export interface EmployeeSummary {
  sourceId: string;
  name: string;
  payBasis: PayBasis;
  categoryName: string | null;
  fullDays: number;
  halfDays: number;
  flaggedDays: number;
  absentDays: number;
  cancelledDays: number;
  hoursWorked: number;
  overtimeHours: number;
  totalBasePay: number;
  totalDocked: number;
  totalBonuses: number;
  totalDeductions: number;
  totalPay: number;
  fullDayRate: number;
  halfDayRate: number;
  hourlyRate: number;
  isNetPay: boolean;
  days: DayResult[];
  generalBonuses: BonusEntry[];
  generalDeductions: DeductionEntry[];
  isManual: boolean;
  excluded: boolean;
}

export interface PayrollWarning {
  level: "info" | "warn";
  employee?: string;
  date?: string;
  message: string;
}

export interface AnalysisResult {
  periodStart: string;
  periodEnd: string;
  employees: EmployeeSummary[];
  warnings: PayrollWarning[];
  totals: {
    employees: number;
    totalPay: number;
    netPay: number;
    grossPay: number;
    bonuses: number;
    deductions: number;
    docked: number;
    fullDays: number;
    halfDays: number;
    flaggedDays: number;
    hours: number;
    overtimeHours: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Database configuration (server-side)
// ─────────────────────────────────────────────────────────────────────────────
export const databaseConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sqlite"), path: z.string().optional() }),
  z.object({ kind: z.literal("supabase"), url: z.string().url(), key: z.string().min(20) }),
  z.object({ kind: z.literal("managed") }),
]);
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;

export interface DatabaseHealth {
  ok: boolean;
  kind: string;
  label: string;
  latencyMs: number | null;
  error: string | null;
  missingTables: string[];
  missingColumns: string[];
  timesheetCount: number | null;
}
