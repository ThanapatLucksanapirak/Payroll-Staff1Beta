// Employee directory for the time clock, one per location. Stored in the
// app_settings key/value table so it works on SQLite and Supabase alike.
import { parsePatch } from "@shared/patch";
import { randomBytes, randomUUID, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { employeeKey, normalizeName } from "@shared/engine";
import { rowToDoc } from "@shared/legacy";
import { db } from "./db";
import type { DataStore } from "./db/types";
import * as settings from "./settings";
import { verifyHash } from "./passwords";

const scrypt = promisify(nodeScrypt) as (pw: string, salt: string, len: number) => Promise<Buffer>;

export interface StoredEmployee {
  id: string;
  name: string;
  role: string;
  active: boolean;
  pinHash: string | null;
  createdAt: string;
  updatedAt: string;
}
/** What the admin app sees: never the PIN hash. */
export interface EmployeeView { id: string; name: string; role: string; active: boolean; hasPin: boolean; createdAt: string; updatedAt: string }
interface Directory { salt: string; employees: StoredEmployee[] }

const key = (siteId: string) => `employees:${siteId}`;
export const PIN_RE = /^\d{4,6}$/;

export const view = (e: StoredEmployee): EmployeeView => ({
  id: e.id, name: e.name, role: e.role, active: e.active, hasPin: !!e.pinHash, createdAt: e.createdAt, updatedAt: e.updatedAt,
});

// Small in-memory cache keyed by store; writes go through it so reads after a
// write on this server are always fresh. A short TTL picks up restores.
const TTL = 30_000;
let cache: { store: DataStore; dirs: Map<string, { dir: Directory; at: number }> } | null = null;

async function load(siteId: string): Promise<Directory> {
  const store = await db();
  if (!cache || cache.store !== store) cache = { store, dirs: new Map() };
  const hit = cache.dirs.get(siteId);
  if (hit && Date.now() - hit.at < TTL) return hit.dir;
  let dir: Directory | null = null;
  try { dir = JSON.parse((await store.getSetting(key(siteId))) ?? "null"); } catch { dir = null; }
  if (!dir || typeof dir.salt !== "string" || !Array.isArray(dir.employees)) dir = { salt: randomBytes(16).toString("base64url"), employees: [] };
  cache.dirs.set(siteId, { dir, at: Date.now() });
  return dir;
}

async function save(siteId: string, dir: Directory) {
  const store = await db();
  await store.setSetting(key(siteId), JSON.stringify(dir));
  if (!cache || cache.store !== store) cache = { store, dirs: new Map() };
  cache.dirs.set(siteId, { dir, at: Date.now() });
}

/** Serialise read-modify-write changes per location. */
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(siteId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(siteId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(siteId, next.catch(() => undefined));
  return next;
}

export function invalidateEmployeeCache() { cache = null; }

/** PINs are hashed with scrypt and a per-location salt, so a PIN can be looked up (PIN-only sign-in) and kept unique. */
async function hashPin(pin: string, salt: string): Promise<string> {
  return (await scrypt(pin, `kiosk-pin:${salt}`, 32)).toString("base64url");
}
function sameHash(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function listEmployees(siteId: string): Promise<StoredEmployee[]> {
  return (await load(siteId)).employees;
}

export async function getEmployee(siteId: string, id: string): Promise<StoredEmployee | undefined> {
  return (await load(siteId)).employees.find((e) => e.id === id);
}

/** The active employee with this PIN (optionally a specific employee), or null. */
export async function findByPin(siteId: string, pin: string, employeeId?: string): Promise<StoredEmployee | null> {
  if (!PIN_RE.test(pin)) return null;
  const dir = await load(siteId);
  const h = await hashPin(pin, dir.salt);
  const match = dir.employees.find((e) => e.active && e.pinHash && sameHash(e.pinHash, h) && (!employeeId || e.id === employeeId));
  return match ?? null;
}

/** Does any employee at the location (active or not) use this PIN? */
export async function pinInUse(siteId: string, pin: string): Promise<boolean> {
  if (!PIN_RE.test(pin)) return false;
  const dir = await load(siteId);
  const h = await hashPin(pin, dir.salt);
  return dir.employees.some((e) => e.pinHash && sameHash(e.pinHash, h));
}

/** Is this the location's kiosk manager PIN? (Same key and hash input as kiosk.ts.) */
async function isManagerPin(siteId: string, pin: string): Promise<boolean> {
  const stored = await (await db()).getSetting(`kiosk_manager_pin:${siteId}`);
  return !!stored && (await verifyHash(`kiosk-manager:${pin}`, stored));
}

const err = (status: number, message: string) => Object.assign(new Error(message), { status });
const MANAGER_CLASH = "That's this location's kiosk manager PIN. Choose a different one.";

async function checkUnique(dir: Directory, selfId: string | null, name: string, pinHash: string | null) {
  const k = employeeKey(name);
  if (dir.employees.some((e) => e.id !== selfId && employeeKey(e.name) === k)) throw err(409, `${name} is already in the list for this location.`);
  if (pinHash && dir.employees.some((e) => e.id !== selfId && e.pinHash === pinHash)) throw err(409, "Another employee at this location already uses that PIN. Choose a different one.");
}

export const employeeInputSchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(80),
  pin: z.string().trim().regex(PIN_RE, "The PIN must be 4 to 6 digits.").nullable().optional(),
  role: z.string().trim().max(60).default(""),
  active: z.boolean().default(true),
});

export async function createEmployee(siteId: string, input: z.input<typeof employeeInputSchema>): Promise<StoredEmployee> {
  const data = employeeInputSchema.parse(input);
  return withLock(siteId, async () => {
    const dir = await load(siteId);
    const name = normalizeName(data.name);
    const pinHash = data.pin ? await hashPin(data.pin, dir.salt) : null;
    await checkUnique(dir, null, name, pinHash);
    if (data.pin && (await isManagerPin(siteId, data.pin))) throw err(409, MANAGER_CLASH);
    const now = new Date().toISOString();
    const e: StoredEmployee = { id: `emp_${randomUUID().replace(/-/g, "").slice(0, 12)}`, name, role: data.role, active: data.active, pinHash, createdAt: now, updatedAt: now };
    await save(siteId, { ...dir, employees: [...dir.employees, e] });
    return e;
  });
}

export async function updateEmployee(siteId: string, id: string, patch: Partial<z.input<typeof employeeInputSchema>>): Promise<StoredEmployee> {
  const data = parsePatch(employeeInputSchema, patch);
  return withLock(siteId, async () => {
    const dir = await load(siteId);
    const cur = dir.employees.find((e) => e.id === id);
    if (!cur) throw err(404, "Employee not found.");
    const next: StoredEmployee = { ...cur, updatedAt: new Date().toISOString() };
    if (data.name !== undefined) next.name = normalizeName(data.name);
    if (data.role !== undefined) next.role = data.role;
    if (data.active !== undefined) next.active = data.active;
    if (data.pin !== undefined) next.pinHash = data.pin ? await hashPin(data.pin, dir.salt) : null;
    await checkUnique(dir, id, next.name, data.pin ? next.pinHash : null);
    if (data.pin && (await isManagerPin(siteId, data.pin))) throw err(409, MANAGER_CLASH);
    await save(siteId, { ...dir, employees: dir.employees.map((e) => (e.id === id ? next : e)) });
    return next;
  });
}

export async function deleteEmployee(siteId: string, id: string): Promise<boolean> {
  return withLock(siteId, async () => {
    const dir = await load(siteId);
    if (!dir.employees.some((e) => e.id === id)) return false;
    await save(siteId, { ...dir, employees: dir.employees.filter((e) => e.id !== id) });
    return true;
  });
}

/** Names already used at this location (saved wages and recent timesheets) that are not in the directory yet. */
export async function nameSuggestions(siteId: string): Promise<{ name: string; from: string }[]> {
  const store = await db();
  const existing = new Set((await listEmployees(siteId)).map((e) => employeeKey(e.name)));
  const found = new Map<string, { name: string; from: string }>();
  const add = (raw: string, from: string) => {
    const name = normalizeName(raw);
    const k = employeeKey(name);
    if (!name || existing.has(k) || found.has(k)) return;
    found.set(k, { name, from });
  };
  for (const w of await settings.getWageProfile(siteId)) add(w.name, "Saved rates");
  const def = await settings.defaultSiteId();
  const sites = await settings.getSites();
  const site = sites.find((s) => s.id === siteId);
  const recent = (await store.listTimesheets()).filter((t) => !t.deletedAt && (t.siteId ?? def) === siteId).slice(0, 12);
  for (const t of recent) {
    const row = await store.getTimesheet(t.id).catch(() => null);
    if (!row || !site) continue;
    try {
      const doc = rowToDoc(row, { defaultSiteId: site.id, rules: site.rules });
      for (const s of doc.shifts) add(s.employee, "Timesheets");
      for (const e of doc.employees) add(e.name, "Timesheets");
    } catch { /* unreadable row */ }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

async function siteOr404(req: Request, res: Response) {
  const site = await settings.getSite(String(req.params.siteId));
  if (!site) { res.status(404).json({ error: "Location not found." }); return null; }
  return site;
}

/** Admin endpoints (behind the admin session). */
export function registerEmployeeRoutes(app: Express) {
  app.get("/api/sites/:siteId/employees", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    res.json((await listEmployees(site.id)).map(view).sort((a, b) => a.name.localeCompare(b.name)));
  }));
  app.post("/api/sites/:siteId/employees", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    res.json(view(await createEmployee(site.id, req.body)));
  }));
  app.put("/api/sites/:siteId/employees/:id", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    res.json(view(await updateEmployee(site.id, String(req.params.id), req.body)));
  }));
  app.delete("/api/sites/:siteId/employees/:id", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    res.json({ ok: await deleteEmployee(site.id, String(req.params.id)) });
  }));
  app.get("/api/sites/:siteId/employee-suggestions", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    res.json(await nameSuggestions(site.id));
  }));
  app.post("/api/sites/:siteId/employees/import", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    const { names } = z.object({ names: z.array(z.string().trim().min(1).max(80)).min(1).max(500) }).parse(req.body);
    const created: EmployeeView[] = [];
    const skipped: string[] = [];
    for (const n of names) {
      try { created.push(view(await createEmployee(site.id, { name: n }))); } catch { skipped.push(n); }
    }
    res.json({ created, skipped });
  }));
}
