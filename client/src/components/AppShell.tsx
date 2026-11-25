import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { AlertTriangle, Menu, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { useApp } from "@/context/AppData";
import { AccountMenu } from "@/components/AccountMenu";
import { safeStorage } from "@/lib/storage";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { CommandPalette, isMac } from "@/components/CommandPalette";
import { NewTimesheetProvider } from "@/components/NewTimesheet";
import { NAV_ITEMS } from "@/components/nav";
import { cn } from "@/lib/utils";

export function SiteDot({ color, className }: { color: string; className?: string }) {
  return <span className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/5", className)} style={{ background: color }} aria-hidden />;
}

const COLLAPSE_KEY = "payroll.sidebar.collapsed";

/** Arrow-key navigation between links inside a nav landmark. */
function onNavKeyDown(e: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const links = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-nav-item]"));
  const i = links.indexOf(document.activeElement as HTMLElement);
  if (i === -1) return;
  e.preventDefault();
  const n = e.key === "Home" ? 0 : e.key === "End" ? links.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + links.length) % links.length;
  links[n]?.focus();
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <NewTimesheetProvider>
      <Shell>{children}</Shell>
    </NewTimesheetProvider>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const [loc] = useLocation();
  const [collapsed, setCollapsed] = useState(() => safeStorage.get(COLLAPSE_KEY) === "1");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleCollapsed = useCallback(() => setCollapsed((c) => { safeStorage.set(COLLAPSE_KEY, c ? "0" : "1"); return !c; }), []);

  useEffect(() => { setMenuOpen(false); }, [loc]);
  // Scroll to top on page change (but not between workspace tabs).
  useEffect(() => { window.scrollTo({ top: 0 }); }, [loc]);

  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:shadow-float">Skip to content</a>

      {/* Desktop sidebar */}
      <aside
        className={cn(
          "sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-sidebar-border bg-sidebar/90 backdrop-blur-xl transition-[width] duration-200 md:flex",
          collapsed ? "w-[4.25rem]" : "w-[15.5rem]",
        )}
        data-testid="sidebar"
      >
        <SidebarBody collapsed={collapsed} onToggleCollapsed={toggleCollapsed} onSearch={() => setPaletteOpen(true)} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="glass sticky top-0 z-40 flex h-14 items-center gap-1 border-b border-border/70 px-2 md:hidden">
          <Button variant="ghost" size="icon" aria-label="Open menu" onClick={() => setMenuOpen(true)} data-testid="button-mobile-menu"><Menu className="h-5 w-5" /></Button>
          <Link href="/" className="flex min-w-0 items-center gap-2" data-testid="link-home-mobile">
            <Logo className="h-7 w-7 shrink-0" />
          </Link>
          <div className="min-w-0 flex-1"><LocationSwitcher compact /></div>
          <Button variant="ghost" size="icon" aria-label="Search" onClick={() => setPaletteOpen(true)} data-testid="button-mobile-search"><Search className="h-5 w-5" /></Button>
        </header>

        <main id="main" className="flex-1 pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-0" tabIndex={-1}>{children}</main>
      </div>

      {/* Mobile bottom tab bar */}
      <nav aria-label="Sections" className="glass fixed inset-x-0 bottom-0 z-40 border-t border-border/70 pb-[env(safe-area-inset-bottom)] md:hidden">
        <ul className="mx-auto flex max-w-lg">
          {NAV_ITEMS.filter((n) => n.tab).map((n) => {
            const active = n.isActive(loc);
            return (
              <li key={n.href} className="flex-1">
                <Link href={n.href} aria-current={active ? "page" : undefined} className={cn("flex h-14 flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium transition-colors", active ? "text-primary" : "text-muted-foreground hover:text-foreground")} data-testid={`tab-${n.label.toLowerCase()}`}>
                  <n.icon className="h-[22px] w-[22px]" strokeWidth={active ? 2.2 : 1.8} />
                  {n.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Mobile slide-over with the full sidebar */}
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" aria-describedby={undefined}>
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <SidebarBody collapsed={false} onSearch={() => { setMenuOpen(false); setPaletteOpen(true); }} />
        </SheetContent>
      </Sheet>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

function SidebarBody({ collapsed, onToggleCollapsed, onSearch }: { collapsed: boolean; onToggleCollapsed?: () => void; onSearch: () => void }) {
  const app = useApp();
  const [loc] = useLocation();

  const tip = (label: string, el: ReactNode) => collapsed ? (
    <Tooltip><TooltipTrigger asChild>{el}</TooltipTrigger><TooltipContent side="right">{label}</TooltipContent></Tooltip>
  ) : el;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Brand + collapse */}
      <div className={cn("flex h-14 shrink-0 items-center gap-2 px-3", collapsed && "justify-center px-0")}>
        <Link href="/" className={cn("flex min-w-0 items-center gap-2.5 rounded-md", collapsed && "hidden")} data-testid="link-home">
          <Logo className="h-7 w-7 shrink-0" />
          <span className="truncate text-[14px] font-semibold tracking-tight">{app.prefs.appName}</span>
        </Link>
        {onToggleCollapsed && tip(collapsed ? "Expand sidebar" : "Collapse sidebar",
          <Button variant="ghost" size="icon-sm" className={cn("shrink-0 text-muted-foreground", !collapsed && "ml-auto")} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} onClick={onToggleCollapsed} data-testid="button-sidebar-toggle">
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>,
        )}
      </div>

      {/* Location switcher */}
      <div className={cn("px-3 pb-2", collapsed && "px-2")}>
        <LocationSwitcher collapsed={collapsed} />
      </div>

      {/* Search / command palette */}
      <div className={cn("px-3 pb-3", collapsed && "px-2")}>
        {tip("Search", (
          <button
            onClick={onSearch}
            className={cn("flex h-8 w-full items-center gap-2 rounded-md border border-border/80 bg-card/70 px-2.5 text-[13px] text-muted-foreground shadow-card transition-colors hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35", collapsed && "justify-center px-0")}
            aria-label="Search and commands"
            aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
            data-testid="button-command"
          >
            <Search className="h-3.5 w-3.5 shrink-0" />
            {!collapsed && <><span className="flex-1 text-left">Search</span><kbd className="font-sans text-[11px] tracking-wide opacity-80">{isMac ? "⌘K" : "Ctrl K"}</kbd></>}
          </button>
        ))}
      </div>

      {/* Primary navigation */}
      <nav aria-label="Main" className={cn("min-h-0 flex-1 overflow-y-auto px-3", collapsed && "px-2")} onKeyDown={onNavKeyDown}>
        <ul className="space-y-0.5">
          {NAV_ITEMS.map((n) => {
            const active = n.isActive(loc);
            return (
              <li key={n.href}>
                {tip(n.label, (
                  <Link
                    href={n.href}
                    data-nav-item
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35",
                      collapsed && "h-9 justify-center px-0",
                      active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-foreground/80 hover:bg-foreground/[0.05] hover:text-foreground",
                    )}
                    data-testid={`nav-${n.label.toLowerCase()}`}
                  >
                    <n.icon className={cn("h-[17px] w-[17px] shrink-0", active ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
                    {!collapsed && <span className="truncate">{n.label}</span>}
                  </Link>
                ))}
              </li>
            );
          })}
        </ul>
      </nav>

      {!app.db.connected && (
        <div className={cn("px-3 pb-2", collapsed && "px-2")}>
          {tip("Database problem — open Settings", (
            <Link href="/settings/database" className={cn("flex items-center gap-2 rounded-md bg-warning-soft px-2.5 py-2 text-xs font-medium text-warning", collapsed && "justify-center px-0")} data-testid="status-db-warning">
              <AlertTriangle className="h-4 w-4 shrink-0" />{!collapsed && "Database problem"}
            </Link>
          ))}
        </div>
      )}

      {/* Account menu: signed-in user, account settings, sign out (avatar only when collapsed). */}
      <div className={cn("shrink-0 border-t border-sidebar-border p-2", collapsed && "px-2")} data-testid="slot-account">
        <AccountMenu collapsed={collapsed} />
      </div>
    </div>
  );
}

function LocationSwitcher({ collapsed, compact }: { collapsed?: boolean; compact?: boolean }) {
  const app = useApp();
  const [loc] = useLocation();
  const inWorkspace = loc.startsWith("/timesheet/");
  if (!(app.activeSites.length > 1 || !inWorkspace)) return null;
  return (
    <Select value={app.site.id} onValueChange={app.setSiteId} disabled={inWorkspace}>
      <SelectTrigger
        aria-label={`Location: ${app.site.name}`}
        title={inWorkspace ? "The open timesheet's location" : "Switch location"}
        className={cn(
          "[&>span]:line-clamp-none [&>span]:!flex",
          compact
            ? "h-9 w-auto max-w-full gap-1.5 border-none bg-transparent px-2 shadow-none hover:bg-accent focus-visible:ring-[3px] disabled:bg-transparent"
            : "h-auto min-h-[2.75rem] gap-2 rounded-lg border-border/80 bg-card/80 py-1.5 pl-2.5 pr-2 disabled:opacity-100",
          collapsed && "h-10 min-h-0 justify-center px-0 [&>svg:last-child]:hidden",
        )}
        data-testid="select-site"
      >
        <span className="flex min-w-0 items-center gap-2">
          <SiteDot color={app.site.color} className={cn(!compact && "h-3 w-3")} />
          {!collapsed && (
            <span className="min-w-0 text-left">
              {!compact && <span className="block text-[10.5px] font-medium uppercase leading-tight tracking-wide text-muted-foreground">Location</span>}
              <span className="block truncate text-[13px] font-medium leading-tight"><SelectValue>{app.site.name}</SelectValue></span>
            </span>
          )}
        </span>
      </SelectTrigger>
      <SelectContent>
        {app.activeSites.map((s) => (
          <SelectItem key={s.id} value={s.id} data-testid={`option-site-${s.id}`}>
            <span className="flex min-w-0 items-center gap-2"><SiteDot color={s.color} /><span className="truncate">{s.name}</span></span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
