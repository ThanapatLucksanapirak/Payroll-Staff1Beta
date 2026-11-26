import { createContext, lazy, Suspense, useCallback, useContext, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import type { EmployeeConfig, TimesheetSummary } from "@shared/schema";
import { useApp } from "@/context/AppData";
import { api, queryClient } from "@/lib/api";
import { newDoc } from "@/lib/doc";
import { useToast } from "@/hooks/use-toast";
import type { ImportResult, ImportSource } from "@/components/import/ImportDialog";

const ImportDialog = lazy(() => import("@/components/import/ImportDialog").then((m) => ({ default: m.ImportDialog })));

type OpenFn = (source?: ImportSource) => void;
const Ctx = createContext<OpenFn>(() => undefined);

/** Opens the "New timesheet" import flow from anywhere (pages, command palette). */
export function useNewTimesheet() {
  return useContext(Ctx);
}

export function NewTimesheetProvider({ children }: { children: ReactNode }) {
  const app = useApp();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [source, setSource] = useState<ImportSource | undefined>();
  const site = app.site;

  const create = async (r: ImportResult) => {
    let profile: EmployeeConfig[] = [];
    if (app.prefs.autoApplySavedRates) profile = await api<EmployeeConfig[]>("GET", `/api/sites/${site.id}/wages`).catch(() => []);
    const doc = newDoc(site, r.shifts, { source: r.source, filename: r.filename, label: r.label, profile, period: r.period });
    const created = await api<TimesheetSummary & { removedByRetention?: number }>("POST", "/api/timesheets", { doc });
    void queryClient.invalidateQueries({ queryKey: ["/api/timesheets"] });
    const matched = profile.length ? doc.employees.filter((e) => e.fullDayRate || e.hourlyRate || e.categoryId !== "custom").length : 0;
    toast({ title: "Timesheet created", description: matched ? `Saved rates applied to ${matched} of ${doc.employees.length} employees.` : undefined });
    navigate(`/timesheet/${created.id}`);
  };

  const openFn = useCallback<OpenFn>((s) => { setSource(s); setMounted(true); setOpen(true); }, []);

  return (
    <Ctx.Provider value={openFn}>
      {children}
      {mounted && (
        <Suspense fallback={null}>
          <ImportDialog open={open} onOpenChange={setOpen} site={site} mode="create" initialSource={source} onComplete={create} />
        </Suspense>
      )}
    </Ctx.Provider>
  );
}
