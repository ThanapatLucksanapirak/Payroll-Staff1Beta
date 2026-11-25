import { Database, HandCoins, HardDriveDownload, History, MapPin, RefreshCw, Shield, SlidersHorizontal, Tags, Users, type LucideIcon } from "lucide-react";
import { isAdmin, type Role } from "@/lib/roles";

/**
 * Settings navigation metadata (no components, so it is safe to import from the
 * app shell / command palette without pulling the Settings chunk in).
 * When adding a section, also map its id to a component in pages/Settings.tsx.
 */
export interface SettingsSectionMeta {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Tile colour for the macOS-style icon. */
  tint: string;
  group: "Payroll" | "App" | "Access" | "System";
  keywords?: string;
  /** Owners and administrators only (the server enforces this too). */
  adminOnly?: boolean;
}

export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  { id: "locations", label: "Locations & rules", description: "Sites, pay rules, Square and time clock", icon: MapPin, tint: "bg-[#0a84ff]", group: "Payroll", adminOnly: true, keywords: "site rules cutoffs overtime square timezone pay period kiosk time clock devices pair" },
  { id: "categories", label: "Pay categories", description: "Shared rate templates", icon: Tags, tint: "bg-[#ff9f0a]", group: "Payroll", adminOnly: true, keywords: "rates chef server wage" },
  { id: "pay", label: "Pay extras", description: "Cash, holidays, standing items, advances, accounting", icon: HandCoins, tint: "bg-[#34c759]", group: "Payroll", adminOnly: true, keywords: "cash denominations bills coins rounding holiday premium recurring bonus deduction uniform advance loan tips points quickbooks xero journal accounts" },
  { id: "preferences", label: "Preferences", description: "Appearance, formats, PDF", icon: SlidersHorizontal, tint: "bg-[#8e8e93]", group: "App", adminOnly: true, keywords: "theme dark light date currency autosave pdf branding logo" },
  { id: "security", label: "Account & password", description: "Your name, password and sessions", icon: Shield, tint: "bg-[#5e5ce6]", group: "Access", keywords: "account profile password login session sign out" },
  { id: "users", label: "Users", description: "People who can sign in, and their roles", icon: Users, tint: "bg-[#32ade6]", group: "Access", adminOnly: true, keywords: "users roles owner admin manager viewer invite accounts" },
  { id: "activity", label: "Activity", description: "Who changed what, and when", icon: History, tint: "bg-[#ff375f]", group: "Access", adminOnly: true, keywords: "audit log history activity changes" },
  { id: "database", label: "Database", description: "Storage and connection", icon: Database, tint: "bg-[#30d158]", group: "System", adminOnly: true, keywords: "supabase sqlite storage" },
  { id: "data", label: "Backup & history", description: "Backups, restore, retention", icon: HardDriveDownload, tint: "bg-[#bf5af2]", group: "System", adminOnly: true, keywords: "backup restore export retention trash" },
  { id: "updates", label: "Software update", description: "Version and Update now", icon: RefreshCw, tint: "bg-[#0a84ff]", group: "System", adminOnly: true, keywords: "update upgrade version new release install" },
];

/** The sections this user may open: everyone gets their own account; the rest are for owners and administrators. */
export function visibleSettingsSections(user: { role: Role } | null | undefined): SettingsSectionMeta[] {
  return SETTINGS_SECTIONS.filter((s) => !s.adminOnly || isAdmin(user));
}

export const SETTINGS_GROUPS: SettingsSectionMeta["group"][] = ["Payroll", "App", "Access", "System"];
