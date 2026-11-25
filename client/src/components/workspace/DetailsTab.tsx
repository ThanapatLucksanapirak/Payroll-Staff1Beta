import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { useApp } from "@/context/AppData";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RulesEditor } from "@/components/settings/RulesEditor";
import { Field, Section } from "./fields";
import type { WsProps } from "./types";

export function DetailsTab(p: WsProps) {
  const app = useApp();
  const confirm = useConfirm();
  const { doc, edit, locked, site } = p;
  const [showRules, setShowRules] = useState(false);
  const differs = JSON.stringify(doc.rules) !== JSON.stringify(site.rules);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
      <Section title="Timesheet">
        <div className="space-y-4">
          <Field label="Name"><Input value={doc.label} placeholder={doc.filename || "Untitled"} maxLength={120} disabled={locked} onChange={(e) => edit((d) => ({ ...d, label: e.target.value }), "label")} data-testid="input-details-label" /></Field>
          <Field label="Location" hint="Moving a timesheet does not change its rules unless you reapply them below.">
            <Select value={doc.siteId} onValueChange={(v) => edit((d) => ({ ...d, siteId: v }))} disabled={locked}>
              <SelectTrigger data-testid="select-details-site"><SelectValue /></SelectTrigger>
              <SelectContent>{app.sites.filter((s) => !s.archived || s.id === doc.siteId).map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Status">
            <Select value={doc.status} onValueChange={(v) => edit((d) => ({ ...d, status: v as any }))}>
              <SelectTrigger data-testid="select-details-status"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="draft">Draft — still editing</SelectItem><SelectItem value="final">Final — locked</SelectItem></SelectContent>
            </Select>
          </Field>
          <Field label="Notes"><Textarea rows={4} value={doc.notes} disabled={locked} onChange={(e) => edit((d) => ({ ...d, notes: e.target.value }), "notes")} placeholder="Anything to remember about this pay period" data-testid="input-details-notes" /></Field>
          <div className="text-xs text-muted-foreground space-y-0.5">
            <p>Source: {({ csv: "CSV file", square: "Square", pdf: "Schedule PDF", manual: "Manual", toast: "Toast", sling: "Sling" } as Record<string, string>)[doc.source] ?? doc.source}{doc.filename ? ` · ${doc.filename}` : ""}</p>
            <p>{doc.shifts.length} shifts · {doc.employees.length} employees · {doc.manualEmployees.length} manual</p>
          </div>
        </div>
      </Section>

      <Section
        title="Pay rules for this timesheet"
        description={differs ? `These differ from the current rules for ${site.name}.` : `Same as the current rules for ${site.name}.`}
        actions={
          <>
            {differs && !locked && (
              <Button variant="outline" size="sm" data-testid="button-reapply-rules" onClick={async () => {
                if (await confirm({ title: `Use the current rules for ${site.name}?`, description: "Day types and pay will be recalculated. Manual overrides are kept.", confirmLabel: "Apply rules" })) edit((d) => ({ ...d, rules: site.rules }));
              }}><RotateCcw /> Use location rules</Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setShowRules(!showRules)} data-testid="button-toggle-rules">{showRules ? "Hide" : "Adjust"}</Button>
          </>
        }
      >
        {showRules ? (
          <RulesEditor rules={doc.rules} disabled={locked} onChange={(r) => edit((d) => ({ ...d, rules: r }), "rules")} />
        ) : (
          <ul className="text-sm space-y-1 text-muted-foreground">
            {doc.rules.classificationMethod === "cutoffs"
              ? <li>Full day: in before {app.time(doc.rules.clockInCutoff)} and out at or after {app.time(doc.rules.clockOutCutoff)}{doc.rules.graceMinutes ? ` (±${doc.rules.graceMinutes} min grace)` : ""}</li>
              : <li>Full day at {doc.rules.fullDayMinHours} h, half day at {doc.rules.halfDayMinHours} h</li>}
            {Object.keys(doc.rules.weekdayOverrides).length > 0 && <li>{Object.keys(doc.rules.weekdayOverrides).length} weekday override(s)</li>}
            <li>Split shifts {doc.rules.mergeSameDayShifts ? "combined into one day" : "counted separately"}</li>
            <li>Flagged days pay {doc.rules.flaggedDayPay === "none" ? "nothing" : `the ${doc.rules.flaggedDayPay}-day rate`}</li>
            {doc.rules.overtimeEnabled && <li>Overtime after {doc.rules.overtimeWeeklyHours} h/week at {doc.rules.overtimeMultiplier}×</li>}
            {doc.rules.roundingMinutes > 0 && <li>Time rounded to {doc.rules.roundingMinutes} min</li>}
          </ul>
        )}
      </Section>
    </div>
  );
}
