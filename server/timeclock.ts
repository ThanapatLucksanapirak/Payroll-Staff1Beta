// Owner / manager side of time-clock data: automatic clock-out of forgotten
// shifts, punch review (the "Fix punches" screen), day approval, the live
// overtime watch and the pre-payroll checklist.
//
// Storage (app settings, so it works on SQLite and Supabase and is included in
// backups): `timeclock:<siteId>` holds the location's auto clock-out settings;
// `timeclock_approvals:<siteId>` holds approved days (date → employee → who,
// when, and a fingerprint of that day's punches, so any later change to the
// punches voids the approval automatically).
import { createHash } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { Site } from "@shared/schema";
import { addDays, daysBetween, isISODate, todayISO } from "@shared/dates";
import { employeeKey, resolveRates } from "@shared/engine";
import { type Punch, localRange } from "@shared/punches";
import {
  type ApprovalMap, type AutoCloseConfig, type DayApproval, type WorkDay, AUTO_CLOSE_NOTE, DEFAULT_AUTO_CLOSE, autoCloseEnabled, autoCloseSchema,
  buildWorkDays, openIssues, overtimeWatch, overtimeWeek, planAutoClose,
} from "@shared/punchIssues";
import { punchChecklist } from "@shared/payrollChecklist";
import { db } from "./db";
import { listPunchesChecked } from "./db/types";
import * as settings from "./settings";
import { getEmployee, listEmployees } from "./employees";
import { PunchError, recordPunch } from "./punches";
import { actorOf, audit } from "./audit";
import { broadcast } from "./live";
import { currentUser } from "./auth";

const DAY = 86_400_000;
const configKey = (siteId: string) => `timeclock:${siteId}`;
const approvalsKey = (siteId: string) => `timeclock_approvals:${siteId}`;
/** Open shifts older than this are left to the Fix punches screen. */
export const AUTO_CLOSE_LOOKBACK_DAYS = 8;
/** Approvals older than this are dropped when the list is next written. */
const APPROVAL_KEEP_DAYS = 400;
const MAX_RANGE_DAYS = 62;

function parse(raw: string | null | undefined): any {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ── Settings ──────────────────────────────────────────────────────────────────
export async function getAutoClose(siteId: string): Promise<AutoCloseConfig> {
  const v = parse(await (await db()).getSetting(configKey(siteId)));
  const r = autoCloseSchema.safeParse(v?.autoClose ?? {});
  return r.success ? r.data : { ...DEFAULT_AUTO_CLOSE };
}

export async function saveAutoClose(siteId: string, cfg: AutoCloseConfig): Promise<AutoCloseConfig> {
  const store = await db();
  const cur = parse(await store.getSetting(configKey(siteId))) ?? {};
  const next = autoCloseSchema.parse(cfg);
  await store.setSetting(configKey(siteId), JSON.stringify({ ...(typeof cur === "object" ? cur : {}), autoClose: next }));
  return next;
}

// ── Approvals ─────────────────────────────────────────────────────────────────
const approvalSchema = z.object({ at: z.string(), by: z.string().nullable().default(null), byName: z.string().default(""), fp: z.string() });

export async function getApprovals(siteId: string): Promise<ApprovalMap> {
  const v = parse(await (await db()).getSetting(approvalsKey(siteId)));
  const out: ApprovalMap = {};
  const days = v?.days && typeof v.days === "object" ? v.days : {};
  for (const [date, emps] of Object.entries<any>(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !emps || typeof emps !== "object") continue;
    for (const [emp, a] of Object.entries<any>(emps)) {
      const r = approvalSchema.safeParse(a);
      if (r.success) (out[date] ??= {})[emp] = r.data;
    }
  }
  return out;
}

const locks = new Map<string, Promise<unknown>>();
function withLock<T>(k: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(k) ?? Promise.resolve()).catch(() => undefined).then(fn);
  const tail = next.catch(() => undefined);
  locks.set(k, tail);
  tail.then(() => { if (locks.get(k) === tail) locks.delete(k); });
  return next;
}

async function updateApprovals(siteId: string, today: string, fn: (m: ApprovalMap) => void): Promise<void> {
  await withLock(`approvals|${siteId}`, async () => {
    const map = await getApprovals(siteId);
    fn(map);
    const oldest = addDays(today, -APPROVAL_KEEP_DAYS);
    for (const [date, emps] of Object.entries(map)) if (date < oldest || !Object.keys(emps).length) delete map[date];
    await (await db()).setSetting(approvalsKey(siteId), JSON.stringify({ v: 1, days: map }));
  });
}

// ── Work days ─────────────────────────────────────────────────────────────────
/** Punches that can belong to work days starting in [start, end] (padded for overnight and forgotten shifts). */
async function punchesFor(site: Site, start: string, end: string): Promise<Punch[]> {
  const r = localRange(addDays(start, -1), addDays(end, 2), site.rules.timezone);
  return listPunchesChecked(await db(), { siteId: site.id, from: r.from, to: r.to });
}

export async function workDays(site: Site, start: string, end: string, now = Date.now()): Promise<WorkDay[]> {
  const [punches, approvals, directory, prefs] = await Promise.all([punchesFor(site, start, end), getApprovals(site.id), listEmployees(site.id), settings.getPrefs()]);
  const names = new Map(directory.map((e) => [e.id, e.name]));
  const named = punches.map((p) => (names.has(p.employeeId) ? { ...p, employeeName: names.get(p.employeeId)! } : p));
  return buildWorkDays(named, {
    timezone: site.rules.timezone, now, start, end, approvals, timeFormat: prefs.timeFormat,
    longShiftHours: site.rules.longShiftWarningHours, shortShiftMinutes: 5,
  });
}

/** Names (in the period's work days) with no usable rate in the location's saved rates. */
async function employeesWithoutRate(site: Site, names: string[]): Promise<string[]> {
  const [profile, categories] = await Promise.all([settings.getWageProfile(site.id), settings.getCategories()]);
  const byKey = new Map(profile.map((e) => [employeeKey(e.name), e]));
  return names.filter((n) => {
    const cfg = byKey.get(employeeKey(n));
    if (cfg?.excluded) return false;
    const r = resolveRates(cfg, categories);
    return !cfg || (r.payBasis === "day_rate" ? r.fullDayRate <= 0 && r.halfDayRate <= 0 : r.hourlyRate <= 0);
  });
}

// ── Automatic clock-out ───────────────────────────────────────────────────────
export interface AutoCloseResult { siteId: string; employeeId: string; employeeName: string; date: string; at: string; reason: string; punchIds: string[] }
let lastRun: { at: string; closed: number } | null = null;
let running: Promise<AutoCloseResult[]> | null = null;

/** Punch ids derived from the shift being closed, so a second run (or a race) can never add a second clock-out. */
export function autoPunchId(siteId: string, inPunchId: string, kind: "b" | "o") {
  return `auto_${createHash("sha256").update(`${siteId}|${inPunchId}`).digest("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 24)}_${kind}`;
}

async function autoCloseSite(site: Site, now: number): Promise<AutoCloseResult[]> {
  const cfg = await getAutoClose(site.id);
  if (!autoCloseEnabled(cfg)) return [];
  const punches = await listPunchesChecked(await db(), { siteId: site.id, from: new Date(now - AUTO_CLOSE_LOOKBACK_DAYS * DAY).toISOString(), to: new Date(now + 1).toISOString() });
  const done: AutoCloseResult[] = [];
  for (const a of planAutoClose(punches, cfg, site.rules.timezone, now)) {
    try {
      const emp = (await getEmployee(site.id, a.employeeId)) ?? { id: a.employeeId, name: a.employeeName };
      const employee = { id: a.employeeId, name: emp.name };
      const flags = { autoClosed: { reason: a.reason, closedAt: new Date(now).toISOString() } };
      const common = { site, employee, at: a.at, source: "admin" as const, deviceId: null, note: AUTO_CLOSE_NOTE, audience: "admin" as const, force: true, flags };
      const ids: string[] = [];
      if (a.endBreak) {
        const b = await recordPunch({ ...common, id: autoPunchId(site.id, a.inPunchId, "b"), type: "break_end" });
        if (b.created) ids.push(b.punch.id);
      }
      const o = await recordPunch({ ...common, id: autoPunchId(site.id, a.inPunchId, "o"), type: "out" });
      if (o.created) ids.push(o.punch.id);
      if (!o.created) continue;
      done.push({ siteId: site.id, employeeId: a.employeeId, employeeName: employee.name, date: a.date, at: a.at, reason: a.reason, punchIds: ids });
      console.log(`[timeclock] auto-closed ${employee.name}'s shift of ${a.date} at ${a.at} (${a.reason})`);
      audit({ userId: null, userName: "System", ip: "", action: "timeclock.auto_close", target: `site:${site.id}`, detail: `${employee.name}, shift of ${a.date}, clocked out at ${a.at} (${a.reason === "cutoff" ? "auto clock-out time" : "max shift length"})` });
    } catch (err: any) {
      console.error(`[timeclock] auto clock-out failed for ${a.employeeName} (${site.id}): ${err?.message ?? err}`);
    }
  }
  return done;
}

/** Close forgotten shifts at every location (or the given ones). Safe to call at any time and repeatedly. */
export function runAutoClose(now = Date.now(), siteIds?: string[]): Promise<AutoCloseResult[]> {
  const job = (running ?? Promise.resolve([] as AutoCloseResult[])).catch(() => []).then(async () => {
    const sites = (await settings.getSites()).filter((s) => !siteIds || siteIds.includes(s.id));
    const all: AutoCloseResult[] = [];
    for (const s of sites) {
      try { all.push(...(await autoCloseSite(s, now))); } catch (err: any) { console.error(`[timeclock] auto clock-out skipped for ${s.id}: ${err?.message ?? err}`); }
    }
    lastRun = { at: new Date().toISOString(), closed: all.length };
    if (all.length) broadcast({ type: "timeclock", action: "auto_closed", count: all.length });
    return all;
  });
  running = job;
  return job;
}

let timer: NodeJS.Timeout | null = null;
let first: NodeJS.Timeout | null = null;
/** Start the background job (server start-up). Every 5 minutes by default; TIMECLOCK_AUTO_CLOSE_MS changes it, "off" disables it. */
export function startAutoCloseJob() {
  if (timer || process.env.TIMECLOCK_AUTO_CLOSE_MS === "off") return;
  const every = Math.max(30_000, Number.parseInt(process.env.TIMECLOCK_AUTO_CLOSE_MS || "", 10) || 5 * 60_000);
  const tick = () => { runAutoClose().catch((err) => console.error("[timeclock] auto clock-out failed:", err?.message ?? err)); };
  first = setTimeout(tick, 20_000);
  first.unref?.();
  timer = setInterval(tick, every);
  timer.unref?.();
}
export function stopAutoCloseJob() {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = timer = null;
}

// ── Routes ────────────────────────────────────────────────────────────────────
type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch((err) => {
    if (err instanceof PunchError) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  });
};
const isoDate = z.string().refine(isISODate, "Use a real date (YYYY-MM-DD).");

async function siteOr404(req: Request, res: Response) {
  const site = await settings.getSite(String(req.params.siteId));
  if (!site) { res.status(404).json({ error: "Location not found." }); return null; }
  return site;
}

function rangeFrom(q: unknown, site: Site, defaultDays = 14) {
  const today = todayISO(site.rules.timezone);
  const r = z.object({ start: isoDate.optional(), end: isoDate.optional() }).parse(q ?? {});
  const end = r.end ?? today;
  const start = r.start ?? addDays(end, -(defaultDays - 1));
  if (end < start) throw Object.assign(new Error("The end date is before the start date."), { status: 400 });
  if (daysBetween(start, end) >= MAX_RANGE_DAYS) throw Object.assign(new Error(`Choose ${MAX_RANGE_DAYS} days or fewer.`), { status: 400 });
  return { start, end, today };
}

/** What the browser needs about a day (punches stay on the server). */
function dayView(d: WorkDay) {
  return {
    employeeId: d.employeeId, employeeName: d.employeeName, date: d.date, workedMinutes: d.workedMinutes, working: d.working,
    approved: d.approved, approvalStale: d.approvalStale, approvable: d.approvable, clean: d.clean,
    approval: d.approval ? { at: d.approval.at, byName: d.approval.byName } : null,
    punchIds: d.punchIds,
    shifts: d.shifts.map((s) => ({
      inId: s.in.id, outId: s.out?.id ?? null, in: s.in.at, out: s.out?.at ?? null, open: s.open, superseded: s.superseded,
      breakMinutes: s.breakMinutes, workedMinutes: s.workedMinutes, autoClosed: !!s.out?.flags?.autoClosed,
    })),
    issues: d.issues,
  };
}
export type WorkDayView = ReturnType<typeof dayView>;

export function registerTimeclockRoutes(app: Express) {
  app.get("/api/sites/:siteId/timeclock/auto-close", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    res.json({ config: await getAutoClose(site.id), lastRun, lookbackDays: AUTO_CLOSE_LOOKBACK_DAYS });
  }));

  app.put("/api/sites/:siteId/timeclock/auto-close", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    const cfg = await saveAutoClose(site.id, autoCloseSchema.parse(req.body ?? {}));
    audit({ ...actorOf(req, res), action: "timeclock.settings", target: `site:${site.id}`, detail: `auto clock-out ${cfg.cutoffMinutes == null ? "off" : `at ${cfg.cutoffMinutes} min`}, max shift ${cfg.maxShiftHours || "off"} h` });
    // Apply right away rather than waiting for the next tick.
    const closed = autoCloseEnabled(cfg) ? await runAutoClose(Date.now(), [site.id]) : [];
    res.json({ config: cfg, closed: closed.length });
  }));

  app.post("/api/sites/:siteId/timeclock/auto-close/run", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    const closed = await runAutoClose(Date.now(), [site.id]);
    if (closed.length) audit({ ...actorOf(req, res), action: "timeclock.auto_close_run", target: `site:${site.id}`, detail: `${closed.length} shift(s) closed` });
    res.json({ closed });
  }));

  app.get("/api/sites/:siteId/timeclock/review", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    const { start, end, today } = rangeFrom(req.query, site);
    const days = await workDays(site, start, end);
    const issues = openIssues(days);
    res.json({
      site: { id: site.id, name: site.name, timezone: site.rules.timezone }, start, end, today, now: new Date().toISOString(),
      autoClose: await getAutoClose(site.id),
      days: days.map(dayView),
      issues,
      counts: {
        fix: issues.filter((i) => i.severity === "fix").length,
        review: issues.filter((i) => i.severity === "review").length,
        days: days.length,
        approved: days.filter((d) => d.approved).length,
        clean: days.filter((d) => d.clean && !d.approved).length,
      },
    });
  }));

  app.post("/api/sites/:siteId/timeclock/approvals", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    const body = z.object({
      approve: z.boolean().default(true),
      days: z.array(z.object({ employeeId: z.string().min(1).max(64), date: isoDate })).max(1000).optional(),
      clean: z.object({ start: isoDate, end: isoDate }).optional(),
    }).refine((b) => !!b.days !== !!b.clean, "Send either days or clean.").parse(req.body ?? {});
    const range = body.clean ?? (() => {
      const dates = body.days!.map((d) => d.date).sort();
      return { start: dates[0] ?? todayISO(site.rules.timezone), end: dates[dates.length - 1] ?? todayISO(site.rules.timezone) };
    })();
    if (daysBetween(range.start, range.end) >= MAX_RANGE_DAYS || range.end < range.start) return res.status(400).json({ error: `Choose ${MAX_RANGE_DAYS} days or fewer.` });
    const all = await workDays(site, range.start, range.end);
    const byKey = new Map(all.map((d) => [`${d.date}|${d.employeeId}`, d]));
    const targets: WorkDay[] = [];
    const skipped: { employeeId: string; date: string; reason: string }[] = [];
    if (body.clean) targets.push(...all.filter((d) => d.clean && !d.approved));
    else {
      for (const k of body.days!) {
        const d = byKey.get(`${k.date}|${k.employeeId}`);
        if (!d) { if (!body.approve) targets.push({ employeeId: k.employeeId, date: k.date } as WorkDay); else skipped.push({ ...k, reason: "No punches on this day." }); continue; }
        if (body.approve && !d.approvable) { skipped.push({ ...k, reason: d.working ? "Still clocked in." : "Fix the punch problems first." }); continue; }
        targets.push(d);
      }
    }
    const user = currentUser(res);
    const actor = actorOf(req, res);
    const stamp: Omit<DayApproval, "fp"> = { at: new Date().toISOString(), by: user?.id ?? null, byName: actor.userName };
    await updateApprovals(site.id, todayISO(site.rules.timezone), (map) => {
      for (const d of targets) {
        if (body.approve) (map[d.date] ??= {})[d.employeeId] = { ...stamp, fp: d.fingerprint };
        else if (map[d.date]) delete map[d.date][d.employeeId];
      }
    });
    if (targets.length) {
      const dates = [...new Set(targets.map((d) => d.date))].sort();
      audit({ ...actor, action: body.approve ? "timeclock.approve" : "timeclock.unapprove", target: `site:${site.id}`, detail: `${targets.length} day(s)${body.clean ? " (all clean days)" : ""}, ${dates[0]}${dates.length > 1 ? ` to ${dates[dates.length - 1]}` : ""}` });
      broadcast({ type: "timeclock", action: "approvals", siteId: site.id });
    }
    res.json({ changed: targets.length, skipped });
  }));

  app.get("/api/sites/:siteId/timeclock/overtime", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    const r = site.rules;
    const now = Date.now();
    const { weekStart, weekEnd, today } = overtimeWeek(r, now);
    const base = { enabled: r.overtimeEnabled && (r.overtimeWeeklyHours > 0 || r.overtimeDailyHours > 0), weekStart, weekEnd, today, weeklyHours: r.overtimeWeeklyHours, dailyHours: r.overtimeDailyHours };
    if (!base.enabled) return res.json({ ...base, employees: [] });
    const range = localRange(addDays(weekStart, -1), today, r.timezone);
    const [punches, directory, profile, categories] = await Promise.all([
      listPunchesChecked(await db(), { siteId: site.id, from: range.from, to: new Date(now + 60_000).toISOString() }),
      listEmployees(site.id), settings.getWageProfile(site.id), settings.getCategories(),
    ]);
    const names = new Map(directory.map((e) => [e.id, e.name]));
    const named = punches.map((p) => (names.has(p.employeeId) ? { ...p, employeeName: names.get(p.employeeId)! } : p));
    const wages = new Map(profile.map((e) => [employeeKey(e.name), e]));
    // Overtime only applies to hourly pay in the engine: leave out people saved on a day rate.
    const list = overtimeWatch(named, { rules: r, now }).filter((e) => {
      const cfg = wages.get(employeeKey(e.employeeName));
      if (!cfg) return true;
      const rates = resolveRates(cfg, categories);
      return rates.payBasis === "hourly";
    });
    res.json({ ...base, employees: list });
  }));

  app.get("/api/sites/:siteId/timeclock/checklist", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    const { start, end } = rangeFrom(req.query, site);
    const days = site.timeSource === "square" ? [] : await workDays(site, start, end);
    const names = [...new Set(days.map((d) => d.employeeName))];
    const noRate = names.length ? await employeesWithoutRate(site, names) : [];
    res.json({ start, end, timeSource: site.timeSource, items: punchChecklist(days, { start, end }, noRate) });
  }));
}
