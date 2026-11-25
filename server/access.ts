// Request guards: CSRF header check and role / location authorization.
//
// Every /api route is matched against POLICY (first match wins). Anything not
// listed needs an owner or administrator, so new routes are safe by default.
// Rules may also name a permission from Settings → Users → Roles (see
// server/permissions.ts); for managers and viewers the permission then decides.
import type { NextFunction, Request, Response } from "express";
import { db } from "./db";
import * as settings from "./settings";
import { type UserRecord, canAccessSite, canEdit, isAdmin } from "./users";
import type { Permission } from "@shared/permissions";
import { hasPermission } from "./permissions";

export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "payroll";
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Browsers only send a custom header from same-origin scripts, so requiring one
 * on every state-changing request stops cross-site form posts riding on the cookie.
 */
export function csrfGuard() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (SAFE.has(req.method)) return next();
    if (req.header(CSRF_HEADER) === CSRF_VALUE) return next();
    return res.status(403).json({ error: "This request was blocked for your security. Reload the page and try again." });
  };
}

type Need = "user" | "editor" | "admin";
/** Location ids the request touches (checked against the user's allowed locations). */
type SiteResolver = (req: Request) => Promise<(string | null | undefined)[]>;

interface Rule {
  method: string;
  path: RegExp;
  need: Need | ((req: Request) => Need);
  sites?: SiteResolver;
  /**
   * A permission from Settings → Users → Roles. For managers and viewers it
   * replaces `need` (so a role can be granted or denied it); owners and
   * administrators always pass. Return undefined to fall back to `need`.
   */
  perm?: Permission | ((req: Request) => Permission | undefined);
}

async function timesheetSite(id: string): Promise<string | null | undefined> {
  const row = await (await db()).getTimesheet(id);
  if (!row) return undefined; // the route answers 404
  return row.site_id ?? (await settings.defaultSiteId());
}

const tsId = (req: Request) => decodeURIComponent(req.path.split("/")[2] ?? "");
const fromRow: SiteResolver = async (req) => [await timesheetSite(tsId(req))];
const fromRowAndBody = (pick: (body: any) => unknown): SiteResolver => async (req) => {
  const extra = pick(req.body ?? {});
  return [await timesheetSite(tsId(req)), typeof extra === "string" ? extra : undefined];
};
const fromParam: SiteResolver = async (req) => [decodeURIComponent(req.path.split("/")[2] ?? "")];

const punchSite: SiteResolver = async (req) => {
  const p = await (await db()).getPunch(decodeURIComponent(req.path.split("/")[2] ?? ""));
  return [p?.siteId ?? undefined];
};

const POLICY: Rule[] = [
  // Own account
  { method: "POST", path: /^\/auth\/(logout-all|change-password)$/, need: "user" },
  { method: "PUT", path: /^\/auth\/profile$/, need: "user" },
  { method: "GET", path: /^\/auth\/me$/, need: "user" },
  { method: "GET", path: /^\/bootstrap$/, need: "user" },
  // Timesheets (the list route filters by location itself)
  { method: "GET", path: /^\/timesheets$/, need: "user" },
  { method: "GET", path: /^\/timesheets\/[^/]+$/, need: "user", sites: fromRow },
  { method: "POST", path: /^\/timesheets$/, need: "editor", perm: "timesheets.edit", sites: async (req) => [req.body?.doc?.siteId ?? (await settings.defaultSiteId())] },
  { method: "PUT", path: /^\/timesheets\/[^/]+$/, need: "editor", perm: "timesheets.edit", sites: fromRowAndBody((b) => b.doc?.siteId) },
  { method: "PATCH", path: /^\/timesheets\/[^/]+$/, need: "editor", perm: "timesheets.edit", sites: fromRowAndBody((b) => b.siteId) },
  { method: "POST", path: /^\/timesheets\/[^/]+\/(duplicate|restore)$/, need: "editor", perm: "timesheets.edit", sites: fromRow },
  { method: "DELETE", path: /^\/timesheets\/[^/]+$/, need: (req) => (req.query.permanent === "1" ? "admin" : "editor"), perm: (req) => (req.query.permanent === "1" ? undefined : "timesheets.edit"), sites: fromRow },
  // Importing
  { method: "POST", path: /^\/import\/pdf$/, need: "editor", perm: "timesheets.edit" },
  { method: "GET", path: /^\/sites\/[^/]+\/square\/pull$/, need: "editor", perm: "timesheets.edit", sites: fromParam },
  // Saved wage profiles (used from the timesheet editor)
  { method: "GET", path: /^\/sites\/[^/]+\/wages$/, need: "user", sites: fromParam },
  { method: "PUT", path: /^\/sites\/[^/]+\/wages$/, need: "editor", perm: "timesheets.edit", sites: fromParam },
  // Time clock: everyone signed in can watch Live for their locations; editors fix punches
  // and build timesheets from them. Employees and kiosk devices stay owner/admin.
  { method: "POST", path: /^\/live\/ticket$/, need: "user" },
  { method: "GET", path: /^\/sites\/[^/]+\/(timeclock|punches|punches\/shifts)$/, need: "user", sites: fromParam },
  { method: "GET", path: /^\/sites\/[^/]+\/employees$/, need: "user", sites: fromParam },
  { method: "POST", path: /^\/sites\/[^/]+\/punches$/, need: "editor", perm: "punches.edit", sites: fromParam },
  { method: "PATCH", path: /^\/punches\/[^/]+$/, need: "editor", perm: "punches.edit", sites: punchSite },
  { method: "DELETE", path: /^\/punches\/[^/]+$/, need: "editor", perm: "punches.edit", sites: punchSite },
  // Employee list and PINs: owner/admin unless the role is given "employees.manage".
  { method: "POST", path: /^\/sites\/[^/]+\/employees(\/import)?$/, need: "admin", perm: "employees.manage", sites: fromParam },
  { method: "PUT", path: /^\/sites\/[^/]+\/employees\/[^/]+$/, need: "admin", perm: "employees.manage", sites: fromParam },
  { method: "DELETE", path: /^\/sites\/[^/]+\/employees\/[^/]+$/, need: "admin", perm: "employees.manage", sites: fromParam },
  { method: "GET", path: /^\/sites\/[^/]+\/employee-suggestions$/, need: "admin", perm: "employees.manage", sites: fromParam },
  // Two-factor sign-in for your own account
  { method: "GET", path: /^\/auth\/2fa$/, need: "user" },
  { method: "POST", path: /^\/auth\/2fa\/(setup|enable|disable|recovery-codes|forget-devices)$/, need: "user" },
];

const MESSAGES: Record<Need, string> = {
  user: "Please sign in.",
  editor: "Your account is view-only. Ask an administrator if you need to make changes.",
  admin: "Only an owner or administrator can do this.",
};

/**
 * Areas other features add routes to. A route here with no `perm` of its own
 * also needs the area's permission (in addition to its role need), so new
 * routes follow the Roles settings without having to know about them.
 */
const AREAS: { path: RegExp; write?: Permission; read?: Permission }[] = [
  { path: /schedul/i, write: "schedule.manage" },
  { path: /approv/i, write: "punches.edit" },
  { path: /^\/reports?(\/|$)/i, read: "reports.view" },
];

/** The permission an area adds to a request (see AREAS). */
function areaPermission(method: string, path: string): Permission | undefined {
  const write = !SAFE.has(method);
  for (const a of AREAS) {
    if (!a.path.test(path)) continue;
    if (write && a.write) return a.write;
    if (!write && a.read) return a.read;
  }
  return undefined;
}

const PERM_MESSAGE = "Your account isn't allowed to do this. Ask an owner or administrator if you need it.";

function allowed(user: UserRecord, need: Need) {
  if (need === "admin") return isAdmin(user);
  if (need === "editor") return canEdit(user);
  return true;
}

export function authorize(publicPaths: Set<string>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (publicPaths.has(req.path)) return next();
    const user = res.locals.user as UserRecord | undefined;
    if (!user) return res.status(401).json({ error: "Your session has expired. Please sign in again." });
    const method = req.method === "HEAD" ? "GET" : req.method;
    const rule = POLICY.find((r) => r.method === method && r.path.test(req.path));
    const need: Need = rule ? (typeof rule.need === "function" ? rule.need(req) : rule.need) : "admin";
    const perm = rule?.perm ? (typeof rule.perm === "function" ? rule.perm(req) : rule.perm) : undefined;
    try {
      if (perm && !isAdmin(user)) {
        // The role's permission decides (it can grant more or less than the default need).
        if (!(await hasPermission(user, perm))) return res.status(403).json({ error: allowed(user, need) ? PERM_MESSAGE : MESSAGES[need] });
      } else {
        if (!allowed(user, need)) return res.status(403).json({ error: MESSAGES[need] });
        const area = isAdmin(user) ? undefined : areaPermission(method, req.path);
        if (area && !(await hasPermission(user, area))) return res.status(403).json({ error: PERM_MESSAGE });
      }
    } catch (err) {
      return next(err);
    }
    if (rule?.sites && !isAdmin(user) && user.siteIds.length) {
      try {
        const ids = await rule.sites(req);
        if (ids.some((id) => id !== undefined && !canAccessSite(user, id))) {
          return res.status(403).json({ error: "Your account doesn't have access to this location." });
        }
      } catch (err) {
        return next(err);
      }
    }
    next();
  };
}
