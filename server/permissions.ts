// Per-role permissions (Settings → Users → Roles).
//
// Owners and administrators can always do everything. Managers and viewers get
// the permissions ticked for their role; until someone changes them, the
// defaults equal what those roles could do before (see shared/permissions.ts).
//
// Enforcement:
//  - access.ts: a POLICY rule may name a permission. For managers and viewers
//    the permission decides (instead of the rule's role need). Rules without one
//    keep their role need, and routes in a few areas (schedule, approvals,
//    reports) additionally need that area's permission.
//  - Without "pay.view", every numeric money field (rates, amounts, totals) in
//    JSON answered to GET /api/* is replaced by 0, so new routes are covered too.
//  - The bootstrap / me / status payloads carry `user.permissions`, so the UI
//    hides what the user can't use.
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  type Permission, type RolePermissions, ACCOUNTANT_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, LIMITED_ROLES, PERMISSIONS, PERMISSION_INFO,
  normalizeRolePermissions, permissionsForRole,
} from "@shared/permissions";
import { db } from "./db";
import type { DataStore } from "./db/types";
import { actorOf, audit } from "./audit";
import { type UserRecord, isAdmin } from "./users";

export const PERMISSIONS_KEY = "permissions:roles";

let cache: { store: DataStore; table: RolePermissions; at: number } | null = null;
const CACHE_MS = 5_000;

export function invalidatePermissionsCache() { cache = null; }

/** The current table (defaults when nothing was saved or the database is unreachable). */
export async function getRolePermissions(): Promise<RolePermissions> {
  let store: DataStore;
  try { store = await db(); } catch { return normalizeRolePermissions(null); }
  if (cache && cache.store === store && Date.now() - cache.at < CACHE_MS) return cache.table;
  let raw: unknown = null;
  try {
    const v = await store.getSetting(PERMISSIONS_KEY);
    raw = v ? JSON.parse(v) : null;
  } catch { raw = null; }
  const table = normalizeRolePermissions(raw);
  cache = { store, table, at: Date.now() };
  return table;
}

export async function saveRolePermissions(input: unknown): Promise<RolePermissions> {
  const table = normalizeRolePermissions(input);
  const store = await db();
  await store.setSetting(PERMISSIONS_KEY, JSON.stringify(table));
  cache = { store, table, at: Date.now() };
  return table;
}

export async function permissionsOf(user: Pick<UserRecord, "role">): Promise<Permission[]> {
  if (isAdmin(user)) return [...PERMISSIONS];
  return permissionsForRole(user.role, await getRolePermissions());
}

export async function hasPermission(user: Pick<UserRecord, "role">, perm: Permission): Promise<boolean> {
  if (isAdmin(user)) return true;
  if (user.role === "accountant") return ACCOUNTANT_PERMISSIONS.includes(perm);
  return (await getRolePermissions())[user.role as "manager" | "viewer"]?.[perm] ?? false;
}

// ── Money redaction ──────────────────────────────────────────────────────────
const MONEY_KEY = /^(amount|rate|pay|wage|wages|cash|bank|check|tips?|gross|net|deductions|lumpSum|total_pay|totalPay|cost|salary)$|(Rate|Pay|Amount|Wages?|Cost|Tips|Salary|Cash|Total)$/;
const NOT_MONEY = new Set(["employeeTotal", "shiftTotal", "hoursTotal", "minutesTotal"]);

// A tips pool ({ total, perDay: { date: amount } }) keeps its money under plain names.
const TIP_POOL = /^tips?$/i;
function redactTipPool(t: any): any {
  const out = { ...t };
  if (typeof out.total === "number") out.total = 0;
  if (out.perDay && typeof out.perDay === "object") out.perDay = Object.fromEntries(Object.keys(out.perDay).map((d) => [d, 0]));
  return out;
}

/** Replace every numeric money field with 0 (in place on a copy). */
export function redactMoney<T>(value: T): T {
  const walk = (v: any, depth: number): any => {
    if (depth > 40 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === "number" && MONEY_KEY.test(k) && !NOT_MONEY.has(k)) out[k] = 0;
      else if (TIP_POOL.test(k) && x && typeof x === "object" && !Array.isArray(x)) out[k] = redactTipPool(walk(x, depth + 1));
      else out[k] = walk(x, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

const WITH_USER = new Set(["/bootstrap", "/auth/me", "/auth/status"]);

/**
 * Mounted on /api after sign-in. Adds `permissions` to the user in the
 * bootstrap / me / status payloads, and hides money from users without "pay.view".
 */
export function permissionsMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = res.locals.user as UserRecord | undefined;
    if (!user || (req.method !== "GET" && req.method !== "HEAD")) return next();
    let perms: Permission[];
    try { perms = await permissionsOf(user); } catch (err) { return next(err); }
    const hidePay = !perms.includes("pay.view");
    const p = req.path; // req.path changes once the request reaches a route
    const addUser = WITH_USER.has(p);
    if (!hidePay && !addUser) return next();
    const json = res.json.bind(res);
    res.json = (body: any) => {
      let out = body;
      if (res.statusCode < 400 && out && typeof out === "object") {
        if (hidePay && !p.startsWith("/auth/")) { out = redactMoney(out); res.setHeader("X-Pay-Hidden", "1"); }
        if (addUser) {
          if (p === "/auth/me") out = { ...out, permissions: perms };
          else if (out.user && typeof out.user === "object") out = { ...out, user: { ...out.user, permissions: perms } };
        }
      }
      return json(out);
    };
    next();
  };
}

// ── Routes (owner / admin: no POLICY rule, so the default applies) ───────────
const tableSchema = z.object(Object.fromEntries(LIMITED_ROLES.map((r) => [r, z.object(Object.fromEntries(PERMISSIONS.map((p) => [p, z.boolean().optional()]))).partial()])) as Record<string, z.ZodTypeAny>).partial();

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

export function registerPermissionRoutes(app: Express) {
  app.use("/api", permissionsMiddleware());

  app.get("/api/permissions", h(async (_req, res) => {
    res.json({ roles: await getRolePermissions(), defaults: DEFAULT_ROLE_PERMISSIONS, info: PERMISSION_INFO, permissions: PERMISSIONS });
  }));

  app.put("/api/permissions", h(async (req, res) => {
    const body = tableSchema.parse(req.body ?? {});
    const before = await getRolePermissions();
    const merged = Object.fromEntries(LIMITED_ROLES.map((r) => [r, { ...before[r], ...(body[r] ?? {}) }]));
    const after = await saveRolePermissions(merged);
    const changes: string[] = [];
    for (const r of LIMITED_ROLES) {
      for (const p of PERMISSIONS) {
        if (before[r][p] !== after[r][p]) changes.push(`${r}: ${after[r][p] ? "+" : "-"}${p}`);
      }
    }
    if (changes.length) audit({ ...actorOf(req, res), action: "permissions.update", target: "roles", detail: changes.join(", ") });
    res.json({ roles: after });
  }));

  app.post("/api/permissions/reset", h(async (req, res) => {
    const after = await saveRolePermissions(DEFAULT_ROLE_PERMISSIONS);
    audit({ ...actorOf(req, res), action: "permissions.update", target: "roles", detail: "reset to defaults" });
    res.json({ roles: after });
  }));
}
