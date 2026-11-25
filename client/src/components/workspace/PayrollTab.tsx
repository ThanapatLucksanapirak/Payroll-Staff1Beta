import { PAYMENT_LABELS } from "@shared/schema";
import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, FileText, Info, Plus, Search, Trash2, Users } from "lucide-react";
import { DAY_LABELS, type BonusEntry, type DayResult, type DeductionEntry, type EmployeeSummary } from "@shared/schema";
import { employeeKey } from "@shared/engine";
import { todayISO } from "@shared/dates";
import { useApp } from "@/context/AppData";
import { useToast } from "@/hooks/use-toast";
import { errorMessage } from "@/lib/api";
import { deleteShifts, newManualShift, setAdjustment, uid, updateEmployee, updateManual, upsertShift } from "@/lib/doc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { DayDialog, type DayEdit } from "./DayDialog";
import { Field, NumberInput, TimeInput } from "./fields";
import type { WsProps } from "./types";

export function PayrollTab(p: WsProps) {
  const app = useApp();
  const { result } = p;
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showWarnings, setShowWarnings] = useState(false);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? result.employees.filter((e) => e.name.toLowerCase().includes(s)) : result.employees;
  }, [result.employees, q]);
  const t = result.totals;
  const warns = result.warnings.filter((w) => w.level === "warn");
  const allOpen = list.length > 0 && list.every((e) => open[e.sourceId]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        <Kpi label="Total payroll" value={app.money(t.totalPay)} strong testid="kpi-total" />
        <Kpi label="Employees" value={String(t.employees)} sub={`${t.fullDays} full · ${t.halfDays} half${t.flaggedDays ? ` · ${t.flaggedDays} flagged` : ""}`} />
        <Kpi label="Net / Gross" value={`${app.money(t.netPay)}`} sub={`Gross ${app.money(t.grossPay)}`} />
        <Kpi label="Hours" value={String(t.hours)} sub={`${t.overtimeHours ? `${t.overtimeHours} OT · ` : ""}Bonuses ${app.money(t.bonuses)}`} />
      </div>

      <PayoutStrip cash={t.cash} bank={t.bank} check={t.check} people={result.employees.filter((e) => !e.excluded)} />

      {result.warnings.length > 0 && (
        <div className={cn("overflow-hidden rounded-xl", warns.length ? "bg-warning-soft" : "border border-card-border bg-card shadow-card")}>
          <button className="flex w-full items-center gap-2 px-4 py-3 text-left text-[13px] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/35" onClick={() => setShowWarnings(!showWarnings)} aria-expanded={showWarnings} data-testid="button-warnings">
            {warns.length ? <AlertTriangle className="h-4 w-4 text-warning" /> : <Info className="h-4 w-4 text-muted-foreground" />}
            <span className="font-medium">{result.warnings.length} item{result.warnings.length === 1 ? "" : "s"} to review</span>
            <ChevronDown className={cn("ml-auto h-4 w-4 transition-transform", showWarnings && "rotate-180")} />
          </button>
          {showWarnings && (
            <ul className="max-h-60 space-y-1.5 overflow-y-auto border-t border-foreground/10 px-4 py-3 text-[13px]">
              {result.warnings.map((w, i) => (
                <li key={i} className="flex gap-2"><span className={w.level === "warn" ? "text-warning" : "text-muted-foreground"}>•</span><span><b className="font-medium">{w.employee}</b>{w.date ? ` (${app.date(w.date)})` : ""}: {w.message}</span></li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[10rem]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find employee" aria-label="Find employee" className="pl-9" data-testid="input-employee-search" />
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen(allOpen ? {} : Object.fromEntries(list.map((e) => [e.sourceId, true])))} data-testid="button-expand-all">{allOpen ? "Collapse all" : "Expand all"}</Button>
      </div>

      {list.length === 0 ? (
        <EmptyState icon={result.employees.length ? Search : Users} title={result.employees.length ? "No employees match" : "No one to pay yet"} description={result.employees.length ? "Try a different name." : "Add shifts on the Shifts tab, or add manual employees on the Rates tab."} />
      ) : (
        <div className="space-y-2">
          {list.map((e) => <EmployeeCard key={e.sourceId} {...p} emp={e} open={!!open[e.sourceId]} onToggle={() => setOpen({ ...open, [e.sourceId]: !open[e.sourceId] })} />)}
        </div>
      )}
    </div>
  );
}

function paymentLabel(p: EmployeeSummary["payment"], money: (n: number) => string) {
  if (p.method === "split") return `${money(p.cash)} cash + ${money(p.bank)} bank`;
  return PAYMENT_LABELS[p.method];
}

/** How the run is paid out: cash / bank / check totals, with counts. Only shown when it adds information. */
function PayoutStrip({ cash, bank, check, people }: { cash: number; bank: number; check: number; people: EmployeeSummary[] }) {
  const app = useApp();
  const count = (k: "cash" | "bank" | "check") => people.filter((e) => e.payment[k] > 0).length;
  const parts = ([["cash", "Cash", cash], ["bank", "Bank transfer", bank], ["check", "Check", check]] as const).filter(([, , v]) => v > 0);
  if (!parts.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-card-border bg-card px-4 py-3 shadow-card" data-testid="strip-payout">
      <span className="text-[13px] font-medium text-muted-foreground">Pay out</span>
      {parts.map(([k, label, v]) => (
        <span key={k} className="text-[13px]" data-testid={`payout-${k}`}>
          <span className="text-muted-foreground">{label}</span>{" "}
          <span className="font-semibold tabular">{app.money(v)}</span>{" "}
          <span className="text-xs text-muted-foreground">({count(k)} {count(k) === 1 ? "person" : "people"})</span>
        </span>
      ))}
    </div>
  );
}

function Kpi({ label, value, sub, strong, testid }: { label: string; value: string; sub?: string; strong?: boolean; testid?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-card-border bg-card p-4 shadow-card">
      <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
      <p className={cn("mt-1.5 truncate font-semibold leading-tight tracking-tight tabular", strong ? "text-[26px] text-foreground" : "text-[20px]")} data-testid={testid}>{value}</p>
      {sub && <p className="mt-1 truncate text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function EmployeeCard(p: WsProps & { emp: EmployeeSummary; open: boolean; onToggle: () => void }) {
  const app = useApp();
  const { toast } = useToast();
  const { emp, doc, site, locked, edit } = p;
  const [day, setDay] = useState<DayResult | null>(null);
  const [adding, setAdding] = useState(false);
  const manualId = emp.isManual ? emp.sourceId.slice("manual:".length) : null;
  const cfg = manualId ? undefined : doc.employees.find((c) => employeeKey(c.name) === employeeKey(emp.name));
  const manual = manualId ? doc.manualEmployees.find((m) => m.id === manualId) : undefined;
  const generalBonuses = manual ? manual.bonuses : (cfg?.bonuses ?? []).filter((b) => !b.date);
  const deductions = manual ? manual.deductions : cfg?.deductions ?? [];
  const noRate = !emp.isManual && (emp.payBasis === "hourly" ? emp.hourlyRate <= 0 : emp.fullDayRate <= 0 && emp.halfDayRate <= 0);

  const setExtras = (bonuses: BonusEntry[] | null, deds: DeductionEntry[] | null) => {
    if (manualId) edit((d) => updateManual(d, manualId, (m) => ({ ...m, ...(bonuses ? { bonuses } : {}), ...(deds ? { deductions: deds } : {}) })), `extras:${emp.sourceId}`);
    else edit((d) => updateEmployee(d, emp.name, site, (c) => ({ ...c, ...(bonuses ? { bonuses: [...c.bonuses.filter((b) => b.date), ...bonuses] } : {}), ...(deds ? { deductions: deds } : {}) })), `extras:${emp.sourceId}`);
  };
  const setExcluded = (excluded: boolean) => {
    if (manualId) edit((d) => updateManual(d, manualId, (m) => ({ ...m, excluded })));
    else edit((d) => updateEmployee(d, emp.name, site, (c) => ({ ...c, excluded })));
  };

  const downloadStatement = async () => {
    try {
      const { downloadPayStatementsPdf } = await import("@/lib/pdf");
      const period = p.result.periodStart ? `${app.date(p.result.periodStart)} – ${app.date(p.result.periodEnd)}` : "";
      downloadPayStatementsPdf({ result: p.result, prefs: app.prefs, site, title: doc.label || `Payroll ${period}`, only: [emp.sourceId], fileBase: `${emp.name} pay statement ${p.result.periodStart}` });
    } catch (e) { toast({ title: "PDF export failed", description: errorMessage(e), variant: "destructive" }); }
  };

  const applyDay = (dayRes: DayResult, e: DayEdit) => {
    edit((d) => {
      let next = d;
      if (e.deleteShifts) return deleteShifts(next, dayRes.shiftIds);
      if (e.shift) next = upsertShift(next, e.shift);
      next = setAdjustment(next, emp.name, dayRes.key, site, e.adjustment);
      next = updateEmployee(next, emp.name, site, (c) => ({ ...c, bonuses: [...c.bonuses.filter((b) => !b.date || b.date !== dayRes.date), ...e.bonuses] }));
      return next;
    });
  };

  return (
    <div className={cn("overflow-hidden rounded-xl border border-card-border bg-card shadow-card transition-shadow", p.open && "shadow-float", emp.excluded && "opacity-60")} data-testid={`card-employee-${employeeKey(emp.name)}`}>
      <div className="flex items-center gap-3 px-4 py-3">
        <button className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35" onClick={p.onToggle} aria-expanded={p.open} data-testid={`button-toggle-${employeeKey(emp.name)}`}>
          <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200", p.open && "rotate-90")} />
          <span className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] text-[12px] font-semibold text-foreground/70 sm:flex" aria-hidden>{emp.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase()}</span>
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold">{emp.name}</p>
            <p className="text-xs text-muted-foreground truncate">
              {emp.isManual ? "Manual pay" : [emp.categoryName ?? "Custom", emp.payBasis === "hourly" ? `${app.money(emp.hourlyRate)}/h · ${emp.hoursWorked} h` : `${emp.fullDays} full · ${emp.halfDays} half${emp.flaggedDays ? ` · ${emp.flaggedDays} flagged` : ""}`].join(" · ")}
            </p>
          </div>
        </button>
        {noRate && !emp.excluded && <Badge variant="warning" className="hidden sm:inline-flex">No rate</Badge>}
        <Badge variant="secondary" className="hidden sm:inline-flex">{emp.isNetPay ? "Net" : "Gross"}</Badge>
        {!emp.excluded && <Badge variant="outline" className="hidden md:inline-flex" data-testid={`badge-payment-${emp.sourceId}`}>{paymentLabel(emp.payment, app.money)}</Badge>}
        <p className="w-24 text-right text-[15px] font-semibold tabular" data-testid={`text-total-${employeeKey(emp.name)}`}>{app.money(emp.totalPay)}</p>
      </div>

      {p.open && (
        <div className="space-y-5 border-t border-border/70 bg-foreground/[0.012] px-4 py-4">
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full text-sm min-w-[34rem]">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-2 font-medium">Date</th><th className="font-medium">In</th><th className="font-medium">Out</th>
                  <th className="font-medium text-right">Hours</th><th className="font-medium pl-3">Type</th><th className="font-medium text-right">Pay</th><th />
                </tr>
              </thead>
              <tbody>
                {emp.days.map((d) => (
                  <tr key={d.key} className="border-t border-border/60 align-middle">
                    <td className="whitespace-nowrap py-2">{d.date ? app.date(d.date) : "—"}</td>
                    <td className="tabular whitespace-nowrap">{d.start != null ? app.time(d.start) : "—"}</td>
                    <td className="tabular whitespace-nowrap">{d.end != null ? app.time(d.end) : "—"}</td>
                    <td className="tabular text-right">{d.punches ? d.hours : ""}</td>
                    <td className="pl-3">
                      {d.punches ? (
                        <span className="flex flex-wrap items-center gap-1">
                          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", `status-${d.dayType}`, d.cancelled && "line-through")}>{DAY_LABELS[d.dayType]}</span>
                          {d.dayType !== d.originalDayType && <span className="text-[10px] text-muted-foreground">edited</span>}
                          {d.hasManualShift && <span className="text-[10px] text-muted-foreground">manual</span>}
                        </span>
                      ) : <span className="text-xs text-muted-foreground">{d.notes}</span>}
                      {(d.adjustmentNote || d.dockAmount > 0 || d.bonuses.length > 0) && (
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {[d.dockAmount > 0 && `Docked ${app.money(d.dockAmount)}`, d.bonuses.length > 0 && `Bonus ${app.money(d.bonuses.reduce((s, b) => s + b.amount, 0))}`, d.adjustmentNote].filter(Boolean).join(" · ")}
                        </p>
                      )}
                    </td>
                    <td className="tabular text-right whitespace-nowrap">{app.money(d.pay)}</td>
                    <td className="text-right w-14">
                      {!emp.isManual && !locked && <Button variant="ghost" size="sm" className="h-7 px-2 text-primary" onClick={() => setDay(d)} data-testid={`button-edit-day-${d.key}`}>Edit</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!locked && (
            <div className="flex flex-wrap items-center gap-2">
              {!emp.isManual && <Button variant="outline" size="sm" onClick={() => setAdding(true)} data-testid={`button-add-day-${employeeKey(emp.name)}`}><Plus /> Add day</Button>}
              <div className="ml-auto flex items-center gap-2 text-[13px]">
                <span className="text-muted-foreground">Leave out of totals</span>
                <Switch checked={emp.excluded} onCheckedChange={setExcluded} data-testid={`switch-exclude-${employeeKey(emp.name)}`} />
              </div>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <ExtrasList title="Bonuses" items={generalBonuses} locked={locked} onChange={(b) => setExtras(b as BonusEntry[], null)} testid="bonus" />
            <ExtrasList title="Deductions" items={deductions} locked={locked} onChange={(dd) => setExtras(null, dd)} testid="deduction" />
          </div>

          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 border-t border-border/70 pt-3 text-xs text-muted-foreground tabular">
            {!emp.excluded && <Button variant="tinted" size="sm" className="mr-auto h-7 px-2 text-xs" onClick={downloadStatement} data-testid={`button-statement-${employeeKey(emp.name)}`}><FileText className="h-3.5 w-3.5" /> Pay statement</Button>}
            <span>Base {app.money(emp.totalBasePay)}</span>
            {emp.totalDocked > 0 && <span>Docked −{app.money(emp.totalDocked)}</span>}
            {emp.totalBonuses > 0 && <span>Bonuses +{app.money(emp.totalBonuses)}</span>}
            {emp.totalDeductions > 0 && <span>Deductions −{app.money(emp.totalDeductions)}</span>}
            <span className="text-[13px] font-semibold text-foreground">Total {app.money(emp.totalPay)}</span>
          </div>
        </div>
      )}

      <DayDialog
        open={!!day}
        onOpenChange={(o) => !o && setDay(null)}
        employee={emp.name}
        day={day}
        adjustment={day ? cfg?.adjustments[day.key] : undefined}
        bonuses={day ? (cfg?.bonuses ?? []).filter((b) => b.date === day.date) : []}
        shifts={day ? doc.shifts.filter((s) => day.shiftIds.includes(s.id)) : []}
        onSave={(e) => day && applyDay(day, e)}
      />
      <AddDayDialog open={adding} onOpenChange={setAdding} employee={emp.name} defaultDate={emp.days.at(-1)?.date || todayISO(site.rules.timezone)}
        onAdd={(date, start, end, brk) => edit((d) => upsertShift(d, newManualShift(emp.name, date, start, end, brk)))} />
    </div>
  );
}

function ExtrasList({ title, items, onChange, locked, testid }: { title: string; items: { id?: string; description: string; amount: number }[]; onChange: (v: any[]) => void; locked: boolean; testid: string }) {
  const app = useApp();
  return (
    <div className="space-y-2">
      <p className="section-label">{title}</p>
      {items.length === 0 && <p className="text-xs text-muted-foreground">None yet</p>}
      {items.map((b, i) => (
        <div key={b.id ?? i} className="flex gap-2">
          <Input placeholder="Description" value={b.description} disabled={locked} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} data-testid={`input-${testid}-desc-${i}`} />
          <NumberInput className="w-28 shrink-0" prefix={app.prefs.currencySymbol} value={b.amount} disabled={locked} onChange={(n) => onChange(items.map((x, j) => (j === i ? { ...x, amount: n } : x)))} data-testid={`input-${testid}-amount-${i}`} />
          {!locked && <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" aria-label={`Remove ${testid}`} onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 /></Button>}
        </div>
      ))}
      {!locked && <Button variant="tinted" size="sm" onClick={() => onChange([...items, { id: uid(testid[0]), description: "", amount: 0 }])} data-testid={`button-add-${testid}`}><Plus /> Add {testid}</Button>}
    </div>
  );
}

function AddDayDialog({ open, onOpenChange, employee, defaultDate, onAdd }: { open: boolean; onOpenChange: (o: boolean) => void; employee: string; defaultDate: string; onAdd: (date: string, start: number, end: number, brk: number) => void }) {
  const [date, setDate] = useState(defaultDate);
  const [start, setStart] = useState(600);
  const [end, setEnd] = useState(1260);
  const [brk, setBrk] = useState(0);
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (o) setDate(defaultDate); }}>
      <DialogContent className="max-w-sm" onOpenAutoFocus={() => setDate(defaultDate)}>
        <DialogHeader><DialogTitle>Add a day for {employee}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="input-add-day-date" /></Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="In"><TimeInput value={start} onChange={setStart} /></Field>
            <Field label="Out"><TimeInput value={end} onChange={setEnd} /></Field>
            <Field label="Break (min)"><NumberInput value={brk} step="1" onChange={(n) => setBrk(Math.round(n))} /></Field>
          </div>
          <p className="text-xs leading-snug text-muted-foreground">Saved as a real shift, so it is classified by the location rules and kept on reload.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!/^\d{4}-\d{2}-\d{2}$/.test(date)} onClick={() => { onAdd(date, start, end, brk); onOpenChange(false); }} data-testid="button-add-day-save">Add day</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
