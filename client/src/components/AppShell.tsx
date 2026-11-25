import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Activity, LogOut, MapPin, Settings, Table2, Users } from "lucide-react";
import { useApp } from "@/context/AppData";
import { session, queryClient } from "@/lib/api";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function SiteDot({ color, className }: { color: string; className?: string }) {
  return <span className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full", className)} style={{ background: color }} aria-hidden />;
}

export function AppShell({ children }: { children: ReactNode }) {
  const app = useApp();
  const [loc] = useLocation();
  const inWorkspace = loc.startsWith("/timesheet/");

  const nav = [
    { href: "/", label: "Timesheets", icon: Table2, active: loc === "/" || inWorkspace },
    { href: "/live", label: "Live", icon: Activity, active: loc === "/live" },
    { href: "/employees", label: "Employees", icon: Users, active: loc === "/employees" },
    { href: "/settings", label: "Settings", icon: Settings, active: loc.startsWith("/settings") },
  ];

  return (
    <div className="min-h-dvh flex flex-col">
      <header className="sticky top-0 z-40 border-b bg-card/90 backdrop-blur supports-[backdrop-filter]:bg-card/75">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-3 sm:px-5">
          <Link href="/" className="flex items-center gap-2 min-w-0" data-testid="link-home">
            <Logo className="h-7 w-7 shrink-0" />
            <span className="hidden md:inline font-semibold truncate max-w-[14rem]">{app.prefs.appName}</span>
          </Link>
          <div className="mx-1 h-6 w-px bg-border hidden sm:block" />
          {app.activeSites.length > 1 || !inWorkspace ? (
            <Select value={app.site.id} onValueChange={app.setSiteId} disabled={inWorkspace}>
              <SelectTrigger className="h-9 w-auto min-w-0 max-w-[11rem] [&>span]:min-w-0 sm:max-w-[16rem] gap-2 border-none bg-transparent shadow-none hover:bg-accent focus:ring-0" data-testid="select-site">
                <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {app.activeSites.map((s) => (
                  <SelectItem key={s.id} value={s.id} data-testid={`option-site-${s.id}`}>
                    <span className="flex min-w-0 items-center gap-2"><SiteDot color={s.color} /><span className="truncate">{s.name}</span></span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <nav className="ml-auto flex items-center gap-1">
            {nav.map((n) => (
              <Link key={n.href} href={n.href}>
                <Button variant="ghost" size="sm" className={cn("gap-1.5", n.active && "bg-accent text-accent-foreground")} data-testid={`nav-${n.label.toLowerCase()}`}>
                  <n.icon className="h-4 w-4" />
                  <span className="hidden sm:inline">{n.label}</span>
                </Button>
              </Link>
            ))}
            {!app.db.connected && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link href="/settings/database"><span className="ml-1 inline-block h-2.5 w-2.5 rounded-full bg-amber-500" data-testid="status-db-warning" /></Link>
                </TooltipTrigger>
                <TooltipContent>Database problem — open Settings</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Sign out" onClick={() => { session.clear(); queryClient.clear(); }} data-testid="button-signout">
                  <LogOut className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Sign out</TooltipContent>
            </Tooltip>
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
