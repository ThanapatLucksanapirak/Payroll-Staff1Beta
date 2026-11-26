import { useMemo, useState } from "react";
import { Clock, FilePlus2, Pencil, Plus, Trash2 } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, NumberInput, Section, TimeInput } from "./fields";
import { EmptyState } from "@/components/ui/empty-state";
import type { WsProps } from "./types";

const ALL = "__all__";
const SOURCE_LABELS: Record<string, string> = { csv: "CSV", square: "Square", toast: "Toast", manual: "Manual", legacy: "Imported", kiosk: "Kiosk" };
/** Table cell on md+, labelled block on phones. */
const cell = "py-1.5 pr-2 max-md:block max-md:p-0 max-md:before:mb-1 max-md:before:block max-md:before:text-xs max-md:before:font-medium max-md:before:text-muted-foreground max-md:before:content-[attr(data-label)]";
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

        {rows.length === 0 ? <EmptyState compact icon={Clock} title="No shifts yet" description={locked ? "This timesheet has no shifts." : "Add a shift by hand or import more from Square, a CSV or a PDF."} /> : (
          <div className="md:-mx-5 md:overflow-x-auto md:px-5">
            {/* Phone: each shift is a small stacked card (labels from data-label). md+: a regular table. */}
            <table className="w-full text-sm max-md:block md:min-w-[48rem]">
              <thead className="max-md:hidden">
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-2 pr-2 font-medium">Employee</th><th className="pb-2 pr-2 font-medium">Date</th><th className="pb-2 pr-2 font-medium">In</th>
                  <th className="pb-2 pr-2 font-medium">Out</th><th className="pb-2 pr-2 font-medium">Break (min)</th><th className="pb-2 pr-4 font-medium text-right">Hours</th>
                  <th className="pb-2 pr-2 font-medium">Role</th><th className="pb-2 pr-2 font-medium">Source</th><th className="pb-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="max-md:block">
                {rows.slice(0, limit).map((s) => {
                  const hrs = round2((s.end - s.start - s.breakMinutes) / 60);
                  return (
                    <tr key={s.id} className="border-t border-border/60 max-md:grid max-md:grid-cols-6 max-md:gap-x-2 max-md:gap-y-2.5 max-md:py-3" data-testid={`row-shift-${s.id}`}>
                      <td className="max-w-[12rem] truncate whitespace-nowrap py-1.5 pr-2 font-medium max-md:col-span-5 max-md:max-w-none max-md:self-center max-md:p-0 max-md:text-[15px]">{s.employee}</td>
                      <td data-label="Date" className={cn(cell, "w-40 max-md:order-2 max-md:col-span-4 max-md:w-auto")}><Input type="date" className="h-8 max-md:h-10" aria-label={`Date, ${s.employee}`} value={s.date} disabled={locked} onChange={(e) => /^\d{4}-\d{2}-\d{2}$/.test(e.target.value) && setShift({ ...s, date: e.target.value })} /></td>
                      <td data-label="In" className={cn(cell, "w-32 max-md:order-4 max-md:col-span-3 max-md:w-auto")}><TimeInput className="h-8 max-md:h-10" aria-label={`Clock in, ${s.employee}`} value={s.start} disabled={locked} onChange={(m) => setShift({ ...s, start: m, end: rollEnd(m, s.end) })} /></td>
                      <td data-label="Out" className={cn(cell, "w-32 max-md:order-5 max-md:col-span-3 max-md:w-auto")}>
                        <div className="flex items-center gap-1">
                          <TimeInput className="h-8 max-md:h-10" aria-label={`Clock out, ${s.employee}`} value={s.end} disabled={locked} onChange={(m) => setShift({ ...s, end: rollEnd(s.start, m) })} />
                          {s.end > 1440 && <span className="shrink-0 text-[11px] font-medium text-muted-foreground" title="Ends the next day">+1 day</span>}
                        </div>
                      </td>
                      <td data-label="Break (min)" className={cn(cell, "w-20 max-md:order-3 max-md:col-span-2 max-md:w-auto")}><NumberInput className="[&_input]:h-8 max-md:[&_input]:h-10" aria-label={`Break minutes, ${s.employee}`} step="1" value={s.breakMinutes} disabled={locked} onChange={(n) => setShift({ ...s, breakMinutes: Math.round(n) }, `brk:${s.id}`)} /></td>
                      <td data-label="Hours" className={cn(cell, "pr-4 text-right tabular max-md:order-7 max-md:col-span-1 max-md:pr-0 max-md:text-[15px] max-md:font-semibold", hrs <= 0 && "text-destructive")}>{hrs}</td>
                      <td data-label="Role" className={cn(cell, "w-32 max-md:order-6 max-md:col-span-3 max-md:w-auto")}><Input className="h-8 max-md:h-10" aria-label={`Role, ${s.employee}`} value={s.role} disabled={locked} onChange={(e) => setShift({ ...s, role: e.target.value }, `role:${s.id}`)} /></td>
                      <td data-label="Source" className={cn(cell, "max-md:order-8 max-md:col-span-2")}><Badge variant="secondary" className="font-medium">{SOURCE_LABELS[s.source] ?? s.source}</Badge></td>
                      <td className="py-1.5 text-right max-md:order-1 max-md:col-span-1 max-md:-my-1.5 max-md:p-0">
                        {!locked && <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive max-md:h-10 max-md:w-10" aria-label={`Delete shift, ${s.employee} ${s.date}`} onClick={() => edit((d) => deleteShifts(d, [s.id]))} data-testid={`button-delete-shift-${s.id}`}><Trash2 /></Button>}
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
