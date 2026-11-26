// Time-clock kiosk: paired devices, the device-token API under /api/kiosk/*,
// PIN brute-force protection, and the optional KIOSK_HOST restriction.
//
// The kiosk API never uses the admin session. Every request carries the device
// token (header X-Kiosk-Token), which is scoped to one location and can only
// read names and clock status, and record punches. Nothing about pay.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { Site } from "@shared/schema";
import { todayISO } from "@shared/dates";
import { PUNCH_TYPES, type Punch, type PunchMeta, allowedActions, clockState, localRange } from "@shared/punches";
import { type KioskDeviceOptions, DEVICE_LOGIN_MODES, IDLE_MAX, IDLE_MIN, breakDue, checkAction, daySummary, matchStation, normalizeDeviceOptions, notesFor, weakPinReason } from "@shared/kiosk";
import { getSiteConfig, listNotes } from "./kioskConfig";
import { decodePhoto, deletePhoto, savePhoto } from "./kioskPhotos";
import { registerKioskDeviceFeatureRoutes } from "./kioskFeatures";
import { getAuthSecret } from "./config";
import { db } from "./db";
import type { DataStore } from "./db/types";
import * as settings from "./settings";
import { type StoredEmployee, PIN_RE, findByPin, getEmployee, listEmployees, pinInUse, registerEmployeeRoutes } from "./employees";
import { PUNCH_ID_RE, PunchError, recordPunch, registerPunchRoutes } from "./punches";
import { registerLiveRoutes } from "./live";
import { hashPassword, verifyHash } from "./passwords";

// ── Devices ───────────────────────────────────────────────────────────────────
export interface KioskDevice {
  id: string;
  siteId: string;
  name: string;
  tokenHash: string;
  pairCodeHash: string | null;
  pairCodeExpiresAt: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  /** Per-device kiosk options (photo, sign-in, idle timeout, stations). Missing on older devices. */
  options?: Partial<KioskDeviceOptions>;
}
const DEVICES_KEY = "kiosk_devices";
const PAIR_CODE_MS = 15 * 60_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const eqHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

let devCache: { store: DataStore; list: KioskDevice[]; at: number } | null = null;
export function invalidateDeviceCache() { devCache = null; }
async function loadDevices(): Promise<KioskDevice[]> {
  const store = await db();
  if (devCache && devCache.store === store && Date.now() - devCache.at < 30_000) return devCache.list;
  let list: KioskDevice[] = [];
  try { list = JSON.parse((await store.getSetting(DEVICES_KEY)) ?? "[]"); } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  devCache = { store, list, at: Date.now() };
  return list;
}
async function saveDevices(list: KioskDevice[]) {
  const store = await db();
  await store.setSetting(DEVICES_KEY, JSON.stringify(list));
  devCache = { store, list, at: Date.now() };
}
let devLock: Promise<unknown> = Promise.resolve();
function withDevLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = devLock.catch(() => undefined).then(fn);
  devLock = next.catch(() => undefined);
  return next;
}

const newToken = () => `kd_${randomBytes(32).toString("base64url")}`;
function newPairCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const chars = [...randomBytes(8)].map((b) => alphabet[b % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}
const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");

export const deviceView = (d: KioskDevice) => ({
  id: d.id, siteId: d.siteId, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt,
  pairCodeExpiresAt: d.pairCodeHash && d.pairCodeExpiresAt && Date.parse(d.pairCodeExpiresAt) > Date.now() ? d.pairCodeExpiresAt : null,
  options: normalizeDeviceOptions(d.options),
});

/** Change a device's kiosk options. Returns the updated device, or null when it doesn't exist at that location. */
export async function setDeviceOptions(siteId: string, id: string, patch: Partial<KioskDeviceOptions>): Promise<KioskDevice | null> {
  return withDevLock(async () => {
    const list = await loadDevices();
    const cur = list.find((d) => d.id === id && d.siteId === siteId);
    if (!cur) return null;
    const next = { ...cur, options: normalizeDeviceOptions({ ...normalizeDeviceOptions(cur.options), ...patch }) };
    await saveDevices(list.map((d) => (d.id === id ? next : d)));
    return next;
  });
}

export async function createDevice(siteId: string, name: string) {
  return withDevLock(async () => {
    const token = newToken();
    const pairCode = newPairCode();
    const d: KioskDevice = {
      id: `dev_${randomUUID().replace(/-/g, "").slice(0, 12)}`, siteId, name, tokenHash: sha(token), pairCodeHash: sha(normCode(pairCode)),
      pairCodeExpiresAt: new Date(Date.now() + PAIR_CODE_MS).toISOString(), createdAt: new Date().toISOString(), lastSeenAt: null,
    };
    await saveDevices([...(await loadDevices()), d]);
    return { device: d, token, pairCode };
  });
}

export async function revokeDevice(id: string, siteId?: string): Promise<boolean> {
  return withDevLock(async () => {
    const list = await loadDevices();
    const next = list.filter((d) => !(d.id === id && (!siteId || d.siteId === siteId)));
    if (next.length === list.length) return false;
    await saveDevices(next);
    pinFails.delete(id);
    return true;
  });
}

/** Exchange a short pairing code for a fresh device token (the code then stops working). */
async function pairWithCode(code: string): Promise<{ device: KioskDevice; token: string } | null> {
  return withDevLock(async () => {
    const list = await loadDevices();
    const h = sha(normCode(code));
    const d = list.find((x) => x.pairCodeHash && eqHex(x.pairCodeHash, h) && x.pairCodeExpiresAt && Date.parse(x.pairCodeExpiresAt) > Date.now());
    if (!d) return null;
    const token = newToken();
    const next = { ...d, tokenHash: sha(token), pairCodeHash: null, pairCodeExpiresAt: null, lastSeenAt: new Date().toISOString() };
    await saveDevices(list.map((x) => (x.id === d.id ? next : x)));
    return { device: next, token };
  });
}

const SEEN_PERSIST_MS = 10 * 60_000;
async function deviceForToken(token: string | undefined): Promise<KioskDevice | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const h = sha(token);
  const d = (await loadDevices()).find((x) => eqHex(x.tokenHash, h));
  if (!d) return null;
  // First use of the token retires the pairing code; otherwise record "last seen" now and then.
  const stale = !d.lastSeenAt || Date.now() - Date.parse(d.lastSeenAt) > SEEN_PERSIST_MS;
  if (d.pairCodeHash || stale) {
    void withDevLock(async () => {
      const list = await loadDevices();
      await saveDevices(list.map((x) => (x.id === d.id ? { ...x, pairCodeHash: null, pairCodeExpiresAt: null, lastSeenAt: new Date().toISOString() } : x)));
    }).catch(() => undefined);
  }
  return d;
}

// ── PIN brute-force protection (per device, in memory) ────────────────────────
export const PIN_MAX_FAILS = 5;
const LOCK_BASE_MS = () => Number(process.env.KIOSK_LOCK_MS) || 60_000;
const LOCK_MAX_MS = 15 * 60_000;
const pinFails = new Map<string, { n: number; lockedUntil: number; locks: number; last: number }>();

function pinLockedFor(deviceId: string): number {
  const f = pinFails.get(deviceId);
  if (!f) return 0;
  return Math.max(0, f.lockedUntil - Date.now());
}
/** Wrong PINs left before this device locks (for the "2 tries left" warning). */
function pinTriesLeft(deviceId: string): number {
  return PIN_MAX_FAILS - (pinFails.get(deviceId)?.n ?? 0);
}
function recordPin(deviceId: string, ok: boolean) {
  if (ok) { pinFails.delete(deviceId); return; }
  const now = Date.now();
  let f = pinFails.get(deviceId);
  if (!f || now - f.last > 30 * 60_000) f = { n: 0, lockedUntil: 0, locks: 0, last: now };
  f.n++;
  f.last = now;
  if (f.n >= PIN_MAX_FAILS) {
    f.lockedUntil = now + Math.min(LOCK_MAX_MS, LOCK_BASE_MS() * 2 ** f.locks);
    f.locks++;
    f.n = 0;
  }
  pinFails.set(deviceId, f);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, f] of pinFails) if (now - f.last > 60 * 60_000) pinFails.delete(k);
}, 10 * 60_000).unref();

// ── Manager PIN (per location) ───────────────────────────────────────────────
// Guards the kiosk's own settings: opening device settings, unpairing, and
// leaving full screen. Stored as a scrypt hash in the settings table.
export const MANAGER_PIN_RE = /^\d{4,8}$/;
const managerKey = (siteId: string) => `kiosk_manager_pin:${siteId}`;

export async function managerPinSet(siteId: string): Promise<boolean> {
  return !!(await (await db()).getSetting(managerKey(siteId)));
}
export async function setManagerPin(siteId: string, pin: string | null) {
  const store = await db();
  if (pin) await store.setSetting(managerKey(siteId), await hashPassword(`kiosk-manager:${pin}`));
  else await store.deleteSetting(managerKey(siteId));
}
async function checkManagerPin(siteId: string, pin: string): Promise<boolean> {
  const stored = await (await db()).getSetting(managerKey(siteId));
  return !!stored && MANAGER_PIN_RE.test(pin) && (await verifyHash(`kiosk-manager:${pin}`, stored));
}

// ── Short-lived "this person entered their PIN" ticket ───────────────────────
const TICKET_MS = 2 * 60_000;
const signTicket = (payload: string) => createHmac("sha256", getAuthSecret()).update(`kiosk-ticket:${payload}`).digest("base64url");
function issueTicket(deviceId: string, employeeId: string) {
  const payload = Buffer.from(JSON.stringify({ d: deviceId, e: employeeId, exp: Date.now() + TICKET_MS })).toString("base64url");
  return `${payload}.${signTicket(payload)}`;
}
function readTicket(ticket: string, deviceId: string): string | null {
  const [payload, sig] = ticket.split(".");
  if (!payload || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(signTicket(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (d.d !== deviceId || typeof d.exp !== "number" || d.exp < Date.now()) return null;
    return String(d.e);
  } catch { return null; }
}

/** The employee a ticket claims to be for (unverified: used only to order requests). */
function ticketEmployee(ticket: string | undefined): string | null {
  if (!ticket) return null;
  try {
    const d = JSON.parse(Buffer.from(ticket.split(".")[0] ?? "", "base64url").toString("utf8"));
    return typeof d?.e === "string" && d.e.length <= 64 ? d.e : null;
  } catch { return null; }
}

// ── Per-employee arrival order ───────────────────────────────────────────────
const arrivals = new Map<string, Promise<void>>();
/**
 * Join the queue for `key` right now (synchronously) and get a promise that
 * resolves when it is this caller's turn. Call done() when finished.
 */
export function acquireArrival(key: string): { ready: Promise<void>; done: () => void } {
  const prev = arrivals.get(key) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((r) => { done = r; });
  const tail = prev.then(() => mine);
  arrivals.set(key, tail);
  tail.then(() => { if (arrivals.get(key) === tail) arrivals.delete(key); });
  // Never hold a queue forever if something hangs.
  const timer = setTimeout(() => done(), 30_000);
  timer.unref?.();
  return { ready: prev, done: () => { clearTimeout(timer); done(); } };
}

// ── Kiosk API ─────────────────────────────────────────────────────────────────
type Handler = (req: Request, res: Response) => Promise<unknown>;
export const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch((err) => {
    if (err instanceof PunchError) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  });
};

export interface Ctx { device: KioskDevice; site: Site }
export const ctx =(res: Response) => res.locals.kiosk as Ctx;

/** Clock-in is allowed only where the location uses the kiosk. */
export const kioskEnabled = (site: Site) => site.timeSource === "kiosk" || site.timeSource === "both";

const pairThrottle = new Map<string, { n: number; until: number }>();

/** An employee's clock state now, today's hours and breaks, and whether a break is due. */
export async function employeeClock(site: Site, employeeId: string, now = Date.now()) {
  const from = new Date(now - 3 * 86_400_000).toISOString();
  const punches = await (await db()).listPunches({ siteId: site.id, employeeId, from, to: new Date(now + 3 * 60_000).toISOString() });
  const st = clockState(punches, now);
  const today = localRange(todayISO(site.rules.timezone), todayISO(site.rules.timezone), site.rules.timezone);
  const day = daySummary(punches, Date.parse(today.from), Date.parse(today.to), now);
  const rule = (await getSiteConfig(site.id)).breakReminderHours;
  const bd = breakDue(punches, rule, now);
  const station = st.shiftStart ? (punches.find((p) => p.type === "in" && p.at === st.shiftStart)?.meta?.station ?? null) : null;
  return {
    ...st, todayMinutes: day.workedMinutes, breakMinutes: day.breakMinutes, breaks: day.breaks, station,
    breakDue: bd.due, minutesWithoutBreak: bd.minutesWithoutBreak, breakReminderHours: rule,
  };
}
type Clock = Awaited<ReturnType<typeof employeeClock>>;
/** What the kiosk shows about a person's day (no pay information). */
export const clockView = (st: Clock) => ({
  status: st.status, since: st.since, shiftStart: st.shiftStart, todayMinutes: st.todayMinutes, breakMinutes: st.breakMinutes, breaks: st.breaks,
  station: st.station, breakDue: st.breakDue, minutesWithoutBreak: st.minutesWithoutBreak,
});

function lockedResponse(res: Response, ms: number) {
  const secs = Math.ceil(ms / 1000);
  res.setHeader("Retry-After", String(secs));
  return res.status(429).json({ error: `Too many wrong PINs. Try again in ${secs < 90 ? `${secs} seconds` : `${Math.ceil(secs / 60)} minutes`}.`, code: "locked", retryAfter: secs });
}

/** Check a PIN (or a ticket from /identify) and return the employee. Sends the error response itself. */
export async function authenticateEmployee(req: Request, res: Response, body: { pin?: string; employeeId?: string; ticket?: string }): Promise<StoredEmployee | null> {
  const { device, site } = ctx(res);
  if (body.ticket) {
    const id = readTicket(body.ticket, device.id);
    const e = id ? await getEmployee(site.id, id) : undefined;
    if (e && e.active) return e;
    if (!body.pin) { res.status(401).json({ error: "That took too long. Enter your PIN again.", code: "ticket" }); return null; }
  }
  return withPinAttempt(device.id, async () => {
    const locked = pinLockedFor(device.id);
    if (locked) { lockedResponse(res, locked); return null; }
    const pin = String(body.pin ?? "");
    const e = PIN_RE.test(pin) ? await findByPin(site.id, pin, body.employeeId || undefined) : null;
    recordPin(device.id, !!e);
    if (!e) {
      const nowLocked = pinLockedFor(device.id);
      if (nowLocked) { lockedResponse(res, nowLocked); return null; }
      const left = pinTriesLeft(device.id);
      res.status(403).json({ error: left <= 2 ? `That PIN didn't match. ${left} ${left === 1 ? "try" : "tries"} left before this clock locks for a while.` : "That PIN didn't match. Try again.", code: "pin", triesLeft: left });
      return null;
    }
    return e;
  });
}

/**
 * PIN attempts for one lockout key are checked one at a time: the lock is
 * checked, the PIN verified and the result recorded before the next attempt
 * starts. Parallel guesses therefore can't slip past the lockout, and once the
 * lock trips even the right PIN waits until it expires.
 */
async function withPinAttempt<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const turn = acquireArrival(`attempt:${lockKey}`);
  try {
    await turn.ready;
    return await fn();
  } finally {
    turn.done();
  }
}

/** Device-token endpoints. Register before the admin auth middleware. */
export function registerKioskRoutes(app: Express) {
  // Pairing with a short code: the only kiosk call without a device token.
  app.post("/api/kiosk/pair", h(async (req, res) => {
    const ip = req.ip ?? "unknown";
    const t = pairThrottle.get(ip);
    if (t && t.until > Date.now() && t.n >= 10) return res.status(429).json({ error: "Too many attempts. Wait a few minutes and try again.", code: "locked" });
    const { code } = z.object({ code: z.string().trim().min(4).max(20) }).parse(req.body);
    const r = await pairWithCode(code);
    if (!r) {
      const cur = pairThrottle.get(ip);
      pairThrottle.set(ip, !cur || cur.until < Date.now() ? { n: 1, until: Date.now() + 15 * 60_000 } : { n: cur.n + 1, until: cur.until });
      return res.status(403).json({ error: "That pairing code isn't valid or has expired. Create a new one in Settings → Locations → Time clock.", code: "pair" });
    }
    pairThrottle.delete(ip);
    const site = await settings.getSite(r.device.siteId);
    res.json({ token: r.token, device: { id: r.device.id, name: r.device.name }, site: site ? { id: site.id, name: site.name } : null });
  }));

  // Everything else needs a valid device token.
  app.use("/api/kiosk", (req: Request, res: Response, next: NextFunction) => {
    (async () => {
      const device = await deviceForToken(req.header("x-kiosk-token") ?? undefined);
      if (!device) return res.status(401).json({ error: "This device isn't paired, or it was removed. Pair it again from the admin app.", code: "device" });
      const site = await settings.getSite(device.siteId);
      if (!site) return res.status(401).json({ error: "This device's location no longer exists.", code: "device" });
      res.locals.kiosk = { device, site } satisfies Ctx;
      next();
    })().catch(next);
  });

  app.get("/api/kiosk/state", h(async (_req, res) => {
    const { device, site } = ctx(res);
    const now = Date.now();
    const employees = (await listEmployees(site.id)).filter((e) => e.active && e.pinHash);
    const from = new Date(now - 2 * 86_400_000).toISOString();
    const punches = kioskEnabled(site) ? await (await db()).listPunches({ siteId: site.id, from }) : [];
    const byEmp = new Map<string, Punch[]>();
    for (const p of punches) { if (!byEmp.has(p.employeeId)) byEmp.set(p.employeeId, []); byEmp.get(p.employeeId)!.push(p); }
    const options = normalizeDeviceOptions(device.options);
    const config = await getSiteConfig(site.id);
    res.json({
      device: { id: device.id, name: device.name },
      site: {
        id: site.id, name: site.name, color: site.color, timezone: site.rules.timezone, enabled: kioskEnabled(site), managerPinSet: await managerPinSet(site.id),
        loginMode: options.loginMode === "site" ? site.kioskLoginMode : options.loginMode,
      },
      options: { photo: options.photo, idleSeconds: options.idleSeconds, stations: options.stations ? config.stations : [], breakReminderHours: config.breakReminderHours },
      serverTime: new Date(now).toISOString(),
      employees: employees.map((e) => {
        const st = clockState(byEmp.get(e.id) ?? [], now);
        return { id: e.id, name: e.name, role: e.role, status: st.status, since: st.since };
      }).sort((a, b) => a.name.localeCompare(b.name)),
    });
  }));

  // Manager PIN: unlock the device settings (and full-screen exit) on this kiosk.
  // Shares the device's wrong-PIN lockout so it can't be guessed.
  const managerGate = async (req: Request, res: Response): Promise<boolean> => {
    const { device, site } = ctx(res);
    const lockKey = `mgr:${device.id}`;
    const { pin } = z.object({ pin: z.string().max(12).default("") }).parse(req.body ?? {});
    // One attempt at a time per device (see withPinAttempt), so the lockout can't be raced.
    return withPinAttempt(lockKey, async () => {
      const locked = pinLockedFor(lockKey);
      if (locked) { lockedResponse(res, locked); return false; }
      if (!(await managerPinSet(site.id))) {
        res.status(409).json({ error: "No manager PIN is set for this location. Set one in the admin app: Settings → Locations → Time clock.", code: "no_manager_pin" });
        return false;
      }
      const ok = await checkManagerPin(site.id, pin);
      recordPin(lockKey, ok);
      if (!ok) {
        const nowLocked = pinLockedFor(lockKey);
        if (nowLocked) lockedResponse(res, nowLocked);
        else res.status(403).json({ error: "That manager PIN isn't right.", code: "pin" });
        return false;
      }
      return true;
    });
  };
  app.post("/api/kiosk/manager-unlock", h(async (req, res) => {
    if (await managerGate(req, res)) res.json({ ok: true });
  }));
  // Unpairing from the kiosk revokes the device on the server too.
  app.post("/api/kiosk/unpair", h(async (req, res) => {
    if (!(await managerGate(req, res))) return;
    const { device, site } = ctx(res);
    await revokeDevice(device.id, site.id);
    res.json({ ok: true });
  }));

  app.post("/api/kiosk/identify", h(async (req, res) => {
    const { site, device } = ctx(res);
    if (!kioskEnabled(site)) return res.status(403).json({ error: "The time clock is turned off for this location.", code: "disabled" });
    const body = z.object({ pin: z.string().max(12), employeeId: z.string().max(64).optional() }).parse(req.body);
    const e = await authenticateEmployee(req, res, body);
    if (!e) return;
    const st = await employeeClock(site, e.id);
    res.json({
      employee: { id: e.id, name: e.name, role: e.role }, ...clockView(st), actions: allowedActions(st.status), ticket: issueTicket(device.id, e.id),
    });
  }));

  app.post("/api/kiosk/punch", h(async (req, res) => {
    const { site, device } = ctx(res);
    if (!kioskEnabled(site)) return res.status(403).json({ error: "The time clock is turned off for this location.", code: "disabled" });
    const body = z.object({
      id: z.string().regex(PUNCH_ID_RE, "Invalid punch id."),
      type: z.enum(PUNCH_TYPES),
      ticket: z.string().max(600).optional(),
      pin: z.string().max(12).optional(),
      employeeId: z.string().max(64).optional(),
      at: z.string().max(40).optional(),
      station: z.string().max(80).nullish(),
      /** JPEG data URL from the front camera, or null when the camera was unavailable. */
      photo: z.string().max(300_000).nullish(),
    }).parse(req.body);

    // Punches for one employee are handled strictly in the order they arrive, from
    // here (before the PIN check, which takes time) to the insert. Otherwise two
    // devices punching the same person a moment apart could be checked out of order.
    // The lock is taken synchronously, before any await, so arrival order is kept.
    const claimed = body.employeeId || ticketEmployee(body.ticket);
    const release = claimed ? acquireArrival(`${site.id}|${claimed}`) : null;
    try {
      await release?.ready;
      return await punchLocked();
    } finally {
      release?.done();
    }

    async function punchLocked() {
    // A replay of a punch this device already sent: answer the same way, without asking for the PIN again.
    const prior = await (await db()).getPunch(body.id);
    if (prior && prior.deviceId === device.id && prior.siteId === site.id) {
      const st = await employeeClock(site, prior.employeeId);
      return res.json({ punch: { id: prior.id, type: prior.type, at: prior.at }, employee: { id: prior.employeeId, name: prior.employeeName }, ...clockView(st), duplicate: true, notes: [] });
    }

    const now = Date.now();
    let at = now;
    if (body.at) {
      const t = Date.parse(body.at);
      if (!Number.isFinite(t)) return res.status(400).json({ error: "Invalid time.", code: "time" });
      if (t > now + 2 * 60_000) return res.status(422).json({ error: "This device's clock is ahead of the server. Check the tablet's date and time.", code: "time" });
      if (t < now - 24 * 3600_000) return res.status(422).json({ error: "This punch is more than 24 hours old and wasn't saved. Ask a manager to add it.", code: "time" });
      at = Math.min(t, now);
    }

    const e = await authenticateEmployee(req, res, body);
    if (!e) return;
    // A live punch is stamped now, in arrival order (the PIN check may have taken a moment).
    if (!body.at) at = Math.max(at, Date.now());

    // Extras chosen per device / location: a station at clock-in, and a photo.
    const options = normalizeDeviceOptions(device.options);
    const meta: PunchMeta = {};
    if (body.type === "in" && options.stations && body.station) {
      const station = matchStation((await getSiteConfig(site.id)).stations, body.station);
      if (station) meta.station = station;
    }
    // Photos on: a live punch must come with a photo (the kiosk checks it shows a
    // face before sending). Punches queued while offline are still accepted
    // without one, so a punch saved on the tablet is never lost over a photo.
    if (options.photo && !body.at && !body.photo) {
      return res.status(422).json({ error: "Face not detected. This time clock takes a photo with each punch: look at the camera and try again.", code: "photo" });
    }
    const photoBytes = options.photo && body.photo ? decodePhoto(body.photo) : null;
    if (options.photo && !body.at && !photoBytes) {
      return res.status(422).json({ error: "The photo didn't come through. Look at the camera and try again.", code: "photo" });
    }
    let photoSaved = false;
    // Photos on: every punch records whether it has one ("none" for a queued punch without one).
    if (options.photo) {
      photoSaved = !!photoBytes && savePhoto(site.id, body.id, photoBytes);
      meta.photo = photoSaved ? "saved" : "none";
    }

    let result: Awaited<ReturnType<typeof recordPunch>>;
    try {
      result = await recordPunch({
        id: body.id, site, employee: e, type: body.type, at: new Date(at).toISOString(), source: "kiosk", deviceId: device.id, audience: "kiosk", meta,
      });
    } catch (err) {
      if (photoSaved) deletePhoto(site.id, body.id);
      // Wrong action for the current state: say what makes sense instead.
      if (err instanceof PunchError && err.code === "state") {
        const st = await employeeClock(site, e.id);
        const check = checkAction(st.status, body.type);
        return res.status(409).json({
          error: err.message, code: "state", status: st.status, suggest: check.suggest ?? null, question: check.question ?? null,
          actions: allowedActions(st.status), ticket: issueTicket(device.id, e.id),
        });
      }
      throw err;
    }
    const { punch, created } = result;
    const st = await employeeClock(site, e.id);
    const notes = punch.type === "in" && created
      ? notesFor(await listNotes(site.id), e.id).map((n) => ({ id: n.id, text: n.text, createdAt: n.createdAt, createdBy: n.createdBy }))
      : [];
    res.json({
      punch: { id: punch.id, type: punch.type, at: punch.at, station: punch.meta?.station ?? null, photo: punch.meta?.photo ?? null },
      employee: { id: e.id, name: e.name }, ...clockView(st), duplicate: !created, notes,
      ticket: notes.length ? issueTicket(device.id, e.id) : undefined,
    });
    }
  }));

  registerKioskDeviceFeatureRoutes(app, { ctx, kioskEnabled, authenticateEmployee }); // shift notes and fix requests (device token)
  app.use("/api/kiosk", (_req: Request, res: Response) => res.status(404).json({ error: "Not found." }));
}

// ── Admin: devices and the rest of the time clock ─────────────────────────────
/** Admin endpoints for the time clock. Register after the admin auth middleware. */
export function registerTimeClockAdminRoutes(app: Express) {
  registerEmployeeRoutes(app);
  registerPunchRoutes(app);
  registerLiveRoutes(app);

  app.get("/api/sites/:siteId/kiosk-devices", h(async (req, res) => {
    const siteId = String(req.params.siteId);
    res.json((await loadDevices()).filter((d) => d.siteId === siteId).map(deviceView));
  }));
  app.post("/api/sites/:siteId/kiosk-devices", h(async (req, res) => {
    const site = await settings.getSite(String(req.params.siteId));
    if (!site) return res.status(404).json({ error: "Location not found." });
    const { name } = z.object({ name: z.string().trim().min(1).max(60).default("Time clock") }).parse(req.body ?? {});
    const { device, token, pairCode } = await createDevice(site.id, name);
    res.json({ device: deviceView(device), token, pairCode, pairPath: `/kiosk#pair=${token}` });
  }));
  app.delete("/api/sites/:siteId/kiosk-devices/:id", h(async (req, res) => {
    res.json({ ok: await revokeDevice(String(req.params.id), String(req.params.siteId)) });
  }));
  app.put("/api/sites/:siteId/kiosk-devices/:id/options", h(async (req, res) => {
    const patch = z.object({
      photo: z.boolean().optional(),
      loginMode: z.enum(DEVICE_LOGIN_MODES).optional(),
      idleSeconds: z.number().int().min(IDLE_MIN).max(IDLE_MAX).optional(),
      stations: z.boolean().optional(),
    }).strict().parse(req.body ?? {});
    const d = await setDeviceOptions(String(req.params.siteId), String(req.params.id), patch);
    if (!d) return res.status(404).json({ error: "Device not found." });
    res.json(deviceView(d));
  }));
  app.get("/api/sites/:siteId/kiosk-manager-pin", h(async (req, res) => {
    res.json({ set: await managerPinSet(String(req.params.siteId)) });
  }));
  app.put("/api/sites/:siteId/kiosk-manager-pin", h(async (req, res) => {
    const site = await settings.getSite(String(req.params.siteId));
    if (!site) return res.status(404).json({ error: "Location not found." });
    const { pin } = z.object({ pin: z.string().regex(MANAGER_PIN_RE, "Use 4 to 8 digits.").nullable() }).parse(req.body ?? {});
    if (pin) {
      const weak = weakPinReason(pin);
      if (weak) return res.status(400).json({ error: weak, code: "weak_pin" });
      if (await pinInUse(site.id, pin)) return res.status(409).json({ error: "An employee at this location uses that PIN. Choose a different manager PIN.", code: "pin_in_use" });
    }
    await setManagerPin(site.id, pin);
    res.json({ set: !!pin });
  }));
}

// ── KIOSK_HOST: a hostname that serves only the kiosk ────────────────────────
let kioskAssets: Set<string> | null = null;
/** Files the kiosk page needs, read from Vite's build manifest. */
function kioskAssetSet(): Set<string> {
  if (kioskAssets) return kioskAssets;
  const set = new Set<string>();
  try {
    const base = typeof __dirname !== "undefined" ? path.resolve(__dirname, "public") : path.resolve(process.cwd(), "dist", "public");
    const manifest = JSON.parse(fs.readFileSync(path.join(base, ".vite", "manifest.json"), "utf8"));
    const walk = (key: string) => {
      const m = manifest[key];
      if (!m || set.has(`/${m.file}`)) return;
      set.add(`/${m.file}`);
      for (const c of m.css ?? []) set.add(`/${c}`);
      for (const a of m.assets ?? []) set.add(`/${a}`);
      for (const i of m.imports ?? []) walk(i);
    };
    walk("kiosk.html");
  } catch { /* no build manifest (development) */ }
  kioskAssets = set;
  return set;
}

/** The face-check model and runtime the kiosk loads (see client/src/kiosk/face.ts). */
const FACE_FILES = new Set(["blaze_face_short_range.tflite", "vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"].map((f) => `/face/${f}`));

const DEV_PREFIXES = ["/@vite/", "/@fs/", "/@id/", "/@react-refresh", "/node_modules/", "/src/", "/vite-hmr"];

/**
 * When KIOSK_HOST is set (comma-separated hostnames) and a request arrives for
 * that host, only the kiosk page, its assets, /api/kiosk/* and /api/health are
 * served; "/" redirects to /kiosk. Read on every request so it can be changed
 * without code changes (and tested).
 */
export function kioskHostGuard() {
  return (req: Request, res: Response, next: NextFunction) => {
    const hosts = (process.env.KIOSK_HOST ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!hosts.length) return next();
    const host = String(req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    if (!hosts.includes(host)) return next();
    const p = req.path;
    if (p === "/" && (req.method === "GET" || req.method === "HEAD")) return res.redirect(302, "/kiosk");
    if (p === "/api/health" || p.startsWith("/api/kiosk/") || p === "/kiosk" || p === "/kiosk/" || p === "/favicon.svg") return next();
    // Installable kiosk (home-screen icon, manifest, the static-shell service worker,
    // and the Android app's Digital Asset Links file)
    if (p === "/kiosk.webmanifest" || p === "/sw.js" || p === "/.well-known/assetlinks.json" || /^\/icons\/[\w.-]+$/.test(p)) return next();
    // Face check for photo on punch (model and WebAssembly runtime)
    if (FACE_FILES.has(p)) return next();
    if (kioskAssetSet().has(p)) return next();
    if (process.env.NODE_ENV !== "production" && DEV_PREFIXES.some((x) => p.startsWith(x))) return next();
    if (p.startsWith("/api/")) return res.status(404).json({ error: "Not found." });
    res.status(404).type("text/plain").send("Not found");
  };
}
