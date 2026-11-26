// Dialogs for the Schedule page: add / edit a shift, time off, and the
// per-location schedule settings (late alerts and the early clock-in rule).
import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { WEEKDAYS_SHORT, dayOfWeek } from "@shared/dates";
import type { ScheduleSettings, ScheduledShift, TimeOff, TimeOffStatus } from "@shared/schedule";
import { useApp } from "@/context/AppData";
import { api, errorMessage } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, NumberInput, TimeInput, ToggleRow } from "@/components/workspace/fields";
import { SegmentedControl } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export interface Person { employeeId: string; employeeName: string; role?: string }

const personValue = (p: Person) => (p.employeeId ? `id:${p.employeeId}` : `name:${p.employeeName}`);

function PersonSelect({ people, value, onChange, testid }: { people: Person[]; value: Person | null; onChange: (p: Person) => void; testid?: string }) {
  return (
    <Select value={value ? personValue(value) : ""} onValueChange={(v) => { const p = people.find((x) => personValue(x) === v); if (p) onChange(p); }}>
      <SelectTrigger data-testid={testid}><SelectValue placeholder="Choose a person" /></SelectTrigger>
      <SelectContent>{people.map((p) => <SelectItem key={personValue(p)} value={personValue(p)}>{p.employeeName}{p.role ? ` · ${p.role}` : ""}</SelectItem>)}</SelectContent>
    </Select>
  );
}

const dayLabel = (iso: string, date: (iso: string) => string) => `${WEEKDAYS_SHORT[dayOfWeek(iso)]} ${date(iso)}`;

export interface ShiftDraft { id?: string; person: Person | null; date: string; start: number; end: number; station: string; note: string }

/** Add or edit one shift. New shifts can be repeated on other days of the week. */
export function ShiftDialog({ draft, dates, people, onSave, onDelete, onClose }: {
  draft: ShiftDraft;
  dates: string[];
  people: Person[];
  onSave: (shifts: Omit<ScheduledShift, "id">[] , id?: string) => Promise<boolean>;
  onDelete?: () => Promise<boolean>;
  onClose: () => void;
}) {
  const app = useApp();
  const [person, setPerson] = useState<Person | null>(draft.person);
  const [date, setDate] = useState(draft.date);
  const [start, setStart] = useState(draft.start);
  const [end, setEnd] = useState(draft.end % 1440);
  const [station, setStation] = useState(draft.station);
  const [note, setNote] = useState(draft.note);
  const [repeat, setRepeat] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const overnight = end <= start;
  const endMin = overnight ? end + 1440 : end;
  const length = (endMin - start) / 60;
  const tooLong = endMin - start > 24 * 60;
  const extra = draft.id ? 0 : repeat.filter((d) => d !== date).length;

  const save = async () => {
    if (!person) return;
    setBusy(true);
    const base = { employeeId: person.employeeId, employeeName: person.employeeName, start, end: endMin, station: station.trim(), note: note.trim() };
    const days = draft.id ? [date] : [date, ...repeat.filter((d) => d !== date)];
    const ok = await onSave(days.map((d) => ({ ...base, date: d })), draft.id);
    setBusy(false);
    if (ok) onClose();
  };
  const remove = async () => {
    if (!onDelete) return;
    setBusy(true);
    const ok = await onDelete();
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{draft.id ? "Edit shift" : "Add shift"}</DialogTitle>
          <DialogDescription className="break-words">{person ? person.employeeName : "Pick who works, the day and the hours."}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {!draft.person && <Field label="Employee"><PersonSelect people={people} value={person} onChange={setPerson} testid="select-shift-employee" /></Field>}
          <Field label="Day">
            <Select value={date} onValueChange={setDate}>
              <SelectTrigger data-testid="select-shift-day"><SelectValue /></SelectTrigger>
              <SelectContent>{dates.map((d) => <SelectItem key={d} value={d}>{dayLabel(d, app.date)}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start"><TimeInput value={start} onChange={setStart} data-testid="input-shift-start" /></Field>
            <Field label="End" hint={overnight ? "Ends the next day" : undefined}><TimeInput value={end} onChange={setEnd} data-testid="input-shift-end" /></Field>
          </div>
          <p className={cn("-mt-1 px-0.5 text-xs tabular", tooLong ? "font-medium text-danger" : "text-muted-foreground")}>
            {tooLong ? "A shift can be at most 24 hours." : `${Number.isInteger(length) ? length : length.toFixed(2)} hours`}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Station (optional)"><Input value={station} maxLength={60} onChange={(e) => setStation(e.target.value)} placeholder="e.g. Grill" data-testid="input-shift-station" /></Field>
            <Field label="Note (optional)"><Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Training" /></Field>
          </div>
          {!draft.id && (
            <Field label="Also on">
              <div className="flex flex-wrap gap-1.5">
                {dates.filter((d) => d !== date).map((d) => {
                  const on = repeat.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setRepeat((r) => (on ? r.filter((x) => x !== d) : [...r, d]))}
                      className={cn("h-9 min-w-[3rem] rounded-full border px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/35", on ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground")}
                    >
                      {WEEKDAYS_SHORT[dayOfWeek(d)]}
                    </button>
                  );
                })}
              </div>
            </Field>
          )}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {onDelete ? <Button variant="ghost" className="text-destructive" disabled={busy} onClick={remove} data-testid="button-delete-shift"><Trash2 /> Delete</Button> : <span className="hidden sm:block" />}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button disabled={busy || !person || tooLong} onClick={save} data-testid="button-save-shift">{busy && <Loader2 className="animate-spin" />}{draft.id ? "Save shift" : extra ? `Add ${extra + 1} shifts` : "Add shift"}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const STATUS_LABELS: Record<TimeOffStatus, string> = { approved: "Approved", pending: "Pending", declined: "Declined" };

/** Mark time off (owner side), or change / remove an existing entry. */
export function TimeOffDialog({ siteId, people, entry, initial, onClose }: {
  siteId: string;
  people: Person[];
  entry?: TimeOff;
  initial?: { person?: Person; date?: string };
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [person, setPerson] = useState<Person | null>(entry ? { employeeId: entry.employeeId, employeeName: entry.employeeName } : initial?.person ?? null);
  const [start, setStart] = useState(entry?.start ?? initial?.date ?? "");
  const [end, setEnd] = useState(entry?.end ?? initial?.date ?? "");
  const [reason, setReason] = useState(entry?.reason ?? "");
  const [status, setStatus] = useState<TimeOffStatus>(entry?.status ?? "approved");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async () => {
    if (!person || !start || !end) return;
    setBusy(true); setProblem(null);
    try {
      if (entry) await api("PUT", `/api/sites/${siteId}/time-off/${entry.id}`, { start, end, reason: reason.trim(), status });
      else await api("POST", `/api/sites/${siteId}/time-off`, { employeeId: person.employeeId, employeeName: person.employeeName, start, end, reason: reason.trim(), status });
      toast({ title: entry ? "Time off updated" : "Time off added" });
      onClose();
    } catch (e) { setProblem(errorMessage(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!entry) return;
    setBusy(true);
    try {
      await api("DELETE", `/api/sites/${siteId}/time-off/${entry.id}`);
      toast({ title: "Time off removed" });
      onClose();
    } catch (e) { setProblem(errorMessage(e)); } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{entry ? "Time off" : "Add time off"}</DialogTitle>
          <DialogDescription>Approved time off shows as a grey block and silences late alerts.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {entry ? <p className="break-words text-[15px] font-semibold">{entry.employeeName}</p> : <Field label="Employee"><PersonSelect people={people} value={person} onChange={setPerson} testid="select-timeoff-employee" /></Field>}
          <div className="grid grid-cols-2 gap-3">
            <Field label="First day"><Input type="date" value={start} onChange={(e) => { setStart(e.target.value); if (!end || end < e.target.value) setEnd(e.target.value); }} data-testid="input-timeoff-start" /></Field>
            <Field label="Last day"><Input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} data-testid="input-timeoff-end" /></Field>
          </div>
          <Field label="Reason (optional)"><Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Vacation" /></Field>
          <Field label="Status">
            <SegmentedControl<TimeOffStatus> label="Status" value={status} onChange={setStatus} options={(["approved", "pending", "declined"] as const).map((s) => ({ value: s, label: STATUS_LABELS[s] }))} />
          </Field>
          {entry?.decidedBy && <p className="text-xs text-muted-foreground">{STATUS_LABELS[entry.status]} by {entry.decidedBy}{entry.decidedAt ? ` on ${new Date(entry.decidedAt).toLocaleDateString()}` : ""}</p>}
          {problem && <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] font-medium text-danger" role="alert">{problem}</p>}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {entry ? <Button variant="ghost" className="text-destructive" disabled={busy} onClick={remove}><Trash2 /> Remove</Button> : <span className="hidden sm:block" />}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button disabled={busy || !person || !start || !end || end < start} onClick={save} data-testid="button-save-timeoff">{busy && <Loader2 className="animate-spin" />}{entry ? "Save" : "Add time off"}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Per-location settings: late / no-show alerts and the early clock-in rule. */
export function ScheduleSettingsDialog({ siteId, siteName, value, onClose, onSaved }: { siteId: string; siteName: string; value: ScheduleSettings; onClose: () => void; onSaved: (v: ScheduleSettings) => void }) {
  const { toast } = useToast();
  const [v, setV] = useState<ScheduleSettings>(value);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const saved = await api<ScheduleSettings>("PUT", `/api/sites/${siteId}/schedule/settings`, v);
      onSaved(saved);
      toast({ title: "Schedule settings saved" });
      onClose();
    } catch (e) { toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" }); } finally { setBusy(false); }
  };
  const app = useApp();
  const early = v.earlyClockIn;
  const example = 30 <= early.minutes ? `${app.time(510)} (within the limit, no change)` : app.time(early.mode === "start" ? 540 : 540 - early.minutes);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule settings</DialogTitle>
          <DialogDescription>{siteName}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Late after (minutes)" hint="Grace time after the scheduled start.">
              <NumberInput step="1" value={v.lateGraceMinutes} onChange={(n) => setV({ ...v, lateGraceMinutes: Math.min(120, Math.round(n)) })} data-testid="input-late-grace" />
            </Field>
            <Field label="No-show after (minutes)" hint="With no clock-in at all.">
              <NumberInput step="1" min={5} value={v.noShowAfterMinutes} onChange={(n) => setV({ ...v, noShowAfterMinutes: Math.min(480, Math.max(5, Math.round(n))) })} />
            </Field>
          </div>
          <ToggleRow
            label="Early clock-in rule"
            hint="When building payroll from the time clock, don't pay for time well before a scheduled start. Only days with a schedule are affected."
            checked={early.enabled}
            onChange={(enabled) => setV({ ...v, earlyClockIn: { ...early, enabled } })}
            testid="switch-early-rule"
          />
          {early.enabled && (
            <div className="space-y-3 rounded-lg bg-foreground/[0.03] p-3">
              <Field label="Applies to clock-ins more than (minutes) before the start">
                <NumberInput step="1" value={early.minutes} onChange={(n) => setV({ ...v, earlyClockIn: { ...early, minutes: Math.min(240, Math.round(n)) } })} data-testid="input-early-minutes" />
              </Field>
              <Field label="Count hours from">
                <SegmentedControl<"start" | "cap">
                  label="Count hours from"
                  value={early.mode}
                  onChange={(mode) => setV({ ...v, earlyClockIn: { ...early, mode } })}
                  options={[{ value: "start", label: "Scheduled start" }, { value: "cap", label: `${early.minutes} min before start` }]}
                />
              </Field>
              <p className="text-xs text-muted-foreground">Example: scheduled {app.time(540)}, clocked in {app.time(510)} → paid from {example}.</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={save} data-testid="button-save-schedule-settings">{busy && <Loader2 className="animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
