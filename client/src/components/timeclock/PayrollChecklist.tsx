import { useMemo, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronRight, CircleDashed, ListChecks, Wrench } from "lucide-react";
import type { AnalysisResult, Site } from "@shared/schema";
import { type ChecklistItem, mergeChecklists, timesheetChecklist } from "@shared/payrollChecklist";
import { isISODate, todayISO } from "@shared/dates";
import { useApp } from "@/context/AppData";
import { errorMessage } from "@/lib/api";
import { payPeriod } from "@/lib/periods";
import { type ChecklistData, tcKeys } from "@/lib/timeclock";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type Tab = NonNullable<ChecklistItem["tab"]>;

/** Everything still wrong for a pay period. Never blocks: it only points to where to fix things. */
export function PayrollChecklistDialog({ site, onClose, period, result, onTab, footer }: {
  site: Site;
  onClose: () => void;
  /** Fixed period (from a timesheet). Without it, the owner picks last or this pay period. */
  period?: { start: string; end: string } | null;
  /** The timesheet's computed payroll: adds flagged days and its own rate check. */
  result?: AnalysisResult | null;
  /** Open a workspace tab (when shown from a timesheet). */
  onTab?: (tab: Tab) => void;
  footer?: ReactNode;
}) {
  const app = useApp();
  const [, navigate] = useLocation();
  const [which, setWhich] = useState<"last" | "this">(() => {
    // Early in a period, payroll is usually for the one that just ended.
    const cur = payPeriod(site.rules, 0);
    const today = todayISO(site.rules.timezone);
    return today <= cur.end && Date.parse(today) - Date.parse(cur.start) < 4 * 86_400_000 ? "last" : "this";
  });
  const fixed = period && isISODate(period.start) && isISODate(period.end) ? period : null;
  const range = useMemo(() => {
    if (fixed) return fixed;
    const p = payPeriod(site.rules, which === "last" ? -1 : 0);
    const today = todayISO(site.rules.timezone);
    return { start: p.start, end: p.end > today ? today : p.end };
  }, [fixed, which, site.rules]);
  // The server limits ranges to 62 days.
  const queryable = Date.parse(range.end) - Date.parse(range.start) < 62 * 86_400_000 && range.end >= range.start;
  const q = useQuery<ChecklistData>({ queryKey: tcKeys.checklist(site.id, range.start, range.end), enabled: queryable, staleTime: 0 });
  const items = useMemo(() => mergeChecklists(q.data?.items ?? [], result ? timesheetChecklist(result) : null), [q.data, result]);
  const loading = queryable && q.isLoading;

  const go = (i: ChecklistItem) => {
    if (i.tab && onTab) { onTab(i.tab); onClose(); return; }
    if (i.href) { navigate(i.href); onClose(); }
  };
  const fixCount = items.filter((i) => i.severity === "fix").length;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ListChecks className="h-5 w-5 text-primary" />Before you run payroll</DialogTitle>
          <DialogDescription>{site.name} · {app.date(range.start)} – {app.date(range.end)}. Nothing here stops you exporting.</DialogDescription>
        </DialogHeader>
        {!fixed && (
          <Tabs value={which} onValueChange={(v) => setWhich(v as "last" | "this")}>
            <TabsList className="w-full">
              <TabsTrigger value="last" className="flex-1" data-testid="tab-checklist-last">Last pay period</TabsTrigger>
              <TabsTrigger value="this" className="flex-1" data-testid="tab-checklist-this">This pay period</TabsTrigger>
            </TabsList>
          </Tabs>
        )}
        {loading ? (
          <div className="divide-y divide-border/70 overflow-hidden rounded-xl border border-card-border" aria-busy="true" aria-label="Checking this pay period">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-start gap-3 px-4 py-3">
                <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
                <div className="flex-1 space-y-2 pt-0.5"><Skeleton className="h-3.5 w-2/5" /><Skeleton className="h-3 w-4/5" /></div>
              </div>
            ))}
          </div>
        ) : q.error ? (
          <p className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[13px] font-medium text-danger" role="alert"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{errorMessage(q.error)}</p>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center" data-testid="checklist-all-clear">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-success-soft text-success"><CheckCircle2 className="h-5 w-5" /></span>
            <p className="text-[15px] font-semibold">All clear</p>
            <p className="max-w-xs text-[13px] text-muted-foreground">No open shifts, punch problems, unapproved days or missing rates for these dates.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-card-border" data-testid="list-checklist">
            {items.map((i) => {
              const target = (i.tab && onTab) || i.href;
              return (
                <li key={i.id}>
                  <button
                    type="button"
                    disabled={!target}
                    onClick={() => go(i)}
                    className={cn("flex w-full items-start gap-3 px-4 py-3 text-left transition-colors", target && "hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/35")}
                    data-testid={`checklist-${i.id}`}
                  >
                    <span className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full", i.severity === "fix" ? "bg-danger-soft text-danger" : "bg-warning-soft text-warning")}>
                      {i.severity === "fix" ? <Wrench className="h-3.5 w-3.5" /> : <CircleDashed className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] font-medium">{i.title}</span>
                      <span className="mt-0.5 block text-[13px] text-muted-foreground">{i.detail}</span>
                    </span>
                    {target && <span className="mt-1 inline-flex shrink-0 items-center text-[13px] font-medium text-primary">{i.tab && onTab ? i.linkLabel.replace(/^Open timesheets$/, "Open Rates") : i.linkLabel}<ChevronRight className="h-4 w-4" /></span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <DialogFooter className="gap-2 sm:justify-between">
          <span className="self-center text-xs tabular text-muted-foreground">{items.length ? `${fixCount} to fix · ${items.length - fixCount} to review` : ""}</span>
          <div className="flex gap-2">{footer}<Button variant={footer ? "outline" : "default"} onClick={onClose}>Close</Button></div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
