// Employee self-service portal (/me): pure rules shared by the server, the
// portal page and the tests. Nothing here touches storage.
//
// The portal is for kiosk employees (no user account). Everything an employee
// can see is filtered to that one person on the server, using the helpers
// below, so the same matching rules apply to hours, pay, schedule and time off.
import { z } from "zod";
import type { AnalysisResult, EmployeeSummary } from "./schema";
import { addDays, daysBetween, isISODate } from "./dates";
import { employeeKey } from "./engine";
import type { ClockStatus } from "./punches";
import type { WorkDay } from "./punchIssues";
import type { ScheduledShift, TimeOff } from "./schedule";

// ── Settings ─────────────────────────────────────────────────────────────────
/** Per location, in app settings under `portal:<siteId>`. Off by default. */
export const portalSettingsSchema = z.object({
  enabled: z.boolean().catch(false).default(false),
});
export type PortalSettings = z.infer<typeof portalSettingsSchema>;
export const portalKey = (siteId: string) => `portal:${siteId}`;
/** employeeId → time (ms) before which that employee's portal sessions no longer count (sign out). */
export const portalRevokedKey = (siteId: string) => `portal_revoked:${siteId}`;

export const PORTAL_SESSION_HOURS = 12;
export const PORTAL_COOKIE = "payroll_portal";
export const PORTAL_COOKIE_PATH = "/api/portal";

// ── Who is who ───────────────────────────────────────────────────────────────
export interface PortalEmployee { id: string; name: string }

/**
 * Does a schedule row / time-off entry belong to this employee? Rows with an
 * employee id match by id only; name-only rows (no id) match by name, the same
 * way the schedule and pay statements match people.
 */
export function isEmployee(row: { employeeId?: string; employeeName: string }, emp: PortalEmployee): boolean {
  if (row.employeeId) return row.employeeId === emp.id;
  return employeeKey(row.employeeName) === employeeKey(emp.name);
}

/**
 * Find the employee a typed name means at a location: the full name (any case
 * and spacing), or a first name only when exactly one active person has it.
 */
export function matchName<T extends { name: string; active: boolean }>(list: T[], typed: string): T | null {
  const k = employeeKey(typed);
  if (!k) return null;
  const active = list.filter((e) => e.active);
  const full = active.find((e) => employeeKey(e.name) === k);
  if (full) return full;
  if (k.includes(" ")) return null;
  const firsts = active.filter((e) => employeeKey(e.name).split(" ")[0] === k);
  return firsts.length === 1 ? firsts[0] : null;
}

// ── Pay statements ───────────────────────────────────────────────────────────
/** The (included) summary for this person in a computed timesheet, matched by name like pay statements and YTD. */
export function employeeSummaryFor(result: Pick<AnalysisResult, "employees">, name: string): EmployeeSummary | null {
  const k = employeeKey(name);
  return result.employees.find((e) => !e.excluded && employeeKey(e.name) === k) ?? null;
}

/**
 * A copy of a computed timesheet that holds ONLY this person: their summary,
 * totals from their numbers alone, and no warnings (which can name others).
 * Returns null when they are not in it.
 */
export function statementResult(result: AnalysisResult, name: string): AnalysisResult | null {
  const e = employeeSummaryFor(result, name);
  if (!e) return null;
  return {
    periodStart: result.periodStart,
    periodEnd: result.periodEnd,
    employees: [e],
    warnings: [],
    totals: {
      employees: 1,
      totalPay: e.totalPay,
      netPay: e.isNetPay ? e.totalPay : 0,
      grossPay: e.isNetPay ? 0 : e.totalPay,
      bonuses: e.totalBonuses,
      deductions: e.totalDeductions,
      docked: e.totalDocked,
      fullDays: e.fullDays,
      halfDays: e.halfDays,
      flaggedDays: e.flaggedDays,
      hours: e.hoursWorked,
      overtimeHours: e.overtimeHours,
      cash: e.payment?.cash ?? 0,
      bank: e.payment?.bank ?? 0,
      check: e.payment?.check ?? 0,
      tips: e.extras?.tips ?? 0,
      holidayPremium: e.extras?.holiday ?? 0,
      advanceRepayments: e.extras?.advance ?? 0,
      recurringBonuses: e.extras?.recurringBonus ?? 0,
      recurringDeductions: e.extras?.recurringDeduction ?? 0,
    },
  };
}

// ── Hours this period ────────────────────────────────────────────────────────
export type PortalDayStatus = "working" | "break" | "flagged" | "approved" | "worked";

export interface PortalShift {
  in: string;
  out: string | null;
  breakMinutes: number;
  workedMinutes: number;
  autoClosed: boolean;
}
export interface PortalDay {
  date: string;
  workedMinutes: number;
  status: PortalDayStatus;
  /** Short reason for "flagged", e.g. "Auto-closed" or "No clock-out". */
  note: string;
  shifts: PortalShift[];
}

/**
 * One person's work days for the portal, newest first. Status: working (or on
 * a break) right now, flagged (a problem the manager hasn't approved yet),
 * approved, or simply worked.
 */
export function portalDays(days: WorkDay[], employeeId: string, clock: ClockStatus): PortalDay[] {
  return days
    .filter((d) => d.employeeId === employeeId)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((d) => {
      let status: PortalDayStatus = "worked";
      let note = "";
      if (d.working) status = clock === "break" ? "break" : "working";
      else if (d.approved) status = "approved";
      else if (d.issues.length) { status = "flagged"; note = d.issues[0].title; }
      return {
        date: d.date,
        workedMinutes: d.workedMinutes,
        status,
        note,
        shifts: d.shifts.map((s) => ({
          in: s.in.at,
          out: s.out?.at ?? null,
          breakMinutes: s.breakMinutes,
          workedMinutes: s.workedMinutes,
          autoClosed: !!s.out?.flags?.autoClosed,
        })),
      };
    });
}

// ── Schedule ─────────────────────────────────────────────────────────────────
export interface PortalShiftItem { id: string; date: string; start: number; end: number; station: string; note: string }
export interface PortalTimeOffItem { id: string; start: string; end: string; reason: string }

/** This person's shifts from published weeks only. */
export function publishedShiftsFor(shifts: (ScheduledShift & { published: boolean })[], emp: PortalEmployee): PortalShiftItem[] {
  return shifts
    .filter((s) => s.published && isEmployee(s, emp))
    .map((s) => ({ id: s.id, date: s.date, start: s.start, end: s.end, station: s.station, note: s.note }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start);
}

/** Approved time off for this person overlapping [from, to]. */
export function approvedTimeOffFor(list: TimeOff[], emp: PortalEmployee, from: string, to: string): PortalTimeOffItem[] {
  return list
    .filter((t) => t.status === "approved" && t.end >= from && t.start <= to && isEmployee(t, emp))
    .map((t) => ({ id: t.id, start: t.start, end: t.end, reason: t.reason }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

// ── Time-off requests ────────────────────────────────────────────────────────
export const MAX_REQUEST_DAYS = 60;
export const MAX_PENDING_REQUESTS = 10;
/** How far ahead a request may start. */
export const MAX_REQUEST_AHEAD_DAYS = 365;

/** Plain-English problem with a request, or null when it is fine. */
export function checkTimeOffRequest(input: { start: string; end: string }, today: string, mine: TimeOff[]): string | null {
  if (!isISODate(input.start) || !isISODate(input.end)) return "Pick the days.";
  if (input.end < input.start) return "The last day is before the first day.";
  if (input.start < today) return "Pick today or a later day.";
  if (daysBetween(today, input.start) > MAX_REQUEST_AHEAD_DAYS) return "That's more than a year away.";
  if (daysBetween(input.start, input.end) + 1 > MAX_REQUEST_DAYS) return `Ask for ${MAX_REQUEST_DAYS} days or fewer at a time.`;
  const open = mine.filter((t) => t.status !== "declined");
  if (open.some((t) => t.start <= input.end && t.end >= input.start)) return "You already have time off or a request on those days.";
  if (mine.filter((t) => t.status === "pending").length >= MAX_PENDING_REQUESTS) return `You have ${MAX_PENDING_REQUESTS} requests waiting. Wait for an answer first.`;
  return null;
}

/** Requests and time off to list for the employee: everything still ahead, plus the last 60 days. */
export function visibleTimeOff(list: TimeOff[], emp: PortalEmployee, today: string): TimeOff[] {
  const since = addDays(today, -60);
  return list
    .filter((t) => isEmployee(t, emp) && t.end >= since)
    .sort((a, b) => b.start.localeCompare(a.start));
}

// ── Sign-in lockout ──────────────────────────────────────────────────────────
export interface LockState { n: number; lockedUntil: number; locks: number; last: number }
export interface LockPolicy {
  /** Wrong tries before a lock. */
  maxFails: number;
  /** First lock length; each later lock doubles it. */
  baseMs: number;
  maxMs: number;
  /** Forget the history after this long without a wrong try. */
  resetMs: number;
}

/** How long (ms) this key is still locked. */
export function lockRemaining(s: LockState | undefined, now: number): number {
  return s ? Math.max(0, s.lockedUntil - now) : 0;
}

/**
 * Record one attempt. A success clears the history; every `maxFails` wrong
 * tries lock the key, for twice as long as the previous lock (capped).
 */
export function recordAttempt(s: LockState | undefined, ok: boolean, now: number, p: LockPolicy): LockState | undefined {
  if (ok) return undefined;
  let f = s && now - s.last <= p.resetMs ? { ...s } : { n: 0, lockedUntil: 0, locks: 0, last: now };
  f.n++;
  f.last = now;
  if (f.n >= p.maxFails) {
    f = { ...f, lockedUntil: now + Math.min(p.maxMs, p.baseMs * 2 ** f.locks), locks: f.locks + 1, n: 0 };
  }
  return f;
}
