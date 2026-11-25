import { Database, HardDriveDownload, MapPin, Shield, SlidersHorizontal, Tags, type LucideIcon } from "lucide-react";

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
}

export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  { id: "locations", label: "Locations & rules", description: "Sites, pay rules, Square connection", icon: MapPin, tint: "bg-[#0a84ff]", group: "Payroll", keywords: "site rules cutoffs overtime square timezone pay period" },
  { id: "categories", label: "Pay categories", description: "Shared rate templates", icon: Tags, tint: "bg-[#ff9f0a]", group: "Payroll", keywords: "rates chef server wage" },
  { id: "preferences", label: "Preferences", description: "Appearance, formats, PDF", icon: SlidersHorizontal, tint: "bg-[#8e8e93]", group: "App", keywords: "theme dark light date currency autosave pdf branding" },
  { id: "security", label: "Password & sessions", description: "Sign-in and devices", icon: Shield, tint: "bg-[#5e5ce6]", group: "Access", keywords: "password login session" },
  { id: "database", label: "Database", description: "Storage and connection", icon: Database, tint: "bg-[#30d158]", group: "System", keywords: "supabase sqlite storage" },
  { id: "data", label: "Backup & history", description: "Backups, restore, retention", icon: HardDriveDownload, tint: "bg-[#bf5af2]", group: "System", keywords: "backup restore export retention trash" },
];

export const SETTINGS_GROUPS: SettingsSectionMeta["group"][] = ["Payroll", "App", "Access", "System"];
