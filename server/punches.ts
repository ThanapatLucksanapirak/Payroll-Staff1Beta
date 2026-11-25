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
import * as settings from "./settings";
import { type StoredEmployee, getEmployee, listEmployees } from "./employees";
import { broadcast } from "./live";
import { applyScheduleRules } from "./schedule";
import { breakDue } from "@shared/kiosk";
import { getSiteConfig } from "./kioskConfig";

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
    res.json(await (await db()).listPunches({ siteId: site.id, from: r.from, to: r.to }));
  }));

  /** Shifts built from punches, for creating a timesheet. */
  app.get("/api/sites/:siteId/punches/shifts", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    const { start, end } = z.object({ start: isoDate, end: isoDate }).parse(req.query);
    if (end < start) return res.status(400).json({ error: "The end date is before the start date." });
    if (Date.parse(end) - Date.parse(start) > 400 * DAY) return res.status(400).json({ error: "Choose a range of about a year or less." });
    // Widen the window so shifts that start in range but end after it (or the reverse) pair up.
    const r = localRange(addDays(start, -1), addDays(end, 2), site.rules.timezone);
    const punches = await (await db()).listPunches({ siteId: site.id, from: r.from, to: r.to, limit: 50000 });
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
    const employee = await getEmployee(site.id, body.employeeId);
    if (!employee) return res.status(404).json({ error: "Employee not found at this location." });
    const r = await recordPunch({
      id: `adm_${randomUUID().replace(/-/g, "")}`, site, employee, type: body.type, at: body.at, source: "admin", deviceId: null,
      note: body.note, audience: "admin", force: body.force,
    });
    res.json(r.punch);
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
