import { Plus, Trash2 } from "lucide-react";
import type { SiteRules } from "@shared/schema";
import { COMMON_TIMEZONES, WEEKDAYS } from "@shared/dates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, NumberInput, TimeInput, ToggleRow } from "@/components/workspace/fields";
import { Disclosure } from "@/components/ui/disclosure";
import { PERIOD_LABELS } from "@/lib/periods";

type Props = { rules: SiteRules; onChange: (r: SiteRules) => void; disabled?: boolean; /** Show location-only fields (time zone, pay period). */ siteLevel?: boolean };

export function RulesEditor({ rules, onChange, disabled, siteLevel }: Props) {
  const set = <K extends keyof SiteRules>(k: K, v: SiteRules[K]) => onChange({ ...rules, [k]: v });
  const overrides = Object.entries(rules.weekdayOverrides ?? {}).sort(([a], [b]) => Number(a) - Number(b));
  const freeDays = WEEKDAYS.map((_, i) => String(i)).filter((d) => !rules.weekdayOverrides?.[d]);

  return (
    <div className="space-y-4">
      <Group title="How days are classified">
        <Field label="Method" className="sm:col-span-2">
          <Select value={rules.classificationMethod} onValueChange={(v) => set("classificationMethod", v as any)} disabled={disabled}>
            <SelectTrigger data-testid="select-classification"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="cutoffs">Clock-in / clock-out cutoffs</SelectItem>
              <SelectItem value="hours">Hours worked</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {rules.classificationMethod === "cutoffs" ? (
          <>
            <Field label="Arrive before" hint="Clocking in before this counts as on time"><TimeInput value={rules.clockInCutoff} onChange={(m) => set("clockInCutoff", m)} disabled={disabled} data-testid="input-rule-in" /></Field>
            <Field label="Stay until" hint="Clocking out at or after this counts as a full shift"><TimeInput value={rules.clockOutCutoff} onChange={(m) => set("clockOutCutoff", m)} disabled={disabled} data-testid="input-rule-out" /></Field>
            <Field label="Grace period (minutes)"><NumberInput step="1" value={rules.graceMinutes} onChange={(n) => set("graceMinutes", Math.min(180, Math.round(n)))} disabled={disabled} /></Field>
            <p className="self-center rounded-lg bg-foreground/[0.03] px-3 py-2 text-xs leading-snug text-muted-foreground sm:col-span-2"><span className="status-full_day mr-1 rounded-full px-1.5 py-px font-semibold">Full</span>on time and stayed late · <span className="status-half_day mx-1 rounded-full px-1.5 py-px font-semibold">Half</span>only one · <span className="status-flagged mx-1 rounded-full px-1.5 py-px font-semibold">Flagged</span>neither</p>
          </>
        ) : (
          <>
            <Field label="Full day at (hours)"><NumberInput step="0.25" value={rules.fullDayMinHours} onChange={(n) => set("fullDayMinHours", Math.min(24, n))} disabled={disabled} /></Field>
            <Field label="Half day at (hours)"><NumberInput step="0.25" value={rules.halfDayMinHours} onChange={(n) => set("halfDayMinHours", Math.min(24, n))} disabled={disabled} /></Field>
          </>
        )}
        <Field label="Pay for flagged days">
          <Select value={rules.flaggedDayPay} onValueChange={(v) => set("flaggedDayPay", v as any)} disabled={disabled}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="none">Nothing (review manually)</SelectItem><SelectItem value="half">Half-day rate</SelectItem><SelectItem value="full">Full-day rate</SelectItem></SelectContent>
          </Select>
        </Field>
        <Field label="Default payment method" hint="Used for anyone without their own method (set per person on the Rates tab)">
          <Select value={rules.defaultPaymentMethod} onValueChange={(v) => set("defaultPaymentMethod", v as any)} disabled={disabled}>
            <SelectTrigger data-testid="select-default-payment"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="cash">Cash</SelectItem><SelectItem value="bank">Bank transfer</SelectItem><SelectItem value="check">Check</SelectItem></SelectContent>
          </Select>
        </Field>
      </Group>

      {rules.classificationMethod === "cutoffs" && (
        <Disclosure title="Different hours on certain days" description={overrides.length ? `${overrides.length} day${overrides.length === 1 ? "" : "s"} with their own cutoffs` : "Every day uses the cutoffs above"} defaultOpen={overrides.length > 0} testid="disclosure-weekday">
        <div className="space-y-2">
          {overrides.length === 0 && <p className="text-xs text-muted-foreground">Every day uses the cutoffs above.</p>}
          {overrides.map(([day, ov]) => (
            <div key={day} className="flex flex-wrap items-end gap-2">
              <div className="w-28 pb-2 text-sm">{WEEKDAYS[Number(day)]}</div>
              <Field label="Arrive before" className="w-32"><TimeInput value={ov.clockInCutoff} disabled={disabled} onChange={(m) => set("weekdayOverrides", { ...rules.weekdayOverrides, [day]: { ...ov, clockInCutoff: m } })} /></Field>
              <Field label="Stay until" className="w-32"><TimeInput value={ov.clockOutCutoff} disabled={disabled} onChange={(m) => set("weekdayOverrides", { ...rules.weekdayOverrides, [day]: { ...ov, clockOutCutoff: m } })} /></Field>
              {!disabled && <Button variant="ghost" size="icon" aria-label="Remove override" onClick={() => { const n = { ...rules.weekdayOverrides }; delete n[day]; set("weekdayOverrides", n); }}><Trash2 className="h-4 w-4" /></Button>}
            </div>
          ))}
          {!disabled && freeDays.length > 0 && (
            <Select value="" onValueChange={(d) => set("weekdayOverrides", { ...rules.weekdayOverrides, [d]: { clockInCutoff: rules.clockInCutoff, clockOutCutoff: rules.clockOutCutoff } })}>
              <SelectTrigger className="w-48 h-8" data-testid="select-add-override"><span className="flex items-center gap-1 text-sm"><Plus className="h-3.5 w-3.5" /> Add a day</span></SelectTrigger>
              <SelectContent>{freeDays.map((d) => <SelectItem key={d} value={d}>{WEEKDAYS[Number(d)]}</SelectItem>)}</SelectContent>
            </Select>
          )}
        </div>
        </Disclosure>
      )}

      <Disclosure title="Advanced: punches & rounding" description="Split shifts, breaks, short punches, rounding, long-shift warnings" testid="disclosure-punches">
      <Group>
        <Toggle label="Combine split shifts on the same day" hint="Two punches on one day count as one day, not two" checked={rules.mergeSameDayShifts} onChange={(v) => set("mergeSameDayShifts", v)} disabled={disabled} />
        <Toggle label="Subtract unpaid breaks" checked={rules.deductUnpaidBreaks} onChange={(v) => set("deductUnpaidBreaks", v)} disabled={disabled} />
        <Field label="Ignore punches shorter than (minutes)"><NumberInput step="1" value={rules.minShiftMinutes} onChange={(n) => set("minShiftMinutes", Math.min(720, Math.round(n)))} disabled={disabled} /></Field>
        <Field label="Round worked time to (minutes)" hint="0 = exact"><NumberInput step="1" value={rules.roundingMinutes} onChange={(n) => set("roundingMinutes", Math.min(60, Math.round(n)))} disabled={disabled} /></Field>
        <Field label="Warn about shifts longer than (hours)"><NumberInput step="1" value={rules.longShiftWarningHours} onChange={(n) => set("longShiftWarningHours", Math.min(48, n))} disabled={disabled} /></Field>
        <Toggle label="New employees are paid net" checked={rules.defaultNetPay} onChange={(v) => set("defaultNetPay", v)} disabled={disabled} />
      </Group>
      </Disclosure>

      <Disclosure title="Overtime (hourly employees)" description={rules.overtimeEnabled ? `On · after ${rules.overtimeWeeklyHours} h/week at ${rules.overtimeMultiplier}×` : "Off"} defaultOpen={rules.overtimeEnabled} testid="disclosure-overtime">
      <Group>
        <Toggle label="Pay overtime" checked={rules.overtimeEnabled} onChange={(v) => set("overtimeEnabled", v)} disabled={disabled} className="sm:col-span-2" />
        {rules.overtimeEnabled && (
          <>
            <Field label="After hours per week"><NumberInput step="1" value={rules.overtimeWeeklyHours} onChange={(n) => set("overtimeWeeklyHours", Math.min(168, n))} disabled={disabled} /></Field>
            <Field label="After hours per day" hint="0 = no daily limit"><NumberInput step="0.5" value={rules.overtimeDailyHours} onChange={(n) => set("overtimeDailyHours", Math.min(24, n))} disabled={disabled} /></Field>
            <Field label="Multiplier"><NumberInput step="0.05" min={1} value={rules.overtimeMultiplier} onChange={(n) => set("overtimeMultiplier", Math.min(4, Math.max(1, n)))} disabled={disabled} /></Field>
          </>
        )}
        <Field label="Week starts on">
          <Select value={String(rules.weekStartsOn)} onValueChange={(v) => set("weekStartsOn", Number(v))} disabled={disabled}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{WEEKDAYS.map((d, i) => <SelectItem key={d} value={String(i)}>{d}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
      </Group>
      </Disclosure>

      {siteLevel && (
        <Group title="Calendar">
          <Field label="Time zone">
            <Select value={rules.timezone} onValueChange={(v) => set("timezone", v)} disabled={disabled}>
              <SelectTrigger data-testid="select-timezone"><SelectValue /></SelectTrigger>
              <SelectContent>{(COMMON_TIMEZONES.includes(rules.timezone as any) ? COMMON_TIMEZONES : [rules.timezone, ...COMMON_TIMEZONES]).map((z) => <SelectItem key={z} value={z}>{z.replace(/_/g, " ")}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Pay period">
            <Select value={rules.payPeriod} onValueChange={(v) => set("payPeriod", v as any)} disabled={disabled}>
              <SelectTrigger data-testid="select-pay-period"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(PERIOD_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {(rules.payPeriod === "weekly" || rules.payPeriod === "biweekly") && (
            <Field label="A period start date" hint="Used to line up weeks for quick date ranges"><Input type="date" value={rules.payPeriodAnchor} onChange={(e) => set("payPeriodAnchor", e.target.value)} disabled={disabled} /></Field>
          )}
        </Group>
      )}
    </div>
  );
}

function Group({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      {title && <p className="text-[13px] font-semibold">{title}</p>}
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </div>
  );
}

function Toggle({ label, hint, checked, onChange, disabled, className }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; className?: string }) {
  return <ToggleRow label={label} hint={hint} checked={checked} onChange={onChange} disabled={disabled} className={className} />;
}
