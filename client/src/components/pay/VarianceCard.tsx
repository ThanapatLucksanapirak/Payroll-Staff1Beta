import { useMemo, useState } from "react";
import { ChevronDown, TrendingDown, TrendingUp } from "lucide-react";
import type { AnalysisResult } from "@shared/schema";
import { comparePeriods, snapshotOf } from "@shared/payExtras";
import { useApp } from "@/context/AppData";
import { usePreviousPeriod } from "@/lib/pay";
import { cn } from "@/lib/utils";

/** Flag when this run's total moves a lot compared with the last finalized period. */
export const VARIANCE_FLAG_PCT = 10;

export function VarianceCard({ timesheetId, result }: { timesheetId: string; result: AnalysisResult }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const prev = usePreviousPeriod(timesheetId, result.periodStart);
  const v = useMemo(() => (prev.data ? comparePeriods(snapshotOf(result), prev.data) : null), [prev.data, result]);
  if (!prev.data || !v || v.diff === 0) return null;
  const flagged = v.pct == null || Math.abs(v.pct) >= VARIANCE_FLAG_PCT;
  const up = v.diff > 0;
  const Icon = up ? TrendingUp : TrendingDown;
  const pctText = v.pct == null ? "" : `${Math.abs(v.pct)}% `;
  return (
    <div className={cn("overflow-hidden rounded-xl", flagged ? "bg-warning-soft" : "border border-card-border bg-card shadow-card")} data-testid="card-variance">
      <button className="flex w-full items-center gap-2 px-4 py-3 text-left text-[13px] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/35" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon className={cn("h-4 w-4 shrink-0", flagged ? "text-warning" : "text-muted-foreground")} />
        <span className="flex-1">
          <span className="font-medium">Total is {pctText}{up ? "higher" : "lower"} than last period</span>
          <span className="text-muted-foreground"> · {up ? "+" : "−"}{app.money(Math.abs(v.diff))} vs {app.money(v.previous)} ({prev.data.periodStart ? `${app.date(prev.data.periodStart)} – ${app.date(prev.data.periodEnd)}` : prev.data.label})</span>
        </span>
        {v.drivers.length > 0 && <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")} />}
      </button>
      {open && v.drivers.length > 0 && (
        <ul className="space-y-1 border-t border-foreground/10 px-4 py-3 text-[13px]">
          {v.drivers.map((d) => (
            <li key={d.name} className="flex items-center gap-3">
              <span className="flex-1 truncate font-medium">{d.name}</span>
              <span className="text-xs text-muted-foreground tabular">{app.money(d.previous)} → {app.money(d.current)}</span>
              <span className="w-24 text-right font-semibold tabular">{d.diff > 0 ? "+" : "−"}{app.money(Math.abs(d.diff))}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
