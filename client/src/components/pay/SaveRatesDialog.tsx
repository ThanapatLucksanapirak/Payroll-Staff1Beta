import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import type { EmployeeConfig } from "@shared/schema";
import { api, errorMessage } from "@/lib/api";
import { requestPayResync } from "@/lib/pay";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, ToggleRow } from "@/components/workspace/fields";

/**
 * Save this timesheet's rates as the location's defaults, effective from a date.
 * Earlier days keep the old saved rate, so older periods recalculate the same.
 */
export function SaveRatesDialog({ open, onOpenChange, siteId, siteName, rows, defaultDate }: {
  open: boolean; onOpenChange: (o: boolean) => void; siteId: string; siteName: string; rows: EmployeeConfig[]; defaultDate: string;
}) {
  const { toast } = useToast();
  const [date, setDate] = useState(defaultDate);
  const [always, setAlways] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setDate(defaultDate); setAlways(false); } }, [open, defaultDate]);
  const valid = always || /^\d{4}-\d{2}-\d{2}$/.test(date);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ saved: number; changed: number }>("PUT", `/api/sites/${siteId}/pay/rates`, { effectiveFrom: always ? "" : date, entries: rows });
      toast({ title: "Default rates saved", description: `${r.saved} employees stored for ${siteName}.${r.changed ? ` ${r.changed} rate change${r.changed === 1 ? "" : "s"} recorded from ${date}.` : ""}` });
      requestPayResync();
      onOpenChange(false);
    } catch (e) {
      toast({ title: "Couldn't save rates", description: errorMessage(e), variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Save rates as defaults for {siteName}?</DialogTitle>
          <DialogDescription>Future timesheets here start with these rates. Employees not in this timesheet keep their saved rates.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Effective from" hint="Days before this date keep the old saved rate, so earlier periods still add up the same.">
            <Input type="date" value={date} disabled={always} onChange={(e) => setDate(e.target.value)} data-testid="input-rates-effective" />
          </Field>
          <ToggleRow label="Fix a mistake instead" hint="Replace the saved rates without keeping the old ones." checked={always} onChange={setAlways} testid="switch-rates-always" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={!valid || busy} data-testid="button-rates-confirm">{busy ? <Loader2 className="animate-spin" /> : <Save />}Save defaults</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
