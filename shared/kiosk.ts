// Kiosk features shared by the server, the admin app and the kiosk: which
// action makes sense now (and what to suggest instead), today's hours and
// breaks, break reminders, per-device options, shift notes and fix requests.
// Everything here is pure so it can be unit tested.
import { type ClockStatus, type Punch, type PunchType, PUNCH_TYPES, STALE_SHIFT_HOURS, byTime, clockState, transitionCode } from "./punches";
import { FACE_RETENTION_DEFAULT_DAYS, normalizeFaceRetention } from "./face";

// ── Wrong-action guard ───────────────────────────────────────────────────────
export interface ActionCheck {
  ok: boolean;
  /** "You're already clocked in." */
  message?: string;
  /** "Clock out instead?" */
  question?: string;
  /** The action that makes sense instead. */
  suggest?: PunchType;
}

const SUGGEST_LABEL: Record<PunchType, string> = {
  in: "Clock in instead?",
  break_start: "Start a break instead?",
  break_end: "End your break instead?",
  out: "Clock out instead?",
};

/**
 * Is `type` a sensible next punch for someone whose status is `status`?
 * When it isn't, says why and which action to offer instead.
 */
export function checkAction(status: ClockStatus, type: PunchType): ActionCheck {
  const code = transitionCode(status, type);
  if (!code) return { ok: true };
  const suggest: PunchType = status === "out" ? "in" : status === "break" ? "break_end" : type === "break_end" ? "break_start" : "out";
  const message = {
    already_in: "You're already clocked in.",
    on_break: "You're on a break.",
    not_in: "You're not clocked in.",
    already_on_break: "You're already on a break.",
    not_on_break: "You're not on a break.",
  }[code];
  return { ok: false, message, question: SUGGEST_LABEL[suggest], suggest };
}

// ── Hours and breaks for a day ───────────────────────────────────────────────
const STALE_MS = STALE_SHIFT_HOURS * 3600_000;
const ms = (iso: string) => Date.parse(iso);

export interface DaySummary {
  /** Minutes worked in [fromMs, toMs), breaks excluded; an open shift counts until now. */
  workedMinutes: number;
  /** Minutes on break in [fromMs, toMs); a break in progress counts until now. */
  breakMinutes: number;
  /** Number of breaks started in the window. */
  breaks: number;
}

/** Worked and break minutes between fromMs and toMs (the same pairing rules as the payroll import). */
export function daySummary(punches: Punch[], fromMs: number, toMs: number, nowMs = Date.now()): DaySummary {
  let worked = 0, onBreak = 0, breaks = 0;
  let workingSince: number | null = null;
  let breakSince: number | null = null;
  let shiftStart: number | null = null;
  const clip = (a: number, b: number) => { const s = Math.max(a, fromMs), e = Math.min(b, toMs); return e > s ? e - s : 0; };
  for (const p of [...punches].filter((x) => ms(x.at) <= nowMs).sort(byTime)) {
    const t = ms(p.at);
    if (shiftStart != null && t - shiftStart > STALE_MS) { workingSince = null; breakSince = null; shiftStart = null; }
    if (p.type === "in") {
      if (shiftStart == null) shiftStart = t;
      if (breakSince != null) { onBreak += clip(breakSince, t); breakSince = null; }
      workingSince = t;
    } else if (p.type === "break_start" && workingSince != null) {
      worked += clip(workingSince, t); workingSince = null; breakSince = t;
      if (t >= fromMs && t < toMs) breaks++;
    } else if (p.type === "break_end" && breakSince != null) {
      onBreak += clip(breakSince, t); breakSince = null; workingSince = t;
    } else if (p.type === "out") {
      if (workingSince != null) worked += clip(workingSince, t);
      if (breakSince != null) onBreak += clip(breakSince, t);
      workingSince = null; breakSince = null; shiftStart = null;
    }
  }
  if (shiftStart != null && nowMs - shiftStart <= STALE_MS) {
    if (workingSince != null) worked += clip(workingSince, nowMs);
    if (breakSince != null) onBreak += clip(breakSince, nowMs);
  }
  return { workedMinutes: Math.round(worked / 60000), breakMinutes: Math.round(onBreak / 60000), breaks };
}

// ── Break reminders ──────────────────────────────────────────────────────────
export interface BreakDue {
  due: boolean;
  /** Minutes worked since the shift started or the last break ended (0 when not working). */
  minutesWithoutBreak: number;
  /** When the break becomes (or became) due, if working. */
  dueAt: string | null;
}

/**
 * Has this person worked `afterHours` hours without a break? Only someone who
 * is clocked in (not on a break) can be due. A rule of 0 or null turns it off.
 */
export function breakDue(punches: Punch[], afterHours: number | null | undefined, nowMs = Date.now()): BreakDue {
  const st = clockState(punches, nowMs);
  if (st.status !== "in" || !st.since) return { due: false, minutesWithoutBreak: 0, dueAt: null };
  const minutes = Math.max(0, Math.floor((nowMs - ms(st.since)) / 60000));
  if (!afterHours || afterHours <= 0) return { due: false, minutesWithoutBreak: minutes, dueAt: null };
  const dueAtMs = ms(st.since) + afterHours * 3600_000;
  return { due: nowMs >= dueAtMs, minutesWithoutBreak: minutes, dueAt: new Date(dueAtMs).toISOString() };
}

// ── Per-device options ───────────────────────────────────────────────────────
export const DEVICE_LOGIN_MODES = ["site", "pin", "name_pin"] as const;
export type DeviceLoginMode = (typeof DEVICE_LOGIN_MODES)[number];

export interface KioskDeviceOptions {
  /** Take a front-camera snapshot with each punch. */
  photo: boolean;
  /** Sign-in style; "site" uses the location's setting. */
  loginMode: DeviceLoginMode;
  /** Seconds without a touch before the PIN / action screens go back home. */
  idleSeconds: number;
  /** Ask for a station at clock-in (when the location has stations). */
  stations: boolean;
}

export const DEFAULT_DEVICE_OPTIONS: KioskDeviceOptions = { photo: false, loginMode: "site", idleSeconds: 10, stations: true };
export const IDLE_MIN = 5;
export const IDLE_MAX = 120;

/** Fill in defaults and clamp anything out of range (old or hand-edited data). */
export function normalizeDeviceOptions(raw: unknown): KioskDeviceOptions {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const idle = Number(o.idleSeconds);
  return {
    photo: typeof o.photo === "boolean" ? o.photo : DEFAULT_DEVICE_OPTIONS.photo,
    loginMode: DEVICE_LOGIN_MODES.includes(o.loginMode as DeviceLoginMode) ? (o.loginMode as DeviceLoginMode) : DEFAULT_DEVICE_OPTIONS.loginMode,
    idleSeconds: Number.isFinite(idle) ? Math.min(IDLE_MAX, Math.max(IDLE_MIN, Math.round(idle))) : DEFAULT_DEVICE_OPTIONS.idleSeconds,
    stations: typeof o.stations === "boolean" ? o.stations : DEFAULT_DEVICE_OPTIONS.stations,
  };
}

// ── Per-location kiosk settings ──────────────────────────────────────────────
export interface KioskSiteConfig {
  /** Stations / roles to pick from at clock-in (empty = don't ask). */
  stations: string[];
  /** Remind after this many hours without a break (null = off). */
  breakReminderHours: number | null;
  /** Delete punch photos older than this many days. */
  photoRetentionDays: number;
  /** Delete someone's face data (reference photos and face templates) this many days after their last punch. */
  faceRetentionDays: number;
}

export const DEFAULT_SITE_CONFIG: KioskSiteConfig = { stations: [], breakReminderHours: null, photoRetentionDays: 90, faceRetentionDays: FACE_RETENTION_DEFAULT_DAYS };
export const MAX_STATIONS = 30;

export function cleanStation(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
}

export function normalizeSiteConfig(raw: unknown): KioskSiteConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const stations: string[] = [];
  for (const s of Array.isArray(o.stations) ? o.stations : []) {
    const c = cleanStation(s);
    if (c && !seen.has(c.toLowerCase()) && stations.length < MAX_STATIONS) { seen.add(c.toLowerCase()); stations.push(c); }
  }
  const h = Number(o.breakReminderHours);
  const days = Number(o.photoRetentionDays);
  return {
    stations,
    breakReminderHours: o.breakReminderHours == null || !Number.isFinite(h) || h <= 0 ? null : Math.min(16, Math.round(h * 4) / 4),
    photoRetentionDays: Number.isFinite(days) && days >= 1 ? Math.min(3650, Math.round(days)) : DEFAULT_SITE_CONFIG.photoRetentionDays,
    faceRetentionDays: normalizeFaceRetention(o.faceRetentionDays),
  };
}

/** Is `name` one of the location's stations? Returns its canonical spelling. */
export function matchStation(stations: string[], name: unknown): string | null {
  const c = cleanStation(name).toLowerCase();
  if (!c) return null;
  return stations.find((s) => s.toLowerCase() === c) ?? null;
}

// ── Shift notes ──────────────────────────────────────────────────────────────
export interface ShiftNote {
  id: string;
  text: string;
  /** Empty = everyone at the location. */
  employeeIds: string[];
  createdAt: string;
  createdBy: string;
  /** Stops showing after this instant (null = until removed). */
  expiresAt: string | null;
  acks: { employeeId: string; name: string; at: string }[];
}

export function noteActive(n: ShiftNote, nowMs = Date.now()): boolean {
  return !n.expiresAt || ms(n.expiresAt) > nowMs;
}

/** Notes this employee still has to see (active, meant for them, not acknowledged), oldest first. */
export function notesFor(notes: ShiftNote[], employeeId: string, nowMs = Date.now()): ShiftNote[] {
  return notes
    .filter((n) => noteActive(n, nowMs) && (!n.employeeIds.length || n.employeeIds.includes(employeeId)) && !n.acks.some((a) => a.employeeId === employeeId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Record that an employee saw a note (idempotent). */
export function acknowledge(n: ShiftNote, employeeId: string, name: string, at: string): ShiftNote {
  if (n.acks.some((a) => a.employeeId === employeeId)) return n;
  return { ...n, acks: [...n.acks, { employeeId, name, at }] };
}

/** Drop notes that expired more than `keepDays` ago and keep at most `max` (newest). */
export function pruneNotes(notes: ShiftNote[], nowMs = Date.now(), keepDays = 30, max = 200): ShiftNote[] {
  const cutoff = nowMs - keepDays * 86_400_000;
  return notes.filter((n) => !n.expiresAt || ms(n.expiresAt) > cutoff).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-max);
}

// ── Fix requests ─────────────────────────────────────────────────────────────
export const FIX_STATUSES = ["pending", "approved", "declined"] as const;
export type FixStatus = (typeof FIX_STATUSES)[number];

export interface FixRequest {
  id: string;
  employeeId: string;
  employeeName: string;
  type: PunchType;
  /** When the missed punch should have happened (UTC ISO). */
  at: string;
  note: string;
  createdAt: string;
  deviceId: string | null;
  status: FixStatus;
  decidedAt: string | null;
  decidedBy: string | null;
  /** Why it was declined, or the note used when approving. */
  reason: string;
  /** The punch created on approval. */
  punchId: string | null;
}

/** How far back an employee can ask for a fix from the kiosk. */
export const FIX_MAX_AGE_DAYS = 14;

/** Check the requested time of a fix request. Returns a message, or null when fine. */
export function fixTimeProblem(atMs: number, nowMs = Date.now()): string | null {
  if (!Number.isFinite(atMs)) return "Pick a time.";
  if (atMs > nowMs + 5 * 60_000) return "That time is in the future.";
  if (atMs < nowMs - FIX_MAX_AGE_DAYS * 86_400_000) return `That's more than ${FIX_MAX_AGE_DAYS} days ago. Ask a manager.`;
  return null;
}

/** Keep every pending request; keep decided ones for `keepDays` days, at most `max` in total. */
export function pruneFixRequests(list: FixRequest[], nowMs = Date.now(), keepDays = 60, max = 500): FixRequest[] {
  const cutoff = nowMs - keepDays * 86_400_000;
  const kept = list.filter((r) => r.status === "pending" || !r.decidedAt || ms(r.decidedAt) > cutoff);
  if (kept.length <= max) return kept;
  const pending = kept.filter((r) => r.status === "pending");
  const decided = kept.filter((r) => r.status !== "pending").sort((a, b) => (a.decidedAt ?? "").localeCompare(b.decidedAt ?? ""));
  return [...pending, ...decided.slice(-Math.max(0, max - pending.length))];
}

export const FIX_TYPE_LABELS: Record<PunchType, string> = {
  in: "Forgot to clock in",
  break_start: "Forgot to start a break",
  break_end: "Forgot to end a break",
  out: "Forgot to clock out",
};

export const isPunchType = (t: unknown): t is PunchType => PUNCH_TYPES.includes(t as PunchType);

// ── PIN strength ─────────────────────────────────────────────────────────────
/**
 * Why a new PIN is too easy to guess, or null when it's fine. Rejects one digit
 * repeated (0000), straight runs up or down (1234, 9876, 8901) and a repeated
 * pair (1212). Only applied when a PIN is set, so existing PINs keep working.
 */
export function weakPinReason(pin: string): string | null {
  if (!/^\d+$/.test(pin)) return null;
  const d = [...pin].map(Number);
  if (d.every((x) => x === d[0])) return "That PIN is too easy to guess (one digit repeated). Choose another.";
  const run = (step: number) => d.every((x, i) => i === 0 || x === (d[i - 1] + step + 10) % 10);
  if (run(1) || run(-1)) return "That PIN is too easy to guess (digits in a row). Choose another.";
  if (d.length % 2 === 0 && d.length >= 4 && d.every((x, i) => x === d[i % 2])) return "That PIN is too easy to guess (a repeated pair). Choose another.";
  return null;
}

// ── Photos ───────────────────────────────────────────────────────────────────
/** Largest photo accepted from a kiosk (bytes, after base64 decoding). */
export const MAX_PHOTO_BYTES = 200_000;

/** Is a file last written at `mtimeMs` past the retention period? */
export function photoExpired(mtimeMs: number, retentionDays: number, nowMs = Date.now()): boolean {
  return nowMs - mtimeMs > Math.max(1, retentionDays) * 86_400_000;
}
