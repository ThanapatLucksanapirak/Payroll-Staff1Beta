import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import type { IssueFix, PunchIssue } from "@shared/punchIssues";
import { PUNCH_LABELS } from "@shared/punches";
import { inputToMinutes, instantToLocal, localToInstant, minutesToInput } from "@shared/dates";
import { errorMessage } from "@/lib/api";
import { applyFix } from "@/lib/timeclock";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/workspace/fields";

/** One-tap fix for a punch problem: pick the real time, keep a note, save through the normal punch routes. */
export function IssueFixDialog({ siteId, tz, issue, fix, onClose }: { siteId: string; tz: string; issue: PunchIssue; fix: IssueFix; onClose: () => void }) {
  const { toast } = useToast();
  const start = fix.kind === "delete" ? null : instantToLocal(fix.suggestedAt, tz);
  const [date, setDate] = useState(start?.date ?? "");
  const [time, setTime] = useState(start ? minutesToInput(start.minutes) : "");
  const [note, setNote] = useState(fix.note);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const conflict = !!problem && /doesn't fit|leave a gap/.test(problem);

  const at = () => {
    const m = inputToMinutes(time);
    return m == null || !date ? null : localToInstant(date, m, tz);
  };

  const save = async () => {
    let when: string | null = null;
    if (fix.kind !== "delete") {
      when = at();
      if (!when) { setProblem("Enter a date and time."); return; }
      if (Date.parse(when) > Date.now() + 5 * 60_000) { setProblem("A punch can't be in the future."); return; }
      if (fix.kind === "add" && !conflict) {
        if (Date.parse(when) < Date.parse(fix.minAt)) { setProblem("That's before the punch it follows. Pick a later time."); return; }
        if (fix.maxAt && Date.parse(when) > Date.parse(fix.maxAt)) { setProblem("That's after their next clock-in. Pick an earlier time."); return; }
      }
    }
    setBusy(true); setProblem(null);
    try {
      await applyFix(siteId, issue.employeeId, fix, when, note.trim(), conflict);
      toast({ title: fix.kind === "delete" ? "Punches deleted" : "Fixed", description: `${issue.employeeName} · ${issue.title}` });
      onClose();
    } catch (e) { setProblem(errorMessage(e)); } finally { setBusy(false); }
  };

  const label = fix.kind === "add" ? `${PUNCH_LABELS[fix.type]} time` : fix.kind === "edit" ? `${PUNCH_LABELS[fix.type]} time` : "";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{fix.label}</DialogTitle>
          <DialogDescription className="break-words">{issue.employeeName} · {issue.detail}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {fix.kind !== "delete" && (
            <div className="space-y-1.5">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="input-fix-date" /></Field>
                <Field label={label}><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} autoFocus data-testid="input-fix-time" /></Field>
              </div>
              <p className="text-xs text-muted-foreground">Time at the location ({tz}).</p>
            </div>
          )}
          {fix.kind === "delete" && <p className="text-[13px] text-muted-foreground">Deletes {fix.punchIds.length === 1 ? "this punch" : `these ${fix.punchIds.length} punches`}. The note is kept in the server log.</p>}
          <Field label="Note (required)" hint="Kept with the punch, with the old value.">
            <Textarea rows={2} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} data-testid="input-fix-note" />
          </Field>
          {problem && (
            <div className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] font-medium text-danger" role="alert">
              {problem}
              {conflict && <p className="mt-1 text-xs font-normal text-muted-foreground">You can save anyway; it will show up here again if the punches still don't pair up.</p>}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant={fix.kind === "delete" ? "destructive" : "default"} disabled={busy || !note.trim()} onClick={save} data-testid="button-apply-fix">
            {busy ? <Loader2 className="animate-spin" /> : fix.kind === "delete" ? <Trash2 /> : null}
            {conflict ? "Save anyway" : fix.kind === "delete" ? "Delete" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
