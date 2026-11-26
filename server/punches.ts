// Recording and correcting time-clock punches, and the admin endpoints that
// read them (Live page, payroll import).
import { randomUUID } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { Site } from "@shared/schema";
import { addDays, todayISO } from "@shared/dates";
import {
  type Punch, type PunchEdit, type PunchMeta, type PunchSource, type PunchType, PUNCH_TYPES, STALE_SHIFT_HOURS, byTime, clockState, localRange,
  punchesToShifts, validateChange, workedMinutes,
} from "@shared/punches";
import { db } from "./db";
import { MAX_PUNCH_QUERY } from "./db/types";
import * as settings from "./settings";
import { type StoredEmployee, getEmployee, listEmployees } from "./employees";
import { broadcast } from "./live";
import { applyScheduleRules } from "./schedule";
import { breakDue } from "@shared/kiosk";
import { getSiteConfig } from "./kioskConfig";
import { actorOf, audit } from "./audit";

const DAY = 86_400_000;
export const PUNCH_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export class PunchError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}

const locks = new Map<string, Promise<unknown>>();
/** One change at a time per employee, so a double tap cannot clock someone in twice. */
function withLock<T>(k: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(k) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const tail = next.catch(() => undefined);
  locks.set(k, tail);
  tail.then(() => { if (locks.get(k) === tail) locks.delete(k); });
  return next;
}

/** An employee's punches within a few days of the given instants. */
async function nearbyPunches(siteId: string, employeeId: string, ...instants: string[]): Promise<Punch[]> {
  const times = instants.map((x) => Date.parse(x));
  const from = new Date(Math.min(...times) - 3 * DAY).toISOString();
  const to = new Date(Math.max(...times) + 3 * DAY).toISOString();
  const store = await db();
  return store.listPunches({ siteId, employeeId, from, to });
}

export interface RecordInput {
  id: string;
  site: Site;
  employee: Pick<StoredEmployee, "id" | "name">;
  type: PunchType;
  at: string;
  source: PunchSource;
  deviceId: string | null;
  note?: string;
  audience: "kiosk" | "admin";
  force?: boolean;
  flags?: Punch["flags"];
  meta?: PunchMeta;
}

export async function recordPunch(input: RecordInput): Promise<{ punch: Punch; created: boolean }> {
  if (!PUNCH_ID_RE.test(input.id)) throw new PunchError("Invalid punch id.", 400, "invalid");
  return withLock(`${input.site.id}|${input.employee.id}`, async () => {
    const store = await db();
    const existing = await store.getPunch(input.id);
    if (existing) {
      if (existing.siteId !== input.site.id || existing.employeeId !== input.employee.id) throw new PunchError("That punch id is already used.", 409, "conflict");
      return { punch: existing, created: false };
    }
    const at = new Date(input.at).toISOString();
    const punch: Punch = {
      id: input.id, siteId: input.site.id, employeeId: input.employee.id, employeeName: input.employee.name, type: input.type, at,
      source: input.source, deviceId: input.deviceId, note: input.note ?? "", createdAt: new Date().toISOString(), editedAt: null, edits: [],
      ...(input.flags ? { flags: input.flags } : {}),
      ...(input.meta && Object.keys(input.meta).length ? { meta: input.meta } : {}),
    };
    const before = await nearbyPunches(input.site.id, input.employee.id, at);
    const problem = validateChange(before, [...before, punch], input.site.rules.timezone, input.audience);
    if (problem && !input.force) throw new PunchError(problem, 409, "state");
    const res = await store.insertPunch(punch);
    if (res.created) broadcast({ type: "punch", action: "created", siteId: punch.siteId, punch: res.punch });
    return res;
  });
}

export async function editPunch(id: string, patch: { type?: PunchType; at?: string; note: string; force?: boolean; by?: string | null }): Promise<Punch> {
  const store = await db();
  const cur = await store.getPunch(id);
  if (!cur) throw new PunchError("That punch no longer exists.", 404, "missing");
  const site = await settings.getSite(cur.siteId);
  return withLock(`${cur.siteId}|${cur.employeeId}`, async () => {
    const at = patch.at ? new Date(patch.at).toISOString() : cur.at;
    const next: Punch = { ...cur, type: patch.type ?? cur.type, at };
    const before = await nearbyPunches(cur.siteId, cur.employeeId, cur.at, at);
    const after = before.map((p) => (p.id === id ? next : p));
    const problem = validateChange(before, after, site?.rules.timezone ?? "UTC", "admin");
    if (problem && !patch.force) throw new PunchError(problem, 409, "state");
    const edit: PunchEdit = { editedAt: new Date().toISOString(), note: patch.note, by: patch.by ?? null, before: { type: cur.type, at: cur.at } };
    const saved = await store.updatePunch(id, { type: next.type, at, note: patch.note, editedAt: edit.editedAt, edits: [...cur.edits, edit], flags: cur.flags, meta: cur.meta });
    if (!saved) throw new PunchError("That punch no longer exists.", 404, "missing");
    broadcast({ type: "punch", action: "updated", siteId: saved.siteId, punch: saved });
    return saved;
  });
}

export async function removePunch(id: string, opts: { force?: boolean; note?: string } = {}): Promise<boolean> {
  const store = await db();
  const cur = await store.getPunch(id);
  if (!cur) return false;
  const site = await settings.getSite(cur.siteId);
  return withLock(`${cur.siteId}|${cur.employeeId}`, async () => {
    const before = await nearbyPunches(cur.siteId, cur.employeeId, cur.at);
    const problem = validateChange(before, before.filter((p) => p.id !== id), site?.rules.timezone ?? "UTC", "admin");
    if (problem && !opts.force) throw new PunchError(`Deleting this punch would leave a gap: ${problem}`, 409, "state");
    const ok = await store.deletePunch(id);
    if (ok) {
      console.log(`[timeclock] punch ${cur.id} (${cur.employeeName}, ${cur.type} ${cur.at}) deleted${opts.note ? `: ${opts.note}` : ""}`);
      broadcast({ type: "punch", action: "deleted", siteId: cur.siteId, punch: cur, note: opts.note ?? "" });
    }
    return ok;
  });
}

/**
 * Cancel an employee's open shift: delete its clock-in and any break punches
 * after it, as if they never clocked in. For a clock-in made by mistake, or one
 * left open because the kiosk went offline. Returns the deleted punches.
 */
export async function cancelOpenShift(site: Site, employeeId: string, opts: { note: string; by?: string | null }, now = Date.now()): Promise<Punch[]> {
  return withLock(`${site.id}|${employeeId}`, async () => {
    const store = await db();
    const from = new Date(now - STALE_SHIFT_HOURS * 3600_000 - DAY).toISOString();
    const list = (await store.listPunches({ siteId: site.id, employeeId, from, to: new Date(now + 1).toISOString() })).sort(byTime);
    const st = clockState(list, now);
    if (st.status === "out" || !st.shiftStart) throw new PunchError("They aren't clocked in, so there's nothing to cancel.", 409, "state");
    const shift = list.filter((p) => p.at >= st.shiftStart! && p.type !== "out");
    const removed: Punch[] = [];
    for (const p of shift) {
      if (await store.deletePunch(p.id)) {
        removed.push(p);
        broadcast({ type: "punch", action: "deleted", siteId: p.siteId, punch: p, note: opts.note });
      }
    }
    console.log(`[timeclock] open shift of ${removed[0]?.employeeName ?? employeeId} cancelled (${removed.length} punch(es))${opts.by ? ` by ${opts.by}` : ""}: ${opts.note}`);
    return removed;
  });
}

/**
 * Someone's open shift at this location right now (clocked in or on a break),
 * with the name on their latest punch, or null when they're clocked out. Works
 * for people no longer in the employee list, from their punches alone.
 */
export async function openShift(siteId: string, employeeId: string, now = Date.now()): Promise<{ status: "in" | "break"; name: string; shiftStart: string } | null> {
  const from = new Date(now - STALE_SHIFT_HOURS * 3600_000 - DAY).toISOString();
  const list = (await (await db()).listPunches({ siteId, employeeId, from, to: new Date(now + 1).toISOString() })).sort(byTime);
  const st = clockState(list, now);
  if (st.status === "out" || !st.shiftStart) return null;
  return { status: st.status, name: list[list.length - 1]!.employeeName, shiftStart: st.shiftStart };
}

export interface EmployeeNow {
  id: string;
  name: string;
  role: string;
  active: boolean;
  inDirectory: boolean;
  status: "out" | "in" | "break";
  since: string | null;
  shiftStart: string | null;
  /** Minutes worked on the given local date (open shifts count until now). */
  minutes: number;
  lastPunch: Punch | null;
  /** Station picked at the current shift's clock-in, if any. */
  station?: string | null;
  /** Worked longer than the location's break reminder without a break. */
  breakDue?: boolean;
}

/** Who is working now at a location, and the punches of a local date. */
export async function timeclockDay(site: Site, date: string, now = Date.now()) {
  const tz = site.rules.timezone;
  const day = localRange(date, date, tz);
  const from = new Date(Date.parse(day.from) - STALE_SHIFT_HOURS * 3600_000).toISOString();
  const to = new Date(Math.max(Date.parse(day.to), now) + 1).toISOString();
  const punches = await (await db()).listPunches({ siteId: site.id, from, to });
  const directory = await listEmployees(site.id);
  const breakRule = (await getSiteConfig(site.id)).breakReminderHours;
  const byEmp = new Map<string, Punch[]>();
  for (const p of punches) {
    if (!byEmp.has(p.employeeId)) byEmp.set(p.employeeId, []);
    byEmp.get(p.employeeId)!.push(p);
  }
  const people: EmployeeNow[] = [];
  const seen = new Set<string>();
  const summarize = (id: string, name: string, role: string, active: boolean, inDirectory: boolean) => {
    const list = byEmp.get(id) ?? [];
    const st = clockState(list, now);
    people.push({
      id, name, role, active, inDirectory, status: st.status, since: st.since, shiftStart: st.shiftStart,
      minutes: workedMinutes(list, Date.parse(day.from), Date.parse(day.to), now), lastPunch: st.last,
      station: st.shiftStart ? (list.find((p) => p.type === "in" && p.at === st.shiftStart)?.meta?.station ?? null) : null,
      breakDue: breakDue(list, breakRule, now).due,
    });
    seen.add(id);
  };
  for (const e of directory) summarize(e.id, e.name, e.role, e.active, true);
  for (const [id, list] of byEmp) if (!seen.has(id)) summarize(id, list[list.length - 1].employeeName, "", false, false);
  const dayPunches = punches.filter((p) => p.at >= day.from && p.at < day.to).sort(byTime).reverse();
  return { site: { id: site.id, name: site.name, timezone: tz, timeSource: site.timeSource }, date, now: new Date(now).toISOString(), employees: people, punches: dayPunches };
}

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch((err) => {
    if (err instanceof PunchError) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  });
};
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instant = z.string().refine((s) => Number.isFinite(Date.parse(s)), "Enter a valid date and time.");

async function siteOr404(req: Request, res: Response) {
  const site = await settings.getSite(String(req.params.siteId));
  if (!site) { res.status(404).json({ error: "Location not found." }); return null; }
  return site;
}

function notFuture(at: string) {
  if (Date.parse(at) > Date.now() + 5 * 60_000) throw new PunchError("A punch can't be in the future.", 400, "time");
}

/** Admin endpoints (behind the admin session). */
export function registerPunchRoutes(app: Express) {
  app.get("/api/sites/:siteId/timeclock", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    const date = isoDate.optional().parse(req.query.date) ?? todayISO(site.rules.timezone);
    res.json(await timeclockDay(site, date));
  }));

  app.get("/api/sites/:siteId/punches", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    const { start, end } = z.object({ start: isoDate, end: isoDate }).parse(req.query);
    if (end < start) return res.status(400).json({ error: "The end date is before the start date." });
    const r = localRange(start, end, site.rules.timezone);
    const LIST_MAX = 20000;
    const list = await (await db()).listPunches({ siteId: site.id, from: r.from, to: r.to, limit: LIST_MAX + 1 });
    if (list.length > LIST_MAX) return res.status(413).json({ error: `More than ${LIST_MAX.toLocaleString("en-US")} punches in that range. Choose a shorter date range.`, code: "too_many" });
    res.json(list);
  }));

  /** Shifts built from punches, for creating a timesheet. */
  app.get("/api/sites/:siteId/punches/shifts", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    const { start, end } = z.object({ start: isoDate, end: isoDate }).parse(req.query);
    if (end < start) return res.status(400).json({ error: "The end date is before the start date." });
    if (Date.parse(end) - Date.parse(start) > 400 * DAY) return res.status(400).json({ error: "Choose a range of about a year or less." });
    // Widen the window so shifts that start in range but end after it (or the reverse) pair up.
    const r = localRange(addDays(start, -1), addDays(end, 2), site.rules.timezone);
    const punches = await (await db()).listPunches({ siteId: site.id, from: r.from, to: r.to, limit: MAX_PUNCH_QUERY + 1 });
    // Never build a timesheet from a cut-off list: missing punches would mean missing pay.
    if (punches.length > MAX_PUNCH_QUERY) return res.status(413).json({ error: `More than ${MAX_PUNCH_QUERY.toLocaleString("en-US")} punches in that range. Create the timesheet for a shorter date range.`, code: "too_many" });
    const names = Object.fromEntries((await listEmployees(site.id)).map((e) => [e.id, e.name]));
    res.json(await applyScheduleRules(site, punchesToShifts(punches, { timezone: site.rules.timezone, start, end, names }), start, end));
  }));

  app.post("/api/sites/:siteId/punches", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    const body = z.object({
      employeeId: z.string().min(1).max(64), type: z.enum(PUNCH_TYPES), at: instant,
      note: z.string().trim().min(1, "Add a short note saying why.").max(300), force: z.boolean().optional(),
    }).parse(req.body);
    notFuture(body.at);
    let employee: Pick<StoredEmployee, "id" | "name"> | null | undefined = await getEmployee(site.id, body.employeeId);
    if (!employee) {
      // Removed from the list while still clocked in: a manager can still clock
      // them out, so the hours they worked are paid. Nothing else.
      const open = body.type === "out" ? await openShift(site.id, body.employeeId) : null;
      if (!open) {
        return res.status(404).json({
          error: body.type === "out"
            ? "That person isn't in the employee list and isn't clocked in here."
            : "Employee not found at this location. Someone who has been removed can only be clocked out.",
        });
      }
      employee = { id: body.employeeId, name: open.name };
    }
    const r = await recordPunch({
      id: `adm_${randomUUID().replace(/-/g, "")}`, site, employee, type: body.type, at: body.at, source: "admin", deviceId: null,
      note: body.note, audience: "admin", force: body.force,
    });
    res.json(r.punch);
  }));

  // Cancel someone's current clock-in (and breaks since), e.g. the kiosk went offline.
  app.post("/api/sites/:siteId/employees/:id/cancel-shift", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    const { note } = z.object({ note: z.string().trim().min(1, "Add a short note saying why.").max(300) }).parse(req.body ?? {});
    const employeeId = String(req.params.id);
    const actor = actorOf(req, res);
    const removed = await cancelOpenShift(site, employeeId, { note, by: actor.userName });
    const first = removed[0];
    audit({
      ...actor, action: "punch.cancel-shift", target: `site:${site.id}`,
      detail: `${first?.employeeName ?? employeeId}: clock-in at ${first?.at ?? "?"} cancelled (${removed.length} punch${removed.length === 1 ? "" : "es"} removed). ${note}`,
    });
    res.json({ ok: true, removed: removed.map((p) => ({ id: p.id, type: p.type, at: p.at })) });
  }));

  app.patch("/api/punches/:id", h(async (req, res) => {
    const body = z.object({
      type: z.enum(PUNCH_TYPES).optional(), at: instant.optional(),
      note: z.string().trim().min(1, "Add a short note saying why.").max(300), force: z.boolean().optional(),
    }).parse(req.body);
    if (body.at) notFuture(body.at);
    res.json(await editPunch(String(req.params.id), body));
  }));

  app.delete("/api/punches/:id", h(async (req, res) => {
    const force = req.query.force === "1" || req.body?.force === true;
    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 300) : "";
    res.json({ ok: await removePunch(String(req.params.id), { force, note }) });
  }));
}
