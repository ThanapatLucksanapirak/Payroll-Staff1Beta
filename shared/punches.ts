// Time-clock punches: the state machine, validation, and the pure conversion
// from punches to payroll shifts. Shared by the server, the admin app and the
// kiosk so every part applies the same rules.
import { z } from "zod";
import type { Shift } from "./schema";
import { formatDate, formatTime, instantToLocal, localToInstant } from "./dates";
import { normalizeName } from "./engine";

export const PUNCH_TYPES = ["in", "break_start", "break_end", "out"] as const;
export type PunchType = (typeof PUNCH_TYPES)[number];
export const PUNCH_SOURCES = ["kiosk", "admin"] as const;
export type PunchSource = (typeof PUNCH_SOURCES)[number];

export const PUNCH_LABELS: Record<PunchType, string> = {
  in: "Clock in",
  break_start: "Start break",
  break_end: "End break",
  out: "Clock out",
};
/** Past tense, e.g. "clocked in at 9:02 AM". */
export const PUNCH_DONE: Record<PunchType, string> = {
  in: "clocked in",
  break_start: "on break from",
  break_end: "back from break at",
  out: "clocked out",
};

export type ClockStatus = "out" | "in" | "break";

/** An open shift older than this is treated as forgotten: the employee can clock in again. */
export const STALE_SHIFT_HOURS = 16;
const STALE_MS = STALE_SHIFT_HOURS * 3600_000;

export interface PunchEdit {
  editedAt: string;
  note: string;
  by?: string | null;
  before: { type: PunchType; at: string } | null;
}

/**
 * Extra markers kept in the punch's meta (optional; older punches have none).
 * autoClosed: the server added this clock-out (or break end) because the shift
 * was left open past the location's auto clock-out time.
 */
export interface PunchFlags {
  autoClosed?: { reason: "cutoff" | "max_shift"; closedAt: string };
}

export interface Punch {
  id: string;
  siteId: string;
  employeeId: string;
  employeeName: string;
  type: PunchType;
  /** UTC ISO instant. */
  at: string;
  source: PunchSource;
  deviceId: string | null;
  note: string;
  createdAt: string;
  editedAt: string | null;
  edits: PunchEdit[];
  flags?: PunchFlags;
  /** Optional extras kept in the row's meta_json (older punches have none). */
  meta?: PunchMeta;
}

/** Extra details stored with a punch. Unknown keys are kept as they are. */
export interface PunchMeta {
  /** Station / role picked at clock-in. */
  station?: string;
  /** Kiosk photo: "saved" when a snapshot was stored, "none" when the camera was unavailable. */
  photo?: "saved" | "none";
  /**
   * A punch saved offline, kept but flagged for a manager: "missing" when it has
   * no photo (Live: "No photo") or its photo showed no face ("No face"),
   * "unchecked" ("Not checked") when the server's face
   * check couldn't run on its photo, "mismatch" ("Face didn't match") when
   * face match is on for the person and the face in the photo wasn't theirs.
   */
  face?: "missing" | "unchecked" | "mismatch";
  /** Face match: distance from the person's closest reference photo (lower is closer; 0.5 or less matches). */
  faceMatch?: number;
  /** The kiosk fix request this punch was created from. */
  fixRequestId?: string;
  [key: string]: unknown;
}

/** Validates a punch read from a backup file. */
export const punchSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  siteId: z.string().min(1).max(100),
  employeeId: z.string().min(1).max(64),
  employeeName: z.string().min(1).max(120),
  type: z.enum(PUNCH_TYPES),
  at: z.string().refine((s) => Number.isFinite(Date.parse(s))).transform((s) => new Date(s).toISOString()),
  source: z.enum(PUNCH_SOURCES).catch("kiosk"),
  deviceId: z.string().nullable().default(null),
  note: z.string().max(500).default(""),
  createdAt: z.string().default(() => new Date().toISOString()),
  editedAt: z.string().nullable().default(null),
  edits: z.array(z.any()).default([]),
  flags: z.object({
    autoClosed: z.object({ reason: z.enum(["cutoff", "max_shift"]).catch("cutoff"), closedAt: z.string() }).optional(),
  }).optional().catch(undefined),
  meta: z.record(z.string(), z.unknown()).optional().catch(undefined),
});

export function statusAfter(type: PunchType): ClockStatus {
  return type === "out" ? "out" : type === "break_start" ? "break" : "in";
}

export function allowedActions(status: ClockStatus): PunchType[] {
  if (status === "in") return ["break_start", "out"];
  if (status === "break") return ["break_end", "out"];
  return ["in"];
}

const ms = (iso: string) => Date.parse(iso);
export const byTime = (a: Pick<Punch, "at" | "id">, b: Pick<Punch, "at" | "id">) => ms(a.at) - ms(b.at) || a.id.localeCompare(b.id);

export interface EmployeeClock {
  status: ClockStatus;
  /** When the current shift started (status in/break). */
  shiftStart: string | null;
  /** When the current status began. */
  since: string | null;
  last: Punch | null;
  /** The last punch left a shift open for longer than STALE_SHIFT_HOURS. */
  stale: boolean;
}

/** The clock state of one employee at `atMs`, from their punches (any order). */
export function clockState(punches: Punch[], atMs = Date.now()): EmployeeClock {
  const sorted = punches.filter((p) => ms(p.at) <= atMs).sort(byTime);
  let status: ClockStatus = "out";
  let shiftStart: string | null = null;
  let since: string | null = null;
  for (const p of sorted) {
    if (status !== "out" && shiftStart && ms(p.at) - ms(shiftStart) > STALE_MS) { status = "out"; shiftStart = null; }
    if (p.type === "in") { status = "in"; shiftStart = p.at; since = p.at; }
    else if (p.type === "break_start" && status === "in") { status = "break"; since = p.at; }
    else if (p.type === "break_end" && status === "break") { status = "in"; since = p.at; }
    else if (p.type === "out" && status !== "out") { status = "out"; shiftStart = null; since = p.at; }
  }
  const last = sorted[sorted.length - 1] ?? null;
  if (status !== "out" && shiftStart && atMs - ms(shiftStart) > STALE_MS) {
    return { status: "out", shiftStart: null, since: null, last, stale: true };
  }
  return { status, shiftStart: status === "out" ? null : shiftStart, since, last, stale: false };
}

export type TransitionCode = "already_in" | "on_break" | "not_in" | "already_on_break" | "not_on_break";

export function transitionCode(status: ClockStatus, type: PunchType): TransitionCode | null {
  if (type === "in") return status === "in" ? "already_in" : status === "break" ? "on_break" : null;
  if (type === "break_start") return status === "out" ? "not_in" : status === "break" ? "already_on_break" : null;
  if (type === "break_end") return status === "out" ? "not_in" : status === "in" ? "not_on_break" : null;
  return status === "out" ? "not_in" : null; // clocking out from a break ends the break
}

/** Messages for the person at the kiosk. */
export const KIOSK_MESSAGES: Record<TransitionCode, string> = {
  already_in: "You're already clocked in.",
  on_break: "You're on a break. End your break first.",
  not_in: "You're not clocked in yet.",
  already_on_break: "You're already on a break.",
  not_on_break: "You're not on a break.",
};
/** Messages for an administrator fixing punches. */
const ADMIN_MESSAGES: Record<TransitionCode, string> = {
  already_in: "they were already clocked in",
  on_break: "they were on a break (end the break first)",
  not_in: "they were not clocked in",
  already_on_break: "they were already on a break",
  not_on_break: "they were not on a break",
};

export interface SequenceIssue { punchId: string; code: TransitionCode }

/** Walk one employee's punches and report every punch that does not follow from the one before. */
export function sequenceIssues(punches: Punch[]): SequenceIssue[] {
  const out: SequenceIssue[] = [];
  let status: ClockStatus = "out";
  let shiftStart: number | null = null;
  for (const p of [...punches].sort(byTime)) {
    const t = ms(p.at);
    if (status !== "out" && shiftStart != null && t - shiftStart > STALE_MS) { status = "out"; shiftStart = null; }
    const code = transitionCode(status, p.type);
    if (code) { out.push({ punchId: p.id, code }); continue; }
    status = statusAfter(p.type);
    if (p.type === "in") shiftStart = t;
    if (status === "out") shiftStart = null;
  }
  return out;
}

/**
 * Check a change to one employee's punches. Returns the first new problem the
 * change introduces (problems that were already there are ignored), or null.
 */
export function validateChange(before: Punch[], after: Punch[], timezone: string, audience: "kiosk" | "admin" = "admin"): string | null {
  const had = new Set(sequenceIssues(before).map((i) => `${i.punchId}|${i.code}`));
  const issue = sequenceIssues(after).find((i) => !had.has(`${i.punchId}|${i.code}`));
  if (!issue) return null;
  if (audience === "kiosk") return KIOSK_MESSAGES[issue.code];
  const p = after.find((x) => x.id === issue.punchId)!;
  const local = instantToLocal(p.at, timezone);
  return `${PUNCH_LABELS[p.type]} at ${formatTime(local.minutes)} on ${formatDate(local.date)} doesn't fit: ${ADMIN_MESSAGES[issue.code]}.`;
}

/** Minutes worked (excluding breaks) between fromMs and toMs; an open shift counts until nowMs. */
export function workedMinutes(punches: Punch[], fromMs: number, toMs: number, nowMs = Date.now()): number {
  let total = 0;
  let workingSince: number | null = null;
  let shiftStart: number | null = null;
  const add = (a: number, b: number) => { const s = Math.max(a, fromMs), e = Math.min(b, toMs); if (e > s) total += e - s; };
  for (const p of [...punches].sort(byTime)) {
    const t = ms(p.at);
    if (shiftStart != null && t - shiftStart > STALE_MS) { workingSince = null; shiftStart = null; }
    if (p.type === "in") { if (shiftStart == null) shiftStart = t; workingSince = t; }
    else if (p.type === "break_start" && workingSince != null) { add(workingSince, t); workingSince = null; }
    else if (p.type === "break_end" && shiftStart != null && workingSince == null) workingSince = t;
    else if (p.type === "out") { if (workingSince != null) add(workingSince, t); workingSince = null; shiftStart = null; }
  }
  if (workingSince != null && shiftStart != null && nowMs - shiftStart <= STALE_MS) add(workingSince, nowMs);
  return Math.round(total / 60000);
}

export interface PunchShiftOptions {
  timezone: string;
  /** Only keep shifts whose local start date is in [start, end] (ISO dates). */
  start?: string;
  end?: string;
  /** Current names by employee id (punches keep the name they were made with). */
  names?: Record<string, string>;
  now?: number;
}

export interface PunchShiftResult {
  shifts: Shift[];
  warnings: string[];
  open: { employeeId: string; employee: string; since: string }[];
}

const MAX_END = 4320;

/**
 * Pair clock-ins with clock-outs and turn them into payroll shifts in the
 * location's time zone. Breaks become breakMinutes; a shift belongs to the date
 * it started on, so overnight shifts end after 1440 (midnight). Open shifts
 * (no clock-out) are skipped and reported as warnings.
 */
export function punchesToShifts(punches: Punch[], opts: PunchShiftOptions): PunchShiftResult {
  const tz = opts.timezone;
  const now = opts.now ?? Date.now();
  const shifts: Shift[] = [];
  const warnings: string[] = [];
  const open: PunchShiftResult["open"] = [];
  const inRange = (date: string) => (!opts.start || date >= opts.start) && (!opts.end || date <= opts.end);
  const when = (iso: string) => { const l = instantToLocal(iso, tz); return `${formatDate(l.date)} at ${formatTime(l.minutes)}`; };

  const byEmp = new Map<string, Punch[]>();
  for (const p of punches) {
    const k = p.employeeId || normalizeName(p.employeeName).toLowerCase();
    if (!byEmp.has(k)) byEmp.set(k, []);
    byEmp.get(k)!.push(p);
  }

  for (const [empId, list] of byEmp) {
    list.sort(byTime);
    const name = normalizeName(opts.names?.[empId] || list[list.length - 1].employeeName) || "Unknown";
    let cur: { start: Punch; breakMs: number; breakStart: number | null; edited: boolean } | null = null;

    const closeOpen = (reason: "new_in" | "end") => {
      if (!cur) return;
      const l = instantToLocal(cur.start.at, tz);
      if (inRange(l.date)) {
        const stillIn = reason === "end" && now - ms(cur.start.at) <= STALE_MS;
        open.push({ employeeId: empId, employee: name, since: cur.start.at });
        warnings.push(stillIn
          ? `${name} is still clocked in (since ${when(cur.start.at)}); that shift is not included yet.`
          : `${name} clocked in ${when(cur.start.at)} with no clock-out; that shift was skipped. Fix the punch on the Live page, or add the shift by hand.`);
      }
      cur = null;
    };
    const orphan = (p: Punch, what: string) => {
      const l = instantToLocal(p.at, tz);
      if (inRange(l.date)) warnings.push(`${name}: ${what} on ${when(p.at)} without a clock-in was ignored.`);
    };

    for (const p of list) {
      const t = ms(p.at);
      if (cur && t - ms(cur.start.at) > STALE_MS && p.type !== "out") closeOpen("new_in");
      if (p.type === "in") {
        if (cur) closeOpen("new_in");
        cur = { start: p, breakMs: 0, breakStart: null, edited: p.source === "admin" || !!p.editedAt };
        continue;
      }
      if (!cur) { orphan(p, PUNCH_LABELS[p.type].toLowerCase()); continue; }
      if (p.source === "admin" || p.editedAt) cur.edited = true;
      if (p.type === "break_start") { if (cur.breakStart == null) cur.breakStart = t; continue; }
      if (p.type === "break_end") { if (cur.breakStart != null) { cur.breakMs += t - cur.breakStart; cur.breakStart = null; } continue; }
      // out
      if (cur.breakStart != null) { cur.breakMs += t - cur.breakStart; cur.breakStart = null; }
      const local = instantToLocal(cur.start.at, tz);
      const startMin = Math.floor(ms(cur.start.at) / 60000);
      const duration = Math.max(1, Math.floor(t / 60000) - startMin);
      let end = local.minutes + duration;
      if (inRange(local.date)) {
        if (end > MAX_END) {
          warnings.push(`${name}: the shift starting ${when(cur.start.at)} is longer than the app can store; it was cut at ${MAX_END / 60 - 24} hours past midnight of the next day.`);
          end = MAX_END;
        }
        shifts.push({
          id: `ki_${cur.start.id}`,
          employee: name,
          date: local.date,
          start: local.minutes,
          end,
          breakMinutes: Math.min(Math.round(cur.breakMs / 60000), duration),
          role: "",
          source: "kiosk",
          note: cur.edited ? "Includes an edited punch" : "",
        });
      }
      cur = null;
    }
    closeOpen("end");
  }
  shifts.sort((a, b) => a.date.localeCompare(b.date) || a.employee.localeCompare(b.employee) || a.start - b.start);
  return { shifts, warnings, open };
}

/** UTC range covering local dates [start, end] in a time zone, widened by `padHours` on each side. */
export function localRange(start: string, end: string, timezone: string, padHours = 0): { from: string; to: string } {
  const from = new Date(Date.parse(localToInstant(start, 0, timezone)) - padHours * 3600_000).toISOString();
  const endNext = localToInstant(end, 1440, timezone);
  const to = new Date(Date.parse(endNext) + padHours * 3600_000).toISOString();
  return { from, to };
}
