// Signed-in user and what their role allows. The server enforces all of this;
// the UI only hides what the user can't do.
import { type Permission, ACCOUNTANT_PERMISSIONS } from "@shared/permissions";

export type Role = "owner" | "admin" | "manager" | "viewer" | "accountant";
export type { Permission };

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  siteIds: string[];
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** From Settings → Users → Roles (sent with bootstrap / me). Missing on older servers. */
  permissions?: Permission[];
  twoFactorEnabled?: boolean;
  /** Where email notifications go. Empty = none. */
  notificationEmail?: string;
}

export const ROLE_LABELS: Record<Role, string> = { owner: "Owner", admin: "Administrator", manager: "Manager", viewer: "Viewer", accountant: "Accountant" };

export const ROLE_HELP: Record<Role, string> = {
  owner: "Everything, including managing other owners.",
  admin: "Everything except managing owners.",
  manager: "Create and edit timesheets and import for their locations. No settings.",
  viewer: "View timesheets and export CSV / PDF. Read only.",
  accountant: "Only payroll you publish: totals, reports and PDF / CSV downloads. Gets an email when you publish. Read only.",
};

export const isAdmin = (u: { role: Role } | null | undefined) => u?.role === "owner" || u?.role === "admin";
/** Accountants only see published payroll (the server enforces it). */
export const isAccountant = (u: { role: Role } | null | undefined) => u?.role === "accountant";

/** Whether the user has a permission (owners and administrators have all of them). */
export function can(u: Pick<SessionUser, "role" | "permissions"> | null | undefined, perm: Permission): boolean {
  if (!u) return false;
  if (isAdmin(u)) return true;
  if (u.role === "accountant") return ACCOUNTANT_PERMISSIONS.includes(perm);
  if (u.permissions) return u.permissions.includes(perm);
  // Older server without permissions: the fixed role defaults.
  if (perm === "employees.manage") return false;
  if (perm === "timesheets.edit" || perm === "punches.edit" || perm === "schedule.manage") return u.role !== "viewer";
  return true;
}

/** Can create and edit timesheets (and import). */
export const canEdit = (u: Pick<SessionUser, "role" | "permissions"> | null | undefined) => can(u, "timesheets.edit");
