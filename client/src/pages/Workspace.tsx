import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, Check, ChevronLeft, Circle, CloudOff, Download, FileDown, FileSpreadsheet, Loader2, Lock, Redo2, RefreshCw, Save, Table2, Undo2 } from "lucide-react";
import { computePayroll } from "@shared/engine";
import { useApp } from "@/context/AppData";
import { useTimesheet, type SaveState } from "@/hooks/useTimesheet";
import { downloadBlob, safeFilename, timeAgo } from "@/lib/doc";
import { shiftsToCsv } from "@shared/importers/csv";
import { errorMessage } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PayrollTab } from "@/components/workspace/PayrollTab";
import { RatesTab } from "@/components/workspace/RatesTab";
import { ShiftsTab } from "@/components/workspace/ShiftsTab";
import { DetailsTab } from "@/components/workspace/DetailsTab";
import { SiteDot } from "@/components/AppShell";

export function WorkspacePage({ id }: { id: string }) {
  const app = useApp();
  const { toast } = useToast();
  const ts = useTimesheet(id, { autosave: app.prefs.autosave });
  const [tab, setTab] = useState("payroll");
  const doc = ts.doc;
  const site = (doc && app.sites.find((s) => s.id === doc.siteId)) || app.site;

  // Follow the timesheet's location in the header switcher
  useEffect(() => { if (doc && doc.siteId !== app.site.id && app.sites.some((s) => s.id === doc.siteId)) app.setSiteId(doc.siteId); }, [doc?.siteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const result = useMemo(
    () => (doc ? computePayroll({ shifts: doc.shifts, employees: doc.employees, manualEmployees: doc.manualEmployees, categories: app.categories, rules: doc.rules }) : null),
    [doc, app.categories],
  );

  if (ts.loadError) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center space-y-3">
        <AlertTriangle className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="text-sm">{ts.loadError}</p>
        <div className="flex justify-center gap-2">
          <Button variant="outline" onClick={ts.reload}><RefreshCw /> Retry</Button>
          <Button asChild variant="ghost"><Link href="/timesheets">Back to timesheets</Link></Button>
        </div>
      </div>
    );
  }
  if (!doc || !result) {
    return <div className="mx-auto max-w-7xl space-y-5 px-4 py-8 sm:px-8"><Skeleton className="h-4 w-24" /><Skeleton className="h-9 w-80" /><Skeleton className="h-9 w-72 rounded-[10px]" /><div className="grid gap-4 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div><Skeleton className="h-64 rounded-xl" /></div>;
  }

  const locked = doc.status === "final";
  const title = doc.label || doc.filename || "Untitled timesheet";
  const periodTitle = result.periodStart ? `${app.date(result.periodStart)} – ${app.date(result.periodEnd)}` : "No dates yet";
  const props = { doc, result, site, locked, edit: ts.edit };

  const exportPdf = async () => {
    try {
      const { downloadPayrollPdf } = await import("@/lib/pdf");
      downloadPayrollPdf({ result, prefs: app.prefs, site, title: doc.label || `Payroll ${periodTitle}`, notes: doc.notes, fileBase: `${base}_payroll` });
    } catch (e) { toast({ title: "PDF export failed", description: errorMessage(e), variant: "destructive" }); }
  };
  const base = safeFilename(`${site.name} ${doc.label || result.periodStart || "payroll"}`);

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 sm:px-8">
      {/* Sticky toolbar: keeps save state, undo/redo and export in reach */}
      <div className="glass sticky top-14 z-30 -mx-4 border-b border-border/60 px-4 pb-3 pt-4 sm:-mx-8 sm:px-8 md:top-0 md:pt-6" data-testid="workspace-toolbar">
        <Link href="/timesheets" className="mb-1 inline-flex items-center gap-0.5 text-[13px] font-medium text-primary hover:underline" data-testid="link-back" aria-label="Back to timesheets">
          <ChevronLeft className="h-4 w-4" />Timesheets
        </Link>
        <div className="flex items-start gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-x-2.5 text-[20px] font-bold leading-7 tracking-tight sm:text-[26px] sm:leading-8">
              <span className="line-clamp-1 break-all sm:break-words" data-testid="text-timesheet-title">{title}</span>
              {locked ? <Badge variant="success"><Lock />Final</Badge> : <Badge variant="secondary">Draft</Badge>}
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[13px] text-muted-foreground"><span className="inline-flex items-center gap-1.5 whitespace-nowrap"><SiteDot color={site.color} />{site.name}</span><span aria-hidden>·</span><span className="whitespace-nowrap">{periodTitle}</span></p>
          </div>
          <div className="flex items-center gap-1">
            <SaveIndicator state={ts.saveState} error={ts.saveError} savedAt={ts.lastSavedAt} legacy={ts.legacy} />
            <div className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden />
            <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={ts.undo} disabled={!ts.canUndo} aria-label="Undo" data-testid="button-undo"><Undo2 /></Button></TooltipTrigger><TooltipContent>Undo (Ctrl+Z)</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={ts.redo} disabled={!ts.canRedo} aria-label="Redo" data-testid="button-redo"><Redo2 /></Button></TooltipTrigger><TooltipContent>Redo (Ctrl+Shift+Z)</TooltipContent></Tooltip>
            {(!app.prefs.autosave || ts.saveState === "error" || ts.legacy) && (
              <Button variant="outline" size="sm" onClick={() => ts.save()} disabled={ts.saveState === "saving" || (!ts.dirty && !ts.legacy)} data-testid="button-save"><Save /> Save</Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="sm" className="ml-1" aria-label="Export" data-testid="button-export"><Download /><span className="hidden sm:inline">Export</span></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Export</DropdownMenuLabel>
                <DropdownMenuItem onClick={exportPdf} data-testid="button-export-pdf"><FileDown />PDF report</DropdownMenuItem>
                <DropdownMenuItem onClick={async () => downloadBlob((await import("@/lib/pdf")).payrollSummaryCsv(result), `${base}_summary.csv`, "text/csv")} data-testid="button-export-csv"><FileSpreadsheet />Summary CSV</DropdownMenuItem>
                <DropdownMenuItem onClick={() => downloadBlob(shiftsToCsv(doc.shifts), `${base}_shifts.csv`, "text/csv")} data-testid="button-export-shifts"><Table2 />Shifts CSV (re-importable)</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <div className="space-y-3 pt-2">
        {ts.saveState === "conflict" && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-warning-soft px-4 py-3 text-[13px]" role="alert" data-testid="banner-conflict">
            <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
            <span className="flex-1">This timesheet was changed in another tab or device. Your edits here haven't been saved.</span>
            <Button size="sm" variant="outline" onClick={ts.reload}>Load their version</Button>
            <Button size="sm" onClick={() => ts.save(true)} data-testid="button-overwrite">Keep mine</Button>
          </div>
        )}
        {locked && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/80 bg-card px-4 py-2.5 text-[13px] shadow-card">
            <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">This timesheet is finalized and read-only.</span>
            <Button size="sm" variant="tinted" onClick={() => ts.edit((d) => ({ ...d, status: "draft" }))} data-testid="button-reopen">Reopen for editing</Button>
          </div>
        )}
      </div>

      <Tabs value={tab} onValueChange={setTab} className="mt-4">
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList className="w-full sm:w-auto">
            <TabsTrigger value="payroll" data-testid="tab-payroll">Payroll</TabsTrigger>
            <TabsTrigger value="rates" data-testid="tab-rates">Rates</TabsTrigger>
            <TabsTrigger value="shifts" data-testid="tab-shifts">Shifts</TabsTrigger>
            <TabsTrigger value="details" data-testid="tab-details">Details</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="payroll" className="mt-5"><PayrollTab {...props} /></TabsContent>
        <TabsContent value="rates" className="mt-5"><RatesTab {...props} /></TabsContent>
        <TabsContent value="shifts" className="mt-5"><ShiftsTab {...props} /></TabsContent>
        <TabsContent value="details" className="mt-5"><DetailsTab {...props} /></TabsContent>
      </Tabs>
    </div>
  );
}

function SaveIndicator({ state, error, savedAt, legacy }: { state: SaveState; error: string | null; savedAt: string | null; legacy: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(t); }, []);
  const map: Record<SaveState, { icon: any; text: string; cls: string }> = {
    saved: { icon: Check, text: savedAt ? `Saved ${timeAgo(savedAt)}` : "Saved", cls: "text-muted-foreground" },
    dirty: { icon: Circle, text: "Unsaved changes", cls: "text-muted-foreground" },
    saving: { icon: Loader2, text: "Saving…", cls: "text-muted-foreground" },
    error: { icon: CloudOff, text: "Not saved — retrying", cls: "text-destructive" },
    conflict: { icon: AlertTriangle, text: "Conflict", cls: "text-warning" },
  };
  const m = map[state];
  const Icon = m.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium ${m.cls}`} title={error ?? (legacy && state === "saved" ? "Opened from an older version — saving will upgrade it" : m.text)} role="status" aria-live="polite" data-testid="text-save-status">
      {Icon && <Icon className={`h-3.5 w-3.5 shrink-0 ${state === "saving" ? "animate-spin" : ""} ${state === "dirty" ? "h-2 w-2 fill-current" : ""}`} />}<span className="sr-only sm:not-sr-only">{m.text}</span>
    </span>
  );
}
