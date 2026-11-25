import type { ComponentType } from "react";
import { Link } from "wouter";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { LocationsSettings } from "@/components/settings/LocationsSettings";
import { CategoriesSettings } from "@/components/settings/CategoriesSettings";
import { DatabaseSettings } from "@/components/settings/DatabaseSettings";
import { SecuritySettings } from "@/components/settings/SecuritySettings";
import { DataSettings } from "@/components/settings/DataSettings";
import { PreferencesSettings } from "@/components/settings/PreferencesSettings";
import { UsersSettings } from "@/components/settings/UsersSettings";
import { AuditSettings } from "@/components/settings/AuditSettings";
import { useApp } from "@/context/AppData";
import { SETTINGS_GROUPS, visibleSettingsSections, type SettingsSectionMeta } from "@/pages/settings-sections";
import { cn } from "@/lib/utils";

/** Section id → component. Navigation metadata lives in settings-sections.ts. */
const PANES: Record<string, ComponentType> = {
  locations: LocationsSettings,
  categories: CategoriesSettings,
  preferences: PreferencesSettings,
  database: DatabaseSettings,
  security: SecuritySettings,
  users: UsersSettings,
  activity: AuditSettings,
  data: DataSettings,
};

function IconTile({ s, size = "md" }: { s: SettingsSectionMeta; size?: "md" | "lg" }) {
  return (
    <span className={cn("flex shrink-0 items-center justify-center text-white shadow-sm", s.tint, size === "lg" ? "h-8 w-8 rounded-[9px]" : "h-[22px] w-[22px] rounded-[6px]")} aria-hidden>
      <s.icon className={size === "lg" ? "h-[18px] w-[18px]" : "h-3.5 w-3.5"} strokeWidth={2.2} />
    </span>
  );
}

export function SettingsPage({ section }: { section?: string }) {
  const { user } = useApp();
  // Managers and viewers only see their own account; the rest is for owners and administrators.
  const sections = visibleSettingsSections(user).filter((s) => PANES[s.id]);
  const cur = sections.find((s) => s.id === section) ?? sections[0];
  const El = PANES[cur.id];
  const hasSection = !!section && sections.some((s) => s.id === section);

  return (
    <div className="mx-auto flex w-full max-w-[90rem] md:min-h-dvh">
      {/* Left pane: section list (on phones this is the whole screen until a section is picked) */}
      <aside className={cn("w-full shrink-0 border-border/70 px-4 pb-10 pt-6 md:sticky md:top-0 md:block md:h-dvh md:w-64 md:overflow-y-auto md:border-r md:px-3 md:pt-8 lg:w-72", hasSection && "hidden")}>
        <h1 className="mb-5 px-2 text-display tracking-tight md:text-[22px] md:leading-7" data-testid="text-page-title">Settings</h1>
        <nav aria-label="Settings sections" className="space-y-5">
          {SETTINGS_GROUPS.map((g) => {
            const items = sections.filter((s) => s.group === g);
            if (!items.length) return null;
            return (
              <div key={g}>
                <p className="section-label mb-1.5 px-2">{g}</p>
                <ul className="overflow-hidden rounded-xl border border-card-border bg-card shadow-card md:space-y-0.5 md:overflow-visible md:rounded-none md:border-none md:bg-transparent md:shadow-none">
                  {items.map((s) => {
                    const active = s.id === cur.id;
                    return (
                      <li key={s.id} className="border-b border-border/60 last:border-none md:border-none">
                        <Link
                          href={`/settings/${s.id}`}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "flex items-center gap-3 px-3 py-2.5 text-[14px] transition-colors md:rounded-md md:px-2 md:py-1.5 md:text-[13px] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/35",
                            active ? "md:bg-primary md:text-primary-foreground" : "hover:bg-foreground/[0.04]",
                          )}
                          data-testid={`nav-settings-${s.id}`}
                        >
                          <IconTile s={s} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{s.label}</span>
                            <span className={cn("block truncate text-xs md:hidden", "text-muted-foreground")}>{s.description}</span>
                          </span>
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60 md:hidden" />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>
      </aside>

      {/* Right pane: the section */}
      <section className={cn("min-w-0 flex-1 px-4 pb-16 pt-4 sm:px-8 md:block md:pt-8", !hasSection && "hidden")} aria-labelledby="settings-section-title">
        <Link href="/settings" className="mb-3 inline-flex items-center gap-0.5 text-[15px] font-medium text-primary md:hidden" data-testid="link-settings-back">
          <ChevronLeft className="h-5 w-5" />Settings
        </Link>
        <div className="mx-auto max-w-4xl">
          <header className="mb-6 flex items-center gap-3">
            <IconTile s={cur} size="lg" />
            <div className="min-w-0">
              <h2 id="settings-section-title" className="text-[22px] font-bold leading-7 tracking-tight">{cur.label}</h2>
              <p className="text-[13px] text-muted-foreground">{cur.description}</p>
            </div>
          </header>
          <El />
        </div>
      </section>
    </div>
  );
}
