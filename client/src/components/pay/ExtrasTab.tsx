import { useMemo, useState } from "react";
import { CalendarHeart, HandCoins, RotateCcw, Trash2 } from "lucide-react";
import { employeeKey, shiftEmployeeNames } from "@shared/engine";
import { type PaySettings, type Tips, linesOf, setTips, skipRecurring, tipsTotal, unskipRecurring } from "@shared/payExtras";
import { useApp } from "@/context/AppData";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SegmentedControl } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, NumberInput, Section } from "@/components/workspace/fields";
import type { WsProps } from "@/components/workspace/types";
import { AdvanceDialog } from "./AdvanceDialog";
import { CashPanel } from "./CashPanel";

const NO_TIPS: Tips = { mode: "total", total: 0, perDay: {}, split: "hours", points: {} };

/** Workspace tab: tips, standing items, advance repayments, holidays and the cash to pull. */
export function ExtrasTab(p: WsProps & { pay: PaySettings; editable: boolean; resync: () => void }) {
  return (
    <div className="space-y-4">
      <TipsSection {...p} />
      <div className="grid gap-4 lg:grid-cols-2">
        <StandingSection {...p} />
        <HolidaySection {...p} />
      </div>
      <CashPanel result={p.result} cash={p.pay.cash} />
    </div>
  );
}

function TipsSection({ doc, result, locked, edit, pay, site }: WsProps & { pay: PaySettings }) {
  const app = useApp();
  const tips = doc.payExtras?.tips ?? null;
  const t = tips ?? { ...NO_TIPS, points: pay.tipPoints };
  const set = (patch: Partial<Tips>) => edit((d) => setTips(d, { ...t, ...patch }), "tips");
  const dates = useMemo(() => [...new Set(result.employees.filter((e) => !e.isManual && !e.excluded).flatMap((e) => e.days.filter((d) => d.punches > 0 && !d.cancelled).map((d) => d.date)))].sort(), [result]);
  const cats = useMemo(() => {
    const active = new Set(shiftEmployeeNames(doc.shifts).map(employeeKey));
    const ids = new Set(doc.employees.filter((e) => active.has(employeeKey(e.name)) && !e.excluded).map((e) => e.categoryId || "custom"));
    return [...ids].map((id) => ({ id, name: id === "custom" ? "No category" : app.categoriesFor(site.id).find((c) => c.id === id)?.name ?? "No category" }));
  }, [doc, app, site.id]);
  const shares = result.employees.filter((e) => (e.extras?.tips ?? 0) > 0);
  const total = tipsTotal(tips);

  return (
    <Section
      title="Tips"
      description="Pooled tips are shared by hours worked (or hours × points per category) and added to take-home pay as their own line."
      actions={!locked && tips && <Button variant="ghost" size="sm" onClick={() => edit((d) => setTips(d, null))} data-testid="button-clear-tips"><Trash2 />Clear tips</Button>}
    >
      {locked && !tips ? <p className="text-[13px] text-muted-foreground">No tips were entered for this period.</p> : (
        <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Enter">
                {locked ? <p className="text-[13px]">{t.mode === "total" ? "One total" : "By day"}</p> : (
                  <SegmentedControl label="Tips entry" value={t.mode} onChange={(mode) => set({ mode })} options={[{ value: "total", label: "One total", testid: "tips-mode-total" }, { value: "per_day", label: "By day", testid: "tips-mode-day" }]} />
                )}
              </Field>
              <Field label="Share by">
                <Select value={t.split} onValueChange={(v) => set({ split: v as Tips["split"] })} disabled={locked}>
                  <SelectTrigger className="w-44" data-testid="select-tips-split"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="hours">Hours worked</SelectItem><SelectItem value="points">Hours × points</SelectItem></SelectContent>
                </Select>
              </Field>
            </div>
            {t.mode === "total" ? (
              <Field label="Tips for the period" className="max-w-[12rem]"><NumberInput prefix={app.prefs.currencySymbol} value={t.total} disabled={locked} onChange={(total) => set({ total })} data-testid="input-tips-total" /></Field>
            ) : dates.length === 0 ? <p className="text-[13px] text-muted-foreground">Add shifts first; tips are entered for days someone worked.</p> : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {dates.map((d) => (
                  <Field key={d} label={app.date(d)}><NumberInput prefix={app.prefs.currencySymbol} value={t.perDay[d] ?? 0} disabled={locked} onChange={(n) => set({ perDay: { ...t.perDay, [d]: n } })} data-testid={`input-tips-${d}`} /></Field>
                ))}
              </div>
            )}
            {t.split === "points" && (
              <div className="space-y-2">
                <p className="section-label">Points per category</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {cats.map((c) => (
                    <Field key={c.id} label={c.name}><NumberInput step="0.5" value={t.points[c.id] ?? 1} disabled={locked} onChange={(n) => set({ points: { ...t.points, [c.id]: n } })} data-testid={`input-tips-points-${c.id}`} /></Field>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div>
            <p className="section-label mb-2">Shares{total > 0 ? ` of ${app.money(total)}` : ""}</p>
            {shares.length === 0 ? <p className="text-[13px] text-muted-foreground">{total > 0 ? "Nobody worked on the days with tips." : "Enter tips to see each person's share."}</p> : (
              <ul className="divide-y divide-border/70 rounded-lg border border-border/80" data-testid="list-tip-shares">
                {shares.map((e) => (
                  <li key={e.sourceId} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                    <span className="min-w-0 truncate font-medium">{e.name}</span>
                    <span className="text-xs text-muted-foreground tabular">{e.hoursWorked} h</span>
                    <span className="w-20 text-right font-semibold tabular">{app.money(e.extras!.tips)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

function StandingSection({ doc, result, locked, edit, pay, site, editable, resync }: WsProps & { pay: PaySettings; editable: boolean; resync: () => void }) {
  const app = useApp();
  const [adding, setAdding] = useState(false);
  const x = doc.payExtras;
  const people = result.employees.filter((e) => !e.excluded && e.extras?.lines.some((l) => l.kind !== "holiday" && l.kind !== "tips"));
  const skipped = (x?.skippedRecurring ?? []).map((id) => pay.recurring.find((r) => r.id === id)).filter(Boolean);
  const scheduled = (x?.advances ?? []).filter((a) => !result.employees.some((e) => linesOf(e, "advance").some((l) => l.sourceId === a.advanceId)));
  const names = [...new Set([...shiftEmployeeNames(doc.shifts), ...doc.manualEmployees.map((m) => m.name).filter(Boolean)])];

  return (
    <Section
      title="Standing items and advances"
      description="Applied automatically from Settings → Pay extras. Remove an item here to skip it for this timesheet only."
      actions={editable && !locked && <Button variant="outline" size="sm" onClick={() => setAdding(true)} data-testid="button-add-advance"><HandCoins />Record advance</Button>}
    >
      {people.length === 0 && skipped.length === 0 && scheduled.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Nothing this period. Standing bonuses and deductions (like a uniform fee) and advance repayments show up here.</p>
      ) : (
        <div className="space-y-3">
          {people.map((e) => (
            <div key={e.sourceId}>
              <p className="mb-1 text-[13px] font-semibold">{e.name}</p>
              <ul className="space-y-1">
                {e.extras!.lines.filter((l) => l.kind !== "holiday" && l.kind !== "tips").map((l, i) => {
                  const adv = l.kind === "advance" ? x?.advances.find((a) => a.advanceId === l.sourceId) : undefined;
                  const neg = l.kind === "advance" || l.kind === "recurring_deduction";
                  return (
                    <li key={i} className="flex items-center gap-2 text-[13px]">
                      <span className="min-w-0 flex-1 truncate">{l.description}{adv && <span className="text-xs text-muted-foreground"> · {app.money(adv.remaining - l.amount)} left after this{l.amount < adv.scheduled ? ` (planned ${app.money(adv.scheduled)}, limited by pay)` : ""}</span>}</span>
                      <span className={neg ? "tabular text-destructive" : "tabular text-success"}>{neg ? "−" : "+"}{app.money(l.amount)}</span>
                      {!locked && editable && l.kind !== "advance" && l.sourceId && (
                        <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label={`Remove ${l.description} from this timesheet`} onClick={() => edit((d) => skipRecurring(d, l.sourceId!))} data-testid={`button-skip-${l.sourceId}`}><Trash2 /></Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {scheduled.length > 0 && (
            <p className="text-xs text-muted-foreground">{scheduled.map((a) => `${a.employee}: nothing taken (no pay this period)`).join(" · ")}</p>
          )}
          {skipped.length > 0 && (
            <div className="border-t border-border/70 pt-3">
              <p className="section-label mb-1">Removed from this timesheet</p>
              <ul className="space-y-1">
                {skipped.map((r) => (
                  <li key={r!.id} className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    <span className="flex-1 truncate">{r!.employee} · {r!.description || (r!.kind === "bonus" ? "Standing bonus" : "Standing deduction")}</span>
                    {!locked && editable && <Button variant="ghost" size="sm" className="h-7 px-2 text-primary" onClick={() => { edit((d) => unskipRecurring(d, r!.id)); resync(); }}><RotateCcw className="h-3.5 w-3.5" />Put back</Button>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <AdvanceDialog open={adding} onOpenChange={setAdding} siteId={site.id} names={names} onSaved={resync} />
    </Section>
  );
}

function HolidaySection({ doc, result }: WsProps) {
  const app = useApp();
  const hols = doc.payExtras?.holidays ?? [];
  const total = result.totals.holidayPremium ?? 0;
  return (
    <Section title="Holidays this period" description="Set holidays and their premium per location in Settings → Pay extras.">
      {hols.length === 0 ? <p className="text-[13px] text-muted-foreground">No holidays in this pay period.</p> : (
        <ul className="space-y-1.5">
          {hols.map((h) => {
            const amt = result.employees.reduce((s, e) => s + linesOf(e, "holiday").filter((l) => l.sourceId === h.id).reduce((a, l) => a + l.amount, 0), 0);
            return (
              <li key={h.id} className="flex items-center gap-2 text-[13px]">
                <CalendarHeart className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate"><b className="font-medium">{h.name}</b> · {app.date(h.date)}</span>
                <Badge variant="secondary">{h.kind === "flat" ? `+${app.money(h.flatBonus)}` : `${h.multiplier}×`}</Badge>
                <span className="w-20 text-right tabular">{app.money(amt)}</span>
              </li>
            );
          })}
          {total > 0 && <li className="flex justify-end border-t border-border/70 pt-1.5 text-[13px] font-semibold tabular">Premiums {app.money(total)}</li>}
        </ul>
      )}
    </Section>
  );
}

/** Extras for one person, shown in their card on the Payroll tab. */
export function EmployeeExtras({ emp, locked, editable, edit }: { emp: WsProps["result"]["employees"][number]; locked: boolean; editable: boolean; edit: WsProps["edit"] }) {
  const app = useApp();
  const lines = emp.extras?.lines ?? [];
  if (!lines.length) return null;
  return (
    <div className="space-y-1.5" data-testid={`extras-${employeeKey(emp.name)}`}>
      <p className="section-label">Tips, premiums and standing items</p>
      <ul className="space-y-1">
        {lines.map((l, i) => {
          const neg = l.kind === "advance" || l.kind === "recurring_deduction";
          return (
            <li key={i} className="flex items-center gap-2 text-[13px]">
              <span className="min-w-0 flex-1 truncate">{l.description}{l.date ? <span className="text-xs text-muted-foreground"> · {app.date(l.date)}</span> : null}</span>
              <span className={neg ? "tabular text-destructive" : "tabular"}>{neg ? "−" : "+"}{app.money(l.amount)}</span>
              {!locked && editable && (l.kind === "recurring_bonus" || l.kind === "recurring_deduction") && l.sourceId && (
                <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label={`Remove ${l.description} from this timesheet`} onClick={() => edit((d) => skipRecurring(d, l.sourceId!))}><Trash2 /></Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

