import { Link } from "wouter";
import { Database, HardDriveDownload, MapPin, Shield, SlidersHorizontal, Tags } from "lucide-react";
import { LocationsSettings } from "@/components/settings/LocationsSettings";
import { CategoriesSettings } from "@/components/settings/CategoriesSettings";
import { DatabaseSettings } from "@/components/settings/DatabaseSettings";
import { SecuritySettings } from "@/components/settings/SecuritySettings";
import { DataSettings } from "@/components/settings/DataSettings";
import { PreferencesSettings } from "@/components/settings/PreferencesSettings";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { id: "locations", label: "Locations & rules", icon: MapPin, el: LocationsSettings },
  { id: "categories", label: "Pay categories", icon: Tags, el: CategoriesSettings },
  { id: "preferences", label: "Preferences", icon: SlidersHorizontal, el: PreferencesSettings },
  { id: "database", label: "Database", icon: Database, el: DatabaseSettings },
  { id: "security", label: "Password & sessions", icon: Shield, el: SecuritySettings },
  { id: "data", label: "Backup & history", icon: HardDriveDownload, el: DataSettings },
] as const;

export function SettingsPage({ section }: { section?: string }) {
  const cur = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  const El = cur.el;
  return (
    <div className="mx-auto max-w-7xl px-3 sm:px-5 py-6">
      <h1 className="mb-4 text-xl font-semibold tracking-tight">Settings</h1>
      <div className="grid gap-6 lg:grid-cols-[13rem_1fr]">
        <nav className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible -mx-3 px-3 lg:mx-0 lg:px-0 pb-1">
          {SECTIONS.map((s) => (
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
