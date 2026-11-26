// Employee self-service portal (/me) for kiosk employees, who have no user
// account: they sign in with their location, name and time-clock PIN.
//
// Security model (the portal is reachable from the internet):
// - Routes live under /api/portal/* and are registered BEFORE the admin
//   session middleware. They never read the admin cookie, and the admin
//   middleware never reads the portal cookie (different name, different path,
//   and a differently-keyed signature, so a portal token can't pass as an
//   admin token even if copied into the admin cookie).
// - Sign-in is locked per employee (5 wrong tries, then 5 min, doubling up to
//   24 h) and per client address (15 wrong tries, then 15 min, doubling).
//   Attempts for one key are handled one at a time so parallel guesses can't
//   slip past the lock. Wrong name and wrong PIN get the same answer and take
//   the same time.
// - The session is an HMAC-signed, httpOnly, SameSite=Strict cookie scoped to
//   /api/portal, valid 12 h. It stops working when the employee's PIN changes,
//   they are deactivated or removed, the portal is turned off for the
//   location, or they sign out (which ends all their portal sessions).
// - Every response is filtered to the signed-in employee on the server.
import { createHmac, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { Site } from "@shared/schema";
import { addDays, isISODate, todayISO } from "@shared/dates";
import { clockState, localRange } from "@shared/punches";
import { buildWorkDays } from "@shared/punchIssues";
import { timeOffSchema, weekStartOf } from "@shared/schedule";
import { ytdStatementMap, ytdTotals } from "@shared/payExtras";
import { employeeKey } from "@shared/engine";
import {
  type LockPolicy, type LockState, type PortalSettings, PORTAL_COOKIE, PORTAL_COOKIE_PATH, PORTAL_SESSION_HOURS,
  approvedTimeOffFor, checkTimeOffRequest, employeeSummaryFor, isEmployee, lockRemaining, matchName, portalDays, portalKey,
  portalRevokedKey, portalSettingsSchema, publishedShiftsFor, recordAttempt, statementResult, visibleTimeOff,
} from "@shared/portal";
import { payPeriod } from "../client/src/lib/periods";
import { getAuthSecret } from "./config";
import { db } from "./db";
import * as settings from "./settings";
import { type StoredEmployee, PIN_RE, findByPin, getEmployee, listEmployees } from "./employees";
import { acquireArrival } from "./kiosk";
import { getApprovals } from "./timeclock";
import { getTimeOff, shiftsBetween, updateTimeOff } from "./schedule";
import { finalizedFor } from "./pay";
import { audit } from "./audit";
import { broadcast } from "./live";
import { CSRF_HEADER, CSRF_VALUE } from "./access";

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const isoDate = z.string().refine(isISODate, "Use a YYYY-MM-DD date.");
const SESSION_MS = PORTAL_SESSION_HOURS * 3600_000;

function parseJson(raw: string | null | undefined): any {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ── Settings ──────────────────────────────────────────────────────────────────
export async function getPortalSettings(siteId: string): Promise<PortalSettings> {
  const r = portalSettingsSchema.safeParse(parseJson(await (await db()).getSetting(portalKey(siteId))) ?? {});
  return r.success ? r.data : { enabled: false };
}

async function portalSite(siteId: string): Promise<Site | null> {
  const site = await settings.getSite(siteId);
  if (!site || site.archived) return null;
  return (await getPortalSettings(site.id)).enabled ? site : null;
}

async function revokedBefore(siteId: string, employeeId: string): Promise<number> {
  const v = parseJson(await (await db()).getSetting(portalRevokedKey(siteId)));
  const t = v && typeof v === "object" ? Number(v[employeeId]) : 0;
  return Number.isFinite(t) ? t : 0;
}

// ── Lockout (in memory) ───────────────────────────────────────────────────────
const EMP_POLICY = (): LockPolicy => ({ maxFails: 5, baseMs: Number(process.env.PORTAL_LOCK_MS) || 5 * 60_000, maxMs: 24 * 3600_000, resetMs: 24 * 3600_000 });
const IP_POLICY = (): LockPolicy => ({ maxFails: Number(process.env.PORTAL_IP_FAILS) || 15, baseMs: Number(process.env.PORTAL_IP_LOCK_MS) || 15 * 60_000, maxMs: 24 * 3600_000, resetMs: 24 * 3600_000 });
const locks = new Map<string, LockState>();
const MAX_LOCK_KEYS = 20_000;

function pruneLocks(now = Date.now()) {
  for (const [k, s] of locks) if (s.lockedUntil < now && now - s.last > 24 * 3600_000) locks.delete(k);
  // Under a flood of made-up names, drop unlocked entries first.
  if (locks.size > MAX_LOCK_KEYS) for (const [k, s] of locks) if (s.lockedUntil < now) locks.delete(k);
}
setInterval(pruneLocks, 10 * 60_000).unref();

function record(key: string, ok: boolean, policy: LockPolicy): boolean {
  const before = locks.get(key);
  const next = recordAttempt(before, ok, Date.now(), policy);
  if (next) locks.set(key, next); else locks.delete(key);
  if (locks.size > MAX_LOCK_KEYS) pruneLocks();
  return !!next && next.locks > (before?.locks ?? 0); // just locked
}

/** For tests: forget every lock. */
export function resetPortalLocks() { locks.clear(); }

function lockedResponse(res: Response, ms: number) {
  const secs = Math.ceil(ms / 1000);
  res.setHeader("Retry-After", String(secs));
  const wait = secs < 90 ? `${secs} seconds` : secs < 5400 ? `${Math.ceil(secs / 60)} minutes` : `${Math.ceil(secs / 3600)} hours`;
  return res.status(429).json({ error: `Too many wrong tries. Try again in ${wait}, or ask your manager.`, code: "locked", retryAfter: secs });
}

// ── Session token ─────────────────────────────────────────────────────────────
const TOKEN_TAG = "payroll-portal";
const sign = (payload: string) => createHmac("sha256", getAuthSecret()).update(`portal-session:${payload}`).digest("base64url");
/** Changes whenever the employee's PIN changes, so old sessions stop working. */
const pinFingerprint = (siteId: string, e: StoredEmployee) =>
  createHmac("sha256", getAuthSecret()).update(`portal-pin:${siteId}:${e.id}:${e.pinHash ?? ""}`).digest("base64url").slice(0, 22);

function issueToken(siteId: string, e: StoredEmployee, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ p: TOKEN_TAG, v: 1, s: siteId, e: e.id, f: pinFingerprint(siteId, e), iat: now, exp: now + SESSION_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function safeEq(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; }
  }
  return undefined;
}

export interface PortalCtx { site: Site; employee: StoredEmployee }
const pctx = (res: Response) => res.locals.portal as PortalCtx;

/** The site and employee a portal token belongs to, if it is valid and still current. */
export async function verifyPortalToken(token: string | undefined): Promise<PortalCtx | null> {
  if (!token || token.length > 1000) return null;
  try {
    const [payload, sig] = token.split(".");
    if (!payload || !sig || !safeEq(sig, sign(payload))) return null;
    const d = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (d.p !== TOKEN_TAG || d.v !== 1 || typeof d.exp !== "number" || d.exp < Date.now() || typeof d.s !== "string" || typeof d.e !== "string") return null;
    const site = await portalSite(d.s);
    if (!site) return null;
    const employee = await getEmployee(site.id, d.e);
    if (!employee || !employee.active || !employee.pinHash) return null;
    if (typeof d.f !== "string" || !safeEq(d.f, pinFingerprint(site.id, employee))) return null;
    if (typeof d.iat !== "number" || d.iat <= (await revokedBefore(site.id, employee.id))) return null;
    return { site, employee };
  } catch {
    return null;
  }
}

function cookieOpts(req: Request) {
  return { httpOnly: true, sameSite: "strict" as const, secure: req.secure, path: PORTAL_COOKIE_PATH };
}

const actor = (req: Request, e: { id: string; name: string } | null, fallback = "Employee portal") =>
  ({ userId: null, userName: e ? `${e.name} (employee portal)` : fallback, ip: req.ip ?? "" });

// ── Routes ────────────────────────────────────────────────────────────────────
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** Employee portal API. Register BEFORE the admin session middleware (like the kiosk). */
export function registerPortalRoutes(app: Express) {
  // Same CSRF rule as the admin API: state changes need the custom header.
  app.use("/api/portal", (req: Request, res: Response, next: NextFunction) => {
    if (SAFE.has(req.method) || req.header(CSRF_HEADER) === CSRF_VALUE) return next();
    return res.status(403).json({ error: "This request was blocked for your security. Reload the page and try again." });
  });

  // Locations that have the portal on (names only).
  app.get("/api/portal/sites", h(async (_req, res) => {
    const out: { id: string; name: string; color: string }[] = [];
    for (const s of await settings.getSites()) {
      if (!s.archived && (await getPortalSettings(s.id)).enabled) out.push({ id: s.id, name: s.name, color: s.color });
    }
    res.json(out.sort((a, b) => a.name.localeCompare(b.name)));
  }));

  app.post("/api/portal/login", h(async (req, res) => {
    const body = z.object({
      siteId: z.string().min(1).max(100),
      name: z.string().trim().min(1, "Enter your name.").max(80),
      pin: z.string().max(12),
    }).parse(req.body ?? {});
    const ip = req.ip ?? "unknown";
    const site = await portalSite(body.siteId);
    if (!site) return res.status(403).json({ error: "The employee portal isn't turned on for this location.", code: "off" });
    const employees = await listEmployees(site.id);
    const match = matchName(employees.filter((e) => e.pinHash), body.name);
    // Unknown names are locked by the name typed, so they behave like real ones.
    const empKey = match ? `emp:${site.id}|${match.id}` : `name:${site.id}|${employeeKey(body.name)}`;

    // One attempt at a time per address, then per person: the lock can't be raced.
    const ipTurn = acquireArrival(`portal-ip:${ip}`);
    try {
      await ipTurn.ready;
      const empTurn = acquireArrival(`portal-${empKey}`);
      try {
        await empTurn.ready;
        const now = Date.now();
        const locked = Math.max(lockRemaining(locks.get(`ip:${ip}`), now), lockRemaining(locks.get(empKey), now));
        if (locked) return lockedResponse(res, locked);
        // Always run the PIN hash (even for an unknown name) so timing says nothing.
        const pinOk = PIN_RE.test(body.pin) ? await findByPin(site.id, body.pin, match?.id ?? "__nobody__") : null;
        const ok = !!match && !!pinOk && pinOk.id === match.id;
        const ipLocked = record(`ip:${ip}`, ok, IP_POLICY());
        const empLocked = record(empKey, ok, EMP_POLICY());
        if (!ok) {
          if (empLocked || ipLocked) {
            audit({ ...actor(req, null), action: "portal.lockout", target: `site:${site.id}`, detail: `${empLocked ? `name "${body.name}"` : "address"} locked after wrong PINs` });
          }
          const nowLocked = Math.max(lockRemaining(locks.get(`ip:${ip}`), Date.now()), lockRemaining(locks.get(empKey), Date.now()));
          if (nowLocked) return lockedResponse(res, nowLocked);
          return res.status(401).json({ error: "That name and PIN don't match. Try again.", code: "pin" });
        }
        res.cookie(PORTAL_COOKIE, issueToken(site.id, match), { ...cookieOpts(req), maxAge: SESSION_MS });
        audit({ ...actor(req, match), action: "portal.login", target: `site:${site.id}` });
        return res.json({ ok: true });
      } finally {
        empTurn.done();
      }
    } finally {
      ipTurn.done();
    }
  }));

  // Everything below needs a portal session.
  app.use("/api/portal", (req: Request, res: Response, next: NextFunction) => {
    (async () => {
      const found = await verifyPortalToken(readCookie(req, PORTAL_COOKIE));
      if (!found) {
        res.clearCookie(PORTAL_COOKIE, cookieOpts(req));
        return res.status(401).json({ error: "Please sign in.", code: "session" });
      }
      res.locals.portal = found satisfies PortalCtx;
      next();
    })().catch(next);
  });

  /** Sign out: ends this employee's portal sessions on every device. */
  app.post("/api/portal/logout", h(async (req, res) => {
    const { site, employee } = pctx(res);
    const store = await db();
    const cur = parseJson(await store.getSetting(portalRevokedKey(site.id)));
    const map: Record<string, number> = cur && typeof cur === "object" ? cur : {};
    map[employee.id] = Date.now();
    await store.setSetting(portalRevokedKey(site.id), JSON.stringify(map));
    res.clearCookie(PORTAL_COOKIE, cookieOpts(req));
    res.json({ ok: true });
  }));

  app.get("/api/portal/me", h(async (_req, res) => {
    const { site, employee } = pctx(res);
    const prefs = await settings.getPrefs();
    res.json({
      employee: { id: employee.id, name: employee.name, role: employee.role },
      site: { id: site.id, name: site.name, color: site.color, timezone: site.rules.timezone, timeClock: site.timeSource !== "square" },
      prefs: { timeFormat: prefs.timeFormat, dateFormat: prefs.dateFormat, currencySymbol: prefs.currencySymbol, businessName: prefs.businessName, appName: prefs.appName },
    });
  }));

  // ── My hours this period ──
  app.get("/api/portal/hours", h(async (req, res) => {
    const { site, employee } = pctx(res);
    const { offset } = z.object({ offset: z.coerce.number().int().min(-6).max(0).default(0) }).parse(req.query);
    const tz = site.rules.timezone;
    const now = Date.now();
    const period = payPeriod(site.rules, offset, todayISO(tz));
    const r = localRange(addDays(period.start, -1), addDays(period.end, 2), tz);
    const [punches, approvals, prefs, finalized] = await Promise.all([
      (await db()).listPunches({ siteId: site.id, employeeId: employee.id, from: r.from, to: r.to, limit: 5000 }),
      getApprovals(site.id), settings.getPrefs(), finalizedFor(site.id),
    ]);
    const mine = punches.filter((p) => p.employeeId === employee.id).map((p) => ({ ...p, employeeName: employee.name }));
    const days = buildWorkDays(mine, {
      timezone: tz, now, start: period.start, end: period.end, approvals, timeFormat: prefs.timeFormat,
      longShiftHours: site.rules.longShiftWarningHours, shortShiftMinutes: 5,
    });
    const clock = clockState(mine, now);
    const list = portalDays(days, employee.id, clock.status);
    res.json({
      period: { start: period.start, end: period.end }, offset,
      status: clock.status, since: clock.since,
      totalMinutes: list.reduce((a, d) => a + d.workedMinutes, 0),
      days: list,
      // Hours on finalized timesheets that overlap this period. They cover hours that came from
      // Square or a spreadsheet, which the time clock never saw, so the page isn't left at zero.
      timesheets: finalized.flatMap((t) => {
        if (!t.periodStart || !t.periodEnd || t.periodEnd < period.start || t.periodStart > period.end) return [];
        const e = employeeSummaryFor(t.result, employee.name);
        return e ? [{ id: t.id, periodStart: t.periodStart, periodEnd: t.periodEnd, minutes: Math.round(e.hoursWorked * 60) }] : [];
      }).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)),
    });
  }));

  // ── My pay statements (finalized timesheets only) ──
  app.get("/api/portal/statements", h(async (_req, res) => {
    const { site, employee } = pctx(res);
    const list = await finalizedFor(site.id);
    const out = list.flatMap((t) => {
      const e = employeeSummaryFor(t.result, employee.name);
      return e ? [{ id: t.id, label: t.label, periodStart: t.periodStart, periodEnd: t.periodEnd, totalPay: e.totalPay, isNetPay: e.isNetPay, minutes: Math.round(e.hoursWorked * 60) }] : [];
    });
    res.json(out.sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)));
  }));

  app.get("/api/portal/statements/:id", h(async (req, res) => {
    const { site, employee } = pctx(res);
    const id = String(req.params.id);
    const list = await finalizedFor(site.id);
    const t = list.find((x) => x.id === id);
    const result = t ? statementResult(t.result, employee.name) : null;
    if (!t || !result) return res.status(404).json({ error: "Statement not found." });
    // Year to date for this person only: earlier finalized periods of the same year, plus this one.
    const year = t.periodEnd.slice(0, 4);
    const earlier = list
      .filter((x) => x.id !== t.id && x.periodEnd.slice(0, 4) === year && x.periodEnd <= t.periodEnd)
      .map((x) => statementResult(x.result, employee.name))
      .filter((x): x is NonNullable<typeof x> => !!x);
    const k = employeeKey(employee.name);
    const ytdAll = ytdStatementMap(ytdTotals(earlier), result);
    const prefs = await settings.getPrefs();
    res.json({
      title: t.label,
      result,
      site: { id: site.id, name: site.name, address: site.address },
      prefs: {
        appName: prefs.appName, businessName: prefs.businessName, dateFormat: prefs.dateFormat, timeFormat: prefs.timeFormat, currencySymbol: prefs.currencySymbol,
        pdfShowShiftTimes: prefs.pdfShowShiftTimes, pdfFooter: prefs.pdfFooter, pdfPageSize: prefs.pdfPageSize, pdfLogoDataUrl: prefs.pdfLogoDataUrl, pdfSignatureLine: prefs.pdfSignatureLine,
      },
      ytd: ytdAll[k] ? { [k]: ytdAll[k] } : {},
      ytdYear: Number(year) || null,
    });
  }));

  // ── My schedule: next 2 weeks, published weeks only, plus approved time off ──
  app.get("/api/portal/schedule", h(async (_req, res) => {
    const { site, employee } = pctx(res);
    const today = todayISO(site.rules.timezone);
    const to = addDays(today, 13);
    const [{ shifts, weeks }, timeOff] = await Promise.all([shiftsBetween(site, today, to), getTimeOff(site.id)]);
    const published = new Map(weeks.map((w) => [w.weekStart, !!w.publishedAt]));
    const withFlag = shifts.map((s) => ({ ...s, published: published.get(weekStartOf(s.date, site.rules.weekStartsOn)) ?? false }));
    const me = { id: employee.id, name: employee.name };
    res.json({
      from: today, to,
      shifts: publishedShiftsFor(withFlag, me),
      timeOff: approvedTimeOffFor(timeOff, me, today, to),
      unpublishedWeeks: weeks.filter((w) => !w.publishedAt).map((w) => w.weekStart),
    });
  }));

  // ── Time-off requests ──
  const view = (t: ReturnType<typeof timeOffSchema.parse>) => ({
    id: t.id, start: t.start, end: t.end, reason: t.reason, status: t.status, requestedBy: t.requestedBy, createdAt: t.createdAt, decidedAt: t.decidedAt,
  });

  app.get("/api/portal/time-off", h(async (_req, res) => {
    const { site, employee } = pctx(res);
    const list = visibleTimeOff(await getTimeOff(site.id), { id: employee.id, name: employee.name }, todayISO(site.rules.timezone));
    res.json(list.map(view));
  }));

  app.post("/api/portal/time-off", h(async (req, res) => {
    const { site, employee } = pctx(res);
    const body = z.object({ start: isoDate, end: isoDate, note: z.string().trim().max(200).default("") }).parse(req.body ?? {});
    const today = todayISO(site.rules.timezone);
    const me = { id: employee.id, name: employee.name };
    const entry = await updateTimeOff(site.id, (list) => {
      const problem = checkTimeOffRequest(body, today, list.filter((t) => isEmployee(t, me)));
      if (problem) throw fail(400, problem);
      const e = timeOffSchema.parse({
        id: `to_${randomUUID().replace(/-/g, "").slice(0, 12)}`, employeeId: employee.id, employeeName: employee.name,
        start: body.start, end: body.end, reason: body.note, status: "pending", requestedBy: "employee",
        createdAt: new Date().toISOString(), decidedAt: null, decidedBy: null,
      });
      return { next: [...list, e], result: e };
    });
    audit({ ...actor(req, employee), action: "timeoff.request", target: `site:${site.id}`, detail: `${employee.name} ${entry.start} to ${entry.end}` });
    broadcast({ type: "schedule", siteId: site.id });
    res.json(view(entry));
  }));

  app.delete("/api/portal/time-off/:id", h(async (req, res) => {
    const { site, employee } = pctx(res);
    const id = String(req.params.id);
    const me = { id: employee.id, name: employee.name };
    const removed = await updateTimeOff(site.id, (list) => {
      const cur = list.find((t) => t.id === id && isEmployee(t, me));
      if (!cur) throw fail(404, "That request no longer exists.");
      if (cur.status !== "pending" || cur.requestedBy !== "employee") throw fail(409, "Only requests still waiting for an answer can be cancelled. Ask your manager.");
      return { next: list.filter((t) => t.id !== id), result: cur };
    });
    audit({ ...actor(req, employee), action: "timeoff.cancel", target: `site:${site.id}`, detail: `${employee.name} ${removed.start} to ${removed.end}` });
    broadcast({ type: "schedule", siteId: site.id });
    res.json({ ok: true });
  }));

  // Nothing under /api/portal ever falls through to the admin API.
  app.use("/api/portal", (_req: Request, res: Response) => res.status(404).json({ error: "Not found." }));
}

/** Owner side: turn the portal on or off per location (behind the admin session; owners and admins). */
export function registerPortalAdminRoutes(app: Express) {
  app.get("/api/sites/:siteId/portal", h(async (req, res) => {
    const site = await settings.getSite(String(req.params.siteId));
    if (!site) return res.status(404).json({ error: "Location not found." });
    res.json(await getPortalSettings(site.id));
  }));
  app.put("/api/sites/:siteId/portal", h(async (req, res) => {
    const site = await settings.getSite(String(req.params.siteId));
    if (!site) return res.status(404).json({ error: "Location not found." });
    const body = z.object({ enabled: z.boolean() }).strict().parse(req.body ?? {});
    const next = portalSettingsSchema.parse({ ...(await getPortalSettings(site.id)), ...body });
    await (await db()).setSetting(portalKey(site.id), JSON.stringify(next));
    const u = res.locals.user;
    audit({ userId: u?.id ?? null, userName: u ? (u.displayName || u.username) : "", ip: req.ip ?? "", action: "portal.settings", target: `site:${site.id}`, detail: next.enabled ? "turned on" : "turned off" });
    res.json(next);
  }));
}
