import { useState } from "react";
import { Loader2, LockOpen } from "lucide-react";
import { api, errorMessage, queryClient } from "@/lib/api";
import { invalidatePay } from "@/lib/pay";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/workspace/fields";

/** Owners reopen a finalized timesheet with a reason (kept in the activity log). */
export function ReopenDialog({ timesheet, onClose, onReopened }: {
  timesheet: { id: string; siteId: string | null; title: string } | null;
  onClose: () => void;
  onReopened?: () => void;
}) {
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = reason.trim().length >= 3;

  const submit = async () => {
    if (!timesheet || !ok) return;
    setBusy(true);
    try {
      await api("POST", `/api/timesheets/${timesheet.id}/reopen`, { reason: reason.trim() });
      void queryClient.invalidateQueries({ queryKey: ["/api/timesheets"] });
      if (timesheet.siteId) invalidatePay(timesheet.siteId);
      toast({ title: "Timesheet reopened", description: "Any advance repayments it took were put back." });
      setReason("");
      onClose();
      onReopened?.();
    } catch (e) {
      toast({ title: "Couldn't reopen", description: errorMessage(e), variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={!!timesheet} onOpenChange={(o) => { if (!o) { onClose(); setReason(""); } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reopen “{timesheet?.title}”?</DialogTitle>
          <DialogDescription>It goes back to a draft so it can be edited. Advance repayments it took are reversed until it is finalized again.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <Field label="Reason" hint="Saved in the activity log.">
            <Textarea rows={3} value={reason} maxLength={300} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="e.g. Ana's Tuesday hours were wrong" data-testid="input-reopen-reason" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!ok || busy} data-testid="button-reopen-confirm">{busy ? <Loader2 className="animate-spin" /> : <LockOpen />}Reopen</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
