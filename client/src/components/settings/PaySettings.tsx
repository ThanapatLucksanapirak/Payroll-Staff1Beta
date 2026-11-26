import { useEffect, useMemo, useState } from "react";
import { Ban, HandCoins, Loader2, Plus, Trash2, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { EmployeeConfig } from "@shared/schema";
import { todayISO } from "@shared/dates";
import { type Accounts, type Holiday, type PaySettings as PaySettingsT, type RecurringItem, DEFAULT_DENOMINATIONS, JOURNAL_DATE_STYLES, installmentOf } from "@shared/payExtras";
import { useApp } from "@/context/AppData";
import { api, errorMessage } from "@/lib/api";
import { uid } from "@/lib/doc";
import { denomLabel, invalidatePay, savePaySettings, useAdvances, usePaySettings } from "@/lib/pay";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { SiteDot } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, NumberInput, Section, ToggleRow } from "@/components/workspace/fields";
import { AdvanceDialog } from "@/components/pay/AdvanceDialog";

const PRESETS: { label: string; values: number[] }[] = [
  { label: "US dollar", values: DEFAULT_DENOMINATIONS },
  { label: "Euro", values: [500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01] },
  { label: "Pound", values: [50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01] },
  { label: "Notes only (US)", values: [100, 50, 20, 10, 5, 1] },
];

/** Settings → Pay extras, for the current location. */
export function PaySettings() {
  const app = useApp();
  const site = app.site;
  const pay = usePaySettings(site.id);
  if (pay.isLoading) return <div className="space-y-4"><Skeleton className="h-40 rounded-xl" /><Skeleton className="h-40 rounded-xl" /></div>;
  return (
    <div className="space-y-5" key={site.id}>
      <p className="flex items-start gap-2 px-1 text-[13px] text-muted-foreground"><SiteDot color={site.color} className="mt-[5px]" /><span className="min-w-0">Settings for <b className="font-medium text-foreground [overflow-wrap:anywhere]">{site.name}</b>. Switch location in the sidebar to change another.</span></p>
      <CashSection siteId={site.id} settings={pay.settings} />
      <HolidaysSection siteId={site.id} settings={pay.settings} />
      <RecurringSection siteId={site.id} settings={pay.settings} />
      <AdvancesSection siteId={site.id} />
      <TipPointsSection siteId={site.id} settings={pay.settings} />
      <AccountsSection siteId={site.id} settings={pay.settings} />
    </div>
  );
}

function useSaver(siteId: string) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const save = async (patch: Partial<PaySettingsT>, what: string) => {
    setBusy(true);
    try { await savePaySettings(siteId, patch); toast({ title: `${what} saved` }); return true; } catch (e) {
      toast({ title: `Couldn't save ${what.toLowerCase()}`, description: errorMessage(e), variant: "destructive" }); return false;
    } finally { setBusy(false); }
  };
  return { busy, save };
}

function SaveBar({ dirty, busy, onSave, onReset, testid }: { dirty: boolean; busy: boolean; onSave: () => void; onReset: () => void; testid: string }) {
  if (!dirty) return null;
  return (
    <div className="mt-4 flex justify-end gap-2 border-t border-border/70 pt-3">
      <Button variant="ghost" size="sm" onClick={onReset}>Discard</Button>
      <Button size="sm" onClick={onSave} disabled={busy} data-testid={`button-save-${testid}`}>{busy && <Loader2 className="animate-spin" />}Save</Button>
    </div>
  );
}

function useDraft<T>(value: T) {
  const [draft, setDraft] = useState<T>(value);
  useEffect(() => setDraft(value), [JSON.stringify(value)]); // eslint-disable-line react-hooks/exhaustive-deps
  return { draft, setDraft, dirty: JSON.stringify(draft) !== JSON.stringify(value), reset: () => setDraft(value) };
}

// ── Cash ─────────────────────────────────────────────────────────────────────
function CashSection({ siteId, settings }: { siteId: string; settings: PaySettingsT }) {
  const app = useApp();
  const { draft, setDraft, dirty, reset } = useDraft(settings.cash);
  const { busy, save } = useSaver(siteId);
  const [add, setAdd] = useState(0);
  const sym = app.prefs.currencySymbol;
  const set = (denominations: number[]) => setDraft({ ...draft, denominations: [...new Set(denominations.map((d) => Math.round(d * 100) / 100))].filter((d) => d > 0).sort((a, b) => b - a) });
  return (
    <Section title="Cash pay-outs" description="The bills and coins you pull from the bank. The pay-out sheet and the Tips & extras tab show how many of each to get, per person and in total.">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2" data-testid="list-denominations">
          {draft.denominations.map((d) => (
            <span key={d} className="inline-flex items-center gap-1 rounded-full border border-border/80 py-1 pl-3 pr-1 text-[13px] tabular">
              {denomLabel(d, sym)}
              <button className="rounded-full p-0.5 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground" aria-label={`Remove ${denomLabel(d, sym)}`} onClick={() => draft.denominations.length > 1 && set(draft.denominations.filter((x) => x !== d))}><X className="h-3.5 w-3.5" /></button>
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Add a bill or coin"><NumberInput className="w-28" prefix={sym} value={add} onChange={setAdd} data-testid="input-add-denomination" /></Field>
          <Button variant="outline" disabled={!(add > 0)} onClick={() => { set([...draft.denominations, add]); setAdd(0); }}><Plus />Add</Button>
          <Select onValueChange={(v) => set(PRESETS[Number(v)].values)}>
            <SelectTrigger className="w-44" aria-label="Use a currency set"><SelectValue placeholder="Use a currency set" /></SelectTrigger>
            <SelectContent>{PRESETS.map((p, i) => <SelectItem key={p.label} value={String(i)}>{p.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <ToggleRow label="Round cash to whole amounts" hint="Each cash hand-out is rounded to the nearest whole unit on the pay-out sheet. Totals in the timesheet are not changed." checked={draft.roundCash} onChange={(roundCash) => setDraft({ ...draft, roundCash })} testid="switch-round-cash" />
      </div>
      <SaveBar dirty={dirty} busy={busy} onReset={reset} onSave={() => save({ cash: draft }, "Cash settings")} testid="cash" />
    </Section>
  );
}

// ── Holidays ─────────────────────────────────────────────────────────────────
function HolidaysSection({ siteId, settings }: { siteId: string; settings: PaySettingsT }) {
  const app = useApp();
  const { draft, setDraft, dirty, reset } = useDraft(settings.holidays);
  const { busy, save } = useSaver(siteId);
  const tz = app.sites.find((s) => s.id === siteId)?.rules.timezone;
  const set = (i: number, patch: Partial<Holiday>) => setDraft(draft.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  const sorted = [...draft].sort((a, b) => a.date.localeCompare(b.date));
  const dupes = new Set(draft.map((h) => h.date).filter((d, i, a) => a.indexOf(d) !== i));
  return (
    <Section
      title="Holidays"
      description="People who work on a holiday get a premium: their day's pay times a multiplier, or a flat amount on top. It shows on pay statements."
      actions={<Button variant="outline" size="sm" onClick={() => setDraft([...draft, { id: uid("hol"), date: todayISO(tz), name: "", kind: "multiplier", multiplier: 1.5, flatBonus: 0 }])} data-testid="button-add-holiday"><Plus />Add holiday</Button>}
    >
      {draft.length === 0 ? <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">No holidays yet. Add one to pay a premium to people who work that day.</p> : (
        <div className="-mx-5 overflow-x-auto px-5">
          <table className="w-full min-w-[38rem] text-sm">
            <thead><tr className="text-left text-xs text-muted-foreground"><th className="pb-2 font-medium">Date</th><th className="pb-2 font-medium">Name</th><th className="pb-2 font-medium">Premium</th><th className="pb-2 font-medium">Amount</th><th /></tr></thead>
            <tbody>
              {sorted.map((h) => {
                const i = draft.indexOf(h);
                return (
                  <tr key={h.id} className="border-t border-border/60">
                    <td className="w-40 py-2 pr-2"><Input type="date" className={dupes.has(h.date) ? "h-8 border-destructive" : "h-8"} value={h.date} onChange={(e) => set(i, { date: e.target.value })} data-testid={`input-holiday-date-${i}`} /></td>
                    <td className="py-2 pr-2"><Input className="h-8" value={h.name} maxLength={80} placeholder="e.g. Thanksgiving" onChange={(e) => set(i, { name: e.target.value })} data-testid={`input-holiday-name-${i}`} /></td>
                    <td className="w-40 py-2 pr-2">
                      <Select value={h.kind} onValueChange={(v) => set(i, { kind: v as Holiday["kind"] })}>
                        <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="multiplier">Pay multiplier</SelectItem><SelectItem value="flat">Flat bonus</SelectItem></SelectContent>
                      </Select>
                    </td>
                    <td className="w-32 py-2 pr-2">
                      {h.kind === "multiplier"
                        ? <NumberInput className="h-8" step="0.25" min={1} value={h.multiplier} onChange={(n) => set(i, { multiplier: Math.min(5, Math.max(1, n)) })} aria-label="Multiplier" />
                        : <NumberInput className="h-8" prefix={app.prefs.currencySymbol} value={h.flatBonus} onChange={(n) => set(i, { flatBonus: n })} aria-label="Flat bonus" />}
                    </td>
                    <td className="w-10 py-2 text-right"><Button variant="ghost" size="icon-sm" aria-label="Remove holiday" onClick={() => setDraft(draft.filter((_, j) => j !== i))}><Trash2 /></Button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {dupes.size > 0 && <p className="mt-2 text-xs font-medium text-destructive">Two holidays on the same day. Keep one per day.</p>}
        </div>
      )}
      <SaveBar dirty={dirty} busy={busy || dupes.size > 0} onReset={reset} onSave={() => save({ holidays: draft.filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.date)).map((h) => ({ ...h, name: h.name.trim() || "Holiday" })) }, "Holidays")} testid="holidays" />
    </Section>
  );
}

// ── Standing bonuses / deductions ───────────────────────────────────────────
function useWageNames(siteId: string) {
  const q = useQuery<EmployeeConfig[]>({ queryKey: ["/api/sites", siteId, "wages"] });
  return useMemo(() => (q.data ?? []).map((e) => e.name).sort((a, b) => a.localeCompare(b)), [q.data]);
}

function RecurringSection({ siteId, settings }: { siteId: string; settings: PaySettingsT }) {
  const app = useApp();
  const { draft, setDraft, dirty, reset } = useDraft(settings.recurring);
  const { busy, save } = useSaver(siteId);
  const names = useWageNames(siteId);
  const set = (i: number, patch: Partial<RecurringItem>) => setDraft(draft.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const invalid = draft.some((r) => !r.employee.trim() || !(r.amount > 0));
  return (
    <Section
      title="Standing bonuses and deductions"
      description="Added to every new timesheet for that person here, for example a uniform fee of −$10 a period or an attendance bonus of +$50. Each timesheet can remove one."
      actions={<Button variant="outline" size="sm" onClick={() => setDraft([...draft, { id: uid("rec"), employee: "", kind: "deduction", description: "", amount: 0, active: true }])} data-testid="button-add-recurring"><Plus />Add item</Button>}
    >
      <datalist id="pay-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
      {draft.length === 0 ? <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">No standing items yet. Add a bonus or deduction that repeats every pay period.</p> : (
        <div className="-mx-5 overflow-x-auto px-5">
          <table className="w-full min-w-[44rem] text-sm">
            <thead><tr className="text-left text-xs text-muted-foreground"><th className="pb-2 font-medium">Employee</th><th className="pb-2 font-medium">Type</th><th className="pb-2 font-medium">Description</th><th className="pb-2 font-medium">Each period</th><th className="pb-2 text-center font-medium">On</th><th /></tr></thead>
            <tbody>
              {draft.map((r, i) => (
                <tr key={r.id} className="border-t border-border/60">
                  <td className="py-2 pr-2"><Input list="pay-names" className="h-8" value={r.employee} maxLength={120} placeholder="Name as on timesheets" onChange={(e) => set(i, { employee: e.target.value })} data-testid={`input-recurring-employee-${i}`} /></td>
                  <td className="w-36 py-2 pr-2">
                    <Select value={r.kind} onValueChange={(v) => set(i, { kind: v as RecurringItem["kind"] })}>
                      <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="bonus">Bonus (+)</SelectItem><SelectItem value="deduction">Deduction (−)</SelectItem></SelectContent>
                    </Select>
                  </td>
                  <td className="py-2 pr-2"><Input className="h-8" value={r.description} maxLength={120} placeholder={r.kind === "bonus" ? "e.g. Attendance bonus" : "e.g. Uniform"} onChange={(e) => set(i, { description: e.target.value })} data-testid={`input-recurring-desc-${i}`} /></td>
                  <td className="w-28 py-2 pr-2"><NumberInput className="h-8" prefix={app.prefs.currencySymbol} value={r.amount} onChange={(n) => set(i, { amount: n })} data-testid={`input-recurring-amount-${i}`} /></td>
                  <td className="py-2 text-center"><Switch checked={r.active} onCheckedChange={(active) => set(i, { active })} aria-label="Active" /></td>
                  <td className="w-10 py-2 text-right"><Button variant="ghost" size="icon-sm" aria-label="Remove item" onClick={() => setDraft(draft.filter((_, j) => j !== i))}><Trash2 /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {invalid && <p className="mt-2 text-xs text-muted-foreground">Each item needs a name and an amount.</p>}
        </div>
      )}
      <SaveBar dirty={dirty} busy={busy || invalid} onReset={reset} onSave={() => save({ recurring: draft.map((r) => ({ ...r, employee: r.employee.trim().replace(/\s+/g, " "), description: r.description.trim() })) }, "Standing items")} testid="recurring" />
    </Section>
  );
}

// ── Advances ────────────────────────────────────────────────────────────────
function AdvancesSection({ siteId }: { siteId: string }) {
  const app = useApp();
  const { toast } = useToast();
  const confirm = useConfirm();
  const q = useAdvances(siteId);
  const names = useWageNames(siteId);
  const [adding, setAdding] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const list = (q.data ?? []).slice().sort((a, b) => b.date.localeCompare(a.date));
  const open = list.filter((a) => a.remaining > 0);
  const done = list.filter((a) => a.remaining <= 0);
  const outstanding = open.reduce((s, a) => s + a.remaining, 0);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); invalidatePay(siteId); toast({ title: ok }); } catch (e) { toast({ title: "Couldn't update the advance", description: errorMessage(e), variant: "destructive" }); }
  };
  const row = (a: (typeof list)[number]) => (
    <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3" data-testid={`row-advance-${a.id}`}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-medium">{a.employee} <span className="font-normal text-muted-foreground">· {app.money(a.amount)} on {app.date(a.date)}</span></p>
        <p className="truncate text-xs text-muted-foreground">
          {a.cancelledAt ? "Written off" : a.remaining > 0 ? `${app.money(installmentOf(a))} a period` : "Repaid"} · repaid {app.money(a.repaid)}{a.note ? ` · ${a.note}` : ""}{a.createdBy ? ` · by ${a.createdBy}` : ""}
        </p>
      </div>
      {a.remaining > 0 ? <Badge variant="warning">{app.money(a.remaining)} left</Badge> : <Badge variant="secondary">{a.cancelledAt ? "Written off" : "Paid back"}</Badge>}
      {a.remaining > 0 && (
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={async () => {
          if (await confirm({ title: `Write off ${a.employee}'s advance?`, description: `${app.money(a.remaining)} will no longer be taken from pay. Repayments already taken stay recorded.`, confirmLabel: "Write off" })) {
            await act(() => api("PATCH", `/api/sites/${siteId}/pay/advances/${a.id}`, { cancelled: true }), "Advance written off");
          }
        }}><Ban className="h-3.5 w-3.5" />Write off</Button>
      )}
      {a.repayments.length === 0 && (
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label="Delete advance" onClick={async () => {
          if (await confirm({ title: "Delete this advance?", description: "Use this for an advance recorded by mistake. Nothing has been repaid yet.", confirmLabel: "Delete", destructive: true })) {
            await act(() => api("DELETE", `/api/sites/${siteId}/pay/advances/${a.id}`), "Advance deleted");
          }
        }}><Trash2 /></Button>
      )}
    </li>
  );

  return (
    <Section
      title="Advances and loans"
      description="Money paid ahead of payday. It comes off the person's next timesheets here until repaid (never more than they earn). Repayments are recorded when a timesheet is finalized and put back if it is reopened."
      actions={<Button variant="outline" size="sm" onClick={() => setAdding(true)} data-testid="button-settings-add-advance"><HandCoins />Record advance</Button>}
    >
      {q.isLoading ? <Skeleton className="h-16 rounded-xl" /> : list.length === 0 ? <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">No advances recorded. Use Record advance when someone is paid ahead of payday.</p> : (
        <div className="space-y-3">
          {open.length > 0 && <p className="text-[13px]"><b className="font-semibold">{app.money(outstanding)}</b> <span className="text-muted-foreground">still owed by {open.length} {open.length === 1 ? "person" : "people"}</span></p>}
          {open.length > 0 && <ul className="divide-y divide-border/70 rounded-xl border border-border/80" data-testid="list-advances">{open.map(row)}</ul>}
          {done.length > 0 && (
            <>
              <button className="rounded-sm text-[13px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35" onClick={() => setShowDone(!showDone)}>{showDone ? "Hide" : "Show"} repaid and written off ({done.length})</button>
              {showDone && <ul className="divide-y divide-border/70 rounded-xl border border-border/80">{done.map(row)}</ul>}
            </>
          )}
        </div>
      )}
      <AdvanceDialog open={adding} onOpenChange={setAdding} siteId={siteId} names={names} />
    </Section>
  );
}

// ── Tip points ──────────────────────────────────────────────────────────────
function TipPointsSection({ siteId, settings }: { siteId: string; settings: PaySettingsT }) {
  const app = useApp();
  const { draft, setDraft, dirty, reset } = useDraft(settings.tipPoints);
  const { busy, save } = useSaver(siteId);
  const cats = [{ id: "custom", name: "No category" }, ...app.categoriesFor(siteId).map((c) => ({ id: c.id, name: c.name }))];
  return (
    <Section title="Tip points" description="When tips are shared by points, each person's share is hours × the points of their pay category. These are the starting points for new timesheets (1 if not set).">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cats.map((c) => <Field key={c.id} label={c.name}><NumberInput step="0.5" value={draft[c.id] ?? 1} onChange={(n) => setDraft({ ...draft, [c.id]: Math.min(100, n) })} /></Field>)}
      </div>
      <SaveBar dirty={dirty} busy={busy} onReset={reset} onSave={() => save({ tipPoints: draft }, "Tip points")} testid="tip-points" />
    </Section>
  );
}

// ── Accounting ──────────────────────────────────────────────────────────────
const ACCOUNT_FIELDS: { key: keyof Accounts; label: string; hint: string }[] = [
  { key: "wages", label: "Wages expense", hint: "Debit: base pay, bonuses, premiums" },
  { key: "tips", label: "Tips", hint: "Debit: tips paid out of the pool" },
  { key: "deductions", label: "Deductions", hint: "Credit: deductions kept back" },
  { key: "advances", label: "Employee advances", hint: "Credit: advance repayments" },
  { key: "cash", label: "Cash", hint: "Credit: paid in cash" },
  { key: "bank", label: "Bank", hint: "Credit: paid by transfer" },
  { key: "check", label: "Checks", hint: "Credit: paid by check" },
  { key: "clearing", label: "Clearing", hint: "Anything left over (e.g. money owed back)" },
];

function AccountsSection({ siteId, settings }: { siteId: string; settings: PaySettingsT }) {
  const { draft, setDraft, dirty, reset } = useDraft(settings.accounts);
  const { busy, save } = useSaver(siteId);
  return (
    <Section title="Accounting export" description="Account names for the journal CSV (Export → Accounting journal), laid out for QuickBooks and Xero journal imports. Use the names exactly as they appear in your chart of accounts.">
      <div className="grid gap-3 sm:grid-cols-2">
        {ACCOUNT_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}><Input value={String(draft[f.key])} maxLength={120} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} data-testid={`input-account-${f.key}`} /></Field>
        ))}
        <Field label="Journal number prefix" hint="Followed by the period end date, e.g. PR20261130."><Input value={draft.journalPrefix} maxLength={20} onChange={(e) => setDraft({ ...draft, journalPrefix: e.target.value })} /></Field>
        <Field label="Date format">
          <Select value={draft.dateStyle} onValueChange={(v) => setDraft({ ...draft, dateStyle: v as Accounts["dateStyle"] })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{JOURNAL_DATE_STYLES.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
      </div>
      <SaveBar dirty={dirty} busy={busy || ACCOUNT_FIELDS.some((f) => !String(draft[f.key]).trim())} onReset={reset} onSave={() => save({ accounts: draft }, "Accounts")} testid="accounts" />
    </Section>
  );
}
