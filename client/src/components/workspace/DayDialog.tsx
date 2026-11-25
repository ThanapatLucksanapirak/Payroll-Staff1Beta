import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { DAY_LABELS, DAY_TYPES, type BonusEntry, type DayAdjustment, type DayResult, type DayType, type Shift } from "@shared/schema";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useApp } from "@/context/AppData";
import { uid } from "@/lib/doc";
import { Field, NumberInput, TimeInput } from "./fields";

export interface DayEdit {
  adjustment: DayAdjustment | null;
  bonuses: BonusEntry[];
  /** Updated times for the day's shifts (only when there's exactly one shift). */
  shift?: Shift;
  deleteShifts?: boolean;
}

const AUTO = "__auto__";

export function DayDialog({ open, onOpenChange, employee, day, adjustment, bonuses, shifts, onSave }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  employee: string;
  day: DayResult | null;
  adjustment: DayAdjustment | undefined;
  bonuses: BonusEntry[];
  shifts: Shift[];
  onSave: (e: DayEdit) => void;
}) {
  const app = useApp();
  const [status, setStatus] = useState<string>(AUTO);
  const [cancelled, setCancelled] = useState(false);
  const [dock, setDock] = useState(0);
  const [note, setNote] = useState("");
  const [list, setList] = useState<BonusEntry[]>([]);
  const [shift, setShift] = useState<Shift | undefined>();

  useEffect(() => {
    if (!open || !day) return;
    setStatus(adjustment?.overrideStatus ?? AUTO);
    setCancelled(!!adjustment?.cancelled);
    setDock(adjustment?.dockAmount ?? 0);
    setNote(adjustment?.note ?? "");
    setList(bonuses.map((b) => ({ ...b, id: b.id ?? uid("b") })));
    setShift(shifts.length === 1 ? { ...shifts[0] } : undefined);
  }, [open, day, adjustment, bonuses, shifts]);

  if (!day) return null;
  const save = () => {
    onSave({
      adjustment: { overrideStatus: status === AUTO ? null : (status as DayType), cancelled, dockAmount: cancelled ? 0 : dock, note: note.trim() },
      bonuses: list.filter((b) => b.amount > 0).map((b) => ({ ...b, date: day.date })),
      shift,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[92dvh] overflow-y-auto" data-testid="dialog-day">
        <DialogHeader>
          <DialogTitle>{employee} · {app.date(day.date)}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {day.punches ? (
              <>
                <span className="tabular">{day.clockIn} – {day.clockOut} · {day.hours} h</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold status-${day.originalDayType}`}>Auto: {DAY_LABELS[day.originalDayType]}</span>
              </>
            ) : day.notes}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {shift && (
            <div className="grid grid-cols-3 gap-2">
              <Field label="Clock in"><TimeInput value={shift.start} onChange={(m) => setShift({ ...shift, start: m, end: fixEnd(m, shift.end) })} data-testid="input-day-start" /></Field>
              <Field label="Clock out"><TimeInput value={shift.end} onChange={(m) => setShift({ ...shift, end: fixEnd(shift.start, m) })} data-testid="input-day-end" /></Field>
              <Field label="Break (min)"><NumberInput value={shift.breakMinutes} step="1" onChange={(n) => setShift({ ...shift, breakMinutes: Math.round(n) })} /></Field>
            </div>
          )}
          {shifts.length > 1 && <p className="text-xs text-muted-foreground">This day has {shifts.length} punches. Edit individual times on the Shifts tab.</p>}
          {day.punches > 0 && (
            <>
              <Field label="Day type">
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger data-testid="select-day-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO}>Automatic ({DAY_LABELS[day.originalDayType]})</SelectItem>
                    {DAY_TYPES.map((t) => <SelectItem key={t} value={t}>{DAY_LABELS[t]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <div className="flex items-center justify-between gap-4 rounded-lg border border-border/80 px-3.5 py-2.5">
                <div><p className="text-[13px] font-medium">Don't pay this day</p><p className="text-xs text-muted-foreground">Keeps the record but pays {app.money(0)}</p></div>
                <Switch checked={cancelled} onCheckedChange={setCancelled} data-testid="switch-day-cancel" />
              </div>
              {!cancelled && <Field label="Dock amount" hint={`Base pay for this day is ${app.money(day.basePay)}`}><NumberInput prefix={app.prefs.currencySymbol} value={dock} onChange={setDock} data-testid="input-day-dock" /></Field>}
            </>
          )}
          <Field label="Day bonuses">
            <div className="space-y-2">
              {list.map((b, i) => (
                <div key={b.id} className="flex gap-2">
                  <Input placeholder="Description" value={b.description} onChange={(e) => setList(list.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
                  <NumberInput className="w-28 shrink-0" prefix={app.prefs.currencySymbol} value={b.amount} onChange={(n) => setList(list.map((x, j) => (j === i ? { ...x, amount: n } : x)))} />
                  <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" onClick={() => setList(list.filter((_, j) => j !== i))} aria-label="Remove bonus"><Trash2 /></Button>
                </div>
              ))}
              <Button variant="tinted" size="sm" onClick={() => setList([...list, { id: uid("b"), description: "", amount: 0, date: day.date }])} data-testid="button-add-day-bonus"><Plus /> Add bonus</Button>
            </div>
          </Field>
          <Field label="Note"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Shown on the PDF" /></Field>
        </div>
        <DialogFooter className="gap-2 border-t border-border/70 pt-4 sm:justify-between">
          {day.hasManualShift && day.punches === 1 ? (
            <Button variant="ghost" className="text-destructive" onClick={() => { onSave({ adjustment: null, bonuses: [], deleteShifts: true }); onOpenChange(false); }} data-testid="button-day-delete"><Trash2 /> Remove day</Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={save} data-testid="button-day-save">Apply</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function fixEnd(start: number, end: number) {
  const e = end % 1440;
  const s = start % 1440;
  return start - s + (e <= s ? e + 1440 : e);
}
