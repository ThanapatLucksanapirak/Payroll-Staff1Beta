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
import { PUNCH_TYPES, type Punch, allowedActions, clockState, localRange, workedMinutes } from "@shared/punches";
import { getAuthSecret } from "./config";
import { db } from "./db";
import type { DataStore } from "./db/types";
import * as settings from "./settings";
import { type StoredEmployee, PIN_RE, findByPin, getEmployee, listEmployees, registerEmployeeRoutes } from "./employees";
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
}
const DEVICES_KEY = "kiosk_devices";
const PAIR_CODE_MS = 15 * 60_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const eqHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

let devCache: { store: DataStore; list: KioskDevice[]; at: number } | null = null;
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
});

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

// ── Kiosk API ─────────────────────────────────────────────────────────────────
type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch((err) => {
    if (err instanceof PunchError) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  });
};

interface Ctx { device: KioskDevice; site: Site }
const ctx = (res: Response) => res.locals.kiosk as Ctx;

/** Clock-in is allowed only where the location uses the kiosk. */
const kioskEnabled = (site: Site) => site.timeSource === "kiosk" || site.timeSource === "both";

const pairThrottle = new Map<string, { n: number; until: number }>();

async function employeeClock(site: Site, employeeId: string, now = Date.now()) {
  const from = new Date(now - 3 * 86_400_000).toISOString();
  const punches = await (await db()).listPunches({ siteId: site.id, employeeId, from, to: new Date(now + 3 * 60_000).toISOString() });
  const st = clockState(punches, now);
  const today = localRange(todayISO(site.rules.timezone), todayISO(site.rules.timezone), site.rules.timezone);
  return { ...st, todayMinutes: workedMinutes(punches, Date.parse(today.from), Date.parse(today.to), now) };
}

function lockedResponse(res: Response, ms: number) {
  const secs = Math.ceil(ms / 1000);
  res.setHeader("Retry-After", String(secs));
  return res.status(429).json({ error: `Too many wrong PINs. Try again in ${secs < 90 ? `${secs} seconds` : `${Math.ceil(secs / 60)} minutes`}.`, code: "locked", retryAfter: secs });
}

/** Check a PIN (or a ticket from /identify) and return the employee. Sends the error response itself. */
async function authenticateEmployee(req: Request, res: Response, body: { pin?: string; employeeId?: string; ticket?: string }): Promise<StoredEmployee | null> {
  const { device, site } = ctx(res);
  if (body.ticket) {
    const id = readTicket(body.ticket, device.id);
    const e = id ? await getEmployee(site.id, id) : undefined;
    if (e && e.active) return e;
    if (!body.pin) { res.status(401).json({ error: "That took too long. Enter your PIN again.", code: "ticket" }); return null; }
  }
  const locked = pinLockedFor(device.id);
  if (locked) { lockedResponse(res, locked); return null; }
  const pin = String(body.pin ?? "");
  const e = PIN_RE.test(pin) ? await findByPin(site.id, pin, body.employeeId || undefined) : null;
  recordPin(device.id, !!e);
  if (!e) {
    const nowLocked = pinLockedFor(device.id);
    if (nowLocked) { lockedResponse(res, nowLocked); return null; }
    res.status(403).json({ error: "That PIN didn't match. Try again.", code: "pin" });
    return null;
  }
  return e;
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
    res.json({
      device: { id: device.id, name: device.name },
      site: { id: site.id, name: site.name, color: site.color, timezone: site.rules.timezone, loginMode: site.kioskLoginMode, enabled: kioskEnabled(site), managerPinSet: await managerPinSet(site.id) },
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
    const locked = pinLockedFor(lockKey);
    if (locked) { lockedResponse(res, locked); return false; }
    const { pin } = z.object({ pin: z.string().max(12).default("") }).parse(req.body ?? {});
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
      employee: { id: e.id, name: e.name, role: e.role }, status: st.status, since: st.since, shiftStart: st.shiftStart,
      todayMinutes: st.todayMinutes, actions: allowedActions(st.status), ticket: issueTicket(device.id, e.id),
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
    }).parse(req.body);

    // A replay of a punch this device already sent: answer the same way, without asking for the PIN again.
    const prior = await (await db()).getPunch(body.id);
    if (prior && prior.deviceId === device.id && prior.siteId === site.id) {
      const st = await employeeClock(site, prior.employeeId);
      return res.json({ punch: { id: prior.id, type: prior.type, at: prior.at }, employee: { id: prior.employeeId, name: prior.employeeName }, status: st.status, since: st.since, todayMinutes: st.todayMinutes, duplicate: true });
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
    const { punch, created } = await recordPunch({
      id: body.id, site, employee: e, type: body.type, at: new Date(at).toISOString(), source: "kiosk", deviceId: device.id, audience: "kiosk",
    });
    const st = await employeeClock(site, e.id);
    res.json({ punch: { id: punch.id, type: punch.type, at: punch.at }, employee: { id: e.id, name: e.name }, status: st.status, since: st.since, todayMinutes: st.todayMinutes, duplicate: !created });
  }));

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
  app.get("/api/sites/:siteId/kiosk-manager-pin", h(async (req, res) => {
    res.json({ set: await managerPinSet(String(req.params.siteId)) });
  }));
  app.put("/api/sites/:siteId/kiosk-manager-pin", h(async (req, res) => {
    const site = await settings.getSite(String(req.params.siteId));
    if (!site) return res.status(404).json({ error: "Location not found." });
    const { pin } = z.object({ pin: z.string().regex(MANAGER_PIN_RE, "Use 4 to 8 digits.").nullable() }).parse(req.body ?? {});
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
    if (kioskAssetSet().has(p)) return next();
    if (process.env.NODE_ENV !== "production" && DEV_PREFIXES.some((x) => p.startsWith(x))) return next();
    if (p.startsWith("/api/")) return res.status(404).json({ error: "Not found." });
    res.status(404).type("text/plain").send("Not found");
  };
}
