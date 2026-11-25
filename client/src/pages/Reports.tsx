import { useEffect, useMemo, useState } from "react";
import { csvCell } from "@shared/csvSafe";
import { Link, useLocation } from "wouter";
import { useQueries, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, Download, Loader2, Users } from "lucide-react";
import type { TimesheetDoc, TimesheetSummary } from "@shared/schema";
import { computePayroll, employeeKey } from "@shared/engine";
import { addDays, todayISO } from "@shared/dates";
import { useApp } from "@/context/AppData";
import { api, errorMessage } from "@/lib/api";
import { downloadBlob } from "@/lib/doc";
import { SiteDot } from "@/components/AppShell";
import { BarChart, BarList } from "@/components/charts/BarChart";
import { Page, PageHeader, SectionLabel } from "@/components/ui/page";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedControl } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { LaborSection } from "@/components/schedule/Labor";
import { can } from "@/lib/roles";

type Range = "3m" | "6m" | "12m" | "all" | "custom";
const ALL = "__all__";
/** Max timesheet documents fetched for the employee breakdown. */
const MAX_DOCS = 12;

interface PeriodRow { key: string; start: string; end: string; total: number; count: number; ids: string[] }

export function ReportsPage() {
  const app = useApp();
  const [, navigate] = useLocation();
  const list = useQuery<TimesheetSummary[]>({ queryKey: ["/api/timesheets"] });
  const today = todayISO(app.site.rules.timezone);
  const [range, setRange] = useState<Range>("6m");
  const [from, setFrom] = useState(addDays(today, -182));
  const [to, setTo] = useState(today);
  const [siteId, setSiteId] = useState<string>(ALL);
  const [finalOnly, setFinalOnly] = useState(false);

  const applyRange = (r: Range) => {
    setRange(r);
    if (r === "custom") return;
    setTo(today);
    setFrom(r === "all" ? "" : addDays(today, r === "3m" ? -91 : r === "6m" ? -182 : -365));
  };

  const inRange = useMemo(() => {
    return (list.data ?? []).filter((t) => {
      if (!t.periodStart || !t.periodEnd) return false;
      if (siteId !== ALL && t.siteId !== siteId) return false;
      if (finalOnly && t.status !== "final") return false;
      if (from && t.periodEnd < from) return false;
      if (to && t.periodStart > to) return false;
      return true;
    });
  }, [list.data, siteId, finalOnly, from, to]);
  const undated = (list.data ?? []).filter((t) => !t.periodStart && (siteId === ALL || t.siteId === siteId)).length;

  const periods = useMemo<PeriodRow[]>(() => {
    const m = new Map<string, PeriodRow>();
    for (const t of inRange) {
      const k = `${t.periodStart}|${t.periodEnd}`;
      const row = m.get(k) ?? { key: k, start: t.periodStart!, end: t.periodEnd!, total: 0, count: 0, ids: [] };
      row.total += t.totalPay; row.count++; row.ids.push(t.id);
      m.set(k, row);
    }
    return [...m.values()].sort((a, b) => a.end.localeCompare(b.end) || a.start.localeCompare(b.start));
  }, [inRange]);

  const bySite = useMemo(() => {
    const m = new Map<string, { total: number; count: number }>();
    for (const t of inRange) {
      const k = t.siteId ?? "";
      const r = m.get(k) ?? { total: 0, count: 0 };
      r.total += t.totalPay; r.count++;
      m.set(k, r);
    }
    return [...m.entries()].map(([id, r]) => {
      const s = app.sites.find((x) => x.id === id);
      return { key: id || "none", label: s?.name ?? "No location", color: s?.color, value: r.total, sub: `${r.count} timesheet${r.count === 1 ? "" : "s"}` };
    }).sort((a, b) => b.value - a.value);
  }, [inRange, app.sites]);

  const total = inRange.reduce((s, t) => s + t.totalPay, 0);
  const avg = periods.length ? total / periods.length : 0;
  const last = periods.at(-1);
  const prev = periods.at(-2);
  const change = last && prev && prev.total > 0 ? (last.total - prev.total) / prev.total : null;

  if (!can(app.user, "reports.view")) {
    return <Page wide><EmptyState icon={BarChart3} title="Reports aren't available" description="Your account can't see reports. Ask an owner or administrator if you need them." /></Page>;
  }

  return (
    <Page wide>
      <PageHeader title="Reports" titleTestId="text-page-title" subtitle="Payroll totals across pay periods and locations." />

      {/* Filters */}
      <div className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-card-border bg-card p-3 shadow-card" data-testid="reports-filters">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Range</Label>
          <SegmentedControl<Range>
            label="Date range"
            value={range}
            onChange={applyRange}
            options={[
              { value: "3m", label: "3M", title: "Last 3 months", testid: "range-3m" },
              { value: "6m", label: "6M", title: "Last 6 months", testid: "range-6m" },
              { value: "12m", label: "1Y", title: "Last 12 months", testid: "range-12m" },
              { value: "all", label: "All", testid: "range-all" },
              { value: "custom", label: "Custom", testid: "range-custom" },
            ]}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="r-from" className="text-xs text-muted-foreground">From</Label>
          <Input id="r-from" type="date" className="w-40" value={from} onChange={(e) => { setFrom(e.target.value); setRange("custom"); }} data-testid="input-report-from" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="r-to" className="text-xs text-muted-foreground">To</Label>
          <Input id="r-to" type="date" className="w-40" value={to} onChange={(e) => { setTo(e.target.value); setRange("custom"); }} data-testid="input-report-to" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Location</Label>
          <Select value={siteId} onValueChange={setSiteId}>
            <SelectTrigger className="w-48" aria-label="Location" data-testid="select-report-site"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All locations</SelectItem>
              {app.sites.map((s) => <SelectItem key={s.id} value={s.id}><span className="flex items-center gap-2"><SiteDot color={s.color} />{s.name}</span></SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <label className="flex h-9 cursor-pointer items-center gap-2 px-1 text-[13px]">
          <Checkbox checked={finalOnly} onCheckedChange={(v) => setFinalOnly(v === true)} data-testid="checkbox-final-only" />
          Finalized only
        </label>
      </div>

      {list.isLoading ? (
        <div className="space-y-4"><div className="grid gap-4 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div><Skeleton className="h-72 rounded-xl" /></div>
      ) : list.error ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load timesheets" description={errorMessage(list.error)} action={<Button variant="outline" size="sm" onClick={() => list.refetch()}>Try again</Button>} />
      ) : inRange.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="Nothing to report in this range"
          description={(list.data ?? []).length ? "Widen the date range or choose All locations." : "Reports fill in as you save timesheets."}
          action={(list.data ?? []).length ? <Button variant="outline" size="sm" onClick={() => { applyRange("all"); setSiteId(ALL); setFinalOnly(false); }}>Show everything</Button> : undefined}
        />
      ) : (
        <div className="space-y-8">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Kpi label="Total payroll" value={app.money(total)} sub={`${inRange.length} timesheet${inRange.length === 1 ? "" : "s"}`} testid="kpi-report-total" />
            <Kpi label="Pay periods" value={String(periods.length)} sub={periods.length ? `${app.date(periods[0].start)} – ${app.date(last!.end)}` : ""} />
            <Kpi label="Average per period" value={app.money(avg)} />
            <Kpi
              label="Latest vs previous"
              value={change === null ? "—" : `${change >= 0 ? "+" : "−"}${Math.abs(change * 100).toFixed(1)}%`}
              sub={last && prev ? `${app.money(last.total - prev.total)} difference` : "Needs two periods"}
              tone={change === null ? undefined : change >= 0 ? "up" : "down"}
            />
          </div>

          <section>
            <SectionLabel>Totals by pay period</SectionLabel>
            <div className="rounded-xl border border-card-border bg-card p-5 shadow-card">
              <BarChart
                ariaLabel="Total payroll by pay period"
                bars={periods.slice(-24).map((p) => ({
                  key: p.key,
                  label: shortDate(p.end),
                  detail: `${app.date(p.start)} – ${app.date(p.end)}${p.count > 1 ? ` · ${p.count} timesheets` : ""}`,
                  value: p.total,
                  onClick: p.ids.length === 1 ? () => navigate(`/timesheet/${p.ids[0]}`) : undefined,
                }))}
                format={app.money}
                height={220}
                highlightLast
              />
              {periods.length > 24 && <p className="mt-3 text-xs text-muted-foreground">Showing the latest 24 of {periods.length} periods.</p>}
            </div>
          </section>

          <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
            <section>
              <SectionLabel>By location</SectionLabel>
              <div className="rounded-xl border border-card-border bg-card p-5 shadow-card">
                <BarList items={bySite} format={app.money} />
              </div>
            </section>
            <section>
              <SectionLabel>Period over period</SectionLabel>
              <div className="overflow-hidden rounded-xl border border-card-border bg-card shadow-card">
                <div className="max-h-[22rem] overflow-y-auto">
                  <table className="w-full text-[13px]" data-testid="table-periods">
                    <thead className="sticky top-0 bg-card/95 backdrop-blur">
                      <tr className="border-b border-border/70 text-left text-xs text-muted-foreground">
                        <th className="px-4 py-2 font-medium">Pay period</th>
                        <th className="px-4 py-2 text-right font-medium">Total</th>
                        <th className="px-4 py-2 text-right font-medium">Change</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {[...periods].reverse().map((p, i, arr) => {
                        const before = arr[i + 1];
                        const ch = before && before.total > 0 ? (p.total - before.total) / before.total : null;
                        return (
                          <tr key={p.key}>
                            <td className="px-4 py-2.5">{app.date(p.start)} – {app.date(p.end)}{p.count > 1 && <span className="ml-1.5 text-xs text-muted-foreground">({p.count})</span>}</td>
                            <td className="px-4 py-2.5 text-right font-medium tabular">{app.money(p.total)}</td>
                            <td className="px-4 py-2.5 text-right tabular">
                              {ch === null ? <span className="text-muted-foreground">—</span> : (
                                <span className={cn("inline-flex items-center gap-0.5", ch >= 0 ? "text-success" : "text-danger")}>
                                  {ch >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}{Math.abs(ch * 100).toFixed(1)}%
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          </div>

          <EmployeeBreakdown timesheets={inRange} />
          {undated > 0 && <p className="text-xs text-muted-foreground">{undated} timesheet{undated === 1 ? " has" : "s have"} no dates yet and {undated === 1 ? "isn't" : "aren't"} included.</p>}
        </div>
      )}
      <LaborSection className="mt-10" />
    </Page>
  );
}

function EmployeeBreakdown({ timesheets }: { timesheets: TimesheetSummary[] }) {
  const app = useApp();
  const sorted = useMemo(() => [...timesheets].sort((a, b) => (b.periodEnd ?? "").localeCompare(a.periodEnd ?? "")), [timesheets]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState<string[]>([]);

  // Default selection: the most recent few timesheets in range.
  const idsKey = sorted.map((t) => t.id).join(",");
  useEffect(() => {
    setSelected(new Set(sorted.slice(0, 4).map((t) => t.id)));
    setLoaded([]);
  }, [idsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const docs = useQueries({
    queries: loaded.map((id) => ({
      queryKey: ["/api/timesheets", id, "doc"],
      queryFn: () => api<{ doc: TimesheetDoc }>("GET", `/api/timesheets/${id}`),
      staleTime: 60_000,
    })),
  });
  const loading = docs.some((d) => d.isLoading);
  const failed = docs.filter((d) => d.error).length;

  const rows = useMemo(() => {
    const m = new Map<string, { name: string; sheets: number; fullDays: number; halfDays: number; flagged: number; hours: number; total: number }>();
    for (const q of docs) {
      const d = q.data?.doc;
      if (!d) continue;
      const r = computePayroll({ shifts: d.shifts, employees: d.employees, manualEmployees: d.manualEmployees, categories: app.categories, rules: d.rules });
      for (const e of r.employees) {
        if (e.excluded) continue;
        const k = employeeKey(e.name);
        const row = m.get(k) ?? { name: e.name, sheets: 0, fullDays: 0, halfDays: 0, flagged: 0, hours: 0, total: 0 };
        row.sheets++; row.fullDays += e.fullDays; row.halfDays += e.halfDays; row.flagged += e.flaggedDays; row.hours += e.hoursWorked; row.total += e.totalPay;
        m.set(k, row);
      }
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [docs, app.categories]);

  const toggle = (id: string) => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id);
    else if (s.size < MAX_DOCS) s.add(id);
    setSelected(s);
  };
  const run = () => setLoaded(sorted.filter((t) => selected.has(t.id)).map((t) => t.id));
  const dirty = loaded.length !== selected.size || loaded.some((id) => !selected.has(id));
  const grand = rows.reduce((s, r) => s + r.total, 0);

  const exportCsv = () => {
    const lines = [["Employee", "Timesheets", "Full days", "Half days", "Flagged days", "Hours", "Total pay"].join(",")];
    for (const r of rows) lines.push([r.name, r.sheets, r.fullDays, r.halfDays, r.flagged, Math.round(r.hours * 100) / 100, r.total.toFixed(2)].map(csvCell).join(","));
    downloadBlob(lines.join("\n"), `employees_${new Date().toISOString().slice(0, 10)}.csv`, "text/csv");
  };

  return (
    <section>
      <SectionLabel action={rows.length > 0 && can(app.user, "export") && <Button variant="ghost" size="sm" onClick={exportCsv} data-testid="button-export-employees"><Download />Export CSV</Button>}>By employee</SectionLabel>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="rounded-xl border border-card-border bg-card shadow-card">
          <div className="border-b border-border/70 px-4 py-3">
            <p className="text-[13px] font-semibold">Timesheets</p>
            <p className="text-xs text-muted-foreground">Pick up to {MAX_DOCS} to combine.</p>
          </div>
          <ul className="max-h-[20rem] overflow-y-auto p-1.5" data-testid="list-report-timesheets">
            {sorted.map((t) => {
              const on = selected.has(t.id);
              const s = app.sites.find((x) => x.id === t.siteId);
              return (
                <li key={t.id}>
                  <label className={cn("flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] hover:bg-foreground/[0.03]", !on && selected.size >= MAX_DOCS && "cursor-not-allowed opacity-50")}>
                    <Checkbox checked={on} onCheckedChange={() => toggle(t.id)} disabled={!on && selected.size >= MAX_DOCS} data-testid={`checkbox-report-${t.id}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{t.customLabel || t.filename || "Untitled"}</span>
                      <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">{s && <SiteDot color={s.color} className="h-2 w-2" />}{app.date(t.periodStart)} – {app.date(t.periodEnd)}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-border/70 p-3">
            <Button className="w-full" onClick={run} disabled={!selected.size || (!dirty && !failed)} data-testid="button-run-employee-report">
              {loading ? <Loader2 className="animate-spin" /> : <Users />}{loaded.length && !dirty ? "Up to date" : `Combine ${selected.size} timesheet${selected.size === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>

        <div className="min-w-0 overflow-hidden rounded-xl border border-card-border bg-card shadow-card">
          {!loaded.length ? (
            <EmptyState compact icon={Users} title="Combine timesheets to compare people" description="Pick timesheets on the left, then Combine. Pay is recalculated with today's categories." />
          ) : loading && !rows.length ? (
            <div className="space-y-2 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8" />)}</div>
          ) : (
            <div className="overflow-x-auto">
              {failed > 0 && <p className="border-b border-border/70 bg-warning-soft px-4 py-2 text-xs text-warning" role="alert">{failed} timesheet{failed === 1 ? "" : "s"} couldn't be loaded and {failed === 1 ? "is" : "are"} left out.</p>}
              <table className="w-full min-w-[36rem] text-[13px]" data-testid="table-employees">
                <thead>
                  <tr className="border-b border-border/70 text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Employee</th>
                    <th className="px-3 py-2 text-right font-medium">Sheets</th>
                    <th className="px-3 py-2 text-right font-medium">Full</th>
                    <th className="px-3 py-2 text-right font-medium">Half</th>
                    <th className="px-3 py-2 text-right font-medium">Flagged</th>
                    <th className="px-3 py-2 text-right font-medium">Hours</th>
                    <th className="px-4 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {rows.map((r) => (
                    <tr key={r.name} className="hover:bg-foreground/[0.02]">
                      <td className="px-4 py-2.5 font-medium">{r.name}</td>
                      <td className="px-3 py-2.5 text-right tabular text-muted-foreground">{r.sheets}</td>
                      <td className="px-3 py-2.5 text-right tabular">{r.fullDays}</td>
                      <td className="px-3 py-2.5 text-right tabular">{r.halfDays}</td>
                      <td className={cn("px-3 py-2.5 text-right tabular", r.flagged > 0 && "text-danger")}>{r.flagged}</td>
                      <td className="px-3 py-2.5 text-right tabular">{Math.round(r.hours * 10) / 10}</td>
                      <td className="px-4 py-2.5 text-right font-semibold tabular">{app.money(r.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border bg-foreground/[0.02]">
                    <td className="px-4 py-2.5 font-semibold" colSpan={6}>{rows.length} people</td>
                    <td className="px-4 py-2.5 text-right font-semibold tabular">{app.money(grand)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
      <p className="mt-2 px-1 text-xs text-muted-foreground">Read-only — nothing here changes a timesheet. <Link href="/timesheets" className="text-primary hover:underline">Open Timesheets</Link> to edit.</p>
    </section>
  );
}

function Kpi({ label, value, sub, tone, testid }: { label: string; value: string; sub?: string; tone?: "up" | "down"; testid?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-card-border bg-card p-4 shadow-card sm:p-5">
      <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
      <p className={cn("mt-2 truncate text-[24px] font-semibold leading-none tracking-tight tabular", tone === "up" && "text-success", tone === "down" && "text-danger")} data-testid={testid}>{value}</p>
      {sub && <p className="mt-1.5 truncate text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function shortDate(iso: string) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
