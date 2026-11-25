import { Link } from "wouter";
import { Database, HardDriveDownload, History, MapPin, Shield, SlidersHorizontal, Tags, Users } from "lucide-react";
import { LocationsSettings } from "@/components/settings/LocationsSettings";
import { CategoriesSettings } from "@/components/settings/CategoriesSettings";
import { DatabaseSettings } from "@/components/settings/DatabaseSettings";
import { SecuritySettings } from "@/components/settings/SecuritySettings";
import { DataSettings } from "@/components/settings/DataSettings";
import { PreferencesSettings } from "@/components/settings/PreferencesSettings";
import { UsersSettings } from "@/components/settings/UsersSettings";
import { AuditSettings } from "@/components/settings/AuditSettings";
import { useApp } from "@/context/AppData";
import { isAdmin } from "@/lib/roles";
import { cn } from "@/lib/utils";

// Sections everyone can open; all others are for owners and administrators.
const OWN_ACCOUNT = new Set(["security"]);

const SECTIONS = [
  { id: "locations", label: "Locations & rules", icon: MapPin, el: LocationsSettings },
  { id: "categories", label: "Pay categories", icon: Tags, el: CategoriesSettings },
  { id: "preferences", label: "Preferences", icon: SlidersHorizontal, el: PreferencesSettings },
  { id: "database", label: "Database", icon: Database, el: DatabaseSettings },
  { id: "users", label: "Users", icon: Users, el: UsersSettings },
  { id: "security", label: "Account & password", icon: Shield, el: SecuritySettings },
  { id: "activity", label: "Activity", icon: History, el: AuditSettings },
  { id: "data", label: "Backup & history", icon: HardDriveDownload, el: DataSettings },
] as const;

export function SettingsPage({ section }: { section?: string }) {
  const { user } = useApp();
  const sections = SECTIONS.filter((s) => isAdmin(user) || OWN_ACCOUNT.has(s.id));
  const cur = sections.find((s) => s.id === section) ?? sections[0];
  const El = cur.el;
  return (
    <div className="mx-auto max-w-7xl px-3 sm:px-5 py-6">
      <h1 className="mb-4 text-xl font-semibold tracking-tight">Settings</h1>
      <div className="grid gap-6 lg:grid-cols-[13rem_1fr]">
        <nav className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible -mx-3 px-3 lg:mx-0 lg:px-0 pb-1">
          {sections.map((s) => (
            <Link key={s.id} href={`/settings/${s.id}`} className={cn("flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent", s.id === cur.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground")} data-testid={`nav-settings-${s.id}`}>
              <s.icon className="h-4 w-4" />{s.label}
            </Link>
          ))}
        </nav>
        <div className="min-w-0"><El /></div>
      </div>
    </div>
  );
}
