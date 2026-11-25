import { useCallback, useEffect, useRef, useState } from "react";
import type { Category, TimesheetDoc } from "@shared/schema";
import { computePayroll } from "@shared/engine";
import { docEmployeeKeys, syncPayExtras } from "@shared/payExtras";
import { PAY_RESYNC_EVENT, fetchPayContext } from "@/lib/pay";

function periodOf(doc: TimesheetDoc, categories: Category[]) {
  const r = computePayroll({ shifts: doc.shifts, employees: doc.employees, manualEmployees: doc.manualEmployees, categories, rules: doc.rules });
  return { start: r.periodStart || doc.periodStart, end: r.periodEnd || doc.periodEnd };
}

/**
 * Keep a draft timesheet's extras in step with its location: holidays in the
 * period, standing items, advance repayments due and rate history. Runs when
 * the timesheet opens and whenever its period, location or people change.
 */
export function usePaySync(opts: { id: string; doc: TimesheetDoc | null; edit: (fn: (d: TimesheetDoc) => TimesheetDoc) => void; enabled: boolean; categories: Category[] }) {
  const { id, doc, edit, enabled, categories } = opts;
  const last = useRef("");
  const [bump, setBump] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const period = doc ? periodOf(doc, categories) : null;
  const key = doc && period ? `${id}|${doc.siteId}|${period.start}|${period.end}|${[...docEmployeeKeys(doc).keys()].sort().join(",")}|${bump}` : "";

  useEffect(() => {
    if (!enabled || !doc || doc.status === "final" || !key || key === last.current) return;
    last.current = key;
    let live = true;
    fetchPayContext(doc.siteId, id)
      .then((ctx) => {
        if (!live) return;
        setError(null);
        edit((d) => (d.status === "final" ? d : syncPayExtras(d, ctx, periodOf(d, categories))));
      })
      .catch((e) => { if (live) { setError(String(e?.message ?? e)); last.current = ""; } });
    return () => { live = false; };
  }, [key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const resync = useCallback(() => setBump((n) => n + 1), []);
  useEffect(() => {
    window.addEventListener(PAY_RESYNC_EVENT, resync);
    return () => window.removeEventListener(PAY_RESYNC_EVENT, resync);
  }, [resync]);
  return { resync, error };
}
