import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, CheckCircle2, ChevronLeft, CircleDashed, Loader2, ShieldCheck, Wrench } from "lucide-react";
import type { IssueFix, PunchIssue } from "@shared/punchIssues";
import { addDays, formatDayLabel, instantToLocal, isISODate, todayISO } from "@shared/dates";
import { useApp } from "@/context/AppData";
import { errorMessage } from "@/lib/api";
import { canEdit } from "@/lib/roles";
import { useLiveEvents } from "@/lib/live";
import { payPeriod } from "@/lib/periods";
import { type DayView, type ReviewData, approveClean, hm, invalidateTimeclock, setApproval, tcKeys } from "@/lib/timeclock";
import { useToast } from "@/hooks/use-toast";
import { SiteDot } from "@/components/AppShell";
import { Page, PageHeader, SectionLabel } from "@/components/ui/page";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { IssueFixDialog } from "@/components/timeclock/IssueFixDialog";
import { cn } from "@/lib/utils";

/** /live/fix[/:start/:end]: punch problems to fix, and day-by-day approval. */
export function FixPunchesPage({ start: startParam, end: endParam }: { start?: string; end?: string }) {
  const app = useApp();
  const site = app.site;
  const tz = site.rules.timezone;
  const today = todayISO(tz);
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const editable = canEdit(app.user);
  const start = isISODate(startParam) ? startParam : addDays(today, -13);
  const end = isISODate(endParam) && endParam >= start ? endParam : today;
  const q = useQuery<ReviewData>({ queryKey: tcKeys.review(site.id, start, end), staleTime: 0 });
  const [fixing, setFixing] = useState<{ issue: PunchIssue; fix: IssueFix } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useLiveEvents((e) => { if (e.type === "hello" || e.siteId === site.id || e.type === "timeclock") void invalidateTimeclock(site.id); });

  const t = (iso: string | null) => (iso ? app.time(instantToLocal(iso, tz).minutes) : "—");
  const data = q.data;
  const fix = useMemo(() => (data?.issues ?? []).filter((i) => i.severity === "fix"), [data]);
  const review = useMemo(() => (data?.issues ?? []).filter((i) => i.severity === "review"), [data]);
  const byDate = useMemo(() => {
    const m = new Map<string, DayView[]>();
    for (const d of data?.days ?? []) { if (!m.has(d.date)) m.set(d.date, []); m.get(d.date)!.push(d); }
    return [...m.entries()];
  }, [data]);

  const ranges = useMemo(() => {
    const cur = payPeriod(site.rules, 0);
    const prev = payPeriod(site.rules, -1);
    return [
      { id: "7", label: "Last 7 days", start: addDays(today, -6), end: today },
      { id: "14", label: "Last 14 days", start: addDays(today, -13), end: today },
      { id: "cur", label: "This pay period", start: cur.start, end: cur.end < today ? cur.end : today },
      { id: "prev", label: "Last pay period", start: prev.start, end: prev.end },
    ];
  }, [site.rules, today]);
  const rangeId = ranges.find((r) => r.start === start && r.end === end)?.id ?? "custom";

  const approve = async (days: DayView[], yes = true) => {
    setBusy(days.length === 1 ? `${days[0].date}|${days[0].employeeId}` : "many");
    try {
      const r = await setApproval(site.id, days.map((d) => ({ employeeId: d.employeeId, date: d.date })), yes);
      if (r.skipped.length) toast({ title: "Some days weren't approved", description: r.skipped[0].reason, variant: "destructive" });
    } catch (e) { toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" }); } finally { setBusy(null); }
  };
  const approveAllClean = async () => {
    setBusy("clean");
    try {
      const r = await approveClean(site.id, start, end);
      toast({ title: r.changed ? `Approved ${r.changed} day${r.changed === 1 ? "" : "s"}` : "Nothing to approve" });
    } catch (e) { toast({ title: "Couldn't approve", description: errorMessage(e), variant: "destructive" }); } finally { setBusy(null); }
  };

  return (
    <Page>
      <Link href="/live" className="mb-1 inline-flex items-center gap-0.5 text-[13px] font-medium text-primary hover:underline" data-testid="link-back-live"><ChevronLeft className="h-4 w-4" />Live</Link>
      <PageHeader
        title="Fix punches"
        titleTestId="text-page-title"
        subtitle={<span className="inline-flex flex-wrap items-center gap-x-1.5"><SiteDot color={site.color} />{site.name}<span aria-hidden>·</span>{app.date(start)} – {app.date(end)}</span>}
        actions={
          <>
            <Select value={rangeId} onValueChange={(v) => { const r = ranges.find((x) => x.id === v); if (r) navigate(`/live/fix/${r.start}/${r.end}`); }}>
              <SelectTrigger className="w-44" aria-label="Dates" data-testid="select-fix-range"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ranges.map((r) => <SelectItem key={r.id} value={r.id}>{r.label}</SelectItem>)}
                {rangeId === "custom" && <SelectItem value="custom">{app.date(start)} – {app.date(end)}</SelectItem>}
              </SelectContent>
            </Select>
            {editable && (
              <Button onClick={approveAllClean} disabled={!data?.counts.clean || busy === "clean"} data-testid="button-approve-clean">
                {busy === "clean" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}Approve clean days{data?.counts.clean ? ` (${data.counts.clean})` : ""}
              </Button>
            )}
          </>
        }
      />

      {q.isLoading ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>
      ) : q.error ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load punches" description={errorMessage(q.error)} action={<Button variant="outline" size="sm" onClick={() => q.refetch()}>Try again</Button>} />
      ) : data && (
        <div className="space-y-8">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="To fix" value={data.counts.fix} tone={data.counts.fix ? "bad" : "ok"} hint="Hours can't be worked out" />
            <Stat label="To double-check" value={data.counts.review} tone={data.counts.review ? "warn" : "ok"} hint="Auto-closed, long or short" />
            <Stat label="Days approved" value={`${data.counts.approved} of ${data.counts.days}`} tone={data.counts.days && data.counts.approved === data.counts.days ? "ok" : undefined} hint={data.autoClose.cutoffMinutes != null ? `Auto clock-out at ${app.time(data.autoClose.cutoffMinutes)}` : data.autoClose.maxShiftHours ? `Auto clock-out after ${data.autoClose.maxShiftHours} h` : "Auto clock-out is off"} />
          </div>

          {fix.length + review.length === 0 ? (
            <EmptyState icon={CheckCircle2} title="No punch problems" description={data.days.length ? "Every shift in these dates pairs up. Approve the days below when you're happy with them." : "No punches in these dates."} />
          ) : (
            <>
              {fix.length > 0 && <IssueList title="Needs fixing" issues={fix} editable={editable} onFix={(issue, f) => setFixing({ issue, fix: f })} dateLabel={(d) => formatDayLabel(d, app.prefs.dateFormat)} />}
              {review.length > 0 && <IssueList title="Double-check" issues={review} editable={editable} onFix={(issue, f) => setFixing({ issue, fix: f })} dateLabel={(d) => formatDayLabel(d, app.prefs.dateFormat)} />}
            </>
          )}

          {byDate.length > 0 && (
            <section>
              <SectionLabel>Days</SectionLabel>
              <div className="space-y-4">
                {byDate.map(([date, days]) => {
                  const ready = days.filter((d) => d.approvable && !d.approved);
                  return (
                    <div key={date} className="overflow-hidden rounded-xl border border-card-border bg-card shadow-card" data-testid={`group-day-${date}`}>
                      <div className="flex items-center justify-between gap-2 border-b border-border/70 px-4 py-2">
                        <span className="text-[13px] font-semibold">{formatDayLabel(date, app.prefs.dateFormat)}</span>
                        {editable && ready.length > 1 && (
                          <Button variant="ghost" size="sm" className="text-primary" disabled={busy === "many"} onClick={() => approve(ready)}>Approve {ready.length}</Button>
                        )}
                      </div>
                      <ul className="divide-y divide-border/70">
                        {days.map((d) => (
                          <li key={d.employeeId} className="flex min-h-[3rem] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[13px]" data-testid={`row-day-${d.date}-${d.employeeId}`}>
                            <span className="min-w-[8rem] flex-1 truncate font-medium">{d.employeeName}</span>
                            <span className="tabular text-muted-foreground">
                              {d.shifts.map((s) => `${t(s.in)} – ${s.open ? (s.superseded ? "no clock-out" : "now") : t(s.out)}`).join(", ")}
                            </span>
                            <span className="w-16 text-right tabular font-semibold">{hm(d.workedMinutes)}</span>
                            <span className="flex w-full items-center justify-end gap-1.5 sm:w-auto sm:min-w-[11rem]">
                              {d.issues.length > 0 && !d.approved && <Badge variant={d.issues.some((i) => i.severity === "fix") ? "destructive" : "warning"}>{d.issues.length} issue{d.issues.length === 1 ? "" : "s"}</Badge>}
                              <ApprovalControl day={d} editable={editable} busy={busy === `${d.date}|${d.employeeId}`} onApprove={(yes) => approve([d], yes)} />
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}

      {fixing && <IssueFixDialog siteId={site.id} tz={tz} issue={fixing.issue} fix={fixing.fix} onClose={() => setFixing(null)} />}
    </Page>
  );
}

function Stat({ label, value, tone, hint }: { label: string; value: number | string; tone?: "ok" | "warn" | "bad"; hint?: string }) {
  return (
    <div className="rounded-xl border border-card-border bg-card px-4 py-3 shadow-card">
      <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-[24px] font-semibold leading-none tracking-tight tabular", tone === "bad" ? "text-danger" : tone === "warn" ? "text-warning" : tone === "ok" ? "text-success" : "")}>{value}</p>
      {hint && <p className="mt-1.5 truncate text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function IssueList({ title, issues, editable, onFix, dateLabel }: { title: string; issues: PunchIssue[]; editable: boolean; onFix: (i: PunchIssue, f: IssueFix) => void; dateLabel: (d: string) => string }) {
  return (
    <section>
      <SectionLabel action={<span className="text-xs text-muted-foreground">{issues.length}</span>}>{title}</SectionLabel>
      <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-card-border bg-card shadow-card" data-testid={`list-issues-${title.toLowerCase().replace(/\W+/g, "-")}`}>
        {issues.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3" data-testid={`issue-${i.id}`}>
            <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full", i.severity === "fix" ? "bg-danger-soft text-danger" : "bg-warning-soft text-warning")}>
              {i.severity === "fix" ? <Wrench className="h-4 w-4" /> : <CircleDashed className="h-4 w-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium">{i.employeeName} <span className="font-normal text-muted-foreground">· {dateLabel(i.date)}</span></p>
              <p className="text-[13px] text-muted-foreground"><b className="font-medium text-foreground">{i.title}.</b> {i.detail}</p>
            </div>
            {editable && (
              <div className="flex flex-wrap gap-1.5">
                {i.fixes.map((f, k) => (
                  <Button key={k} size="sm" variant={k === 0 ? "tinted" : "ghost"} className={cn(f.kind === "delete" && "text-destructive")} onClick={() => onFix(i, f)} data-testid={`button-fix-${i.id}-${k}`}>{f.label}</Button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ApprovalControl({ day, editable, busy, onApprove }: { day: DayView; editable: boolean; busy: boolean; onApprove: (yes: boolean) => void }) {
  if (day.approved) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Badge variant="success" title={day.approval ? `Approved by ${day.approval.byName || "someone"}` : undefined}><Check />Approved</Badge>
        {editable && <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={busy} onClick={() => onApprove(false)}>Undo</Button>}
      </span>
    );
  }
  if (day.working) return <Badge variant="secondary">Still working</Badge>;
  return (
    <span className="inline-flex items-center gap-1.5">
      {day.approvalStale && <Badge variant="warning" title="A punch changed after this day was approved">Changed</Badge>}
      {editable ? (
        <Button size="sm" variant="outline" disabled={busy || !day.approvable} title={day.approvable ? undefined : "Fix the punch problems first"} onClick={() => onApprove(true)} data-testid={`button-approve-${day.date}-${day.employeeId}`}>
          {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}Approve
        </Button>
      ) : <Badge variant="secondary">Not approved</Badge>}
    </span>
  );
}
