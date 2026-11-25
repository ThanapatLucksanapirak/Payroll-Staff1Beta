import { useMemo, useState } from "react";
import { FilePlus2, Pencil, Plus, Trash2 } from "lucide-react";
import type { EmployeeConfig, Shift } from "@shared/schema";
import { employeeKey, round2, shiftEmployeeNames } from "@shared/engine";
import { todayISO } from "@shared/dates";
import { useApp } from "@/context/AppData";
import { api } from "@/lib/api";
import { deleteShifts, newManualShift, renameEmployee, syncEmployees, upsertShift } from "@/lib/doc";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { ImportDialog, type ImportResult } from "@/components/import/ImportDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, NumberInput, Section, TimeInput } from "./fields";
import type { WsProps } from "./types";

const ALL = "__all__";
const PAGE = 150;

export function ShiftsTab(p: WsProps) {
  const app = useApp();
  const { toast } = useToast();
  const confirm = useConfirm();
  const { doc, site, edit, locked } = p;
  const names = useMemo(() => shiftEmployeeNames(doc.shifts).sort((a, b) => a.localeCompare(b)), [doc.shifts]);
  const [who, setWho] = useState(ALL);
  const [limit, setLimit] = useState(PAGE);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);

  const rows = useMemo(() => {
    const r = who === ALL ? doc.shifts : doc.shifts.filter((s) => employeeKey(s.employee) === employeeKey(who));
    return [...r].sort((a, b) => a.date.localeCompare(b.date) || a.employee.localeCompare(b.employee) || a.start - b.start);
  }, [doc.shifts, who]);

  const setShift = (s: Shift, key?: string) => edit((d) => upsertShift(d, s), key);

  const append = async (r: ImportResult) => {
    let profile: EmployeeConfig[] = [];
    if (app.prefs.autoApplySavedRates) profile = await api<EmployeeConfig[]>("GET", `/api/sites/${site.id}/wages`).catch(() => []);
    const seen = new Set(doc.shifts.map((s) => `${employeeKey(s.employee)}|${s.date}|${s.start}|${s.end}`));
    const fresh = r.shifts.filter((s) => !seen.has(`${employeeKey(s.employee)}|${s.date}|${s.start}|${s.end}`));
    const added = fresh.length;
    edit((d) => {
      const shifts = [...d.shifts, ...fresh];
      return { ...d, shifts, employees: syncEmployees(shifts, d.employees, site, profile) };
    });
    const dupes = r.shifts.length - added;
    toast({ title: `${added} shift${added === 1 ? "" : "s"} added`, description: dupes ? `${dupes} duplicate${dupes === 1 ? " was" : "s were"} skipped.` : undefined });
  };

  return (
    <div className="space-y-4">
      <Section
        title={`Shifts (${doc.shifts.length})`}
        description="Every punch used to calculate pay. Times after midnight roll into the next day automatically."
        actions={!locked && (
          <>
            <Button variant="outline" size="sm" onClick={() => setImporting(true)} data-testid="button-add-data"><FilePlus2 /> Import more</Button>
            <Button size="sm" onClick={() => setAdding(true)} data-testid="button-add-shift"><Plus /> Add shift</Button>
          </>
        )}
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Select value={who} onValueChange={(v) => { setWho(v); setLimit(PAGE); }}>
            <SelectTrigger className="w-56" data-testid="select-shift-employee"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All employees ({names.length})</SelectItem>
              {names.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
            </SelectContent>
          </Select>
          {who !== ALL && !locked && <Button variant="outline" size="sm" onClick={() => setRenaming(who)} data-testid="button-rename-employee"><Pencil /> Rename / merge</Button>}
        </div>

        {rows.length === 0 ? <p className="text-sm text-muted-foreground">No shifts.</p> : (
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="w-full text-sm min-w-[48rem]">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-2 font-medium">Employee</th><th className="pb-2 font-medium">Date</th><th className="pb-2 font-medium">In</th>
                  <th className="pb-2 font-medium">Out</th><th className="pb-2 font-medium">Break</th><th className="pb-2 font-medium text-right">Hours</th>
                  <th className="pb-2 font-medium pl-2">Role</th><th className="pb-2 font-medium">Source</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, limit).map((s) => {
                  const hrs = round2((s.end - s.start - s.breakMinutes) / 60);
                  return (
                    <tr key={s.id} className="border-t" data-testid={`row-shift-${s.id}`}>
                      <td className="py-1.5 pr-2 font-medium whitespace-nowrap max-w-[12rem] truncate">{s.employee}</td>
                      <td className="py-1.5 pr-2 w-40"><Input type="date" className="h-8" value={s.date} disabled={locked} onChange={(e) => /^\d{4}-\d{2}-\d{2}$/.test(e.target.value) && setShift({ ...s, date: e.target.value })} /></td>
                      <td className="py-1.5 pr-2 w-32"><TimeInput className="h-8" value={s.start} disabled={locked} onChange={(m) => setShift({ ...s, start: m, end: rollEnd(m, s.end) })} /></td>
                      <td className="py-1.5 pr-2 w-32">
                        <div className="flex items-center gap-1">
                          <TimeInput className="h-8" value={s.end} disabled={locked} onChange={(m) => setShift({ ...s, end: rollEnd(s.start, m) })} />
                          {s.end > 1440 && <span className="text-[10px] text-muted-foreground" title="Ends the next day">+1</span>}
                        </div>
                      </td>
                      <td className="py-1.5 pr-2 w-20"><NumberInput className="h-8" step="1" value={s.breakMinutes} disabled={locked} onChange={(n) => setShift({ ...s, breakMinutes: Math.round(n) }, `brk:${s.id}`)} /></td>
                      <td className={`py-1.5 pr-2 text-right tabular ${hrs <= 0 ? "text-destructive" : ""}`}>{hrs}</td>
                      <td className="py-1.5 pl-2 pr-2 w-32"><Input className="h-8" value={s.role} disabled={locked} onChange={(e) => setShift({ ...s, role: e.target.value }, `role:${s.id}`)} /></td>
                      <td className="py-1.5 pr-2 text-xs text-muted-foreground capitalize">{s.source}</td>
                      <td className="py-1.5 text-right">
                        {!locked && <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Delete shift" onClick={() => edit((d) => deleteShifts(d, [s.id]))} data-testid={`button-delete-shift-${s.id}`}><Trash2 className="h-4 w-4" /></Button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length > limit && <div className="pt-3 text-center"><Button variant="outline" size="sm" onClick={() => setLimit(limit + PAGE)}>Show {Math.min(PAGE, rows.length - limit)} more of {rows.length - limit}</Button></div>}
          </div>
        )}
      </Section>

      <RenameDialog
        from={renaming}
        names={names}
        onClose={() => setRenaming(null)}
        onSave={async (to) => {
          const from = renaming!;
          const merging = names.some((n) => employeeKey(n) === employeeKey(to)) && employeeKey(to) !== employeeKey(from);
          if (merging && !(await confirm({ title: `Merge ${from} into ${to}?`, description: `All of ${from}'s shifts move to ${to}. ${to}'s pay rates are kept.`, confirmLabel: "Merge" }))) return;
          edit((d) => renameEmployee(d, from, to));
          setWho(to.trim());
          setRenaming(null);
        }}
      />
      <AddShiftDialog open={adding} onOpenChange={setAdding} names={names} defaultDate={doc.periodEnd || todayISO(site.rules.timezone)}
        onAdd={(s) => edit((d) => { const shifts = [...d.shifts, s]; return { ...d, shifts, employees: syncEmployees(shifts, d.employees, site) }; })} />
      <ImportDialog open={importing} onOpenChange={setImporting} site={site} mode="append" onComplete={append} />
    </div>
  );
}

function rollEnd(start: number, end: number) {
  const e = end % 1440;
  return e <= start % 1440 ? e + 1440 : e;
}

function RenameDialog({ from, names, onClose, onSave }: { from: string | null; names: string[]; onClose: () => void; onSave: (to: string) => void }) {
  const [to, setTo] = useState("");
  return (
    <Dialog open={!!from} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm" onOpenAutoFocus={() => setTo(from ?? "")}>
        <DialogHeader>
          <DialogTitle>Rename {from}</DialogTitle>
          <DialogDescription>Type an existing name to merge two people (for example when a POS spells a name two ways).</DialogDescription>
        </DialogHeader>
        <Input list="ws-names" value={to} onChange={(e) => setTo(e.target.value)} autoFocus data-testid="input-rename-employee" />
        <datalist id="ws-names">{names.filter((n) => n !== from).map((n) => <option key={n} value={n} />)}</datalist>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!to.trim() || to.trim() === from} onClick={() => onSave(to)} data-testid="button-rename-employee-save">Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddShiftDialog({ open, onOpenChange, names, defaultDate, onAdd }: { open: boolean; onOpenChange: (o: boolean) => void; names: string[]; defaultDate: string; onAdd: (s: Shift) => void }) {
  const [name, setName] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [start, setStart] = useState(600);
  const [end, setEnd] = useState(1260);
  const [brk, setBrk] = useState(0);
  const valid = name.trim() && /^\d{4}-\d{2}-\d{2}$/.test(date);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" onOpenAutoFocus={() => { setDate(defaultDate); }}>
        <DialogHeader><DialogTitle>Add shift</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Field label="Employee"><Input list="ws-add-names" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" data-testid="input-add-shift-name" /></Field>
          <datalist id="ws-add-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
          <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="input-add-shift-date" /></Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="In"><TimeInput value={start} onChange={setStart} /></Field>
            <Field label="Out"><TimeInput value={end} onChange={setEnd} /></Field>
            <Field label="Break (min)"><NumberInput step="1" value={brk} onChange={(n) => setBrk(Math.round(n))} /></Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!valid} onClick={() => { onAdd(newManualShift(name.trim().replace(/\s+/g, " "), date, start, end, brk)); onOpenChange(false); setName(""); }} data-testid="button-add-shift-save">Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
