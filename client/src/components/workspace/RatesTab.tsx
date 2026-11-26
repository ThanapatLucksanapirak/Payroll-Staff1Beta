import { useState } from "react";
import { Download, Loader2, Plus, Save, Trash2, Users } from "lucide-react";
import { PAYMENT_LABELS, type EmployeeConfig, type ManualEmployee, type PaymentMethod } from "@shared/schema";
import { employeeKey, shiftEmployeeNames } from "@shared/engine";
import { useApp } from "@/context/AppData";
import { api, errorMessage } from "@/lib/api";
import { applyProfile, blankManual, updateEmployee, updateManual } from "@/lib/doc";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, NumberInput, Section } from "./fields";
import { EmptyState } from "@/components/ui/empty-state";
import type { WsProps } from "./types";
import { SaveRatesDialog } from "@/components/pay/SaveRatesDialog";

const CUSTOM = "custom";

/** "Paid by" picker: Default (follows the pay run), Cash, Bank, Check, or Cash + bank with a cash amount. */
export function PaymentPicker({ method, cash, defaultMethod, disabled, onChange, testid }: {
  method: "default" | PaymentMethod; cash: number; defaultMethod: PaymentMethod; disabled?: boolean;
  onChange: (patch: { paymentMethod?: "default" | PaymentMethod; splitCashAmount?: number }, key?: string) => void; testid: string;
}) {
  const app = useApp();
  return (
    <div className="flex items-center gap-2">
      <Select value={method} onValueChange={(v) => onChange({ paymentMethod: v as any })} disabled={disabled}>
        <SelectTrigger className="h-8 w-[13rem]" data-testid={`select-payment-${testid}`}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="default">Default ({PAYMENT_LABELS[defaultMethod]})</SelectItem>
          <SelectItem value="cash">Cash</SelectItem>
          <SelectItem value="bank">Bank transfer</SelectItem>
          <SelectItem value="check">Check</SelectItem>
          <SelectItem value="split">Cash + bank</SelectItem>
        </SelectContent>
      </Select>
      {method === "split" && (
        <NumberInput className="w-28 [&_input]:h-8" prefix={app.prefs.currencySymbol} value={cash} disabled={disabled} aria-label="Cash amount" title="Paid in cash; the rest goes by bank transfer"
          onChange={(n) => onChange({ splitCashAmount: Math.max(0, n) }, `split:${testid}`)} data-testid={`input-split-cash-${testid}`} />
      )}
    </div>
  );
}

export function RatesTab(p: WsProps) {
  const app = useApp();
  const { toast } = useToast();
  const { doc, site, edit, locked } = p;
  const cats = app.categoriesFor(site.id);
  const [busy, setBusy] = useState<"load" | "save" | null>(null);
  const [saving, setSaving] = useState(false);
  const active = new Set(shiftEmployeeNames(doc.shifts).map(employeeKey));
  const rows = doc.employees.filter((e) => active.has(employeeKey(e.name))).sort((a, b) => a.name.localeCompare(b.name));
  const setEmp = (name: string, patch: Partial<EmployeeConfig>, key?: string) => edit((d) => updateEmployee(d, name, site, (e) => ({ ...e, ...patch })), key);

  const loadSaved = async () => {
    setBusy("load");
    try {
      const profile = await api<EmployeeConfig[]>("GET", `/api/sites/${site.id}/wages`);
      if (!profile.length) { toast({ title: "No saved rates yet", description: `Use "Save as defaults" to store rates for ${site.name}.` }); return; }
      const { matched } = applyProfile(doc.employees, profile);
      edit((d) => ({ ...d, employees: applyProfile(d.employees, profile).employees }));
      toast({ title: matched ? "Saved rates applied" : "No matching employees", description: matched ? `${matched} employee${matched === 1 ? "" : "s"} updated.` : `None of the saved names for ${site.name} appear in this timesheet.` });
    } catch (e) {
      toast({ title: "Couldn't load saved rates", description: errorMessage(e), variant: "destructive" });
    } finally { setBusy(null); }
  };

  // Saved with an effective date (rate history); see SaveRatesDialog.
  const saveDefaults = () => setSaving(true);

  return (
    <div className="space-y-4">
      <Section
        title="Employee pay rates"
        description="Pick a category to use its rates, or choose Custom to set rates for one person."
        actions={!locked && (
          <>
            <Button variant="outline" size="sm" onClick={loadSaved} disabled={!!busy} data-testid="button-load-rates">{busy === "load" ? <Loader2 className="animate-spin" /> : <Download />} Load saved rates</Button>
            <Button variant="outline" size="sm" onClick={saveDefaults} disabled={!!busy || !rows.length} data-testid="button-save-rates">{busy === "save" ? <Loader2 className="animate-spin" /> : <Save />} Save as defaults</Button>
          </>
        )}
      >
        {rows.length === 0 ? <EmptyState compact icon={Users} title="No employees with shifts yet" description="Rates appear here once the timesheet has shifts. Add them on the Shifts tab." /> : (
          <div className="overflow-x-auto -mx-5 px-5">
            <table className="w-full text-sm min-w-[58rem]">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="sticky left-0 z-10 bg-card pb-2 font-medium">Employee</th><th className="pb-2 font-medium">Category</th><th className="pb-2 font-medium">Pay basis</th>
                  <th className="pb-2 font-medium">Full day</th><th className="pb-2 font-medium">Half day</th><th className="pb-2 font-medium">Hourly</th>
                  <th className="pb-2 font-medium text-center">Net</th><th className="pb-2 font-medium">Paid by</th><th className="pb-2 font-medium text-center">Include</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const cat = e.categoryId !== CUSTOM ? cats.find((c) => c.id === e.categoryId) : undefined;
                  const k = employeeKey(e.name);
                  const basis = cat?.payBasis ?? e.payBasis;
                  return (
                    <tr key={k} className="border-t border-border/60" data-testid={`row-rate-${k}`}>
                      <td className="sticky left-0 z-10 max-w-[9rem] truncate bg-card py-2 pr-2 font-medium sm:max-w-none" title={e.name}>{e.name}</td>
                      <td className="py-2 pr-2 w-40">
                        <Select value={cat ? e.categoryId : CUSTOM} onValueChange={(v) => setEmp(e.name, { categoryId: v })} disabled={locked}>
                          <SelectTrigger className="h-8" data-testid={`select-category-${k}`}><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value={CUSTOM}>Custom</SelectItem>
                            {cats.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="py-2 pr-2 w-32">
                        <Select value={basis} onValueChange={(v) => setEmp(e.name, { payBasis: v as any })} disabled={locked || !!cat}>
                          <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                          <SelectContent><SelectItem value="day_rate">Day rate</SelectItem><SelectItem value="hourly">Hourly</SelectItem></SelectContent>
                        </Select>
                      </td>
                      <td className="py-2 pr-2 w-28"><NumberInput className="[&_input]:h-8" prefix={app.prefs.currencySymbol} value={cat ? cat.fullDayRate : e.fullDayRate} disabled={locked || !!cat || basis === "hourly"} onChange={(n) => setEmp(e.name, { fullDayRate: n }, `full:${k}`)} data-testid={`input-full-${k}`} /></td>
                      <td className="py-2 pr-2 w-28"><NumberInput className="[&_input]:h-8" prefix={app.prefs.currencySymbol} value={cat ? cat.halfDayRate : e.halfDayRate} disabled={locked || !!cat || basis === "hourly"} onChange={(n) => setEmp(e.name, { halfDayRate: n }, `half:${k}`)} data-testid={`input-half-${k}`} /></td>
                      <td className="py-2 pr-2 w-28"><NumberInput className="[&_input]:h-8" prefix={app.prefs.currencySymbol} value={cat ? cat.hourlyRate : e.hourlyRate} disabled={locked || !!cat || basis !== "hourly"} onChange={(n) => setEmp(e.name, { hourlyRate: n }, `hourly:${k}`)} data-testid={`input-hourly-${k}`} /></td>
                      <td className="py-2 text-center"><Switch checked={e.isNetPay} disabled={locked} onCheckedChange={(v) => setEmp(e.name, { isNetPay: v })} aria-label="Net pay" /></td>
                      <td className="py-2 pr-2"><PaymentPicker method={e.paymentMethod} cash={e.splitCashAmount} defaultMethod={doc.rules.defaultPaymentMethod} disabled={locked} testid={k} onChange={(patch, key) => setEmp(e.name, patch, key)} /></td>
                      <td className="py-2 text-center"><Switch checked={!e.excluded} disabled={locked} onCheckedChange={(v) => setEmp(e.name, { excluded: !v })} aria-label="Include in totals" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <SaveRatesDialog open={saving} onOpenChange={setSaving} siteId={site.id} siteName={site.name} rows={rows} defaultDate={p.result.periodStart || doc.periodStart || ""} />
      <Section
        title="Manual employees"
        description="People paid outside of timecards — a flat amount for the period or amounts on specific dates."
        actions={!locked && <Button variant="outline" size="sm" onClick={() => edit((d) => ({ ...d, manualEmployees: [...d.manualEmployees, blankManual()] }))} data-testid="button-add-manual"><Plus /> Add person</Button>}
      >
        {doc.manualEmployees.length === 0 ? <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">No manual employees. Use <b className="font-medium text-foreground">Add person</b> for anyone paid outside of timecards.</p> : (
          <div className="space-y-3">
            {doc.manualEmployees.map((m) => <ManualRow key={m.id} m={m} locked={locked} defaultMethod={doc.rules.defaultPaymentMethod} onChange={(fn, key) => edit((d) => updateManual(d, m.id, fn), key)} onRemove={() => edit((d) => ({ ...d, manualEmployees: d.manualEmployees.filter((x) => x.id !== m.id) }))} />)}
          </div>
        )}
      </Section>
    </div>
  );
}

function ManualRow({ m, locked, defaultMethod, onChange, onRemove }: { m: ManualEmployee; locked: boolean; defaultMethod: PaymentMethod; onChange: (fn: (m: ManualEmployee) => ManualEmployee, key?: string) => void; onRemove: () => void }) {
  const app = useApp();
  const total = m.payMode === "lump_sum" ? m.lumpSum : m.payDates.reduce((s, d) => s + d.amount, 0);
  return (
    <div className="space-y-3 rounded-xl border border-border/80 p-4" data-testid={`card-manual-${m.id}`}>
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem_auto_auto] items-end">
        <Field label="Name"><Input value={m.name} disabled={locked} placeholder="Full name" onChange={(e) => onChange((x) => ({ ...x, name: e.target.value }), `mname:${m.id}`)} data-testid={`input-manual-name-${m.id}`} /></Field>
        <Field label="Paid as">
          <Select value={m.payMode} disabled={locked} onValueChange={(v) => onChange((x) => ({ ...x, payMode: v as any }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="lump_sum">Lump sum</SelectItem><SelectItem value="by_date">By date</SelectItem></SelectContent>
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-sm pb-2"><Switch checked={m.isNetPay} disabled={locked} onCheckedChange={(v) => onChange((x) => ({ ...x, isNetPay: v }))} />Net</label>
        {!locked && <Button variant="ghost" size="icon" onClick={onRemove} aria-label="Remove person" className="mb-0.5"><Trash2 /></Button>}
      </div>
      {m.payMode === "lump_sum" ? (
        <Field label="Amount for the period" className="max-w-[12rem]"><NumberInput prefix={app.prefs.currencySymbol} value={m.lumpSum} disabled={locked} onChange={(n) => onChange((x) => ({ ...x, lumpSum: n }), `mlump:${m.id}`)} data-testid={`input-manual-lump-${m.id}`} /></Field>
      ) : (
        <div className="space-y-2">
          {m.payDates.map((pd, i) => (
            <div key={i} className="flex flex-wrap gap-2">
              <Input type="date" className="w-40" value={pd.date} disabled={locked} onChange={(e) => onChange((x) => ({ ...x, payDates: x.payDates.map((y, j) => (j === i ? { ...y, date: e.target.value } : y)) }))} />
              <NumberInput className="w-28" prefix={app.prefs.currencySymbol} value={pd.amount} disabled={locked} onChange={(n) => onChange((x) => ({ ...x, payDates: x.payDates.map((y, j) => (j === i ? { ...y, amount: n } : y)) }), `mpd:${m.id}:${i}`)} />
              <Input className="flex-1 min-w-[8rem]" placeholder="Note" value={pd.note} disabled={locked} onChange={(e) => onChange((x) => ({ ...x, payDates: x.payDates.map((y, j) => (j === i ? { ...y, note: e.target.value } : y)) }), `mpn:${m.id}:${i}`)} />
              {!locked && <Button variant="ghost" size="icon" aria-label="Remove date" onClick={() => onChange((x) => ({ ...x, payDates: x.payDates.filter((_, j) => j !== i) }))}><Trash2 /></Button>}
            </div>
          ))}
          {!locked && <Button variant="outline" size="sm" onClick={() => onChange((x) => ({ ...x, payDates: [...x.payDates, { date: "", amount: 0, note: "" }] }))}><Plus /> Add date</Button>}
        </div>
      )}
      <Field label="Paid by"><PaymentPicker method={m.paymentMethod} cash={m.splitCashAmount} defaultMethod={defaultMethod} disabled={locked} testid={`manual-${m.id}`} onChange={(patch, key) => onChange((x) => ({ ...x, ...patch }), key)} /></Field>
      <p className="text-xs text-muted-foreground">Base {app.money(total)} · bonuses and deductions can be added on the Payroll tab.</p>
    </div>
  );
}
