import { useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, CalendarDays, CalendarOff, CheckCircle2, ChevronLeft, ChevronRight, Copy, Download, EyeOff, Loader2, MoreHorizontal, Plus, Send, Settings2, UserRound,
} from "lucide-react";
import type { EmployeeConfig, Shift } from "@shared/schema";
import { WEEKDAYS_SHORT, addDays, dayOfWeek, todayISO } from "@shared/dates";
import { type ScheduleSettings, type ScheduleWeek, type ScheduledShift, type TimeOff, personKey, shiftMinutes, timeOffOn, weekStartOf } from "@shared/schedule";
import { laborFromShifts } from "@shared/labor";
import { useApp } from "@/context/AppData";
import { api, ApiError, errorMessage, queryClient } from "@/lib/api";
import { canEdit, isAdmin } from "@/lib/roles";
import { useLiveEvents } from "@/lib/live";
import { downloadBlob, safeFilename, timeAgo } from "@/lib/doc";
import { buildSchedulePdf } from "@/lib/pdf/schedule";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { SiteDot } from "@/components/AppShell";
import { Page, PageHeader } from "@/components/ui/page";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { type Person, type ShiftDraft, ScheduleSettingsDialog, ShiftDialog, TimeOffDialog } from "@/components/schedule/dialogs";
import { TimeOffRequests } from "@/components/schedule/TimeOffRequests";
import { cn } from "@/lib/utils";

interface WeekData {
  week: ScheduleWeek;
  dates: string[];
  previousWeekShifts: number;
  timeOff: TimeOff[];
  employees: { id: string; name: string; role: string; active: boolean }[];
  settings: ScheduleSettings;
}

const hoursText = (min: number) => { const h = min / 60; return Number.isInteger(h) ? `${h}` : h.toFixed(1); };

export function SchedulePage() {
  const app = useApp();
  const site = app.site;
  const tz = site.rules.timezone;
  const editable = canEdit(app.user);
  const admin = isAdmin(app.user);
  const { toast } = useToast();
  const confirm = useConfirm();
  const today = todayISO(tz);
  const [weekStart, setWeekStart] = useState(() => weekStartOf(today, site.rules.weekStartsOn));
  // A location switch can change the week start day.
  const ws = weekStartOf(weekStart, site.rules.weekStartsOn);
  const key = ["/api/sites", site.id, `schedule/week?start=${ws}`];
  const q = useQuery<WeekData>({ queryKey: key, staleTime: 0 });
  const wages = useQuery<EmployeeConfig[]>({ queryKey: ["/api/sites", site.id, "wages"] });
  const [editing, setEditing] = useState<{ draft: ShiftDraft; shift?: ScheduledShift } | null>(null);
  const [timeOff, setTimeOff] = useState<{ entry?: TimeOff; person?: Person; date?: string } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  useLiveEvents((e) => {
    if (e.type === "schedule" && e.siteId === site.id) void queryClient.invalidateQueries({ queryKey: ["/api/sites", site.id] });
  });

  const data = q.data;
  const week = data?.week;
  const dates = data?.dates ?? [];

  const people = useMemo<Person[]>(() => {
    if (!data) return [];
    const out: Person[] = data.employees.filter((e) => e.active).map((e) => ({ employeeId: e.id, employeeName: e.name, role: e.role }));
    const seen = new Set(out.map(personKeyOf));
    const extra = (p: Person) => { const k = personKeyOf(p); if (!seen.has(k)) { seen.add(k); out.push(p); } };
    const dir = new Map(data.employees.map((e) => [e.id, e]));
    for (const s of data.week.shifts) extra({ employeeId: s.employeeId, employeeName: dir.get(s.employeeId)?.name ?? s.employeeName, role: dir.get(s.employeeId)?.role });
    for (const t of data.timeOff) extra({ employeeId: t.employeeId, employeeName: dir.get(t.employeeId)?.name ?? t.employeeName });
    return out;
  }, [data]);

  const cells = useMemo(() => {
    const m = new Map<string, ScheduledShift[]>();
    for (const s of week?.shifts ?? []) {
      const k = `${personKey(s)}|${s.date}`;
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    return m;
  }, [week]);

  const totals = useMemo(() => {
    const byDay = new Map<string, number>();
    const byPerson = new Map<string, number>();
    let all = 0;
    for (const s of week?.shifts ?? []) {
      const m = shiftMinutes(s);
      byDay.set(s.date, (byDay.get(s.date) ?? 0) + m);
      byPerson.set(personKey(s), (byPerson.get(personKey(s)) ?? 0) + m);
      all += m;
    }
    return { byDay, byPerson, all };
  }, [week]);

  // Estimated cost of the week at saved rates (same engine as payroll).
  const cost = useMemo(() => {
    if (!week?.shifts.length || !wages.data) return null;
    const shifts: Shift[] = week.shifts.map((s) => ({ id: s.id, employee: s.employeeName, date: s.date, start: s.start, end: s.end, breakMinutes: 0, role: s.station, source: "manual", note: "" }));
    const r = laborFromShifts(shifts, { employees: wages.data, categories: app.categories, rules: site.rules }, dates[0], dates[6]);
    return { total: Object.values(r.days).reduce((a, d) => a + d.cost, 0), missing: r.missingRates.length };
  }, [week, wages.data, app.categories, site.rules, dates]);

  /** Save the whole week. Saves run one after another so each one builds on the last. */
  const saveShifts = (next: (Omit<ScheduledShift, "id"> & { id?: string })[]) => {
    const run = async () => {
      const cur = queryClient.getQueryData<WeekData>(key);
      if (!cur) return false;
      try {
        const saved = await api<ScheduleWeek>("PUT", `/api/sites/${site.id}/schedule/week/${ws}`, { shifts: next, baseUpdatedAt: cur.week.updatedAt });
        queryClient.setQueryData<WeekData>(key, (d) => (d ? { ...d, week: saved } : d));
        return true;
      } catch (e) {
        toast({ title: "Couldn't save the schedule", description: errorMessage(e), variant: "destructive" });
        if (e instanceof ApiError && e.status === 409) void q.refetch();
        return false;
      }
    };
    const p = chain.current.then(run, run);
    chain.current = p;
    return p;
  };

  const upsert = async (list: Omit<ScheduledShift, "id">[], id?: string) => {
    const cur = queryClient.getQueryData<WeekData>(key)?.week.shifts ?? [];
    const next = id ? cur.map((s) => (s.id === id ? { ...s, ...list[0], id } : s)) : [...cur, ...list];
    return saveShifts(next);
  };
  const remove = async (id: string) => {
    const cur = queryClient.getQueryData<WeekData>(key)?.week.shifts ?? [];
    return saveShifts(cur.filter((s) => s.id !== id));
  };

  const copyLast = async () => {
    if (!data) return;
    let replace = false;
    if (data.week.shifts.length) {
      replace = await confirm({ title: "Replace this week?", description: `This week already has ${data.week.shifts.length} shift${data.week.shifts.length === 1 ? "" : "s"}. Copying last week replaces them.`, confirmLabel: "Replace", destructive: true });
      if (!replace) return;
    }
    setBusy("copy");
    try {
      const saved = await api<ScheduleWeek>("POST", `/api/sites/${site.id}/schedule/week/${ws}/copy-previous`, { replace });
      queryClient.setQueryData<WeekData>(key, (d) => (d ? { ...d, week: saved } : d));
      toast({ title: "Copied last week", description: `${saved.shifts.length} shift${saved.shifts.length === 1 ? "" : "s"}. Approved time off was skipped.` });
    } catch (e) { toast({ title: "Couldn't copy", description: errorMessage(e), variant: "destructive" }); } finally { setBusy(null); }
  };

  const publish = async (on: boolean) => {
    setBusy("publish");
    try {
      const saved = await api<ScheduleWeek>("POST", `/api/sites/${site.id}/schedule/week/${ws}/publish`, { publish: on });
      queryClient.setQueryData<WeekData>(key, (d) => (d ? { ...d, week: saved } : d));
      toast({ title: on ? "Schedule published" : "Schedule unpublished" });
    } catch (e) { toast({ title: "Couldn't update", description: errorMessage(e), variant: "destructive" }); } finally { setBusy(null); }
  };

  const printPdf = () => {
    if (!data) return;
    try {
      const pdf = buildSchedulePdf({ week: data.week, people: people.filter((p) => totals.byPerson.get(personKeyOf(p)) || data.timeOff.some((t) => dates.some((d) => timeOffOn([t], p, d)))), timeOff: data.timeOff, prefs: app.prefs, site });
      downloadBlob(pdf.output("arraybuffer"), `${safeFilename(`${site.name} schedule ${ws}`)}.pdf`, "application/pdf");
    } catch (e) { toast({ title: "Couldn't make the PDF", description: errorMessage(e), variant: "destructive" }); }
  };

  const range = dates.length ? `${app.date(dates[0])} – ${app.date(dates[6])}` : "";
  const isThisWeek = ws === weekStartOf(today, site.rules.weekStartsOn);
  const t = (m: number) => (app.prefs.timeFormat === "24h" ? app.time(m) : app.time(m).replace(":00", "").replace(" AM", "a").replace(" PM", "p"));

  return (
    <Page wide>
      <PageHeader
        title="Schedule"
        titleTestId="text-page-title"
        subtitle={<span className="inline-flex flex-wrap items-center gap-x-1.5"><SiteDot color={site.color} />{site.name}<span aria-hidden>·</span>{range}</span>}
        actions={
          <>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" aria-label="Previous week" onClick={() => setWeekStart(addDays(ws, -7))} data-testid="button-prev-week"><ChevronLeft /></Button>
              <Button variant="outline" disabled={isThisWeek} onClick={() => setWeekStart(weekStartOf(today, site.rules.weekStartsOn))}>This week</Button>
              <Button variant="outline" size="icon" aria-label="Next week" onClick={() => setWeekStart(addDays(ws, 7))} data-testid="button-next-week"><ChevronRight /></Button>
            </div>
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="outline" size="icon" aria-label="More" data-testid="button-schedule-more"><MoreHorizontal /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={printPdf} disabled={!data}><Download />Print / PDF</DropdownMenuItem>
                  {editable && <DropdownMenuItem onClick={copyLast} disabled={!data || !data.previousWeekShifts || busy === "copy"} data-testid="menu-copy-last-week"><Copy />Copy last week</DropdownMenuItem>}
                  {editable && <DropdownMenuItem onClick={() => setTimeOff({})} disabled={!data}><CalendarOff />Add time off</DropdownMenuItem>}
                  {editable && week?.publishedAt && <DropdownMenuItem onClick={() => publish(false)}><EyeOff />Unpublish</DropdownMenuItem>}
                  {admin && <><DropdownMenuSeparator /><DropdownMenuItem onClick={() => setShowSettings(true)} disabled={!data}><Settings2 />Schedule settings</DropdownMenuItem></>}
                </DropdownMenuContent>
              </DropdownMenu>
              {editable && <Button variant="outline" onClick={() => setEditing({ draft: { person: null, date: dates.includes(today) ? today : dates[0], start: 540, end: 1020, station: "", note: "" } })} disabled={!data || !people.length} data-testid="button-add-shift"><Plus /> Add shift</Button>}
              {editable && (!week?.publishedAt || week.changedSincePublish) && (
                <Button onClick={() => publish(true)} disabled={!week || !week.shifts.length || busy === "publish"} data-testid="button-publish">
                  {busy === "publish" ? <Loader2 className="animate-spin" /> : <Send />}{week?.publishedAt ? "Publish changes" : "Publish"}
                </Button>
              )}
            </div>
          </>
        }
      />

      {q.isLoading ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : q.error ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load the schedule" description={errorMessage(q.error)} action={<Button variant="outline" size="sm" onClick={() => q.refetch()}>Try again</Button>} />
      ) : data && !people.length ? (
        <EmptyState
          icon={CalendarDays}
          title="Add your team first"
          description={`The schedule lists the employees of ${site.name}. Add them on the Employees page (a PIN is only needed for the time clock).`}
          action={<Button asChild variant="outline"><Link href="/employees"><UserRound />Employees</Link></Button>}
        />
      ) : data && week && (
        <>
          <TimeOffRequests siteId={site.id} onChanged={() => void q.refetch()} />
          <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-[13px] text-muted-foreground" data-testid="schedule-status">
            {week.publishedAt
              ? <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4 text-success" /><span className="text-foreground">Published</span> {timeAgo(week.publishedAt)}{week.changedSincePublish && <Badge variant="warning" className="ml-1">Changed since</Badge>}</span>
              : <span className="inline-flex items-center gap-1.5"><Badge variant="secondary">Draft</Badge>Not published yet</span>}
            <span><b className="tabular font-semibold text-foreground">{hoursText(totals.all)}</b> hours</span>
            <span><b className="tabular font-semibold text-foreground">{week.shifts.length}</b> shift{week.shifts.length === 1 ? "" : "s"}</span>
            {cost && <span title="Scheduled hours at saved rates">Est. labor <b className="tabular font-semibold text-foreground">{app.money(cost.total)}</b>{cost.missing > 0 && <span className="text-warning"> · {cost.missing} without a rate</span>}</span>}
          </div>

          <div className="overflow-x-auto rounded-xl border border-card-border bg-card shadow-card" data-testid="schedule-grid">
            <table className="w-full min-w-[56rem] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-border/70">
                  <th scope="col" className="sticky left-0 z-10 w-32 bg-card px-3 py-3 text-left align-bottom text-xs font-semibold text-muted-foreground shadow-[inset_-1px_0_0_hsl(var(--border)/0.7)] sm:w-48 sm:px-4">Employee</th>
                  {dates.map((d) => (
                    <th key={d} scope="col" className={cn("px-3.5 py-3 text-left text-xs font-semibold", d === today ? "bg-primary/[0.03] text-primary" : "text-muted-foreground")}>
                      <span className="block">{WEEKDAYS_SHORT[dayOfWeek(d)]}</span>
                      <span className={cn("block text-[15px] font-semibold tabular", d === today ? "text-primary" : "text-foreground")}>{Number(d.slice(8))}</span>
                    </th>
                  ))}
                  <th scope="col" className="w-16 px-4 py-3 text-right align-bottom text-xs font-semibold text-muted-foreground">Hours</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {people.map((p) => {
                  const pk = personKeyOf(p);
                  return (
                    <tr key={pk} data-testid={`row-schedule-${p.employeeId || p.employeeName}`}>
                      <th scope="row" className="sticky left-0 z-10 max-w-[8rem] bg-card px-3 py-2.5 text-left align-top font-normal shadow-[inset_-1px_0_0_hsl(var(--border)/0.7)] sm:max-w-[12rem] sm:px-4">
                        <span className="block truncate font-medium" title={p.employeeName}>{p.employeeName}</span>
                        {p.role && <span className="block truncate text-xs text-muted-foreground">{p.role}</span>}
                      </th>
                      {dates.map((d) => {
                        const list = cells.get(`${pk}|${d}`) ?? [];
                        const off = timeOffOn(data.timeOff, p, d);
                        return (
                          <td key={d} className={cn("group h-16 min-w-[6.5rem] px-1.5 py-1.5 align-top", d === today && "bg-primary/[0.03]")}>
                            <div className="flex flex-col gap-1">
                              {off && (
                                <button
                                  type="button"
                                  disabled={!editable}
                                  onClick={() => setTimeOff({ entry: off })}
                                  className="rounded-md bg-neutral-soft px-2 py-1 text-left text-xs text-neutral outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:cursor-default"
                                  title={off.reason || "Time off"}
                                  data-testid={`timeoff-${p.employeeId || p.employeeName}-${d}`}
                                >
                                  <span className="block font-medium">Time off</span>
                                  {off.reason && <span className="block truncate">{off.reason}</span>}
                                </button>
                              )}
                              {list.map((s) => (
                                <button
                                  key={s.id}
                                  type="button"
                                  disabled={!editable}
                                  onClick={() => setEditing({ shift: s, draft: { id: s.id, person: p, date: s.date, start: s.start, end: s.end, station: s.station, note: s.note } })}
                                  className={cn("rounded-md px-2 py-1 text-left text-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:cursor-default", off ? "bg-warning-soft text-warning" : "bg-primary/10 text-primary hover:bg-primary/15")}
                                  title={[off ? "Overlaps time off" : "", s.note].filter(Boolean).join(" · ") || undefined}
                                  data-testid={`shift-${s.id}`}
                                >
                                  <span className="block whitespace-nowrap font-semibold tabular">{t(s.start)}–{t(s.end)}</span>
                                  {s.station && <span className="block truncate text-[11px] opacity-80">{s.station}</span>}
                                </button>
                              ))}
                              {editable && (
                                <button
                                  type="button"
                                  onClick={() => setEditing({ draft: { person: p, date: d, start: list.at(-1) ? Math.min(1380, list.at(-1)!.end % 1440) : 540, end: list.at(-1) ? Math.min(1439, (list.at(-1)!.end % 1440) + 240) : 1020, station: "", note: "" } })}
                                  className={cn("flex h-7 items-center justify-center rounded-md text-muted-foreground/70 outline-none transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/35", list.length || off ? "opacity-0 group-hover:opacity-100" : "opacity-60 sm:opacity-0 sm:group-hover:opacity-100")}
                                  aria-label={`Add a shift for ${p.employeeName} on ${app.date(d)}`}
                                  data-testid={`button-add-${p.employeeId || p.employeeName}-${d}`}
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          </td>
                        );
                      })}
                      <td className="px-4 py-2.5 text-right align-top font-medium tabular">{totals.byPerson.get(pk) ? hoursText(totals.byPerson.get(pk)!) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-border">
                  <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground shadow-[inset_-1px_0_0_hsl(var(--border)/0.7)] sm:px-4">Total hours</th>
                  {dates.map((d) => <td key={d} className={cn("px-3.5 py-2.5 text-xs font-semibold tabular", d === today && "bg-primary/[0.03]")}>{totals.byDay.get(d) ? hoursText(totals.byDay.get(d)!) : ""}</td>)}
                  <td className="px-4 py-2.5 text-right font-semibold tabular">{hoursText(totals.all)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {editable && <p className="mt-3 px-1 text-xs text-muted-foreground">Tap a shift to change it, or the + in a day to add one. Changes save as you go; publish when the week is ready.</p>}
        </>
      )}

      {editing && data && (
        <ShiftDialog
          draft={editing.draft}
          dates={dates}
          people={people}
          onClose={() => setEditing(null)}
          onSave={(list, id) => upsert(list, id)}
          onDelete={editing.shift ? () => remove(editing.shift!.id) : undefined}
        />
      )}
      {timeOff && data && <TimeOffDialog siteId={site.id} people={people} entry={timeOff.entry} initial={{ person: timeOff.person, date: timeOff.date ?? (dates.includes(today) ? today : dates[0]) }} onClose={() => { setTimeOff(null); void q.refetch(); }} />}
      {showSettings && data && (
        <ScheduleSettingsDialog siteId={site.id} siteName={site.name} value={data.settings} onClose={() => setShowSettings(false)} onSaved={(v) => queryClient.setQueryData<WeekData>(key, (d) => (d ? { ...d, settings: v } : d))} />
      )}
    </Page>
  );
}

const personKeyOf = (p: Person) => personKey({ employeeId: p.employeeId, employeeName: p.employeeName });
