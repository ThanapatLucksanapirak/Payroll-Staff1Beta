// Labor cost vs. sales and the payroll forecast: a pair of tiles for Home and
// a full section for Reports. Both are for the current location.
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Info, Loader2, Percent, TrendingUp } from "lucide-react";
import type { LaborReport } from "@shared/labor";
import { addDays, startOfWeek, todayISO, WEEKDAYS_SHORT, dayOfWeek } from "@shared/dates";
import { useApp } from "@/context/AppData";
import { api, errorMessage, queryClient } from "@/lib/api";
import { canEdit } from "@/lib/roles";
import { payPeriod } from "@/lib/periods";
import { useToast } from "@/hooks/use-toast";
import { SectionLabel } from "@/components/ui/page";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { SegmentedControl } from "@/components/ui/tabs";
import { NumberInput } from "@/components/workspace/fields";
import { cn } from "@/lib/utils";

type LaborData = LaborReport & { square: { connected: boolean; ok: boolean; message: string | null }; missingRates: string[] };
interface ForecastData {
  start: string; end: string; paidSoFar: number; projected: number; remaining: number; actualHours: number;
  scheduledHoursRemaining: number; hasSchedule: boolean; missingRates: string[]; basis: "punches" | "timesheets"; today: string;
}

const pctText = (p: number | null | undefined) => (p == null ? "—" : `${(p * 100).toFixed(1)}%`);

function useForecast() {
  const app = useApp();
  const period = payPeriod(app.site.rules);
  return { period, q: useQuery<ForecastData>({ queryKey: ["/api/sites", app.site.id, `forecast?start=${period.start}&end=${period.end}`], staleTime: 60_000 }) };
}

function useLabor(from: string, to: string) {
  const app = useApp();
  return useQuery<LaborData>({ queryKey: ["/api/sites", app.site.id, `labor?from=${from}&to=${to}`], staleTime: 60_000 });
}

function Tile({ icon: Icon, label, value, sub, badge, to, testid, children }: { icon: any; label: string; value: string; sub?: React.ReactNode; badge?: React.ReactNode; to: string; testid: string; children?: React.ReactNode }) {
  return (
    // One cell of the Home "Labor" strip; same label / figure / meta rhythm as "At a glance".
    <Link href={to} className="flex min-w-0 flex-col bg-card p-4 text-left transition-colors duration-150 hover:bg-foreground/[0.02] focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/35 sm:p-5" data-testid={testid}>
      <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-muted-foreground"><Icon className="h-4 w-4 shrink-0" /><span className="truncate">{label}</span>{badge}</span>
      <span className="mt-3 text-[26px] font-semibold leading-none tracking-tight tabular">{value}</span>
      <span className="mt-2 min-h-[1rem] text-xs leading-snug text-muted-foreground tabular">{sub}</span>
      {children}
    </Link>
  );
}

export const EstimateBadge = () => <Badge variant="secondary" className="ml-auto">Estimate</Badge>;

/** Home: labor % this week and the projected pay period total. Hidden until there is something to show. */
export function HomeLaborTiles() {
  const app = useApp();
  const tz = app.site.rules.timezone;
  const today = todayISO(tz);
  const weekStart = startOfWeek(today, app.site.rules.weekStartsOn);
  const labor = useLabor(weekStart, today);
  const { q: forecast } = useForecast();
  const l = labor.data;
  const f = forecast.data;
  const showLabor = !!l && (l.totals.labor > 0 || l.totals.sales > 0);
  const showForecast = !!f && (f.projected > 0 || f.hasSchedule);
  if (!showLabor && !showForecast) return null;
  const todayRow = l?.days.find((d) => d.date === today);

  return (
    <section className="mb-8">
      <SectionLabel>Labor</SectionLabel>
      <div className={cn("grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-card-border bg-border/70 shadow-card", showLabor && showForecast && "sm:grid-cols-2")}>
        {showLabor && (
          <Tile
            icon={Percent}
            label="Labor vs. sales this week"
            value={l!.totals.sales > 0 ? pctText(l!.totals.pct) : app.money(l!.totals.labor)}
            sub={l!.totals.sales > 0
              ? `${app.money(l!.totals.labor)} labor on ${app.money(l!.totals.sales)} sales${todayRow?.pct != null ? ` · today ${pctText(todayRow.pct)}` : ""}`
              : "Labor so far. Add sales to see the percentage."}
            badge={<EstimateBadge />}
            to="/reports"
            testid="tile-labor"
          />
        )}
        {showForecast && (
          <Tile
            icon={TrendingUp}
            label="Projected payroll this period"
            value={app.money(f!.projected)}
            sub={`${app.money(f!.paidSoFar)} earned so far + ${app.money(f!.remaining)} scheduled · ${app.date(f!.start)} – ${app.date(f!.end)}`}
            badge={<EstimateBadge />}
            to="/reports"
            testid="tile-forecast"
          />
        )}
      </div>
    </section>
  );
}

type Range = "week" | "last" | "month" | "30";

/** Reports: daily labor vs. sales with manual sales entry, and the forecast. */
export function LaborSection({ className }: { className?: string }) {
  const app = useApp();
  const site = app.site;
  const tz = site.rules.timezone;
  const today = todayISO(tz);
  const editable = canEdit(app.user);
  const [range, setRange] = useState<Range>("week");
  const { from, to } = useMemo(() => {
    const ws = startOfWeek(today, site.rules.weekStartsOn);
    if (range === "last") return { from: addDays(ws, -7), to: addDays(ws, -1) };
    if (range === "month") return { from: `${today.slice(0, 8)}01`, to: today };
    if (range === "30") return { from: addDays(today, -29), to: today };
    return { from: ws, to: addDays(ws, 6) };
  }, [range, today, site.rules.weekStartsOn]);
  const labor = useLabor(from, to);
  const { q: forecast } = useForecast();
  const l = labor.data;
  const f = forecast.data;

  return (
    <div className={cn("space-y-8", className)} data-testid="section-labor">
      <section>
        <SectionLabel action={<span className="text-xs text-muted-foreground">{site.name}</span>}>Payroll forecast</SectionLabel>
        {forecast.isLoading ? <Skeleton className="h-28 rounded-xl" /> : forecast.error ? (
          <p className="rounded-xl border border-card-border bg-card p-5 text-[13px] text-muted-foreground shadow-card">{errorMessage(forecast.error)}</p>
        ) : f && (
          <div className="rounded-xl border border-card-border bg-card p-5 shadow-card" data-testid="card-forecast">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-medium text-muted-foreground"><span className="tabular">Current pay period · {app.date(f.start)} – {app.date(f.end)}</span> <Badge variant="secondary">Estimate</Badge></p>
                <p className="mt-2 text-[28px] font-semibold leading-none tracking-tight tabular">{app.money(f.projected)}</p>
              </div>
              <dl className="grid grid-cols-2 gap-x-8 gap-y-1 text-[13px] sm:grid-cols-4">
                <div><dt className="text-xs text-muted-foreground">Earned so far</dt><dd className="font-semibold tabular">{app.money(f.paidSoFar)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Hours so far</dt><dd className="font-semibold tabular">{f.actualHours.toFixed(1)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Still scheduled</dt><dd className="font-semibold tabular">{app.money(f.remaining)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Scheduled hours left</dt><dd className="font-semibold tabular">{f.scheduledHoursRemaining.toFixed(1)}</dd></div>
              </dl>
            </div>
            <p className="mt-4 flex items-start gap-1.5 border-t border-border/70 pt-3 text-xs text-muted-foreground">
              <Info className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>
                {f.basis === "timesheets" ? "Earned so far comes from saved timesheets" : "Earned so far comes from time-clock punches"} at saved rates, plus the rest of the schedule. Bonuses, deductions and edits are not included.
                {!f.hasSchedule && <> No schedule yet for this period: <Link href="/schedule" className="font-medium text-primary hover:underline">build one</Link> to project the rest.</>}
                {f.missingRates.length > 0 && <> {f.missingRates.length} {f.missingRates.length === 1 ? "person has" : "people have"} no saved rate ({f.missingRates.slice(0, 3).join(", ")}{f.missingRates.length > 3 ? "…" : ""}).</>}
              </span>
            </p>
          </div>
        )}
      </section>

      <section>
        <SectionLabel className="flex-wrap" action={
          <SegmentedControl<Range>
            label="Labor range"
            value={range}
            onChange={setRange}
            options={[{ value: "week", label: "Week" }, { value: "last", label: "Last week" }, { value: "month", label: "Month" }, { value: "30", label: "30d", title: "Last 30 days" }]}
          />
        }>
          Labor vs. sales
        </SectionLabel>
        {labor.isLoading ? <Skeleton className="h-72 rounded-xl" /> : labor.error ? (
          <p className="rounded-xl border border-card-border bg-card p-5 text-[13px] text-muted-foreground shadow-card">{errorMessage(labor.error)}</p>
        ) : l && (
          <div className="overflow-hidden rounded-xl border border-card-border bg-card shadow-card">
            {l.square.message && (
              <div className="flex items-start gap-2 border-b border-border/70 bg-warning-soft px-4 py-2.5 text-[13px] text-warning" role="status">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{l.square.message}</span>
              </div>
            )}
            <div className="grid grid-cols-3 divide-x divide-border/70 border-b border-border/70">
              <Stat label="Labor %" value={pctText(l.totals.pct)} />
              <Stat label="Labor" value={app.money(l.totals.labor)} />
              <Stat label="Sales" value={l.totals.sales ? app.money(l.totals.sales) : "—"} />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-[13px]" data-testid="table-labor">
                <thead>
                  <tr className="border-b border-border/70 text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Day</th>
                    <th className="px-4 py-2 font-medium">Sales</th>
                    <th className="px-4 py-2 text-right font-medium">Labor</th>
                    <th className="px-4 py-2 text-right font-medium">Hours</th>
                    <th className="px-4 py-2 text-right font-medium">Labor %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {l.days.map((d) => (
                    <tr key={d.date} className={cn(d.date > today && "text-muted-foreground")}>
                      <td className="whitespace-nowrap px-4 py-2">{WEEKDAYS_SHORT[dayOfWeek(d.date)]} {app.date(d.date)}</td>
                      <td className="px-4 py-1.5"><SalesCell siteId={site.id} date={d.date} value={d.sales} source={d.salesSource} editable={editable && d.date <= today} squareOk={l.square.ok} /></td>
                      <td className="px-4 py-2 text-right tabular">
                        {d.labor ? app.money(d.labor) : "—"}
                        {d.laborSource === "punches" && <span className="ml-1 text-[11px] text-muted-foreground" title="Estimated from punches at saved rates">est.</span>}
                      </td>
                      <td className="px-4 py-2 text-right tabular">{d.hours ? d.hours.toFixed(1) : "—"}</td>
                      <td className={cn("px-4 py-2 text-right font-medium tabular", d.pct != null && d.pct > 0.35 && "text-warning")}>{pctText(d.pct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="border-t border-border/70 px-4 py-2.5 text-xs text-muted-foreground">
              Labor comes from saved timesheets where there is one, otherwise from time-clock punches at saved rates (marked est.).
              Sales come from {l.square.connected && l.square.ok ? "Square (net of tax and tips) unless you type a number in" : "the numbers you type in"}.
              {l.missingRates.length > 0 && ` ${l.missingRates.length} ${l.missingRates.length === 1 ? "person has" : "people have"} no saved rate.`}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-[17px] sm:text-[20px] font-semibold leading-none tracking-tight tabular">{value}</p>
    </div>
  );
}

function SalesCell({ siteId, date, value, source, editable, squareOk }: { siteId: string; date: string; value: number | null; source: "square" | "manual" | null; editable: boolean; squareOk: boolean }) {
  const app = useApp();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? 0);
  const [busy, setBusy] = useState(false);
  const save = async (amount: number | null) => {
    setBusy(true);
    try {
      await api("PUT", `/api/sites/${siteId}/sales`, { date, amount });
      await queryClient.invalidateQueries({ queryKey: ["/api/sites", siteId] });
      setEditing(false);
    } catch (e) { toast({ title: "Couldn't save sales", description: errorMessage(e), variant: "destructive" }); } finally { setBusy(false); }
  };
  if (editing) {
    return (
      <span className="flex items-center gap-1.5">
        <NumberInput className="w-28" prefix={app.prefs.currencySymbol} value={draft} onChange={setDraft} autoFocus onKeyDown={(e) => { if (e.key === "Enter") void save(draft); if (e.key === "Escape") setEditing(false); }} aria-label={`Sales on ${date}`} data-testid={`input-sales-${date}`} />
        <button type="button" className="rounded-sm px-1 py-0.5 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:opacity-45 text-xs font-medium text-primary hover:underline" disabled={busy} onClick={() => save(draft)}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}</button>
        {source === "manual" && <button type="button" className="rounded-sm px-1 py-0.5 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:opacity-45 text-xs text-muted-foreground hover:text-foreground" disabled={busy} onClick={() => save(null)} title={squareOk ? "Use Square's number again" : "Clear"}>Clear</button>}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      <span className="tabular">{value != null ? app.money(value) : "—"}</span>
      {source && <span className="text-[11px] text-muted-foreground">{source === "square" ? "Square" : "manual"}</span>}
      {editable && <button type="button" className="rounded-sm px-1 py-0.5 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:opacity-45 ml-0.5 text-xs font-medium text-primary hover:underline" onClick={() => { setDraft(value ?? 0); setEditing(true); }} data-testid={`button-edit-sales-${date}`}>{value != null ? "Edit" : "Add"}</button>}
    </span>
  );
}
