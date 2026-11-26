import { useMemo, useState } from "react";
import { Banknote, ChevronDown } from "lucide-react";
import type { AnalysisResult } from "@shared/schema";
import { type CashConfig, cashPlan } from "@shared/payExtras";
import { useApp } from "@/context/AppData";
import { denomLabel } from "@/lib/pay";
import { cn } from "@/lib/utils";
import { Section } from "@/components/workspace/fields";

/** Bills and coins to pull from the bank for this run's cash pay. */
export function CashPanel({ result, cash }: { result: AnalysisResult; cash: CashConfig }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const plan = useMemo(
    () => cashPlan(result.employees.filter((e) => !e.excluded).map((e) => ({ name: e.name, cash: e.payment.cash })), cash),
    [result, cash],
  );
  if (!plan.rows.length) {
    return (
      <Section title="Cash to pull from the bank" description="No one is paid in cash in this timesheet.">
        <p className="text-[13px] text-muted-foreground">Set people to Cash on the Rates tab to see the bills and coins you need.</p>
      </Section>
    );
  }
  const sym = app.prefs.currencySymbol;
  return (
    <Section
      title="Cash to pull from the bank"
      description={`${app.money(plan.total)} for ${plan.rows.length} ${plan.rows.length === 1 ? "person" : "people"}${cash.roundCash ? " · rounded to whole amounts" : ""}. Also on the pay-out sheet PDF.`}
    >
      <div className="space-y-4" data-testid="panel-cash">
        <div className="flex flex-wrap gap-2">
          {plan.totals.map((d) => (
            <div key={d.value} className="min-w-[4.5rem] rounded-lg border border-border/80 px-3 py-2 text-center">
              <p className="text-[11px] font-medium text-muted-foreground">{denomLabel(d.value, sym)}</p>
              <p className="text-[17px] font-semibold tabular" data-testid={`cash-count-${d.value}`}>× {d.count}</p>
            </div>
          ))}
        </div>
        {(plan.rounding !== 0 || plan.leftover > 0) && (
          <p className="text-xs text-muted-foreground">
            {plan.rounding !== 0 && <>Rounding {plan.rounding > 0 ? "adds" : "takes off"} {app.money(Math.abs(plan.rounding))} in total (owed {app.money(plan.owed)}). </>}
            {plan.leftover > 0 && <span className="text-warning">{app.money(plan.leftover)} can't be made with these bills and coins. Check the denominations in Settings → Pay extras.</span>}
          </p>
        )}
        <button className="-mx-1 flex items-center gap-1 rounded-md px-1 text-[13px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="button-cash-per-person">
          <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />{open ? "Hide" : "Show"} per person
        </button>
        {open && (
          <ul className="divide-y divide-border/70 rounded-lg border border-border/80">
            {plan.rows.map((r) => (
              <li key={r.name} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2 text-[13px]">
                <span className="font-medium"><Banknote className="mr-1.5 inline h-3.5 w-3.5 text-muted-foreground" />{r.name}</span>
                <span className="text-xs text-muted-foreground">{r.counts.map((c) => `${c.count}×${denomLabel(c.value, sym)}`).join("  ")}</span>
                <span className="w-24 text-right font-semibold tabular">{app.money(r.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
