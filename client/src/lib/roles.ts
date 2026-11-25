// Signed-in user and what their role allows. The server enforces all of this;
// the UI only hides what the user can't do.
export type Role = "owner" | "admin" | "manager" | "viewer";

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  siteIds: string[];
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export const ROLE_LABELS: Record<Role, string> = { owner: "Owner", admin: "Administrator", manager: "Manager", viewer: "Viewer" };

export const ROLE_HELP: Record<Role, string> = {
  owner: "Everything, including managing other owners.",
  admin: "Everything except managing owners.",
  manager: "Create and edit timesheets and import for their locations. No settings.",
  viewer: "View timesheets and export CSV / PDF. Read only.",
};

export const isAdmin = (u: { role: Role } | null | undefined) => u?.role === "owner" || u?.role === "admin";
export const canEdit = (u: { role: Role } | null | undefined) => !!u && u.role !== "viewer";
