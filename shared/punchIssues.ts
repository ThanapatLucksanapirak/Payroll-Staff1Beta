// Owner / manager side of time-clock data: grouping punches into shifts and
// work days, finding punch problems, planning automatic clock-outs, day
// approval fingerprints and the live overtime watch. Pure functions only, so
// the server, the admin app and the tests all apply the same rules.
import { z } from "zod";
import type { SiteRules } from "./schema";
import { addDays, daysBetween, formatTime, instantToLocal, localToInstant, startOfWeek } from "./dates";
import { type Punch, type PunchType, PUNCH_LABELS, STALE_SHIFT_HOURS, byTime, localRange, workedMinutes } from "./punches";

const MIN = 60_000;
const HOUR = 3_600_000;
const STALE_MS = STALE_SHIFT_HOURS * HOUR;
const ms = (iso: string) => Date.parse(iso);
const iso = (t: number) => new Date(t).toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────
/** Per-location automatic clock-out. Stored in app settings under `timeclock:<siteId>`. */
export const autoCloseSchema = z.object({
  /** Local time of day (minutes after midnight) at which forgotten shifts close; null = off. */
  cutoffMinutes: z.number().int().min(0).max(1439).nullable().default(null),
  /** Close any shift open longer than this many hours; 0 = off. */
  maxShiftHours: z.number().min(0).max(48).default(0),
});
export type AutoCloseConfig = z.infer<typeof autoCloseSchema>;
export const DEFAULT_AUTO_CLOSE: AutoCloseConfig = { cutoffMinutes: null, maxShiftHours: 0 };
export const autoCloseEnabled = (c: AutoCloseConfig) => c.cutoffMinutes != null || c.maxShiftHours > 0;

export const AUTO_CLOSE_NOTE = "Auto-closed: forgot to clock out";
/** A daily cutoff never closes a shift that started less than this long before it. */
export const AUTO_CLOSE_MIN_SHIFT_MS = HOUR;

// ─────────────────────────────────────────────────────────────────────────────
// Shifts
// ─────────────────────────────────────────────────────────────────────────────
export interface WorkBreak { start: Punch; end: Punch | null; /** The clock-out ended it (no break-end punch). */ endedByOut: boolean }

export interface WorkShift {
  employeeId: string;
  employeeName: string;
  /** Local date the shift started on (payroll files it on this day). */
  date: string;
  in: Punch;
  out: Punch | null;
  /** Every punch of the shift, in order (in, breaks, out). */
  punches: Punch[];
  breaks: WorkBreak[];
  /** No clock-out. */
  open: boolean;
  /** Open, and a later clock-in (or a stale gap) shows it was forgotten. */
  superseded: boolean;
  /** For a superseded shift: the next clock-in, if that is what ended it. */
  nextInAt: string | null;
  /** Clock-out minus clock-in (open shifts: until `now`), in minutes. */
  grossMinutes: number;
  breakMinutes: number;
  workedMinutes: number;
}

/** A punch that does not follow from the punches before it (e.g. a clock-out with no clock-in). */
export interface StrayPunch { employeeId: string; employeeName: string; date: string; punch: Punch; reason: string }

export interface GroupResult { shifts: WorkShift[]; strays: StrayPunch[] }

/**
 * Pair one or more employees' punches into shifts, the same way the payroll
 * import does (a clock-in more than STALE_SHIFT_HOURS after an open shift's start
 * starts a new shift; a clock-out always closes the open shift).
 */
export function groupShifts(punches: Punch[], timezone: string, now = Date.now()): GroupResult {
  const byEmp = new Map<string, Punch[]>();
  for (const p of punches) {
    if (!byEmp.has(p.employeeId)) byEmp.set(p.employeeId, []);
    byEmp.get(p.employeeId)!.push(p);
  }
  const shifts: WorkShift[] = [];
  const strays: StrayPunch[] = [];
  const dateOf = (p: Punch) => instantToLocal(p.at, timezone).date;

  for (const [employeeId, list] of byEmp) {
    list.sort(byTime);
    const name = list[list.length - 1].employeeName;
    let cur: { in: Punch; punches: Punch[]; breaks: WorkBreak[] } | null = null;

    const finish = (out: Punch | null, superseded: boolean, nextInAt: string | null) => {
      if (!cur) return;
      const start = ms(cur.in.at);
      const end = out ? ms(out.at) : Math.max(start, now);
      let breakMs = 0;
      for (const b of cur.breaks) {
        const bEnd = b.end ? ms(b.end.at) : out ? ms(out.at) : end;
        if (!b.end && out) b.endedByOut = true;
        breakMs += Math.max(0, bEnd - ms(b.start.at));
      }
      const gross = Math.max(0, end - start);
      shifts.push({
        employeeId, employeeName: name, date: dateOf(cur.in), in: cur.in, out, punches: out ? [...cur.punches, out] : cur.punches, breaks: cur.breaks,
        open: !out, superseded: !out && superseded, nextInAt: !out ? nextInAt : null,
        grossMinutes: Math.round(gross / MIN), breakMinutes: Math.round(breakMs / MIN), workedMinutes: Math.round(Math.max(0, gross - breakMs) / MIN),
      });
      cur = null;
    };
    const stray = (p: Punch, reason: string) => strays.push({ employeeId, employeeName: name, date: dateOf(p), punch: p, reason });

    for (const p of list) {
      const t = ms(p.at);
      if (cur && t - ms(cur.in.at) > STALE_MS && p.type !== "out") finish(null, true, p.type === "in" ? p.at : null);
      if (p.type === "in") {
        if (cur) finish(null, true, p.at);
        cur = { in: p, punches: [p], breaks: [] };
        continue;
      }
      if (!cur) { stray(p, `${PUNCH_LABELS[p.type]} without a clock-in`); continue; }
      const open = cur.breaks.find((b) => !b.end);
      if (p.type === "break_start") {
        if (open) { stray(p, "Break started twice"); continue; }
        cur.breaks.push({ start: p, end: null, endedByOut: false });
        cur.punches.push(p);
        continue;
      }
      if (p.type === "break_end") {
        if (!open) { stray(p, "Break ended without starting"); continue; }
        open.end = p;
        cur.punches.push(p);
        continue;
      }
      finish(p, false, null);
    }
    if (cur) finish(null, now - ms((cur as { in: Punch }).in.at) > STALE_MS, null);
  }
  shifts.sort((a, b) => byTime(a.in, b.in));
  return { shifts, strays };
}

// ─────────────────────────────────────────────────────────────────────────────
// Automatic clock-out
// ─────────────────────────────────────────────────────────────────────────────
export interface AutoCloseAction {
  employeeId: string;
  employeeName: string;
  /** The clock-in of the shift being closed (stable: used for idempotent punch ids). */
  inPunchId: string;
  date: string;
  /** When the shift is closed (the cutoff, not the time the job runs). */
  at: string;
  reason: "cutoff" | "max_shift";
  /** The shift is on a break: end it at the same moment first. */
  endBreak: boolean;
}

/** First instant after `afterMs` at which the local clock in `timezone` reads `minutes`. */
export function nextLocalTime(afterMs: number, minutes: number, timezone: string): number {
  const startDate = instantToLocal(iso(afterMs), timezone).date;
  for (let k = -1; k <= 3; k++) {
    const t = ms(localToInstant(addDays(startDate, k), minutes, timezone));
    if (t > afterMs) return t;
  }
  return afterMs + 24 * HOUR; // unreachable in practice
}

/** When an open shift should be closed, or null when auto clock-out is off. */
export function autoCloseTime(shift: Pick<WorkShift, "in" | "punches">, cfg: AutoCloseConfig, timezone: string): { at: number; reason: AutoCloseAction["reason"] } | null {
  const start = ms(shift.in.at);
  const last = Math.max(...shift.punches.map((p) => ms(p.at)));
  const candidates: { at: number; reason: AutoCloseAction["reason"] }[] = [];
  if (cfg.cutoffMinutes != null) {
    candidates.push({ at: nextLocalTime(Math.max(last, start + AUTO_CLOSE_MIN_SHIFT_MS - 1), cfg.cutoffMinutes, timezone), reason: "cutoff" });
  }
  if (cfg.maxShiftHours > 0) {
    const cap = start + cfg.maxShiftHours * HOUR;
    candidates.push({ at: cap > last ? cap : last + MIN, reason: "max_shift" });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.at - b.at);
  return candidates[0];
}

/**
 * Which open shifts to close now. A shift is closed at its cutoff once that time
 * has passed; one that was followed by another clock-in is only closed when the
 * cutoff falls before that clock-in. Running it again changes nothing.
 */
export function planAutoClose(punches: Punch[], cfg: AutoCloseConfig, timezone: string, now = Date.now()): AutoCloseAction[] {
  if (!autoCloseEnabled(cfg)) return [];
  const out: AutoCloseAction[] = [];
  for (const s of groupShifts(punches, timezone, now).shifts) {
    if (!s.open) continue;
    const when = autoCloseTime(s, cfg, timezone);
    if (!when || when.at > now) continue;
    if (s.nextInAt && when.at >= ms(s.nextInAt)) continue;
    out.push({
      employeeId: s.employeeId, employeeName: s.employeeName, inPunchId: s.in.id, date: s.date,
      at: iso(when.at), reason: when.reason, endBreak: s.breaks.some((b) => !b.end),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Punch problems
// ─────────────────────────────────────────────────────────────────────────────
export const ISSUE_KINDS = ["missing_out", "out_of_order", "auto_closed", "open_break", "long_shift", "short_shift"] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];
/** "fix": the hours can't be worked out until it is fixed. "review": worth a look. */
export type IssueSeverity = "fix" | "review";

export const ISSUE_LABELS: Record<IssueKind, string> = {
  missing_out: "No clock-out",
  out_of_order: "Out of order",
  auto_closed: "Auto-closed",
  open_break: "Break never ended",
  long_shift: "Very long shift",
  short_shift: "Very short shift",
};

/** One-tap fixes. Every fix goes through the normal punch add / edit / delete routes, with a note. */
export type IssueFix =
  /** linkedPunchIds: punches at the same moment that move with it (an automatic break end before an automatic clock-out). */
  | { kind: "edit"; label: string; punchId: string; type: PunchType; suggestedAt: string; note: string; linkedPunchIds?: string[] }
  | { kind: "add"; label: string; type: PunchType; suggestedAt: string; minAt: string; maxAt: string | null; note: string }
  | { kind: "delete"; label: string; punchIds: string[]; note: string };

export interface PunchIssue {
  /** Stable id: kind + punch id. */
  id: string;
  kind: IssueKind;
  severity: IssueSeverity;
  employeeId: string;
  employeeName: string;
  /** The work day it belongs to (local start date of the shift). */
  date: string;
  title: string;
  detail: string;
  punchIds: string[];
  fixes: IssueFix[];
}

export interface IssueOptions {
  timezone: string;
  now?: number;
  /** Shifts longer than this are flagged (0 = never). Default 14. */
  longShiftHours?: number;
  /** Shifts shorter than this many minutes are flagged (0 = never). Default 5. */
  shortShiftMinutes?: number;
  /** A break left running into the clock-out for at least this long is flagged. Default 120. */
  longBreakMinutes?: number;
  timeFormat?: "12h" | "24h";
}

export function detectIssues(group: GroupResult, opts: IssueOptions): PunchIssue[] {
  const now = opts.now ?? Date.now();
  const tz = opts.timezone;
  const longH = opts.longShiftHours ?? 14;
  const shortM = opts.shortShiftMinutes ?? 5;
  const longBreakM = opts.longBreakMinutes ?? 120;
  const at = (s: string) => { const l = instantToLocal(s, tz); return formatTime(l.minutes, opts.timeFormat); };
  const hours = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  const issues: PunchIssue[] = [];

  for (const s of group.shifts) {
    const base = { employeeId: s.employeeId, employeeName: s.employeeName, date: s.date };
    const start = ms(s.in.at);
    if (s.open) {
      if (!s.superseded) continue; // still working
      const openBreak = s.breaks.find((b) => !b.end);
      const lastAt = Math.max(...s.punches.map((p) => ms(p.at)));
      const cap = s.nextInAt ? ms(s.nextInAt) - MIN : now;
      const suggested = Math.max(lastAt + MIN, Math.min(start + 8 * HOUR, cap));
      issues.push({
        ...base, id: `missing_out:${s.in.id}`, kind: "missing_out", severity: "fix",
        title: `${ISSUE_LABELS.missing_out}`,
        detail: `Clocked in at ${at(s.in.at)}${openBreak ? `, on a break since ${at(openBreak.start.at)}` : ""} and never clocked out.`,
        punchIds: s.punches.map((p) => p.id),
        fixes: [{ kind: "add", label: "Add the clock-out", type: "out", suggestedAt: iso(suggested), minAt: iso(lastAt + MIN), maxAt: s.nextInAt ? iso(ms(s.nextInAt) - MIN) : null, note: "Forgot to clock out" }],
      });
      continue;
    }
    const out = s.out!;
    const auto = !!out.flags?.autoClosed && out.edits.length === 0;
    if (auto) {
      issues.push({
        ...base, id: `auto_closed:${out.id}`, kind: "auto_closed", severity: "review",
        title: ISSUE_LABELS.auto_closed,
        detail: `Clocked in at ${at(s.in.at)}; the app clocked them out at ${at(out.at)}. Set the real time, or approve the day to keep it.`,
        punchIds: [s.in.id, out.id],
        fixes: [{ kind: "edit", label: "Set the real clock-out", punchId: out.id, type: "out", suggestedAt: out.at, note: "Real clock-out time", linkedPunchIds: s.breaks.filter((b) => b.end?.flags?.autoClosed && b.end.at === out.at).map((b) => b.end!.id) }],
      });
    }
    for (const b of s.breaks) {
      if (b.end || !b.endedByOut) continue;
      const len = Math.round((ms(out.at) - ms(b.start.at)) / MIN);
      if (len < longBreakM) continue;
      issues.push({
        ...base, id: `open_break:${b.start.id}`, kind: "open_break", severity: "review",
        title: ISSUE_LABELS.open_break,
        detail: `Break started at ${at(b.start.at)} and ran until the clock-out at ${at(out.at)} (${hours(len)} unpaid).`,
        punchIds: [b.start.id, out.id],
        fixes: [{ kind: "add", label: "Add the break end", type: "break_end", suggestedAt: iso(Math.min(ms(b.start.at) + 30 * MIN, ms(out.at) - MIN)), minAt: iso(ms(b.start.at) + MIN), maxAt: iso(ms(out.at) - MIN), note: "Forgot to end break" }],
      });
    }
    if (!auto && longH > 0 && s.grossMinutes > longH * 60) {
      issues.push({
        ...base, id: `long_shift:${s.in.id}`, kind: "long_shift", severity: "review",
        title: ISSUE_LABELS.long_shift,
        detail: `${hours(s.grossMinutes)} from ${at(s.in.at)} to ${at(out.at)}. A missed clock-out?`,
        punchIds: [s.in.id, out.id],
        fixes: [{ kind: "edit", label: "Fix the clock-out", punchId: out.id, type: "out", suggestedAt: out.at, note: "Corrected clock-out time" }],
      });
    }
    if (shortM > 0 && s.grossMinutes < shortM) {
      issues.push({
        ...base, id: `short_shift:${s.in.id}`, kind: "short_shift", severity: "review",
        title: ISSUE_LABELS.short_shift,
        detail: `Clocked in at ${at(s.in.at)} and out ${s.grossMinutes < 1 ? "right away" : `${s.grossMinutes} min later`}. A double tap?`,
        punchIds: s.punches.map((p) => p.id),
        fixes: [
          { kind: "delete", label: "Delete this shift", punchIds: s.punches.map((p) => p.id), note: "Accidental punch" },
          { kind: "edit", label: "Fix the clock-out", punchId: out.id, type: "out", suggestedAt: out.at, note: "Corrected clock-out time" },
        ],
      });
    }
  }

  for (const x of group.strays) {
    issues.push({
      employeeId: x.employeeId, employeeName: x.employeeName, date: x.date,
      id: `out_of_order:${x.punch.id}`, kind: "out_of_order", severity: "fix",
      title: ISSUE_LABELS.out_of_order,
      detail: `${x.reason} at ${at(x.punch.at)}.`,
      punchIds: [x.punch.id],
      fixes: [
        { kind: "edit", label: "Change this punch", punchId: x.punch.id, type: x.punch.type, suggestedAt: x.punch.at, note: "Fixed punch order" },
        { kind: "delete", label: "Delete it", punchIds: [x.punch.id], note: "Stray punch" },
      ],
    });
  }
  const order: Record<IssueSeverity, number> = { fix: 0, review: 1 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity] || a.date.localeCompare(b.date) || a.employeeName.localeCompare(b.employeeName) || a.id.localeCompare(b.id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Work days and approval
// ─────────────────────────────────────────────────────────────────────────────
export interface DayApproval { at: string; by: string | null; byName: string; /** dayFingerprint() of the day when it was approved. */ fp: string }

export interface WorkDay {
  employeeId: string;
  employeeName: string;
  date: string;
  shifts: WorkShift[];
  punchIds: string[];
  workedMinutes: number;
  issues: PunchIssue[];
  /** Someone is still clocked in on this day's shift. */
  working: boolean;
  fingerprint: string;
  approval: DayApproval | null;
  /** Approved, then the punches changed: the approval no longer counts. */
  approvalStale: boolean;
  approved: boolean;
  /** No "fix" problems and nobody still clocked in. */
  approvable: boolean;
  /** Approvable and no problems at all. */
  clean: boolean;
}

/** FNV-1a hash of the day's punches (id, type, time, last edit), so any change or edit shows. */
export function dayFingerprint(punches: Pick<Punch, "id" | "type" | "at" | "editedAt">[]): string {
  const text = [...punches].sort((a, b) => a.id.localeCompare(b.id)).map((p) => `${p.id}|${p.type}|${ms(p.at)}|${p.editedAt ?? ""}`).join(";");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${punches.length}-${h.toString(36)}`;
}

/** Stored approvals: date → employeeId → approval. */
export type ApprovalMap = Record<string, Record<string, DayApproval>>;

/**
 * Build each employee's work days in [start, end] (local dates). A day holds
 * the shifts that started on it plus any stray punches dated on it.
 */
export function buildWorkDays(punches: Punch[], opts: IssueOptions & { start: string; end: string; approvals?: ApprovalMap }): WorkDay[] {
  const now = opts.now ?? Date.now();
  const group = groupShifts(punches, opts.timezone, now);
  const issues = detectIssues(group, { ...opts, now });
  const days = new Map<string, WorkDay>();
  const inRange = (d: string) => d >= opts.start && d <= opts.end;
  const get = (employeeId: string, employeeName: string, date: string) => {
    const k = `${date}|${employeeId}`;
    let d = days.get(k);
    if (!d) {
      d = { employeeId, employeeName, date, shifts: [], punchIds: [], workedMinutes: 0, issues: [], working: false, fingerprint: "", approval: null, approvalStale: false, approved: false, approvable: false, clean: false };
      days.set(k, d);
    }
    return d;
  };
  const dayPunches = new Map<string, Punch[]>();
  const add = (d: WorkDay, ps: Punch[]) => { const k = `${d.date}|${d.employeeId}`; dayPunches.set(k, [...(dayPunches.get(k) ?? []), ...ps]); };
  for (const s of group.shifts) {
    if (!inRange(s.date)) continue;
    const d = get(s.employeeId, s.employeeName, s.date);
    d.shifts.push(s);
    d.workedMinutes += s.workedMinutes;
    if (s.open && !s.superseded) d.working = true;
    add(d, s.punches);
  }
  for (const x of group.strays) {
    if (!inRange(x.date)) continue;
    add(get(x.employeeId, x.employeeName, x.date), [x.punch]);
  }
  for (const i of issues) {
    const d = days.get(`${i.date}|${i.employeeId}`);
    if (d) d.issues.push(i);
  }
  for (const [k, d] of days) {
    const ps = dayPunches.get(k) ?? [];
    d.punchIds = ps.sort(byTime).map((p) => p.id);
    d.fingerprint = dayFingerprint(ps);
    d.approvable = !d.working && !d.issues.some((i) => i.severity === "fix");
    d.clean = d.approvable && d.issues.length === 0;
    const a = opts.approvals?.[d.date]?.[d.employeeId] ?? null;
    d.approval = a;
    d.approved = !!a && a.fp === d.fingerprint;
    d.approvalStale = !!a && !d.approved;
  }
  return [...days.values()].sort((a, b) => b.date.localeCompare(a.date) || a.employeeName.localeCompare(b.employeeName));
}

/** Problems still needing attention: "fix" problems always, "review" ones until the day is approved. */
export function openIssues(days: WorkDay[]): PunchIssue[] {
  return days.flatMap((d) => d.issues.filter((i) => i.severity === "fix" || !d.approved));
}

// ─────────────────────────────────────────────────────────────────────────────
// Live overtime watch
// ─────────────────────────────────────────────────────────────────────────────
export type OvertimeState = "over" | "near" | "pace" | "ok";

export interface OvertimeStatus {
  employeeId: string;
  employeeName: string;
  working: boolean;
  weekMinutes: number;
  todayMinutes: number;
  weeklyLimitMinutes: number | null;
  dailyLimitMinutes: number | null;
  state: OvertimeState;
  /** Which limit the state refers to. */
  limit: "weekly" | "daily" | null;
  /** Minutes left before overtime starts (min of the limits); 0 when over. */
  minutesLeft: number | null;
  /** If they keep working without a break: when overtime starts (ISO). */
  crossesAt: string | null;
  /** At the current pace (hours so far / days so far × 7). */
  projectedWeekMinutes: number;
}

/** "Near" means within this many minutes of the weekly limit. */
export const OT_NEAR_WEEK_MINUTES = 240;
/** "Near" means within this many minutes of the daily limit while working. */
export const OT_NEAR_DAY_MINUTES = 60;

export interface OvertimeOptions {
  rules: Pick<SiteRules, "overtimeEnabled" | "overtimeWeeklyHours" | "overtimeDailyHours" | "weekStartsOn" | "timezone">;
  now?: number;
}

export function overtimeWeek(rules: OvertimeOptions["rules"], now = Date.now()) {
  const tz = rules.timezone;
  const today = instantToLocal(iso(now), tz).date;
  const weekStart = startOfWeek(today, rules.weekStartsOn);
  return { today, weekStart, weekEnd: addDays(weekStart, 6) };
}

/**
 * Where each employee stands against the location's overtime rules this week,
 * from their punches (open shifts count until now). Returns [] when overtime is off.
 */
export function overtimeWatch(punches: Punch[], opts: OvertimeOptions): OvertimeStatus[] {
  const r = opts.rules;
  if (!r.overtimeEnabled) return [];
  const now = opts.now ?? Date.now();
  const tz = r.timezone;
  const weekly = r.overtimeWeeklyHours > 0 ? Math.round(r.overtimeWeeklyHours * 60) : null;
  const daily = r.overtimeDailyHours > 0 ? Math.round(r.overtimeDailyHours * 60) : null;
  if (weekly == null && daily == null) return [];
  const { today, weekStart } = overtimeWeek(r, now);
  const week = localRange(weekStart, today, tz);
  const day = localRange(today, today, tz);
  const weekFrom = ms(week.from);
  const elapsedDays = Math.max(0, daysBetween(weekStart, today)) + Math.min(1, Math.max(0, (now - ms(day.from)) / (24 * HOUR)));

  const byEmp = new Map<string, Punch[]>();
  for (const p of punches) {
    if (!byEmp.has(p.employeeId)) byEmp.set(p.employeeId, []);
    byEmp.get(p.employeeId)!.push(p);
  }
  const out: OvertimeStatus[] = [];
  for (const [employeeId, list] of byEmp) {
    list.sort(byTime);
    const weekMinutes = workedMinutes(list, weekFrom, now + 1, now);
    const todayMinutes = workedMinutes(list, ms(day.from), now + 1, now);
    const g = groupShifts(list, tz, now).shifts;
    const current = g.find((s) => s.open && !s.superseded);
    const working = !!current && !current.breaks.some((b) => !b.end);
    const weekLeft = weekly != null ? weekly - weekMinutes : null;
    const dayLeft = daily != null ? daily - todayMinutes : null;
    const lefts = [weekLeft, dayLeft].filter((x): x is number => x != null);
    const minutesLeft = lefts.length ? Math.max(0, Math.min(...lefts)) : null;
    const projected = elapsedDays >= 1 ? Math.round((weekMinutes / elapsedDays) * 7) : weekMinutes;
    let state: OvertimeState = "ok";
    let limit: OvertimeStatus["limit"] = null;
    if (weekLeft != null && weekLeft <= 0) { state = "over"; limit = "weekly"; }
    else if (dayLeft != null && dayLeft <= 0) { state = "over"; limit = "daily"; }
    else if (weekLeft != null && weekLeft <= OT_NEAR_WEEK_MINUTES) { state = "near"; limit = "weekly"; }
    else if (working && dayLeft != null && dayLeft <= OT_NEAR_DAY_MINUTES) { state = "near"; limit = "daily"; }
    else if (weekly != null && elapsedDays >= 2 && projected >= weekly) { state = "pace"; limit = "weekly"; }
    const crossesAt = working && minutesLeft != null && minutesLeft > 0 ? iso(now + minutesLeft * MIN) : null;
    if (weekMinutes === 0 && !current) continue;
    out.push({
      employeeId, employeeName: list[list.length - 1].employeeName, working, weekMinutes, todayMinutes,
      weeklyLimitMinutes: weekly, dailyLimitMinutes: daily, state, limit, minutesLeft, crossesAt, projectedWeekMinutes: projected,
    });
  }
  const rank: Record<OvertimeState, number> = { over: 0, near: 1, pace: 2, ok: 3 };
  return out.sort((a, b) => rank[a.state] - rank[b.state] || (a.minutesLeft ?? 0) - (b.minutesLeft ?? 0) || a.employeeName.localeCompare(b.employeeName));
}
