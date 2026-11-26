import { createContext, lazy, Suspense, useCallback, useContext, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import type { EmployeeConfig, TimesheetSummary } from "@shared/schema";
import { useApp } from "@/context/AppData";
import { api, errorMessage, queryClient } from "@/lib/api";
import { can } from "@/lib/roles";
import { employeeKey, shiftEmployeeNames } from "@shared/engine";
import { ToastAction } from "@/components/ui/toast";
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
    // People in the file who aren't on the Employees list yet: offer to add them (they need to be
    // there for the time clock and the staff portal). Uploading alone doesn't create employees.
    let missing: string[] = [];
    if (can(app.user, "employees.manage") && r.source !== "kiosk" && r.shifts.length) {
      const list = await api<{ name: string }[]>("GET", `/api/sites/${site.id}/employees`).catch(() => null);
      if (list) {
        const have = new Set(list.map((e) => employeeKey(e.name)));
        missing = shiftEmployeeNames(r.shifts).filter((n) => !have.has(employeeKey(n)));
      }
    }
    const addMissing = async () => {
      try {
        const res = await api<{ created: unknown[]; skipped: string[] }>("POST", `/api/sites/${site.id}/employees/import`, { names: missing });
        void queryClient.invalidateQueries({ queryKey: ["/api/sites", site.id, "employees"] });
        toast({ title: `${res.created.length} added to Employees`, description: "Give them PINs on the Employees page so they can use the time clock and staff portal." });
      } catch (e) { toast({ title: "Couldn't add them", description: errorMessage(e), variant: "destructive" }); }
    };
    const desc = [
      matched ? `Saved rates applied to ${matched} of ${doc.employees.length} employees.` : "",
      missing.length ? `${missing.length === 1 ? missing[0] + " isn't" : `${missing.length} people aren't`} on your Employees list yet.` : "",
    ].filter(Boolean).join(" ");
    toast({
      title: "Timesheet created", description: desc || undefined,
      ...(missing.length ? { action: <ToastAction altText="Add them to Employees" onClick={() => void addMissing()} data-testid="toast-add-employees">Add to Employees</ToastAction>, duration: 15000 } : {}),
    });
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
