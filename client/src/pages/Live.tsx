import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Clock, Coffee, Loader2, LogOut, Pencil, Plus, Tablet, Trash2, UserRound, Users, XCircle } from "lucide-react";
import { type ClockStatus, type Punch, type PunchType, PUNCH_LABELS, PUNCH_TYPES } from "@shared/punches";
import { instantToLocal, localToInstant, minutesToInput, inputToMinutes, todayISO } from "@shared/dates";
import { useApp } from "@/context/AppData";
import { api, errorMessage, queryClient } from "@/lib/api";
import { can, isAdmin } from "@/lib/roles";
import { useLiveEvents } from "@/lib/live";
import { useToast } from "@/hooks/use-toast";
import { SiteDot } from "@/components/AppShell";
import { Page, PageHeader, SectionLabel } from "@/components/ui/page";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/workspace/fields";
import { ScheduleAlerts } from "@/components/schedule/ScheduleAlerts";
import { LiveTimeclockPanel } from "@/components/timeclock/LiveTimeclockPanel";
import { cn } from "@/lib/utils";
import { BreakDueBadge, FaceAlerts, FixRequests, NoFaceBadge, PunchPhoto, ShiftNotes, StationTag } from "@/components/live/KioskLive";

interface EmployeeNow {
  id: string; name: string; role: string; active: boolean; inDirectory: boolean;
  status: ClockStatus; since: string | null; shiftStart: string | null; minutes: number; lastPunch: Punch | null;
  station?: string | null; breakDue?: boolean;
}
interface DayData {
  site: { id: string; name: string; timezone: string; timeSource: string };
  date: string; now: string; employees: EmployeeNow[]; punches: Punch[];
}

const STATUS_LABEL: Record<ClockStatus, string> = { in: "Working", break: "On break", out: "Not in" };
const STATUS_VARIANT: Record<ClockStatus, "success" | "warning" | "secondary"> = { in: "success", break: "warning", out: "secondary" };
const TYPE_CLS: Record<PunchType, string> = {
  in: "text-success", break_start: "text-warning", break_end: "text-info", out: "text-foreground",
};
const hm = (min: number) => { const h = Math.floor(min / 60), m = Math.round(min % 60); return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`; };

function Banner({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-2.5 rounded-xl bg-warning-soft px-4 py-3 text-[13px] sm:flex-row sm:items-center sm:gap-3" role="status">
      <span className="flex min-w-0 flex-1 items-start gap-3">
        <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-warning" />
        <span className="min-w-0 flex-1">{children}</span>
      </span>
      {action && <span className="shrink-0 pl-7 sm:pl-0">{action}</span>}
    </div>
  );
}

export function LivePage() {
  const app = useApp();
  const site = app.site;
  const tz = site.rules.timezone;
  const editable = can(app.user, "punches.edit");
  const key = ["/api/sites", site.id, "timeclock"];
  const q = useQuery<DayData>({ queryKey: key, staleTime: 0, refetchInterval: 5 * 60_000 });
  const [fix, setFix] = useState<Punch | null>(null);
  const [adding, setAdding] = useState<{ employeeId?: string; type?: PunchType; title?: string } | null>(null);
  const [cancelling, setCancelling] = useState<EmployeeNow | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);

  const connected = useLiveEvents((e) => {
    if (e.type === "hello" || (e.type === "punch" && e.siteId === site.id)) void queryClient.invalidateQueries({ queryKey: key });
  });

  const t = (iso: string | null | undefined) => (iso ? app.time(instantToLocal(iso, tz).minutes) : "—");
  const data = q.data;
  const fetchedAt = q.dataUpdatedAt || Date.now();
  const minutesNow = (e: EmployeeNow) => e.minutes + (e.status === "in" && data?.date === todayISO(tz) ? Math.max(0, (Date.now() - fetchedAt) / 60000) : 0);

  const groups = useMemo(() => {
    const list = data?.employees ?? [];
    const order: Record<ClockStatus, number> = { in: 0, break: 1, out: 2 };
    const on = list.filter((e) => e.status !== "out").sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
    const off = list.filter((e) => e.status === "out" && (e.active || e.minutes > 0)).sort((a, b) => (b.minutes > 0 ? 1 : 0) - (a.minutes > 0 ? 1 : 0) || a.name.localeCompare(b.name));
    return { on, off, working: list.filter((e) => e.status === "in").length, onBreak: list.filter((e) => e.status === "break").length };
  }, [data]);

  const names = useMemo(() => Object.fromEntries((data?.employees ?? []).map((e) => [e.id, e.name])), [data]);

  return (
    <Page>
      <PageHeader
        title={
          <span className="inline-flex items-center gap-3">
            Live
            <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold tracking-normal", connected ? "bg-success-soft text-success" : "bg-neutral-soft text-neutral")} data-testid="status-live">
              <span className={cn("h-1.5 w-1.5 rounded-full", connected ? "animate-pulse bg-success" : "bg-neutral")} />
              {connected ? "Live" : "Reconnecting…"}
            </span>
          </span>
        }
        titleTestId="text-page-title"
        subtitle={<span className="inline-flex flex-wrap items-center gap-x-1.5"><SiteDot color={site.color} />{site.name}<span aria-hidden>·</span>{data ? app.date(data.date) : app.date(todayISO(tz))}<span aria-hidden>·</span><span className="text-[13px]">{tz}</span></span>}
        actions={
          <>
            <Button asChild variant="ghost"><Link href="/employees"><UserRound /> Employees</Link></Button>
            {editable && <Button onClick={() => setAdding({})} data-testid="button-add-punch"><Plus /> Add punch</Button>}
          </>
        }
      />

      {site.timeSource === "square" && (
        <Banner action={isAdmin(app.user) ? <Button asChild size="sm" variant="outline"><Link href="/settings/locations">Turn on the time clock</Link></Button> : undefined}>
          {site.name} takes its hours from Square, so the time clock is off here.
        </Banner>
      )}

      <ScheduleAlerts />

      {q.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>
      ) : q.error ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load the time clock" description={errorMessage(q.error)} action={<Button variant="outline" size="sm" onClick={() => q.refetch()}>Try again</Button>} />
      ) : data && (
        <div className="space-y-8">
          <section>
            <SectionLabel action={<span className="text-[13px] text-muted-foreground"><b className="tabular font-semibold text-foreground">{groups.working}</b> working · <b className="tabular font-semibold text-foreground">{groups.onBreak}</b> on break</span>}>
              Who's working now
            </SectionLabel>
            {groups.on.length === 0 ? (
              <div className="rounded-xl border border-card-border bg-card shadow-card">
                <EmptyState compact icon={Users} title="Nobody is clocked in right now" description="Clock-ins from the kiosk appear here the moment they happen." />
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {groups.on.map((e) => (
                  <div key={e.id} className="min-w-0 rounded-xl border border-card-border bg-card p-4 shadow-card" data-testid={`card-live-${e.id}`}>
                    <div className="flex items-start gap-3">
                      <Initials name={e.name} status={e.status} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[15px] font-semibold tracking-tight">{e.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{e.role || (e.inDirectory ? " " : "Not in the employee list")}</p>
                        {e.station && <StationTag station={e.station} className="mt-1" />}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <Badge variant={STATUS_VARIANT[e.status]} className="shrink-0">{e.status === "break" && <Coffee />}{STATUS_LABEL[e.status]}</Badge>
                        <BreakDueBadge due={e.breakDue} />
                      </div>
                    </div>
                    <div className="mt-4 flex items-end justify-between gap-2">
                      <span className="text-[13px] text-muted-foreground">{e.status === "break" ? "Break since" : "In since"} <b className="font-medium text-foreground">{t(e.status === "break" ? e.since : e.shiftStart)}</b></span>
                      <span className="tabular text-[20px] font-semibold leading-none tracking-tight">{hm(minutesNow(e))}</span>
                    </div>
                    {editable && (
                      <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/70 pt-3">
                        <Button size="sm" variant="outline" onClick={() => setAdding({ employeeId: e.id, type: "out", title: `Clock out ${e.name}` })} data-testid={`button-clock-out-${e.id}`}><LogOut /> Clock out</Button>
                        <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => setCancelling(e)} data-testid={`button-cancel-shift-${e.id}`}><XCircle /> Cancel clock-in</Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {groups.off.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {groups.off.map((e) => (
                  <span key={e.id} className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-card-border bg-card px-3 py-1 text-xs text-muted-foreground shadow-card">
                    <span className="min-w-0 truncate font-medium text-foreground" title={e.name}>{e.name}</span>
                    <span className="shrink-0 whitespace-nowrap">{e.minutes > 0 ? <>out {t(e.lastPunch?.at)} · <span className="tabular">{hm(e.minutes)}</span></> : "not in today"}</span>
                  </span>
                ))}
              </div>
            )}
          </section>

          <LiveTimeclockPanel site={site} />
          {editable && <FaceAlerts siteId={site.id} tz={tz} editable={editable} />}
          <FixRequests siteId={site.id} tz={tz} editable={editable} />
          <ShiftNotes siteId={site.id} tz={tz} editable={editable} employees={data.employees.filter((e) => e.inDirectory)} />

          <section>
            <SectionLabel action={<span className="text-xs text-muted-foreground">{data.punches.length} punch{data.punches.length === 1 ? "" : "es"}</span>}>Today's punches</SectionLabel>
            <div className="overflow-hidden rounded-xl border border-card-border bg-card shadow-card">
              {data.punches.length === 0 ? (
                <EmptyState compact icon={Clock} title="No punches yet today" description="Clock-ins, breaks and clock-outs show up here as they happen." />
              ) : (
                <ul className="divide-y divide-border/70" data-testid="list-punches">
                  {data.punches.map((p) => (
                    <li key={p.id} className="flex min-h-[3.25rem] min-w-0 items-center gap-3 px-4 py-2 text-[13px]">
                      <span className="w-[4.5rem] shrink-0 tabular font-semibold sm:w-20">{t(p.at)}</span>
                      <PunchPhoto punch={p} canView={editable} label={`${names[p.employeeId] ?? p.employeeName} · ${PUNCH_LABELS[p.type]} at ${t(p.at)}`} />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium" title={names[p.employeeId] ?? p.employeeName}>{names[p.employeeId] ?? p.employeeName}</span>
                          {p.flags?.autoClosed && !p.editedAt && <Badge variant="warning" className="shrink-0">Auto-closed</Badge>}
                          <NoFaceBadge punch={p} />
                          {p.editedAt && <Badge variant="secondary" className="shrink-0">Edited</Badge>}
                        </span>
                        <span className={cn("text-xs font-medium sm:hidden", TYPE_CLS[p.type])}>{PUNCH_LABELS[p.type]}</span>
                        {p.meta?.station && <StationTag station={p.meta.station} className="self-start" />}
                      </span>
                      <span className={cn("hidden w-24 shrink-0 font-medium sm:block", TYPE_CLS[p.type])}>{PUNCH_LABELS[p.type]}</span>
                      <span className="hidden w-20 shrink-0 items-center gap-1.5 text-xs text-muted-foreground md:flex">
                        {p.source === "kiosk" ? <><Tablet className="h-3.5 w-3.5" />Kiosk</> : <><UserRound className="h-3.5 w-3.5" />Admin</>}
                      </span>
                      <span className="hidden w-52 shrink-0 truncate text-xs text-muted-foreground lg:block" title={(p.editedAt || p.source === "admin") && p.note ? p.note : undefined}>
                        {(p.editedAt || p.source === "admin") && p.note ? `“${p.note}”` : ""}
                      </span>
                      {editable && <Button variant="ghost" size="sm" className="-mr-2 shrink-0 text-muted-foreground" aria-label={`Fix ${PUNCH_LABELS[p.type].toLowerCase()} at ${t(p.at)}`} onClick={() => setFix(p)} data-testid={`button-fix-${p.id}`}><Pencil /> <span className="hidden sm:inline">Fix</span></Button>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      )}

      {fix && <FixPunchDialog punch={fix} tz={tz} name={names[fix.employeeId] ?? fix.employeeName} onClose={() => setFix(null)} />}
      {adding && data && <AddPunchDialog siteId={site.id} tz={tz} employees={data.employees.filter((e) => e.inDirectory || e.id === adding.employeeId)} initial={adding} onClose={() => setAdding(null)} />}
      {cancelling && <CancelShiftDialog siteId={site.id} employee={cancelling} when={t(cancelling.shiftStart)} onClose={() => setCancelling(null)} />}
    </Page>
  );
}

function Initials({ name, status }: { name: string; status: ClockStatus }) {
  const init = name.split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  return (
    <span className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
      {init}
      <span className={cn("absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-card", status === "in" ? "bg-success" : status === "break" ? "bg-warning" : "bg-muted-foreground/40")} />
    </span>
  );
}

function useLocalDateTime(iso: string, tz: string) {
  const l = instantToLocal(iso, tz);
  const [date, setDate] = useState(l.date);
  const [time, setTime] = useState(minutesToInput(l.minutes));
  const toIso = () => { const m = inputToMinutes(time); return m == null || !date ? null : localToInstant(date, m, tz); };
  return { date, setDate, time, setTime, toIso };
}

function FixPunchDialog({ punch, tz, name, onClose }: { punch: Punch; tz: string; name: string; onClose: () => void }) {
  const { toast } = useToast();
  const dt = useLocalDateTime(punch.at, tz);
  const [type, setType] = useState<PunchType>(punch.type);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async (force = false) => {
    const at = dt.toIso();
    if (!at) { setProblem("Enter a date and time."); return; }
    setBusy(true); setProblem(null);
    try {
      await api("PATCH", `/api/punches/${punch.id}`, { type, at, note: note.trim(), force });
      toast({ title: "Punch updated" });
      onClose();
    } catch (e) { setProblem(errorMessage(e)); } finally { setBusy(false); }
  };
  const remove = async (force = false) => {
    setBusy(true); setProblem(null);
    try {
      await api("DELETE", `/api/punches/${punch.id}${force ? "?force=1" : ""}`, { note: note.trim() });
      toast({ title: "Punch deleted" });
      onClose();
    } catch (e) { setProblem(errorMessage(e)); } finally { setBusy(false); }
  };
  const conflict = problem && /doesn't fit|leave a gap/.test(problem);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Fix a punch</DialogTitle>
          <DialogDescription>{name} · recorded {punch.source === "kiosk" ? "at the kiosk" : "by an admin"}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Type">
            <Select value={type} onValueChange={(v) => setType(v as PunchType)}>
              <SelectTrigger data-testid="select-punch-type"><SelectValue /></SelectTrigger>
              <SelectContent>{PUNCH_TYPES.map((x) => <SelectItem key={x} value={x}>{PUNCH_LABELS[x]}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date"><Input type="date" value={dt.date} onChange={(e) => dt.setDate(e.target.value)} /></Field>
            <Field label={`Time (${tz})`}><Input type="time" value={dt.time} onChange={(e) => dt.setTime(e.target.value)} data-testid="input-punch-time" /></Field>
          </div>
          <Field label="Note (required)" hint="Why the punch is being changed. Kept with the punch.">
            <Textarea rows={2} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Forgot to clock out, left at 5:30" data-testid="input-punch-note" />
          </Field>
          {punch.edits.length > 0 && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Edit history ({punch.edits.length})</summary>
              <ul className="mt-2 space-y-1">
                {punch.edits.map((ed, i) => (
                  <li key={i}>{new Date(ed.editedAt).toLocaleString()}: {ed.before ? `was ${PUNCH_LABELS[ed.before.type]} at ${new Date(ed.before.at).toLocaleString(undefined, { timeZone: tz })}` : ""} — “{ed.note}”</li>
                ))}
              </ul>
            </details>
          )}
          {problem && (
            <div className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] font-medium text-danger" role="alert">
              {problem}
              {conflict && <p className="mt-1 text-xs font-normal text-muted-foreground">You can save anyway; the payroll import will warn about any shift that doesn't pair up.</p>}
            </div>
          )}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {confirmDelete ? (
            <Button variant="destructive" disabled={busy} onClick={() => remove(!!conflict)} data-testid="button-confirm-delete-punch"><Trash2 /> {conflict ? "Delete anyway" : "Really delete"}</Button>
          ) : (
            <Button variant="ghost" className="text-destructive" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 /> Delete</Button>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button disabled={busy || !note.trim()} onClick={() => save(!!conflict && !confirmDelete)} data-testid="button-save-punch">
              {busy && <Loader2 className="animate-spin" />}{conflict && !confirmDelete ? "Save anyway" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddPunchDialog({ siteId, tz, employees, initial, onClose }: { siteId: string; tz: string; employees: EmployeeNow[]; initial?: { employeeId?: string; type?: PunchType; title?: string }; onClose: () => void }) {
  const { toast } = useToast();
  const dt = useLocalDateTime(new Date().toISOString(), tz);
  const [employeeId, setEmployeeId] = useState(initial?.employeeId ?? employees[0]?.id ?? "");
  const emp = employees.find((e) => e.id === employeeId);
  const suggested: PunchType = emp ? (emp.status === "out" ? "in" : emp.status === "break" ? "break_end" : "out") : "in";
  const [type, setType] = useState<PunchType | null>(initial?.type ?? null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const conflict = !!problem && /doesn't fit/.test(problem);

  const save = async () => {
    const at = dt.toIso();
    if (!at) { setProblem("Enter a date and time."); return; }
    setBusy(true); setProblem(null);
    try {
      await api("POST", `/api/sites/${siteId}/punches`, { employeeId, type: type ?? suggested, at, note: note.trim(), force: conflict });
      toast({ title: "Punch added" });
      onClose();
    } catch (e) { setProblem(errorMessage(e)); } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{initial?.title ?? "Add a punch"}</DialogTitle>
          <DialogDescription>{initial?.type === "out" ? "Records the clock-out for them, for example when the kiosk was offline. Change the time if they left earlier." : "For a missed clock-in, break or clock-out."}</DialogDescription>
        </DialogHeader>
        {employees.length === 0 ? (
          <p className="text-sm text-muted-foreground">Add employees first on the <Link href="/employees" className="font-medium text-primary hover:underline">Employees</Link> page.</p>
        ) : (
          <div className="space-y-3">
            <Field label="Employee">
              <Select value={employeeId} onValueChange={(v) => { setEmployeeId(v); setType(null); }}>
                <SelectTrigger data-testid="select-punch-employee"><SelectValue /></SelectTrigger>
                <SelectContent>{employees.map((e) => <SelectItem key={e.id} value={e.id}>{e.name} · {STATUS_LABEL[e.status]}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Type">
              <Select value={type ?? suggested} onValueChange={(v) => setType(v as PunchType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{PUNCH_TYPES.map((x) => <SelectItem key={x} value={x}>{PUNCH_LABELS[x]}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Date"><Input type="date" value={dt.date} onChange={(e) => dt.setDate(e.target.value)} /></Field>
              <Field label={`Time (${tz})`}><Input type="time" value={dt.time} onChange={(e) => dt.setTime(e.target.value)} /></Field>
            </div>
            <Field label="Note (required)">
              <Textarea rows={2} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Tablet was offline" data-testid="input-new-punch-note" />
            </Field>
            {problem && <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] font-medium text-danger" role="alert">{problem}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !employeeId || !note.trim()} onClick={save} data-testid="button-save-new-punch">{busy && <Loader2 className="animate-spin" />}{conflict ? "Add anyway" : "Add punch"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Cancel someone's current clock-in (and any breaks since): as if they never clocked in. */
function CancelShiftDialog({ siteId, employee, when, onClose }: { siteId: string; employee: EmployeeNow; when: string; onClose: () => void }) {
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setProblem(null);
    try {
      await api("POST", `/api/sites/${siteId}/employees/${encodeURIComponent(employee.id)}/cancel-shift`, { note: note.trim() });
      toast({ title: "Clock-in cancelled", description: `${employee.name} is no longer clocked in.` });
      await queryClient.invalidateQueries({ queryKey: ["/api/sites", siteId, "timeclock"] });
      onClose();
    } catch (e) { setProblem(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel {employee.name}'s clock-in?</DialogTitle>
          <DialogDescription>
            Removes the clock-in at {when}{employee.status === "break" ? " and their break" : " and any breaks since"}, as if they never clocked in. No hours are counted for it.
            If they did work, use Clock out instead.
          </DialogDescription>
        </DialogHeader>
        <Field label="Note (required)" hint="Kept in Settings → Activity.">
          <Textarea rows={2} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Clocked in by mistake, kiosk went offline" data-testid="input-cancel-shift-note" />
        </Field>
        {problem && <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] font-medium text-danger" role="alert">{problem}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Keep it</Button>
          <Button variant="destructive" disabled={busy || !note.trim()} onClick={run} data-testid="button-confirm-cancel-shift">{busy && <Loader2 className="animate-spin" />}Cancel clock-in</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
