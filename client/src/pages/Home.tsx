import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, CalendarRange, CheckCircle2, ChevronRight, FileSpreadsheet, FileText, Flag, Link2, ListChecks, Plus, Radio, Table2, Tablet, Users, Wallet } from "lucide-react";
import type { TimesheetDoc, TimesheetSummary } from "@shared/schema";
import { computePayroll } from "@shared/engine";
import { todayISO } from "@shared/dates";
import { useApp } from "@/context/AppData";
import { api, errorMessage } from "@/lib/api";
import { timeAgo } from "@/lib/doc";
import { canEdit, isAccountant, isAdmin } from "@/lib/roles";
import { useNewTimesheet } from "@/components/NewTimesheet";
import { SiteDot } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { BarChart } from "@/components/charts/BarChart";
import { Page, PageHeader, SectionLabel } from "@/components/ui/page";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { PayrollChecklistDialog } from "@/components/timeclock/PayrollChecklist";
import { InstallHint } from "@/components/InstallHint";
import { AccessNotices } from "@/components/AccessNotices";
import { cn } from "@/lib/utils";
import { HomeLaborTiles } from "@/components/schedule/Labor";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function HomePage() {
  const app = useApp();
  const [, navigate] = useLocation();
  const newTimesheet = useNewTimesheet();
  const [checklist, setChecklist] = useState(false);
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
  const timeSource = site.timeSource ?? "square";
  // Viewers are read only: no new timesheets or imports. Settings links are for owners / admins.
  const editable = canEdit(app.user);
  const admin = isAdmin(app.user);
  const quick = [
    ...(timeSource !== "square" ? [{ icon: Tablet, tint: "bg-foreground/[0.06] text-foreground/70 dark:bg-foreground/10", title: "Time clock", sub: "Hours from the kiosk", source: "kiosk" as const, testid: "kiosk" }] : []),
    ...(timeSource !== "kiosk" ? [{ icon: CalendarRange, tint: "bg-foreground/[0.06] text-foreground/70 dark:bg-foreground/10", title: "Pull from Square", sub: squareOn ? "Fetch timecards" : "Not connected", source: "square" as const, testid: "square" }] : []),
    { icon: FileSpreadsheet, tint: "bg-foreground/[0.06] text-foreground/70 dark:bg-foreground/10", title: "Upload CSV", sub: "Square, Toast, Sling…", source: "csv" as const, testid: "csv" },
    { icon: FileText, tint: "bg-foreground/[0.06] text-foreground/70 dark:bg-foreground/10", title: "Toast PDF", sub: "Schedule or time entries", source: "pdf" as const, testid: "pdf" },
    { icon: Plus, tint: "bg-foreground/[0.06] text-foreground/70 dark:bg-foreground/10", title: "New timesheet", sub: "Blank or any source", source: undefined, testid: "new" },
    ...(timeSource !== "square" ? [{ icon: ListChecks, tint: "bg-foreground/[0.06] text-foreground/70 dark:bg-foreground/10", title: "Payroll checklist", sub: "What's left to fix", source: undefined, testid: "checklist", action: () => setChecklist(true) }] : []),
  ] as { icon: any; tint: string; title: string; sub: string; source: Parameters<typeof newTimesheet>[0]; testid: string; action?: () => void }[];
  const today = new Date(`${todayISO(site.rules.timezone)}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <Page>
      <PageHeader
        title={greeting()}
        titleTestId="text-page-title"
        subtitle={<span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5"><span className="inline-flex items-center gap-1.5"><SiteDot color={site.color} />{site.name}</span><span aria-hidden>·</span><span>{today}</span></span>}
        actions={editable && <Button onClick={() => newTimesheet()} data-testid="button-new-timesheet"><Plus /> New timesheet</Button>}
      />

      <InstallHint />
      <AccessNotices />

      {/* Quick actions */}
      {editable && (
        <div className={cn("mb-8 grid grid-cols-2 gap-3", quick.length > 4 ? "lg:grid-cols-3" : "xl:grid-cols-4")}>
          {quick.map((a) => <QuickAction key={a.testid} icon={a.icon} tint={a.tint} title={a.title} sub={a.sub} onClick={() => (a.action ? a.action() : newTimesheet(a.source))} testid={a.testid} />)}
        </div>
      )}
      {checklist && <PayrollChecklistDialog site={site} onClose={() => setChecklist(false)} />}

      {!isAccountant(app.user) && <HomeLaborTiles />}

      {list.isLoading ? (
        <div className="space-y-8"><Skeleton className="h-[8.5rem] rounded-xl sm:h-[7.75rem]" /><div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]"><Skeleton className="h-72 rounded-xl" /><Skeleton className="h-72 rounded-xl" /></div></div>
      ) : list.error ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load timesheets" description={errorMessage(list.error)} action={<Button variant="outline" size="sm" onClick={() => list.refetch()}>Try again</Button>} />
      ) : !siteRows.length ? (
        <EmptyState
          icon={Table2}
          title={`Welcome to ${app.prefs.appName}`}
          description={isAccountant(app.user)
            ? `Nothing has been published for ${site.name} yet. You'll see payroll here once it's published${app.user.notificationEmail ? ", and you'll get an email" : ""}.`
            : !editable
            ? `There are no timesheets for ${site.name} yet. They'll show up here once your team runs payroll.`
            : timeSource === "kiosk"
              ? `There are no timesheets for ${site.name} yet. Build one from the time clock or upload a file to run your first payroll.`
              : `There are no timesheets for ${site.name} yet. Pull timecards from Square or upload a file to run your first payroll.`}
          action={editable && <>
            {admin && timeSource !== "kiosk" && !squareOn && <Button asChild variant="outline"><Link href="/settings/locations"><Link2 />Connect Square</Link></Button>}
            <Button onClick={() => newTimesheet()}><Plus />New timesheet</Button>
          </>}
        >
          {editable && <FirstRunSteps timeSource={timeSource} />}
        </EmptyState>
      ) : (
        <>
          {/* At a glance */}
          <SectionLabel>At a glance</SectionLabel>
          <div className="mb-8 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-card-border bg-border/70 shadow-card sm:grid-cols-3">
            <StatCard
              icon={Wallet}
              label="Latest pay period"
              value={latest ? app.money(latest.totalPay) : "—"}
              sub={latest ? `${app.date(latest.periodStart)} – ${app.date(latest.periodEnd)}` : "No dated timesheets"}
              extra={change !== null && (
                <span className="inline-flex items-center gap-0.5 text-xs font-medium tabular text-foreground/80">
                  {change >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
                  {Math.abs(change * 100).toFixed(1)}% vs previous
                </span>
              )}
              onClick={latest ? () => navigate(`/timesheet/${latest.id}`) : undefined}
              testid="stat-latest-total"
            />
            <StatCard icon={Users} label="Employees paid" value={latest ? String(latest.employeeCount) : "—"} sub={latest ? (latest.customLabel || latest.filename) : undefined} testid="stat-employees" />
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

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            {/* Recent timesheets */}
            <section>
              <SectionLabel action={<Link href="/timesheets" className="inline-flex items-center gap-0.5 text-[13px] font-medium text-primary hover:underline" data-testid="link-all-timesheets">See all<ChevronRight className="h-3.5 w-3.5" /></Link>}>Recent timesheets</SectionLabel>
              <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-card-border bg-card shadow-card" data-testid="list-recent">
                {recent.map((t) => (
                  <li key={t.id}>
                    <Link href={`/timesheet/${t.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.04] focus-visible:outline-none" data-testid={`link-recent-${t.id}`}>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] font-medium" title={t.customLabel || t.filename || undefined}>{t.customLabel || t.filename || "Untitled"}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          <span className="tabular">{t.periodStart ? `${app.date(t.periodStart)} – ${app.date(t.periodEnd)}` : "No dates"}</span>
                          {" · "}{t.employeeCount} {t.employeeCount === 1 ? "person" : "people"}
                          <span className="hidden sm:inline"> · edited {timeAgo(t.updatedAt ?? t.createdAt)}</span>
                        </p>
                      </div>
                      <span className="hidden shrink-0 sm:block"><StatusBadge status={t.status} publishedAt={t.publishedAt} /></span>
                      <span className="min-w-[5.5rem] shrink-0 text-right text-[14px] font-semibold tabular">{app.money(t.totalPay)}</span>
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
                {!isAccountant(app.user) && timeSource !== "kiosk" && (
                  <div className="mt-4 flex items-center justify-between border-t border-border/70 pt-3 text-[13px]">
                    <span className="text-muted-foreground">Square</span>
                    {squareOn
                      ? <span className="inline-flex items-center gap-1 font-medium text-success"><CheckCircle2 className="h-3.5 w-3.5" />Connected</span>
                      : admin
                        ? <Link href="/settings/locations" className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline">Connect<ArrowRight className="h-3.5 w-3.5" /></Link>
                        : <span className="text-muted-foreground">Not connected</span>}
                  </div>
                )}
                {!isAccountant(app.user) && timeSource !== "square" && (
                  <div className={cn("flex items-center justify-between pt-3 text-[13px]", timeSource === "kiosk" ? "mt-4 border-t border-border/70" : "mt-3")}>
                    <span className="text-muted-foreground">Time clock</span>
                    <Link href="/live" className="inline-flex items-center gap-1 font-medium text-primary hover:underline" data-testid="link-home-live"><Radio className="h-3.5 w-3.5" />See who's in<ArrowRight className="h-3.5 w-3.5" /></Link>
                  </div>
                )}
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
      type="button"
      className="group flex min-w-0 flex-col items-start gap-3 rounded-xl border border-card-border bg-card p-3.5 text-left shadow-card transition-[box-shadow,background-color] duration-200 hover:bg-foreground/[0.015] hover:shadow-float focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 active:scale-[0.99] sm:flex-row sm:items-center"
      data-testid={`button-quick-${testid}`}
    >
      <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]", tint)}><Icon className="h-[18px] w-[18px]" /></span>
      <span className="w-full min-w-0">
        <span className="block truncate text-[13.5px] font-semibold" title={title}>{title}</span>
        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground sm:truncate" title={sub}>{sub}</span>
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
      type={onClick ? "button" : undefined}
      className={cn(
        // One cell of the "At a glance" strip: label, figure, meta on a shared left edge.
        // Phone: label + meta left, figure right, so three facts fit in one compact card.
        "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 bg-card px-4 py-3.5 text-left sm:flex sm:flex-col sm:items-start sm:gap-0 sm:p-5",
        onClick && "transition-colors duration-150 hover:bg-foreground/[0.02] focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/35",
      )}
      data-testid={testid}
    >
      <span className="col-start-1 flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-muted-foreground">
        <Icon className={cn("h-4 w-4 shrink-0", tone === "warn" ? "text-warning" : tone === "ok" ? "text-success" : "")} /><span className="truncate">{label}</span>
      </span>
      <span className={cn("col-start-2 row-span-2 row-start-1 text-right text-[22px] font-semibold leading-none tracking-tight tabular sm:mt-3 sm:text-left sm:text-[26px]", tone === "warn" && "text-warning")}>{value}</span>
      <span className="col-start-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 sm:mt-2 sm:min-h-[1rem]">
        {sub && <span className="truncate text-xs text-muted-foreground tabular" title={sub}>{sub}</span>}
        {extra}
      </span>
    </Comp>
  );
}

/** The order a first payroll goes in, so the starting points above aren't four equal guesses. */
function FirstRunSteps({ timeSource }: { timeSource: string }) {
  const steps: { title: string; sub: string; href?: string }[] = [
    { title: "Add your staff", sub: "Names, and a PIN for anyone using the time clock or staff portal", href: "/employees" },
    { title: "Bring in hours", sub: timeSource === "kiosk" ? "From the time clock, or upload a CSV" : timeSource === "square" ? "Pull from Square, or upload a CSV" : "From the time clock, Square or a CSV" },
    { title: "Set pay rates", sub: "On the timesheet's Rates tab. Save them as defaults for next time" },
    { title: "Review", sub: "Check before export lists anything that needs a look" },
    { title: "Mark as final", sub: "Locks the numbers. Then export, email the PDFs or publish" },
  ];
  return (
    <ol className="mx-auto mt-2 w-full max-w-md space-y-2 text-left" data-testid="first-run-steps">
      {steps.map((st, i) => (
        <li key={st.title} className="flex items-start gap-3 rounded-xl border border-border/80 bg-card px-3.5 py-2.5">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[12px] font-semibold text-primary tabular">{i + 1}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold">{st.href ? <Link href={st.href} className="hover:underline">{st.title}</Link> : st.title}</span>
            <span className="block text-[12px] leading-snug text-muted-foreground">{st.sub}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
