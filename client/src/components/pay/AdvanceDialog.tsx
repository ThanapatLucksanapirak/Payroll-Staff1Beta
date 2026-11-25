import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { todayISO } from "@shared/dates";
import { installmentOf } from "@shared/payExtras";
import { useApp } from "@/context/AppData";
import { api, errorMessage } from "@/lib/api";
import { invalidatePay } from "@/lib/pay";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, NumberInput } from "@/components/workspace/fields";

/** Record a pay advance or loan; it is taken back from later timesheets at this location. */
export function AdvanceDialog({ open, onOpenChange, siteId, names, defaultName, onSaved }: {
  open: boolean; onOpenChange: (o: boolean) => void; siteId: string; names: string[]; defaultName?: string; onSaved?: () => void;
}) {
  const app = useApp();
  const { toast } = useToast();
  const tz = app.sites.find((s) => s.id === siteId)?.rules.timezone;
  const [employee, setEmployee] = useState(defaultName ?? "");
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(todayISO(tz));
  const [mode, setMode] = useState<"per_period" | "periods">("periods");
  const [perPeriod, setPerPeriod] = useState(0);
  const [periods, setPeriods] = useState(2);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setEmployee(defaultName ?? ""); setAmount(0); setDate(todayISO(tz)); setPerPeriod(0); setPeriods(2); setNote(""); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const each = amount > 0 ? installmentOf({ amount, mode, perPeriod, periods }) : 0;
  const valid = employee.trim() && amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date) && (mode === "periods" ? periods >= 1 : perPeriod > 0);

  const save = async () => {
    setBusy(true);
    try {
      await api("POST", `/api/sites/${siteId}/pay/advances`, { employee: employee.trim(), amount, date, mode, perPeriod, periods, note: note.trim() });
      invalidatePay(siteId);
      toast({ title: "Advance recorded", description: `${app.money(each)} a period comes off ${employee.trim()}'s pay until it is repaid.` });
      onOpenChange(false);
      onSaved?.();
    } catch (e) {
      toast({ title: "Couldn't record the advance", description: errorMessage(e), variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record an advance</DialogTitle>
          <DialogDescription>Money paid ahead of payday or lent. It comes off this person's next timesheets here until it is repaid. Repayments count once a timesheet is finalized.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) void save(); }}>
          <Field label="Employee">
            <Input list="advance-names" value={employee} onChange={(e) => setEmployee(e.target.value)} placeholder="Full name, as on timesheets" maxLength={120} autoFocus data-testid="input-advance-employee" />
            <datalist id="advance-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount"><NumberInput prefix={app.prefs.currencySymbol} value={amount} onChange={setAmount} data-testid="input-advance-amount" /></Field>
            <Field label="Date given"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="input-advance-date" /></Field>
          </div>
          <Field label="Pay back">
            <SegmentedControl label="Repayment" value={mode} onChange={setMode} options={[{ value: "periods", label: "Over a number of periods" }, { value: "per_period", label: "Fixed amount" }]} />
          </Field>
          {mode === "periods"
            ? <Field label="Number of pay periods"><NumberInput step="1" value={periods} onChange={(n) => setPeriods(Math.max(1, Math.min(104, Math.round(n))))} data-testid="input-advance-periods" /></Field>
            : <Field label="Each pay period"><NumberInput prefix={app.prefs.currencySymbol} value={perPeriod} onChange={setPerPeriod} data-testid="input-advance-per-period" /></Field>}
          <Field label="Note (optional)"><Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Rent help" /></Field>
          {each > 0 && <p className="text-xs text-muted-foreground">{app.money(each)} per period, never more than the person earns that period.</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!valid || busy} data-testid="button-advance-save">{busy && <Loader2 className="animate-spin" />}Record advance</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
