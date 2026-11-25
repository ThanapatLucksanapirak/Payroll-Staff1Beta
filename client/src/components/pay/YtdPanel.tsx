import { useState } from "react";
import { ChevronLeft, ChevronRight, FileSpreadsheet } from "lucide-react";
import { ytdCsv } from "@shared/payExtras";
import { useApp } from "@/context/AppData";
import { downloadBlob, safeFilename } from "@/lib/doc";
import { useYtd } from "@/lib/pay";
import { errorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/** Year-to-date pay per person, from finalized timesheets at this location. */
export function YtdPanel({ siteId, siteName }: { siteId: string; siteName: string }) {
  const app = useApp();
  const [year, setYear] = useState(new Date().getFullYear());
  const q = useYtd(siteId, year);
  const rows = q.data?.rows ?? [];
  const tot = rows.reduce((s, r) => ({ gross: s.gross + r.gross, net: s.net + r.net }), { gross: 0, net: 0 });

  return (
    <section className="mt-8 space-y-2" data-testid="section-ytd">
      <div className="flex flex-wrap items-end justify-between gap-2 px-1">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">Year to date</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">From finalized timesheets at {siteName} with a pay period ending in {year}. Gross is earnings before deductions; net is what was paid.</p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label="Previous year" onClick={() => setYear(year - 1)}><ChevronLeft /></Button>
          <span className="w-12 text-center text-[13px] font-medium tabular">{year}</span>
          <Button variant="ghost" size="icon-sm" aria-label="Next year" disabled={year >= new Date().getFullYear()} onClick={() => setYear(year + 1)}><ChevronRight /></Button>
          <Button variant="outline" size="sm" className="ml-2" disabled={!rows.length} onClick={() => downloadBlob(ytdCsv(rows, year), `${safeFilename(`${siteName} YTD ${year}`)}.csv`, "text/csv")} data-testid="button-ytd-csv"><FileSpreadsheet />YTD CSV</Button>
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-card-border bg-card shadow-card">
        {q.isLoading ? <div className="p-4"><Skeleton className="h-16" /></div> : q.error ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">{errorMessage(q.error)}</p>
        ) : !rows.length ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">No finalized timesheets for {year} yet. Totals appear once a pay period is marked final.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] text-sm">
              <thead><tr className="border-b border-border/70 text-left text-xs text-muted-foreground"><th className="px-4 py-2 font-medium">Employee</th><th className="px-2 py-2 text-right font-medium">Periods</th><th className="px-2 py-2 text-right font-medium">YTD gross</th><th className="px-2 py-2 text-right font-medium">Deductions</th><th className="px-4 py-2 text-right font-medium">YTD net</th></tr></thead>
              <tbody className="divide-y divide-border/70">
                {rows.map((r) => (
                  <tr key={r.key} data-testid={`row-ytd-${r.key}`}>
                    <td className="px-4 py-2 font-medium">{r.name}</td>
                    <td className="px-2 py-2 text-right tabular text-muted-foreground">{r.timesheets}</td>
                    <td className="px-2 py-2 text-right tabular">{app.money(r.gross)}</td>
                    <td className="px-2 py-2 text-right tabular text-muted-foreground">{r.deductions ? `−${app.money(r.deductions)}` : "—"}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular">{app.money(r.net)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="border-t border-border/70 text-[13px] font-semibold"><td className="px-4 py-2">Total · {q.data?.timesheets} timesheet{q.data?.timesheets === 1 ? "" : "s"}</td><td /><td className="px-2 py-2 text-right tabular">{app.money(tot.gross)}</td><td /><td className="px-4 py-2 text-right tabular">{app.money(tot.net)}</td></tr></tfoot>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
