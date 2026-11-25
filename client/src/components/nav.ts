import { BarChart3, CalendarDays, Home, Radio, Settings, Table2, Users, type LucideIcon } from "lucide-react";
import { type Permission, type SessionUser, can } from "@/lib/roles";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown in the mobile bottom tab bar (max 5). */
  tab?: boolean;
  keywords?: string;
  isActive: (loc: string) => boolean;
  /** Hidden from users without this permission (Settings → Users → Roles). */
  perm?: Permission;
}

/** Primary sections, in sidebar order. */
export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Home", icon: Home, tab: true, keywords: "overview dashboard", isActive: (l) => l === "/" },
  { href: "/timesheets", label: "Timesheets", icon: Table2, tab: true, keywords: "payroll list saved", isActive: (l) => l.startsWith("/timesheets") || l.startsWith("/timesheet/") },
  { href: "/live", label: "Live", icon: Radio, tab: true, keywords: "clocked in now today kiosk", isActive: (l) => l.startsWith("/live") },
  { href: "/schedule", label: "Schedule", icon: CalendarDays, keywords: "shifts rota roster week time off publish", isActive: (l) => l.startsWith("/schedule") },
  { href: "/employees", label: "Employees", icon: Users, keywords: "people staff team", isActive: (l) => l.startsWith("/employees") },
  { href: "/reports", label: "Reports", icon: BarChart3, tab: true, keywords: "totals charts analytics", perm: "reports.view", isActive: (l) => l.startsWith("/reports") },
  { href: "/settings", label: "Settings", icon: Settings, tab: true, keywords: "preferences options", isActive: (l) => l.startsWith("/settings") },
];

/** The sections this user may open. */
export function visibleNav(user: Pick<SessionUser, "role" | "permissions"> | null | undefined): NavItem[] {
  return NAV_ITEMS.filter((n) => !n.perm || can(user, n.perm));
}
