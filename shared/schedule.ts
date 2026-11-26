// Weekly schedules, time off, late / no-show alerts and the early clock-in
// rule. Pure: shared by the server (API, alerts, payroll import) and the admin
// app (Schedule page), and later the employee portal.
//
// Times follow the rest of the app: a shift belongs to a local ISO date and its
// start / end are minutes after midnight of that date (end may pass 1440 for
// overnight shifts).
import { z } from "zod";
import type { Shift } from "./schema";
import type { Punch } from "./punches";
import { addDays, daysBetween, formatTime, isISODate, localToInstant, startOfWeek } from "./dates";
import { employeeKey } from "./engine";

const isoDate = z.string().refine(isISODate, "Use a YYYY-MM-DD date.");

// ── Scheduled shifts and weeks ───────────────────────────────────────────────
export const scheduledShiftSchema = z.object({
  id: z.string().min(1).max(64),
  /** Kiosk employee id when known; "" for a name-only row. */
  employeeId: z.string().max(64).default(""),
  employeeName: z.string().trim().min(1).max(120),
  date: isoDate,
  start: z.number().int().min(0).max(1439),
  end: z.number().int().min(1).max(2880),
  station: z.string().trim().max(60).default(""),
  note: z.string().trim().max(200).default(""),
}).refine((s) => s.end > s.start, { message: "The shift must end after it starts.", path: ["end"] })
  .refine((s) => s.end - s.start <= 24 * 60, { message: "A shift can be at most 24 hours.", path: ["end"] });
export type ScheduledShift = z.infer<typeof scheduledShiftSchema>;

export interface ScheduleWeek {
  siteId: string;
  /** First day of the week (ISO date), per the location's week start. */
  weekStart: string;
  shifts: ScheduledShift[];
  /** When the week was last published (null = draft). */
  publishedAt: string | null;
  /** Changes after publishing. */
  changedSincePublish: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export function emptyWeek(siteId: string, weekStart: string): ScheduleWeek {
  return { siteId, weekStart, shifts: [], publishedAt: null, changedSincePublish: false, updatedAt: null, updatedBy: null };
}

/** Read a stored week leniently: bad shifts are dropped, never fatal. */
export function parseWeek(raw: unknown, siteId: string, weekStart: string): ScheduleWeek {
  const w = emptyWeek(siteId, weekStart);
  if (!raw || typeof raw !== "object") return w;
  const r = raw as Record<string, unknown>;
  const shifts = Array.isArray(r.shifts) ? r.shifts.map((s) => scheduledShiftSchema.safeParse(s)).filter((x) => x.success).map((x) => x.data!) : [];
  return {
    ...w,
    shifts: sortShifts(shifts),
    publishedAt: typeof r.publishedAt === "string" ? r.publishedAt : null,
    changedSincePublish: r.changedSincePublish === true,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : null,
    updatedBy: typeof r.updatedBy === "string" ? r.updatedBy : null,
  };
}

export const sortShifts = (list: ScheduledShift[]) =>
  [...list].sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start || a.employeeName.localeCompare(b.employeeName));

export const scheduleKey = (siteId: string, weekStart: string) => `schedule:${siteId}:${weekStart}`;
export const timeOffKey = (siteId: string) => `timeoff:${siteId}`;
export const scheduleSettingsKey = (siteId: string) => `schedule-settings:${siteId}`;

export function weekStartOf(date: string, weekStartsOn: number): string {
  return startOfWeek(date, weekStartsOn);
}

/** The seven dates of a week. */
export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** First day of every week that touches [from, to]. */
export function weeksCovering(from: string, to: string, weekStartsOn: number): string[] {
  const out: string[] = [];
  for (let w = weekStartOf(from, weekStartsOn); w <= to && out.length < 120; w = addDays(w, 7)) out.push(w);
  return out;
}

/** Shift minutes (no breaks are scheduled). */
export const shiftMinutes = (s: Pick<ScheduledShift, "start" | "end">) => Math.max(0, s.end - s.start);

/** Who a shift is for, so name-only rows and directory rows match the same person. */
export const personKey = (s: { employeeId?: string; employeeName: string }) => (s.employeeId ? `id:${s.employeeId}` : `name:${employeeKey(s.employeeName)}`);

/** Copy a week's shifts to another week, keeping weekday and times. */
export function copyShifts(shifts: ScheduledShift[], fromWeek: string, toWeek: string, newId: () => string): ScheduledShift[] {
  const delta = daysBetween(fromWeek, toWeek);
  return sortShifts(shifts.map((s) => ({ ...s, id: newId(), date: addDays(s.date, delta) })));
}

/** Total scheduled hours per person and overall. */
export function scheduledHours(shifts: ScheduledShift[]): { total: number; byPerson: Record<string, number> } {
  const byPerson: Record<string, number> = {};
  let total = 0;
  for (const s of shifts) {
    const h = shiftMinutes(s) / 60;
    total += h;
    byPerson[personKey(s)] = (byPerson[personKey(s)] ?? 0) + h;
  }
  return { total, byPerson };
}

// ── Time off ─────────────────────────────────────────────────────────────────
export const TIME_OFF_STATUSES = ["pending", "approved", "declined"] as const;
export type TimeOffStatus = (typeof TIME_OFF_STATUSES)[number];

export const timeOffSchema = z.object({
  id: z.string().min(1).max(64),
  employeeId: z.string().max(64).default(""),
  employeeName: z.string().trim().min(1).max(120),
  start: isoDate,
  end: isoDate,
  reason: z.string().trim().max(200).default(""),
  status: z.enum(TIME_OFF_STATUSES).catch("pending"),
  /** Who asked: the owner (entered on the schedule) or, later, the employee. */
  requestedBy: z.enum(["owner", "employee"]).catch("owner").default("owner"),
  createdAt: z.string().default(() => new Date().toISOString()),
  decidedAt: z.string().nullable().default(null),
  decidedBy: z.string().nullable().default(null),
}).refine((t) => t.end >= t.start, { message: "The last day is before the first day.", path: ["end"] });
export type TimeOff = z.infer<typeof timeOffSchema>;

export function parseTimeOff(raw: unknown): TimeOff[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => timeOffSchema.safeParse(t)).filter((x) => x.success).map((x) => x.data!);
}

/** Approved time off covering this person on this date, if any. */
export function timeOffOn(list: TimeOff[], who: { employeeId?: string; employeeName: string }, date: string): TimeOff | undefined {
  const k = personKey(who);
  const nk = `name:${employeeKey(who.employeeName)}`;
  return list.find((t) => t.status === "approved" && date >= t.start && date <= t.end && (personKey(t) === k || `name:${employeeKey(t.employeeName)}` === nk));
}

// ── Per-location settings ────────────────────────────────────────────────────
export const EARLY_MODES = ["start", "cap"] as const;
export type EarlyMode = (typeof EARLY_MODES)[number];

export const scheduleSettingsSchema = z.object({
  /** Minutes after the scheduled start before someone counts as late. */
  lateGraceMinutes: z.number().int().min(0).max(120).catch(5).default(5),
  /** Minutes after the scheduled start with no clock-in before it is a no-show. */
  noShowAfterMinutes: z.number().int().min(5).max(480).catch(60).default(60),
  earlyClockIn: z.object({
    /** Off by default: payroll hours stay exactly as punched. */
    enabled: z.boolean().catch(false).default(false),
    /** Clock-ins more than this many minutes before the scheduled start are adjusted. */
    minutes: z.number().int().min(0).max(240).catch(10).default(10),
    /** start: pay from the scheduled start; cap: pay from `minutes` before the start. */
    mode: z.enum(EARLY_MODES).catch("start").default("start"),
  }).catch({ enabled: false, minutes: 10, mode: "start" }).prefault({}),
});
export type ScheduleSettings = z.infer<typeof scheduleSettingsSchema>;
export const DEFAULT_SCHEDULE_SETTINGS: ScheduleSettings = scheduleSettingsSchema.parse({});

// ── Read-only API (GET /api/schedule) ────────────────────────────────────────
export interface ScheduleApiShift extends ScheduledShift {
  weekStart: string;
  /** The week this shift is in has been published. */
  published: boolean;
}
export interface ScheduleApiResponse {
  siteId: string;
  from: string;
  to: string;
  timezone: string;
  weekStartsOn: number;
  shifts: ScheduleApiShift[];
  timeOff: TimeOff[];
  weeks: { weekStart: string; publishedAt: string | null; changedSincePublish: boolean }[];
}

// ── Late / no-show alerts ────────────────────────────────────────────────────
export type AlertKind = "no_show" | "late" | "arrived_late";
export interface ScheduleAlert {
  kind: AlertKind;
  shiftId: string;
  employeeId: string;
  employeeName: string;
  date: string;
  /** Scheduled start, minutes after midnight. */
  start: number;
  end: number;
  minutesLate: number;
  /** When they clocked in (arrived_late). */
  clockedInAt: string | null;
  message: string;
}

export interface AlertInput {
  date: string;
  timezone: string;
  now: number;
  shifts: ScheduledShift[];
  punches: Punch[];
  timeOff?: TimeOff[];
  settings?: Partial<ScheduleSettings>;
  /** Time style for the messages. */
  timeFormat?: "12h" | "24h";
}

const LOOK_BACK_MS = 4 * 3600_000;
const firstName = (n: string) => n.trim().split(/\s+/)[0] || n;

/**
 * Compare today's schedule with the punches. A person is late once the grace
 * time has passed without a clock-in, and a no-show after `noShowAfterMinutes`
 * (or once the shift is over). People who clocked in late are reported too.
 * Approved time off silences a shift.
 */
export function scheduleAlerts(input: AlertInput): ScheduleAlert[] {
  const st = { ...DEFAULT_SCHEDULE_SETTINGS, ...(input.settings ?? {}) };
  const grace = st.lateGraceMinutes * 60_000;
  const noShow = st.noShowAfterMinutes * 60_000;
  const fmt = (m: number) => formatTime(m, input.timeFormat ?? "12h");
  const todays = sortShifts(input.shifts.filter((s) => s.date === input.date));
  const ins = input.punches.filter((p) => p.type === "in").map((p) => ({ p, t: Date.parse(p.at) })).sort((a, b) => a.t - b.t);
  const used = new Set<string>();
  const prevEnd = new Map<string, number>();
  const out: ScheduleAlert[] = [];

  for (const s of todays) {
    if (input.timeOff && timeOffOn(input.timeOff, s, s.date)) continue;
    const startMs = Date.parse(localToInstant(s.date, s.start, input.timezone));
    const endMs = Date.parse(localToInstant(s.date, s.end, input.timezone));
    const who = personKey(s);
    const nameK = employeeKey(s.employeeName);
    const windowFrom = Math.max(startMs - LOOK_BACK_MS, prevEnd.get(who) ?? -Infinity);
    prevEnd.set(who, endMs);
    const hit = ins.find(({ p, t }) => !used.has(p.id) && t >= windowFrom && t < endMs
      && (s.employeeId ? p.employeeId === s.employeeId : employeeKey(p.employeeName) === nameK));
    const base = { shiftId: s.id, employeeId: s.employeeId, employeeName: s.employeeName, date: s.date, start: s.start, end: s.end };
    if (hit) {
      used.add(hit.p.id);
      const late = Math.floor((hit.t - startMs) / 60_000);
      if (hit.t - startMs > grace) {
        out.push({ ...base, kind: "arrived_late", minutesLate: late, clockedInAt: hit.p.at, message: `${firstName(s.employeeName)} clocked in ${late} min late` });
      }
      continue;
    }
    if (input.now - startMs <= grace) continue;
    const late = Math.floor((input.now - startMs) / 60_000);
    if (input.now - startMs >= noShow || input.now >= endMs) {
      out.push({ ...base, kind: "no_show", minutesLate: late, clockedInAt: null, message: `No-show: ${firstName(s.employeeName)} (scheduled ${fmt(s.start)})` });
    } else {
      out.push({ ...base, kind: "late", minutesLate: late, clockedInAt: null, message: `${firstName(s.employeeName)} is ${late} min late` });
    }
  }
  const order: Record<AlertKind, number> = { no_show: 0, late: 1, arrived_late: 2 };
  return out.sort((a, b) => order[a.kind] - order[b.kind] || a.start - b.start || a.employeeName.localeCompare(b.employeeName));
}

// ── Early clock-in rule (payroll) ────────────────────────────────────────────
export interface EarlyRule { enabled: boolean; minutes: number; mode: EarlyMode }
export interface EarlyResult { shifts: Shift[]; adjusted: number; warnings: string[] }

/**
 * Adjust kiosk shifts that started more than `minutes` before a scheduled
 * start on the same day. Only days with a schedule for that person are
 * touched; with the rule off, the shifts are returned unchanged.
 *   mode "start": hours count from the scheduled start.
 *   mode "cap":   hours count from `minutes` before the scheduled start.
 */
export function applyEarlyClockIn(shifts: Shift[], scheduled: (Pick<ScheduledShift, "employeeName" | "date" | "start"> & { end?: number })[], rule: EarlyRule | undefined, timeFormat: "12h" | "24h" = "12h"): EarlyResult {
  if (!rule?.enabled || !scheduled.length) return { shifts, adjusted: 0, warnings: [] };
  const starts = new Map<string, number[]>();
  const spans = new Map<string, { start: number; end: number }[]>();
  for (const s of scheduled) {
    const k = `${employeeKey(s.employeeName)}|${s.date}`;
    starts.set(k, [...(starts.get(k) ?? []), s.start].sort((a, b) => a - b));
    // Without an end time, assume a scheduled shift lasts at least 4 hours.
    spans.set(k, [...(spans.get(k) ?? []), { start: s.start, end: s.end ?? s.start + 240 }]);
  }
  let adjusted = 0;
  const warnings: string[] = [];
  const out = shifts.map((sh) => {
    if (sh.source !== "kiosk") return sh;
    const list = starts.get(`${employeeKey(sh.employee)}|${sh.date}`);
    if (!list) return sh;
    // Clocked in during (or late for) an earlier scheduled shift that day: not early,
    // even if another shift starts later (a double shift worked straight through).
    if ((spans.get(`${employeeKey(sh.employee)}|${sh.date}`) ?? []).some((sp) => sp.start <= sh.start && sh.start < sp.end)) return sh;
    // The scheduled shift they came in early for: the first start at or after the clock-in.
    const target = list.find((st) => st >= sh.start);
    if (target == null || target - sh.start <= rule.minutes) return sh;
    const newStart = rule.mode === "cap" ? target - rule.minutes : target;
    if (newStart >= sh.end) return sh;
    adjusted++;
    const note = `Clocked in ${formatTime(sh.start, timeFormat)}, counted from ${formatTime(newStart, timeFormat)} (early clock-in rule)`;
    return { ...sh, start: newStart, breakMinutes: Math.min(sh.breakMinutes, sh.end - newStart), note: sh.note ? `${sh.note} · ${note}` : note };
  });
  if (adjusted) warnings.push(`${adjusted} early clock-in${adjusted === 1 ? " was" : "s were"} adjusted by the early clock-in rule (hours count from the schedule).`);
  return { shifts: out, adjusted, warnings };
}
