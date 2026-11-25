// Per-role permissions for Managers and Viewers (Owners and Administrators can
// always do everything). Pure and shared by the server (enforcement) and the
// client (hiding what a user can't use).

export const PERMISSIONS = [
  "pay.view",
  "export",
  "timesheets.edit",
  "punches.edit",
  "employees.manage",
  "reports.view",
  "schedule.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Roles whose permissions can be changed. */
export const LIMITED_ROLES = ["manager", "viewer"] as const;
export type LimitedRole = (typeof LIMITED_ROLES)[number];

export interface PermissionInfo { label: string; help: string; requires?: Permission[] }

export const PERMISSION_INFO: Record<Permission, PermissionInfo> = {
  "pay.view": { label: "See pay rates and money totals", help: "Rates, totals and pay on every page. Without it, amounts show as a dash." },
  "export": { label: "Export PDFs and CSV", help: "Reports, pay statements and CSV downloads.", requires: ["pay.view"] },
  "timesheets.edit": { label: "Edit timesheets", help: "Create, import, change and delete timesheets for their locations.", requires: ["pay.view"] },
  "punches.edit": { label: "Edit punches and approve shifts", help: "Add, fix and remove time-clock punches on Live." },
  "employees.manage": { label: "Manage employees and PINs", help: "Add and edit people in the employee list, and set their time-clock PINs." },
  "reports.view": { label: "See reports", help: "The Reports page." },
  "schedule.manage": { label: "Manage the schedule", help: "Create and change scheduled shifts." },
};

export type RolePermissions = Record<LimitedRole, Record<Permission, boolean>>;

/** What each role could do before permissions were editable. These defaults must never change behaviour. */
export const DEFAULT_ROLE_PERMISSIONS: RolePermissions = {
  manager: {
    "pay.view": true, "export": true, "timesheets.edit": true, "punches.edit": true,
    "employees.manage": false, "reports.view": true, "schedule.manage": true,
  },
  viewer: {
    "pay.view": true, "export": true, "timesheets.edit": false, "punches.edit": false,
    "employees.manage": false, "reports.view": true, "schedule.manage": false,
  },
};

/** Fill gaps with defaults, drop unknown keys and switch off anything whose requirement is off. */
export function normalizeRolePermissions(raw: unknown): RolePermissions {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = {} as RolePermissions;
  for (const role of LIMITED_ROLES) {
    const given = src[role] && typeof src[role] === "object" ? (src[role] as Record<string, unknown>) : {};
    const perms = {} as Record<Permission, boolean>;
    for (const p of PERMISSIONS) perms[p] = typeof given[p] === "boolean" ? (given[p] as boolean) : DEFAULT_ROLE_PERMISSIONS[role][p];
    for (const p of PERMISSIONS) {
      if (PERMISSION_INFO[p].requires?.some((r) => !perms[r])) perms[p] = false;
    }
    out[role] = perms;
  }
  return out;
}

/** The permissions a role has. Owners and administrators have all of them. */
export function permissionsForRole(role: string, table: RolePermissions): Permission[] {
  if (role === "owner" || role === "admin") return [...PERMISSIONS];
  const perms = table[role as LimitedRole];
  if (!perms) return [];
  return PERMISSIONS.filter((p) => perms[p]);
}

export const isPermission = (v: unknown): v is Permission => typeof v === "string" && (PERMISSIONS as readonly string[]).includes(v);
