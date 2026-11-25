// Weekly schedules, time off, late / no-show alerts, labor vs. sales and the
// payroll forecast. Everything is stored as JSON in app settings:
//   schedule:<siteId>:<weekStart>   one week of shifts (+ published flag)
//   timeoff:<siteId>                time-off entries (owner-entered now, employee requests later)
//   schedule-settings:<siteId>      grace minutes, no-show and early clock-in rule
//   sales:<siteId>:<YYYY-MM>        manual daily sales, by date
import { randomUUID } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { Shift, Site } from "@shared/schema";
import { addDays, daysBetween, instantToLocal, isISODate, todayISO } from "@shared/dates";
import { computePayroll } from "@shared/engine";
import { rowToDoc } from "@shared/legacy";
import { STALE_SHIFT_HOURS, localRange, punchesToShifts } from "@shared/punches";
import {
  type ScheduleApiResponse, type ScheduleSettings, type ScheduleWeek, type ScheduledShift, type TimeOff, DEFAULT_SCHEDULE_SETTINGS,
  TIME_OFF_STATUSES, applyEarlyClockIn, copyShifts, parseTimeOff, parseWeek, scheduleAlerts, scheduleKey, scheduleSettingsKey,
  scheduleSettingsSchema, scheduledShiftSchema, sortShifts, timeOffKey, timeOffOn, timeOffSchema, weekDates, weekStartOf, weeksCovering,
} from "@shared/schedule";
import { type DayCost, dailyFromEmployees, forecastPayroll, laborFromShifts, laborReport, mergeSales } from "@shared/labor";
import { db } from "./db";
import * as settings from "./settings";
import { listEmployees } from "./employees";
import { broadcast } from "./live";
import { actorOf, audit } from "./audit";
import { SquareError, pullDailySales } from "./square";

const isoDate = z.string().refine(isISODate, "Use a YYYY-MM-DD date.");
const DAY = 86_400_000;

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** One read-modify-write at a time per key. */
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(k: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(k) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const tail = next.catch(() => undefined);
  locks.set(k, tail);
  tail.then(() => { if (locks.get(k) === tail) locks.delete(k); });
  return next;
}

const newId = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const userName = (res: Response) => { const u = res.locals.user; return u ? (u.displayName || u.username) : null; };

// ── Storage ──────────────────────────────────────────────────────────────────
export async function getWeek(siteId: string, weekStart: string): Promise<ScheduleWeek> {
  const store = await db();
  return parseWeek(parseJson(await store.getSetting(scheduleKey(siteId, weekStart))), siteId, weekStart);
}

async function saveWeek(w: ScheduleWeek) {
  const store = await db();
  if (!w.shifts.length && !w.publishedAt) await store.deleteSetting(scheduleKey(w.siteId, w.weekStart)).catch(() => undefined);
  else await store.setSetting(scheduleKey(w.siteId, w.weekStart), JSON.stringify(w));
}

/** Every scheduled shift on local dates [from, to]. */
export async function shiftsBetween(site: Site, from: string, to: string): Promise<{ shifts: ScheduledShift[]; weeks: ScheduleWeek[] }> {
  const starts = weeksCovering(from, to, site.rules.weekStartsOn);
  const store = await db();
  const raw = await store.getSettings(starts.map((w) => scheduleKey(site.id, w)));
  const weeks = starts.map((w) => parseWeek(parseJson(raw[scheduleKey(site.id, w)]), site.id, w));
  const shifts = weeks.flatMap((w) => w.shifts).filter((s) => s.date >= from && s.date <= to);
  return { shifts: sortShifts(shifts), weeks };
}

export async function getTimeOff(siteId: string): Promise<TimeOff[]> {
  return parseTimeOff(parseJson(await (await db()).getSetting(timeOffKey(siteId))));
}

/**
 * Change a location's time off under the same lock as the Schedule routes
 * (used by the employee portal). `fn` returns the new list (or null to leave
 * it unchanged) and a result.
 */
export async function updateTimeOff<T>(siteId: string, fn: (list: TimeOff[]) => { next: TimeOff[] | null; result: T }): Promise<T> {
  return withLock(timeOffKey(siteId), async () => {
    const { next, result } = fn(await getTimeOff(siteId));
    if (next) await (await db()).setSetting(timeOffKey(siteId), JSON.stringify(next));
    return result;
  });
}

export async function getScheduleSettings(siteId: string): Promise<ScheduleSettings> {
  const p = scheduleSettingsSchema.safeParse(parseJson(await (await db()).getSetting(scheduleSettingsKey(siteId))) ?? {});
  return p.success ? p.data : DEFAULT_SCHEDULE_SETTINGS;
}

const salesKey = (siteId: string, month: string) => `sales:${siteId}:${month}`;
function monthsOf(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  for (let i = 0; i < 40; i++) {
    const k = `${y}-${String(m).padStart(2, "0")}`;
    if (k > to.slice(0, 7)) break;
    out.push(k);
    m++; if (m === 13) { m = 1; y++; }
  }
  return out;
}

async function manualSales(siteId: string, from: string, to: string): Promise<Record<string, number>> {
  const months = monthsOf(from, to);
  const raw = await (await db()).getSettings(months.map((m) => salesKey(siteId, m)));
  const out: Record<string, number> = {};
  for (const m of months) {
    const v = parseJson(raw[salesKey(siteId, m)]);
    if (!v || typeof v !== "object") continue;
    for (const [d, amt] of Object.entries(v as Record<string, unknown>)) {
      if (isISODate(d) && d >= from && d <= to && typeof amt === "number" && Number.isFinite(amt)) out[d] = amt;
    }
  }
  return out;
}

// ── Punches → payroll: early clock-in rule ───────────────────────────────────
interface ShiftResult { shifts: Shift[]; warnings: string[]; open: { employeeId: string; employee: string; since: string }[] }

/**
 * Apply the location's early clock-in rule to shifts built from punches. Only
 * days that have a schedule are touched, and the rule is off by default.
 */
export async function applyScheduleRules<T extends ShiftResult>(site: Site, result: T, start: string, end: string): Promise<T> {
  try {
    const st = await getScheduleSettings(site.id);
    if (!st.earlyClockIn.enabled || !result.shifts.length) return result;
    const { shifts } = await shiftsBetween(site, start, end);
    if (!shifts.length) return result;
    const names = Object.fromEntries((await listEmployees(site.id)).map((e) => [e.id, e.name]));
    const scheduled = shifts.map((s) => ({ ...s, employeeName: (s.employeeId && names[s.employeeId]) || s.employeeName }));
    const prefs = await settings.getPrefs();
    const r = applyEarlyClockIn(result.shifts, scheduled, st.earlyClockIn, prefs.timeFormat);
    return { ...result, shifts: r.shifts, warnings: [...result.warnings, ...r.warnings] };
  } catch (err) {
    console.error("[schedule] early clock-in rule skipped:", err);
    return result;
  }
}

/** Shifts from punches for local dates [start, end], with the schedule rules applied. */
async function punchShifts(site: Site, start: string, end: string): Promise<ShiftResult> {
  const r = localRange(addDays(start, -1), addDays(end, 2), site.rules.timezone);
  const punches = await (await db()).listPunches({ siteId: site.id, from: r.from, to: r.to, limit: 50000 });
  const names = Object.fromEntries((await listEmployees(site.id)).map((e) => [e.id, e.name]));
  return applyScheduleRules(site, punchesToShifts(punches, { timezone: site.rules.timezone, start, end, names }), start, end);
}

/** Saved timesheets' shifts and daily pay for dates in range (final ones first, then most recent). */
async function timesheetDays(site: Site, from: string, to: string): Promise<{ days: Record<string, DayCost>; shifts: Shift[] }> {
  const store = await db();
  const def = await settings.defaultSiteId();
  const list = (await store.listTimesheets())
    .filter((t) => !t.deletedAt && (t.siteId ?? def) === site.id && t.periodStart && t.periodEnd && t.periodEnd >= from && t.periodStart <= to)
    .sort((a, b) => (a.status === "final" ? 0 : 1) - (b.status === "final" ? 0 : 1) || (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
    .slice(0, 30);
  if (!list.length) return { days: {}, shifts: [] };
  const categories = await settings.getCategories();
  const days: Record<string, DayCost> = {};
  const shifts: Shift[] = [];
  const taken = new Set<string>();
  for (const t of list) {
    try {
      const row = await store.getTimesheet(t.id);
      if (!row) continue;
      const doc = rowToDoc(row, { defaultSiteId: site.id, rules: site.rules });
      const r = computePayroll({ shifts: doc.shifts, employees: doc.employees, manualEmployees: [], categories, rules: doc.rules });
      const daily = dailyFromEmployees(r.employees, from, to);
      for (const [d, v] of Object.entries(daily)) if (!taken.has(d)) days[d] = v;
      for (const s of doc.shifts) if (s.date >= from && s.date <= to && !taken.has(s.date)) shifts.push(s);
      for (const d of Object.keys(daily)) taken.add(d);
      for (const s of doc.shifts) taken.add(s.date);
    } catch { /* unreadable row: skip */ }
  }
  return { days, shifts };
}

// ── Square sales (cached briefly) ────────────────────────────────────────────
const salesCache = new Map<string, { at: number; data: Record<string, number> }>();
const SALES_TTL = 5 * 60_000;

export interface SquareSalesStatus { connected: boolean; ok: boolean; message: string | null }

async function squareSales(site: Site, from: string, to: string): Promise<{ data: Record<string, number>; status: SquareSalesStatus }> {
  const token = await settings.getSquareToken(site.id);
  if (!token) return { data: {}, status: { connected: false, ok: false, message: null } };
  const today = todayISO(site.rules.timezone);
  const end = to > today ? today : to;
  if (end < from) return { data: {}, status: { connected: true, ok: true, message: null } };
  const k = `${site.id}|${site.squareLocationId}|${from}|${end}`;
  const hit = salesCache.get(k);
  if (hit && Date.now() - hit.at < SALES_TTL) return { data: hit.data, status: { connected: true, ok: true, message: null } };
  try {
    const data = await pullDailySales(token, { locationId: site.squareLocationId || undefined, start: from, end, timezone: site.rules.timezone });
    if (salesCache.size > 200) salesCache.clear();
    salesCache.set(k, { at: Date.now(), data });
    return { data, status: { connected: true, ok: true, message: null } };
  } catch (err: any) {
    const scope = err instanceof SquareError && (err.code === "INSUFFICIENT_SCOPES" || err.code === "FORBIDDEN");
    const message = scope
      ? "Your Square token can't read sales. Give it the Orders (read) permission in the Square Developer Dashboard, or enter daily sales by hand."
      : `Couldn't get sales from Square (${err?.message ?? "unknown error"}). You can enter daily sales by hand.`;
    return { data: {}, status: { connected: true, ok: false, message } };
  }
}

/** Labor cost vs. sales per date. */
export async function laborBetween(site: Site, from: string, to: string) {
  const [ts, sq, manual] = await Promise.all([timesheetDays(site, from, to), squareSales(site, from, to), manualSales(site.id, from, to)]);
  let fromPunches: Record<string, DayCost> = {};
  let missingRates: string[] = [];
  if (site.timeSource !== "square") {
    const ps = await punchShifts(site, from, to);
    const rates = { employees: await settings.getWageProfile(site.id), categories: await settings.getCategories(), rules: site.rules };
    const est = laborFromShifts(ps.shifts, rates, from, to);
    fromPunches = est.days;
    missingRates = est.missingRates;
  }
  const report = laborReport({ from, to, fromTimesheets: ts.days, fromPunches, sales: mergeSales(sq.data, manual) });
  return { ...report, square: sq.status, missingRates };
}

/** Projected payroll for a pay period. */
export async function forecastFor(site: Site, start: string, end: string, now = Date.now()) {
  const tz = site.rules.timezone;
  const local = instantToLocal(new Date(now), tz);
  const today = local.date;
  const directory = await listEmployees(site.id);
  const names = Object.fromEntries(directory.map((e) => [e.id, e.name]));
  let actual: Shift[] = [];
  let open: { employee: string; date: string; start: number }[] = [];
  let basis: "punches" | "timesheets" = "punches";
  const upTo = today < end ? today : end;
  if (today >= start) {
    if (site.timeSource !== "square") {
      const ps = await punchShifts(site, start, upTo);
      actual = ps.shifts;
      open = ps.open
        .filter((o) => now - Date.parse(o.since) <= STALE_SHIFT_HOURS * 3600_000)
        .map((o) => { const l = instantToLocal(o.since, tz); return { employee: o.employee, date: l.date, start: l.minutes }; });
    } else {
      basis = "timesheets";
      actual = (await timesheetDays(site, start, upTo)).shifts;
    }
  }
  const [{ shifts: scheduled }, timeOff, employees, categories] = await Promise.all([
    shiftsBetween(site, start, end), getTimeOff(site.id), settings.getWageProfile(site.id), settings.getCategories(),
  ]);
  const f = forecastPayroll({ period: { start, end }, today, nowMinutes: local.minutes, actual, open, scheduled, timeOff, names, employees, categories, rules: site.rules });
  return { ...f, basis, today };
}

// ── Routes ───────────────────────────────────────────────────────────────────
async function siteOr404(id: unknown): Promise<Site> {
  const site = await settings.getSite(String(id ?? ""));
  if (!site) throw fail(404, "Location not found.");
  return site;
}

const weekShiftInput = z.object({
  id: z.string().max(64).optional(),
  employeeId: z.string().max(64).default(""),
  employeeName: z.string().trim().min(1, "Choose who works this shift.").max(120),
  date: isoDate,
  start: z.number().int().min(0).max(1439),
  end: z.number().int().min(1).max(2880),
  station: z.string().trim().max(60).default(""),
  note: z.string().trim().max(200).default(""),
});

function rangeOf(req: Request, maxDays = 400) {
  const q = z.object({ from: isoDate, to: isoDate }).parse(req.query);
  if (q.to < q.from) throw fail(400, "The end date is before the start date.");
  if (daysBetween(q.from, q.to) > maxDays) throw fail(400, `Choose a range of ${maxDays} days or less.`);
  return q;
}

export function registerScheduleRoutes(app: Express) {
  // Read-only schedule for a date range (the employee portal will use this).
  app.get("/api/schedule", h(async (req, res) => {
    const site = await siteOr404(req.query.siteId);
    const { from, to } = rangeOf(req, 92);
    const { shifts, weeks } = await shiftsBetween(site, from, to);
    const published = new Map(weeks.map((w) => [w.weekStart, !!w.publishedAt]));
    const timeOff = (await getTimeOff(site.id)).filter((t) => t.end >= from && t.start <= to);
    const body: ScheduleApiResponse = {
      siteId: site.id, from, to, timezone: site.rules.timezone, weekStartsOn: site.rules.weekStartsOn,
      shifts: shifts.map((s) => { const w = weekStartOf(s.date, site.rules.weekStartsOn); return { ...s, weekStart: w, published: published.get(w) ?? false }; }),
      timeOff,
      weeks: weeks.map((w) => ({ weekStart: w.weekStart, publishedAt: w.publishedAt, changedSincePublish: w.changedSincePublish })),
    };
    res.json(body);
  }));

  // One week for the Schedule page.
  app.get("/api/sites/:siteId/schedule/week", h(async (req, res) => {
    const site = await siteOr404(req.params.siteId);
    const start = weekStartOf(isoDate.parse(req.query.start ?? todayISO(site.rules.timezone)), site.rules.weekStartsOn);
    const end = addDays(start, 6);
    const [week, prev, timeOff, directory, st] = await Promise.all([
      getWeek(site.id, start), getWeek(site.id, addDays(start, -7)), getTimeOff(site.id), listEmployees(site.id), getScheduleSettings(site.id),
    ]);
    res.json({
      week,
      dates: weekDates(start),
      previousWeekShifts: prev.shifts.length,
      timeOff: timeOff.filter((t) => t.end >= start && t.start <= end),
      employees: directory.map((e) => ({ id: e.id, name: e.name, role: e.role, active: e.active })).sort((a, b) => a.name.localeCompare(b.name)),
      settings: st,
    });
  }));

  // Save a whole week (the page sends the full list after each change).
  app.put("/api/sites/:siteId/schedule/week/:weekStart", h(async (req, res) => {
    const site = await siteOr404(req.params.siteId);
    const weekStart = isoDate.parse(req.params.weekStart);
    if (weekStartOf(weekStart, site.rules.weekStartsOn) !== weekStart) throw fail(400, "That date is not the first day of a week here.");
    const body = z.object({ shifts: z.array(weekShiftInput).max(2000), baseUpdatedAt: z.string().nullable().optional() }).parse(req.body);
    const dates = new Set(weekDates(weekStart));
    const shifts = body.shifts.map((s) => {
      if (!dates.has(s.date)) throw fail(400, "A shift is outside this week.");
      return scheduledShiftSchema.parse({ ...s, id: s.id && /^[A-Za-z0-9_-]{1,64}$/.test(s.id) ? s.id : newId("sh") });
    });
    const saved = await withLock(scheduleKey(site.id, weekStart), async () => {
      const cur = await getWeek(site.id, weekStart);
      if (body.baseUpdatedAt !== undefined && (cur.updatedAt ?? null) !== (body.baseUpdatedAt ?? null)) {
        throw fail(409, "Someone else changed this week. Reload to see the latest schedule.");
      }
      const next: ScheduleWeek = { ...cur, shifts: sortShifts(shifts), changedSincePublish: !!cur.publishedAt, updatedAt: new Date().toISOString(), updatedBy: userName(res) };
      await saveWeek(next);
      return next;
    });
    audit({ ...actorOf(req, res), action: "schedule.update", target: `site:${site.id}`, detail: `week of ${weekStart}, ${saved.shifts.length} shifts` });
    broadcast({ type: "schedule", siteId: site.id, weekStart });
    res.json(saved);
  }));

  app.post("/api/sites/:siteId/schedule/week/:weekStart/copy-previous", h(async (req, res) => {
    const site = await siteOr404(req.params.siteId);
    const weekStart = isoDate.parse(req.params.weekStart);
    if (weekStartOf(weekStart, site.rules.weekStartsOn) !== weekStart) throw fail(400, "That date is not the first day of a week here.");
    const { replace } = z.object({ replace: z.boolean().default(false) }).parse(req.body ?? {});
    const prevStart = addDays(weekStart, -7);
    const prev = await getWeek(site.id, prevStart);
    if (!prev.shifts.length) throw fail(400, "Last week has no shifts to copy.");
    const timeOff = await getTimeOff(site.id);
    const saved = await withLock(scheduleKey(site.id, weekStart), async () => {
      const cur = await getWeek(site.id, weekStart);
      if (cur.shifts.length && !replace) throw fail(409, "This week already has shifts. Replace them?");
      const copied = copyShifts(prev.shifts, prevStart, weekStart, () => newId("sh")).filter((s) => !timeOffOn(timeOff, s, s.date));
      const next: ScheduleWeek = { ...cur, shifts: copied, changedSincePublish: !!cur.publishedAt, updatedAt: new Date().toISOString(), updatedBy: userName(res) };
      await saveWeek(next);
      return next;
    });
    audit({ ...actorOf(req, res), action: "schedule.copy", target: `site:${site.id}`, detail: `week of ${prevStart} to ${weekStart}` });
    broadcast({ type: "schedule", siteId: site.id, weekStart });
    res.json(saved);
  }));

  app.post("/api/sites/:siteId/schedule/week/:weekStart/publish", h(async (req, res) => {
    const site = await siteOr404(req.params.siteId);
    const weekStart = isoDate.parse(req.params.weekStart);
    const { publish } = z.object({ publish: z.boolean().default(true) }).parse(req.body ?? {});
    const saved = await withLock(scheduleKey(site.id, weekStart), async () => {
      const cur = await getWeek(site.id, weekStart);
      const next: ScheduleWeek = { ...cur, publishedAt: publish ? new Date().toISOString() : null, changedSincePublish: false, updatedAt: new Date().toISOString(), updatedBy: userName(res) };
      await saveWeek(next);
      return next;
    });
    audit({ ...actorOf(req, res), action: publish ? "schedule.publish" : "schedule.unpublish", target: `site:${site.id}`, detail: `week of ${weekStart}` });
    broadcast({ type: "schedule", siteId: site.id, weekStart });
    res.json(saved);
  }));

  // Per-location schedule settings.
  app.get("/api/sites/:siteId/schedule/settings", h(async (req, res) => {
    const site = await siteOr404(req.params.siteId);
    res.json(await getScheduleSettings(site.id));
  }));
  app.put("/api/sites/:siteId/schedule/settings", h(async (req, res) => {
    const site = await siteOr404(req.params.siteId);
    const cur = await getScheduleSettings(site.id);
    const patch = z.object({
      lateGraceMinutes: z.number().int().min(0).max(120).optional(),
      noShowAfterMinutes: z.number().int().min(5).max(480).optional(),
      earlyClockIn: z.object({ enabled: z.boolean(), minutes: z.number().int().min(0).max(240), mode: z.enum(["start", "cap"]) }).partial().optional(),
    }).parse(req.body);
    const next = scheduleSettingsSchema.parse({ ...cur, ...patch, earlyClockIn: { ...cur.earlyClockIn, ...(patch.earlyClockIn ?? {}) } });
    await (await db()).setSetting(scheduleSettingsKey(site.id), JSON.stringify(next));
    audit({ ...actorOf(req, res), action: "schedule.settings", target: `site:${site.id}`, detail: Object.keys(patch).join(", ") });
    broadcast({ type: "schedule", siteId: site.id });
    res.json(next);
  }));

  // Time off (owner side; the status field is ready for employee requests).
  app.get("/api/sites/:siteId/time-off", h(async (req, res) => {
    const site = await siteOr404(req.params.siteId);
    res.json(await getTimeOff(site.id));
  }));
  app.post("/api/sites/:siteId/time-off", h(async (req, res) => {
    const site = await siteOr404(req.params.siteId);
    const input = z.object({
      employeeId: z.string().max(64).default(""), employeeName: z.string().trim().min(1, "Choose who is off.").max(120),
      start: isoDate, end: isoDate, reason: z.string().trim().max(200).default(""), status: z.enum(TIME_OFF_STATUSES).default("approved"),
    }).parse(req.body);
    const now = new Date().toISOString();
    const entry = timeOffSchema.parse({
      ...input, id: newId("to"), requestedBy: "owner", createdAt: now,
      decidedAt: input.status === "pending" ? null : now, decidedBy: input.status === "pending" ? null : userName(res),
    });
    await withLock(timeOffKey(site.id), async () => {
      const list = await getTimeOff(site.id);
      await (await db()).setSetting(timeOffKey(site.id), JSON.stringify([...list, entry]));
    });
    audit({ ...actorOf(req, res), action: "timeoff.create", target: `site:${site.id}`, detail: `${entry.employeeName} ${entry.start} to ${entry.end} (${entry.status})` });
    broadcast({ type: "schedule", siteId: site.id });
    res.json(entry);
  }));
  app.put("/api/sites/:siteId/time-off/:id", h(async (req, res) => {
    const site = await siteOr404(req.params.siteId);
    const patch = z.object({
      start: isoDate.optional(), end: isoDate.optional(), reason: z.string().trim().max(200).optional(), status: z.enum(TIME_OFF_STATUSES).optional(),
    }).parse(req.body);
    const id = String(req.params.id);
    const saved = await withLock(timeOffKey(site.id), async () => {
      const list = await getTimeOff(site.id);
      const cur = list.find((t) => t.id === id);
      if (!cur) throw fail(404, "That time off no longer exists.");
      const decided = patch.status && patch.status !== cur.status;
      const next = timeOffSchema.parse({ ...cur, ...patch, ...(decided ? { decidedAt: new Date().toISOString(), decidedBy: userName(res) } : {}) });
      await (await db()).setSetting(timeOffKey(site.id), JSON.stringify(list.map((t) => (t.id === id ? next : t))));
      return next;
    });
    audit({ ...actorOf(req, res), action: "timeoff.update", target: `site:${site.id}`, detail: `${saved.employeeName} ${saved.start} to ${saved.end} (${saved.status})` });
    broadcast({ type: "schedule", siteId: site.id });
    res.json(saved);
  }));
  app.delete("/api/sites/:siteId/time-off/:id", h(async (req, res) => {
    const site = await siteOr404(req.params.siteId);
    const id = String(req.params.id);
    const removed = await withLock(timeOffKey(site.id), async () => {
      const list = await getTimeOff(site.id);
      const cur = list.find((t) => t.id === id);
      if (!cur) return null;
      await (await db()).setSetting(timeOffKey(site.id), JSON.stringify(list.filter((t) => t.id !== id)));
      return cur;
    });
    if (removed) {
      audit({ ...actorOf(req, res), action: "timeoff.delete", target: `site:${site.id}`, detail: `${removed.employeeName} ${removed.start} to ${removed.end}` });
      broadcast({ type: "schedule", siteId: site.id });
    }
    res.json({ ok: !!removed });
  }));

  // Late / no-show alerts for today (Live page).
  app.get("/api/sites/:siteId/schedule/alerts", h(async (req, res) => {
    const site = await siteOr404(req.params.siteId);
    const tz = site.rules.timezone;
    const now = Date.now();
    const date = todayISO(tz);
    const [{ shifts }, timeOff, st, prefs, directory] = await Promise.all([
      shiftsBetween(site, date, date), getTimeOff(site.id), getScheduleSettings(site.id), settings.getPrefs(), listEmployees(site.id),
    ]);
    if (!shifts.length) return res.json({ date, hasSchedule: false, alerts: [], settings: st });
    const day = localRange(date, date, tz);
    const punches = await (await db()).listPunches({ siteId: site.id, from: new Date(Date.parse(day.from) - 6 * 3600_000).toISOString(), to: new Date(Math.max(Date.parse(day.to), now) + 1).toISOString() });
    const names = Object.fromEntries(directory.map((e) => [e.id, e.name]));
    const current = shifts.map((s) => ({ ...s, employeeName: (s.employeeId && names[s.employeeId]) || s.employeeName }));
    const alerts = scheduleAlerts({ date, timezone: tz, now, shifts: current, punches, timeOff, settings: st, timeFormat: prefs.timeFormat });
    res.json({ date, hasSchedule: true, alerts, settings: st });
  }));

  // Labor cost vs. sales.
  app.get("/api/sites/:siteId/labor", h(async (req, res) => {
    const site = await siteOr404(req.params.siteId);
    const { from, to } = rangeOf(req, 92);
    res.json(await laborBetween(site, from, to));
  }));

  // Manual daily sales (fallback when Square sales aren't available).
  app.get("/api/sites/:siteId/sales", h(async (req, res) => {
    const site = await siteOr404(req.params.siteId);
    const { from, to } = rangeOf(req, 400);
    res.json(await manualSales(site.id, from, to));
  }));
  app.put("/api/sites/:siteId/sales", h(async (req, res) => {
    const site = await siteOr404(req.params.siteId);
    const { date, amount } = z.object({ date: isoDate, amount: z.number().finite().min(0).max(100_000_000).nullable() }).parse(req.body);
    const k = salesKey(site.id, date.slice(0, 7));
    await withLock(k, async () => {
      const store = await db();
      const cur = parseJson(await store.getSetting(k));
      const map: Record<string, number> = cur && typeof cur === "object" ? { ...(cur as Record<string, number>) } : {};
      if (amount == null) delete map[date]; else map[date] = Math.round(amount * 100) / 100;
      if (Object.keys(map).length) await store.setSetting(k, JSON.stringify(map));
      else await store.deleteSetting(k).catch(() => undefined);
    });
    audit({ ...actorOf(req, res), action: "sales.update", target: `site:${site.id}`, detail: `${date}: ${amount ?? "cleared"}` });
    res.json({ date, amount });
  }));

  // Payroll forecast for a pay period.
  app.get("/api/sites/:siteId/forecast", h(async (req, res) => {
    const site = await siteOr404(req.params.siteId);
    const q = z.object({ start: isoDate, end: isoDate }).parse(req.query);
    if (q.end < q.start) throw fail(400, "The end date is before the start date.");
    if (Date.parse(q.end) - Date.parse(q.start) > 62 * DAY) throw fail(400, "Choose a pay period of two months or less.");
    res.json(await forecastFor(site, q.start, q.end));
  }));
}
