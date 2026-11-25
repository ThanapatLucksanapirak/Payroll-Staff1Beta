import { useMemo } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, CalendarRange, CheckCircle2, ChevronRight, FileSpreadsheet, FileText, Flag, Link2, Plus, Table2, Users, Wallet } from "lucide-react";
import type { TimesheetDoc, TimesheetSummary } from "@shared/schema";
import { computePayroll } from "@shared/engine";
import { todayISO } from "@shared/dates";
import { useApp } from "@/context/AppData";
import { api, errorMessage } from "@/lib/api";
import { timeAgo } from "@/lib/doc";
import { useNewTimesheet } from "@/components/NewTimesheet";
import { SiteDot } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { BarChart } from "@/components/charts/BarChart";
import { Page, PageHeader, SectionLabel } from "@/components/ui/page";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function HomePage() {
  const app = useApp();
  const [, navigate] = useLocation();
  const newTimesheet = useNewTimesheet();
  const site = app.site;
  const list = useQuery<TimesheetSummary[]>({ queryKey: ["/api/timesheets"] });

  const siteRows = useMemo(() => (list.data ?? []).filter((t) => t.siteId === site.id), [list.data, site.id]);
  const byPeriod = useMemo(() => [...siteRows].filter((t) => t.periodEnd).sort((a, b) => (b.periodEnd ?? "").localeCompare(a.periodEnd ?? "")), [siteRows]);
  const latest = byPeriod[0];
  const previous = byPeriod[1];
  const recent = useMemo(() => [...siteRows].sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)).slice(0, 5), [siteRows]);
  const drafts = siteRows.filter((t) => (t.status || "draft") === "draft").length;

  // Flags come from running the engine on the latest timesheet (read-only).
  const latestDoc = useQuery({
    queryKey: ["/api/timesheets", latest?.id, "doc"],
    queryFn: () => api<{ doc: TimesheetDoc }>("GET", `/api/timesheets/${latest!.id}`),
    enabled: !!latest,
    staleTime: 30_000,
  });
  const flags = useMemo(() => {
    const d = latestDoc.data?.doc;
    if (!d) return null;
    const r = computePayroll({ shifts: d.shifts, employees: d.employees, manualEmployees: d.manualEmployees, categories: app.categories, rules: d.rules });
    return { flagged: r.totals.flaggedDays, warnings: r.warnings.filter((w) => w.level === "warn").length };
  }, [latestDoc.data, app.categories]);

  const change = latest && previous && previous.totalPay > 0 ? (latest.totalPay - previous.totalPay) / previous.totalPay : null;
  const trend = useMemo(() => [...byPeriod].slice(0, 8).reverse(), [byPeriod]);
  const squareOn = !!app.squareConnected[site.id];
  const today = new Date(`${todayISO(site.rules.timezone)}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <Page>
      <PageHeader
        eyebrow={today}
        title={greeting()}
        titleTestId="text-page-title"
        subtitle={<span className="inline-flex items-center gap-1.5"><SiteDot color={site.color} />{site.name}{site.address ? ` · ${site.address}` : ""}</span>}
        actions={<Button onClick={() => newTimesheet()} data-testid="button-new-timesheet"><Plus /> New timesheet</Button>}
      />

      {/* Quick actions */}
      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <QuickAction icon={CalendarRange} tint="bg-[#0a84ff]" title="Pull from Square" sub={squareOn ? "Fetch timecards" : "Not connected"} onClick={() => newTimesheet("square")} testid="square" />
        <QuickAction icon={FileSpreadsheet} tint="bg-[#30d158]" title="Upload CSV" sub="Square, Toast, Sling…" onClick={() => newTimesheet("csv")} testid="csv" />
        <QuickAction icon={FileText} tint="bg-[#ff9f0a]" title="Toast PDF" sub="Schedule or time entries" onClick={() => newTimesheet("pdf")} testid="pdf" />
        <QuickAction icon={Plus} tint="bg-[#8e8e93]" title="New timesheet" sub="Blank or any source" onClick={() => newTimesheet()} testid="new" />
      </div>

      {list.isLoading ? (
        <div className="space-y-4"><div className="grid gap-4 sm:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-32 rounded-xl" />)}</div><Skeleton className="h-64 rounded-xl" /></div>
      ) : list.error ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load timesheets" description={errorMessage(list.error)} action={<Button variant="outline" size="sm" onClick={() => list.refetch()}>Try again</Button>} />
      ) : !siteRows.length ? (
        <EmptyState
          icon={Table2}
          title={`Welcome to ${app.prefs.appName}`}
          description={`There are no timesheets for ${site.name} yet. Pull timecards from Square or upload a file to run your first payroll.`}
          action={<>
            {!squareOn && <Button asChild variant="outline"><Link href="/settings/locations"><Link2 />Connect Square</Link></Button>}
            <Button onClick={() => newTimesheet()}><Plus />New timesheet</Button>
          </>}
        />
      ) : (
        <>
          {/* At a glance */}
          <SectionLabel>At a glance</SectionLabel>
          <div className="mb-8 grid gap-4 sm:grid-cols-3">
            <StatCard
              icon={Wallet}
              label="Latest pay period"
              value={latest ? app.money(latest.totalPay) : "—"}
              sub={latest ? `${app.date(latest.periodStart)} – ${app.date(latest.periodEnd)}` : "No dated timesheets"}
              extra={change !== null && (
                <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium", change >= 0 ? "text-success" : "text-danger")}>
                  {change >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
                  {Math.abs(change * 100).toFixed(1)}% vs previous
                </span>
              )}
              onClick={latest ? () => navigate(`/timesheet/${latest.id}`) : undefined}
              testid="stat-latest-total"
            />
            <StatCard icon={Users} label="Employees paid" value={latest ? String(latest.employeeCount) : "—"} sub={latest ? (latest.customLabel || latest.filename) : ""} testid="stat-employees" />
            <StatCard
              icon={Flag}
              label="Flags to review"
              value={flags ? String(flags.flagged + flags.warnings) : latestDoc.isLoading ? "…" : "—"}
              sub={flags ? (flags.flagged + flags.warnings === 0 ? "All clear on the latest period" : `${flags.flagged} flagged day${flags.flagged === 1 ? "" : "s"} · ${flags.warnings} warning${flags.warnings === 1 ? "" : "s"}`) : "In the latest period"}
              tone={flags && flags.flagged + flags.warnings > 0 ? "warn" : flags ? "ok" : undefined}
              onClick={latest ? () => navigate(`/timesheet/${latest.id}`) : undefined}
              testid="stat-flags"
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
            {/* Recent timesheets */}
            <section>
              <SectionLabel action={<Link href="/timesheets" className="inline-flex items-center gap-0.5 text-[13px] font-medium text-primary hover:underline" data-testid="link-all-timesheets">See all<ChevronRight className="h-3.5 w-3.5" /></Link>}>Recent timesheets</SectionLabel>
              <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-card-border bg-card shadow-card" data-testid="list-recent">
                {recent.map((t) => (
                  <li key={t.id}>
                    <Link href={`/timesheet/${t.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-foreground/[0.02] focus-visible:bg-foreground/[0.03] focus-visible:outline-none" data-testid={`link-recent-${t.id}`}>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] font-medium">{t.customLabel || t.filename || "Untitled"}</p>
                        <p className="truncate text-xs text-muted-foreground">{t.periodStart ? `${app.date(t.periodStart)} – ${app.date(t.periodEnd)}` : "No dates"} · {t.employeeCount} people · edited {timeAgo(t.updatedAt ?? t.createdAt)}</p>
                      </div>
                      <span className="hidden sm:block"><StatusBadge status={t.status} /></span>
                      <span className="w-24 text-right text-[14px] font-semibold tabular">{app.money(t.totalPay)}</span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />
                    </Link>
                  </li>
                ))}
              </ul>
              {drafts > 0 && <p className="mt-2 px-1 text-xs text-muted-foreground">{drafts} draft{drafts === 1 ? "" : "s"} still open at {site.name}.</p>}
            </section>

            {/* Trend */}
            <section>
              <SectionLabel action={<Link href="/reports" className="inline-flex items-center gap-0.5 text-[13px] font-medium text-primary hover:underline" data-testid="link-reports">Reports<ChevronRight className="h-3.5 w-3.5" /></Link>}>Payroll by period</SectionLabel>
              <div className="rounded-xl border border-card-border bg-card p-5 shadow-card">
                {trend.length < 2 ? (
                  <EmptyState compact icon={CheckCircle2} title="Trends appear after two pay periods" description="Keep saving timesheets and totals will chart here." />
                ) : (
                  <BarChart
                    ariaLabel={`Total payroll for the last ${trend.length} pay periods at ${site.name}`}
                    bars={trend.map((t) => ({ key: t.id, label: shortDate(t.periodEnd), detail: `${app.date(t.periodStart)} – ${app.date(t.periodEnd)}`, value: t.totalPay, onClick: () => navigate(`/timesheet/${t.id}`) }))}
                    format={app.money}
                    height={170}
                    highlightLast
                  />
                )}
                <div className="mt-4 flex items-center justify-between border-t border-border/70 pt-3 text-[13px]">
                  <span className="text-muted-foreground">Square</span>
                  {squareOn
                    ? <span className="inline-flex items-center gap-1 font-medium text-success"><CheckCircle2 className="h-3.5 w-3.5" />Connected</span>
                    : <Link href="/settings/locations" className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline">Connect<ArrowRight className="h-3.5 w-3.5" /></Link>}
                </div>
              </div>
            </section>
          </div>
        </>
      )}
    </Page>
  );
}

function shortDate(iso: string | null) {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function QuickAction({ icon: Icon, title, sub, onClick, testid, tint }: { icon: any; title: string; sub: string; onClick: () => void; testid: string; tint: string }) {
  return (
    <button
      onClick={onClick}
      className="group flex min-w-0 flex-col items-start gap-2.5 rounded-xl border border-card-border bg-card p-3.5 text-left sm:flex-row sm:items-center sm:gap-3 shadow-card transition-[box-shadow,transform] duration-200 hover:-translate-y-px hover:shadow-float focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 active:scale-[0.99]"
      data-testid={`button-quick-${testid}`}
    >
      <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-white shadow-sm", tint)}><Icon className="h-[18px] w-[18px]" /></span>
      <span className="min-w-0">
        <span className="block text-[13.5px] font-semibold sm:truncate">{title}</span>
        <span className="block text-xs text-muted-foreground sm:truncate">{sub}</span>
      </span>
    </button>
  );
}

function StatCard({ icon: Icon, label, value, sub, extra, tone, onClick, testid }: {
  icon: any; label: string; value: string; sub?: string; extra?: React.ReactNode; tone?: "warn" | "ok"; onClick?: () => void; testid?: string;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      className={cn("flex min-w-0 flex-col rounded-xl border border-card-border bg-card p-5 text-left shadow-card", onClick && "transition-shadow duration-200 hover:shadow-float focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35")}
      data-testid={testid}
    >
      <span className="flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground">
        <Icon className={cn("h-4 w-4", tone === "warn" ? "text-warning" : tone === "ok" ? "text-success" : "")} />{label}
      </span>
      <span className="mt-3 text-[28px] font-semibold leading-none tracking-tight tabular">{value}</span>
      <span className="mt-2 flex min-h-[1rem] flex-wrap items-center gap-x-2 gap-y-0.5">
        {sub && <span className="truncate text-xs text-muted-foreground">{sub}</span>}
        {extra}
      </span>
    </Comp>
  );
}
