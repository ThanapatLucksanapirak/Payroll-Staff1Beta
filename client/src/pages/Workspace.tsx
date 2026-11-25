import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, ArrowLeft, Check, CloudOff, Download, FileDown, Loader2, Lock, Redo2, RefreshCw, Save, Undo2 } from "lucide-react";
import { computePayroll } from "@shared/engine";
import { useApp } from "@/context/AppData";
import { useTimesheet, type SaveState } from "@/hooks/useTimesheet";
import { downloadBlob, safeFilename, timeAgo } from "@/lib/doc";
import { shiftsToCsv } from "@shared/importers/csv";
import { errorMessage } from "@/lib/api";
import { canEdit } from "@/lib/roles";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PayrollTab } from "@/components/workspace/PayrollTab";
import { RatesTab } from "@/components/workspace/RatesTab";
import { ShiftsTab } from "@/components/workspace/ShiftsTab";
import { DetailsTab } from "@/components/workspace/DetailsTab";
import { SiteDot } from "@/components/AppShell";

export function WorkspacePage({ id }: { id: string }) {
  const app = useApp();
  const { toast } = useToast();
  const readOnly = !canEdit(app.user);
  const ts = useTimesheet(id, { autosave: app.prefs.autosave && !readOnly });
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
          <Button asChild variant="ghost"><Link href="/">Back to timesheets</Link></Button>
        </div>
      </div>
    );
  }
  if (!doc || !result) {
    return <div className="mx-auto max-w-7xl px-3 sm:px-5 py-6 space-y-4"><Skeleton className="h-10 w-72" /><Skeleton className="h-24" /><Skeleton className="h-64" /></div>;
  }

  const locked = doc.status === "final" || readOnly;
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
    <div className="mx-auto max-w-7xl px-3 sm:px-5 py-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="icon" aria-label="Back to timesheets"><Link href="/" data-testid="link-back"><ArrowLeft className="h-4 w-4" /></Link></Button>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <span className="line-clamp-2 break-words sm:line-clamp-1" data-testid="text-timesheet-title">{title}</span>
            {doc.status === "final" ? <Badge className="gap-1"><Lock className="h-3 w-3" />Final</Badge> : <Badge variant="secondary">Draft</Badge>}
          </h1>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><SiteDot color={site.color} />{site.name} · {periodTitle}</p>
        </div>
        <div className="flex items-center gap-1">
          <SaveIndicator state={ts.saveState} error={ts.saveError} savedAt={ts.lastSavedAt} legacy={ts.legacy} />
          <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={ts.undo} disabled={!ts.canUndo} aria-label="Undo" data-testid="button-undo"><Undo2 className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Undo (Ctrl+Z)</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={ts.redo} disabled={!ts.canRedo} aria-label="Redo" data-testid="button-redo"><Redo2 className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent>Redo (Ctrl+Shift+Z)</TooltipContent></Tooltip>
          {!readOnly && (!app.prefs.autosave || ts.saveState === "error" || ts.legacy) && (
            <Button variant="outline" size="sm" onClick={() => ts.save()} disabled={ts.saveState === "saving" || (!ts.dirty && !ts.legacy)} data-testid="button-save"><Save /> Save</Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="sm" data-testid="button-export"><Download /> Export</Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={exportPdf} data-testid="button-export-pdf"><FileDown className="h-4 w-4 mr-2" />PDF report</DropdownMenuItem>
              <DropdownMenuItem onClick={async () => downloadBlob((await import("@/lib/pdf")).payrollSummaryCsv(result), `${base}_summary.csv`, "text/csv")} data-testid="button-export-csv">Summary CSV</DropdownMenuItem>
              <DropdownMenuItem onClick={() => downloadBlob(shiftsToCsv(doc.shifts), `${base}_shifts.csv`, "text/csv")} data-testid="button-export-shifts">Shifts CSV (re-importable)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {ts.saveState === "conflict" && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm" data-testid="banner-conflict">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <span className="flex-1">This timesheet was changed in another tab or device. Your edits here haven't been saved.</span>
          <Button size="sm" variant="outline" onClick={ts.reload}>Load their version</Button>
          <Button size="sm" onClick={() => ts.save(true)} data-testid="button-overwrite">Keep mine</Button>
        </div>
      )}
      {readOnly && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/40 px-4 py-2.5 text-sm" data-testid="banner-view-only">
          <Lock className="h-4 w-4 text-muted-foreground" />
          <span className="flex-1">Your account is view-only. You can look through and export this timesheet, but not change it.</span>
        </div>
      )}
      {locked && !readOnly && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/40 px-4 py-2.5 text-sm">
          <Lock className="h-4 w-4 text-muted-foreground" />
          <span className="flex-1">This timesheet is finalized and read-only.</span>
          <Button size="sm" variant="outline" onClick={() => ts.edit((d) => ({ ...d, status: "draft" }))} data-testid="button-reopen">Reopen for editing</Button>
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
          <TabsTrigger value="payroll" data-testid="tab-payroll">Payroll</TabsTrigger>
          <TabsTrigger value="rates" data-testid="tab-rates">Rates</TabsTrigger>
          <TabsTrigger value="shifts" data-testid="tab-shifts">Shifts</TabsTrigger>
          <TabsTrigger value="details" data-testid="tab-details">Details</TabsTrigger>
        </TabsList>
        <TabsContent value="payroll" className="mt-4"><PayrollTab {...props} /></TabsContent>
        <TabsContent value="rates" className="mt-4"><RatesTab {...props} /></TabsContent>
        <TabsContent value="shifts" className="mt-4"><ShiftsTab {...props} /></TabsContent>
        <TabsContent value="details" className="mt-4"><DetailsTab {...props} /></TabsContent>
      </Tabs>
    </div>
  );
}

function SaveIndicator({ state, error, savedAt, legacy }: { state: SaveState; error: string | null; savedAt: string | null; legacy: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(t); }, []);
  const map: Record<SaveState, { icon: any; text: string; cls: string }> = {
    saved: { icon: Check, text: savedAt ? `Saved ${timeAgo(savedAt)}` : "Saved", cls: "text-muted-foreground" },
    dirty: { icon: null, text: "Unsaved changes", cls: "text-muted-foreground" },
    saving: { icon: Loader2, text: "Saving…", cls: "text-muted-foreground" },
    error: { icon: CloudOff, text: "Not saved — retrying", cls: "text-destructive" },
    conflict: { icon: AlertTriangle, text: "Conflict", cls: "text-amber-600" },
  };
  const m = map[state];
  const Icon = m.icon;
  return (
    <span className={`hidden sm:inline-flex items-center gap-1 px-2 text-xs ${m.cls}`} title={error ?? (legacy && state === "saved" ? "Opened from an older version — saving will upgrade it" : undefined)} data-testid="text-save-status">
      {Icon && <Icon className={`h-3.5 w-3.5 ${state === "saving" ? "animate-spin" : ""}`} />}{m.text}
    </span>
  );
}
