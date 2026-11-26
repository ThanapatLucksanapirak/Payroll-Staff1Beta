import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ChevronRight, Loader2, ShieldCheck, TrendingUp, Wrench } from "lucide-react";
import type { Site } from "@shared/schema";
import type { OvertimeStatus } from "@shared/punchIssues";
import { addDays, instantToLocal, todayISO } from "@shared/dates";
import { useApp } from "@/context/AppData";
import { errorMessage } from "@/lib/api";
import { canEdit } from "@/lib/roles";
import { useLiveEvents } from "@/lib/live";
import { type OvertimeData, type ReviewData, approveClean, hm, invalidateTimeclock, tcKeys } from "@/lib/timeclock";
import { useToast } from "@/hooks/use-toast";
import { SectionLabel } from "@/components/ui/page";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Live page: punch problems and approvals for the last two weeks, and who is heading into overtime. */
export function LiveTimeclockPanel({ site }: { site: Site }) {
  const app = useApp();
  const { toast } = useToast();
  const tz = site.rules.timezone;
  const today = todayISO(tz);
  const start = addDays(today, -13);
  const editable = canEdit(app.user);
  const review = useQuery<ReviewData>({ queryKey: tcKeys.review(site.id, start, today), staleTime: 0, refetchInterval: 5 * 60_000, enabled: site.timeSource !== "square" });
  const ot = useQuery<OvertimeData>({ queryKey: tcKeys.overtime(site.id), staleTime: 0, refetchInterval: 60_000, enabled: site.timeSource !== "square" });
  const [busy, setBusy] = useState(false);
  useLiveEvents((e) => { if (e.siteId === site.id || e.type === "timeclock") void invalidateTimeclock(site.id); });

  if (site.timeSource === "square") return null;
  const r = review.data;
  const yesterday = addDays(today, -1);
  const dayCount = (date: string) => {
    const ds = (r?.days ?? []).filter((d) => d.date === date && !d.working);
    return { total: ds.length, approved: ds.filter((d) => d.approved).length };
  };
  const y = dayCount(yesterday);
  const td = dayCount(today);
  const watch = (ot.data?.employees ?? []).filter((e) => e.state !== "ok");
  // Without the overtime card the review card spans the row: actions sit on the right.
  const single = !ot.data?.enabled;

  const approve = async () => {
    setBusy(true);
    try {
      const res = await approveClean(site.id, start, today);
      toast({ title: res.changed ? `Approved ${res.changed} clean day${res.changed === 1 ? "" : "s"}` : "Nothing to approve" });
    } catch (e) { toast({ title: "Couldn't approve", description: errorMessage(e), variant: "destructive" }); } finally { setBusy(false); }
  };

  return (
    <section data-testid="section-timeclock-review">
      <SectionLabel>Review</SectionLabel>
      <div className={cn("grid gap-4", ot.data?.enabled && "lg:grid-cols-2")}>
        <div className={cn("rounded-xl border border-card-border bg-card p-4 shadow-card", single && "sm:flex sm:items-center sm:justify-between sm:gap-6")}>
          <div className="flex min-w-0 items-start gap-3">
            <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full", r?.counts.fix ? "bg-danger-soft text-danger" : r?.counts.review ? "bg-warning-soft text-warning" : "bg-success-soft text-success")}>
              {r && !r.counts.fix && !r.counts.review ? <CheckCircle2 className="h-[18px] w-[18px]" /> : <Wrench className="h-[18px] w-[18px]" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold tracking-tight" data-testid="text-review-summary">
                {!r ? "Checking punches…" : r.counts.fix + r.counts.review === 0 ? "No punch problems" : [r.counts.fix ? `${r.counts.fix} to fix` : "", r.counts.review ? `${r.counts.review} to double-check` : ""].filter(Boolean).join(" · ")}
              </p>
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                Last 14 days
                {r && <> · approved: yesterday <b className="tabular font-medium text-foreground">{y.approved}/{y.total}</b>, today <b className="tabular font-medium text-foreground">{td.approved}/{td.total}</b></>}
              </p>
            </div>
          </div>
          <div className={cn("mt-4 flex flex-wrap gap-2", single && "sm:mt-0 sm:shrink-0 sm:justify-end")}>
            <Button asChild size="sm" variant={r?.counts.fix ? "tinted" : "outline"}><Link href="/live/fix" data-testid="link-fix-punches"><Wrench />Fix punches & approve<ChevronRight /></Link></Button>
            {editable && !!r?.counts.clean && (
              <Button size="sm" variant="tinted" disabled={busy} onClick={approve} data-testid="button-live-approve-clean">{busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}Approve {r.counts.clean} clean day{r.counts.clean === 1 ? "" : "s"}</Button>
            )}
          </div>
        </div>

        {ot.data?.enabled && (
          <div className="rounded-xl border border-card-border bg-card p-4 shadow-card" data-testid="card-overtime-watch">
            <div className="flex items-start gap-3">
              <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full", watch.some((e) => e.state === "over") ? "bg-danger-soft text-danger" : watch.length ? "bg-warning-soft text-warning" : "bg-success-soft text-success")}>
                <TrendingUp className="h-[18px] w-[18px]" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-semibold tracking-tight">Overtime watch</p>
                <p className="mt-0.5 text-[13px] text-muted-foreground">
                  Week of {app.date(ot.data.weekStart)} · over {ot.data.weeklyHours > 0 ? `${ot.data.weeklyHours} h/week` : ""}{ot.data.weeklyHours > 0 && ot.data.dailyHours > 0 ? " or " : ""}{ot.data.dailyHours > 0 ? `${ot.data.dailyHours} h/day` : ""}
                </p>
              </div>
            </div>
            {watch.length === 0 ? (
              <p className="mt-4 text-[13px] text-muted-foreground">Nobody is close to overtime this week.</p>
            ) : (
              <ul className="mt-3 divide-y divide-border/70">
                {watch.slice(0, 6).map((e) => <OvertimeRow key={e.employeeId} e={e} tz={tz} />)}
              </ul>
            )}
            {watch.length > 6 && <p className="mt-2 text-xs text-muted-foreground">and {watch.length - 6} more</p>}
          </div>
        )}
      </div>
    </section>
  );
}

function OvertimeRow({ e, tz }: { e: OvertimeStatus; tz: string }) {
  const app = useApp();
  const when = e.crossesAt ? app.time(instantToLocal(e.crossesAt, tz).minutes) : null;
  const limitLabel = e.limit === "daily" ? "today" : "this week";
  const text = e.state === "over"
    ? `In overtime ${limitLabel}`
    : e.state === "near"
      ? `${hm(e.minutesLeft ?? 0)} left${when ? ` · at ${when} if they stay` : ""}`
      : `On pace for ${Math.round(e.projectedWeekMinutes / 60)} h`;
  return (
    <li className="flex items-center gap-3 py-2 text-[13px]" data-testid={`row-overtime-${e.employeeId}`}>
      <span className={cn("h-2 w-2 shrink-0 rounded-full", e.working ? "bg-success" : "bg-muted-foreground/40")} title={e.working ? "Working now" : "Not working now"} />
      <span className="min-w-0 flex-1 truncate font-medium">{e.employeeName}</span>
      <Badge variant={e.state === "over" ? "destructive" : e.state === "near" ? "warning" : "secondary"}>{text}</Badge>
      <span className="w-16 shrink-0 text-right tabular text-muted-foreground">{hm(e.weekMinutes)}</span>
    </li>
  );
}
