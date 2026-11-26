// Employee portal ↔ server. The session is an httpOnly cookie scoped to
// /api/portal that the page can't read; it never uses the admin session.
import { useCallback, useEffect, useState } from "react";
import type { ClockStatus } from "@shared/punches";
import type { PortalDay, PortalShiftItem, PortalTimeOffItem } from "@shared/portal";
import type { TimeOffStatus } from "@shared/schedule";
import type { AnalysisResult } from "@shared/schema";

export class PortalError extends Error {
  constructor(public status: number, message: string, public code?: string, public retryAfter?: number) {
    super(message);
    this.name = "PortalError";
  }
}

const signedOut = new Set<() => void>();
/** Called when the server says the session has ended (PIN changed, signed out elsewhere, portal turned off). */
export function onSignedOut(fn: () => void) {
  signedOut.add(fn);
  return () => { signedOut.delete(fn); };
}

export async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { "X-Requested-With": "payroll", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new PortalError(0, "Can't reach the server. Check your connection and try again.", "offline");
  }
  let data: any = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = new PortalError(res.status, data?.error || "Something went wrong. Try again.", data?.code, data?.retryAfter);
    if (res.status === 401 && data?.code === "session") signedOut.forEach((f) => f());
    throw err;
  }
  return data as T;
}

/** Load a GET endpoint; reload() fetches again. */
export function useLoad<T>(url: string | null) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: !!url });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) return;
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    call<T>("GET", url)
      .then((data) => { if (live) setState({ data, error: null, loading: false }); })
      .catch((e: Error) => { if (live) setState((s) => ({ data: s.data, error: e.message, loading: false })); });
    return () => { live = false; };
  }, [url, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

// ── Response shapes ──────────────────────────────────────────────────────────
export interface PortalSite { id: string; name: string; color: string }
export interface Me {
  employee: { id: string; name: string; role: string };
  site: { id: string; name: string; color: string; timezone: string; timeClock: boolean };
  prefs: { timeFormat: "12h" | "24h"; dateFormat: string; currencySymbol: string; businessName: string; appName: string };
}
export interface HoursData {
  period: { start: string; end: string };
  offset: number;
  status: ClockStatus;
  since: string | null;
  totalMinutes: number;
  days: PortalDay[];
  /** Finalized timesheets overlapping this period, with this person's hours on the days inside this period (for hours not from the time clock). */
  timesheets?: { id: string; periodStart: string; periodEnd: string; minutes: number; partial?: boolean }[];
}
export interface StatementItem { id: string; label: string; periodStart: string; periodEnd: string; totalPay: number; isNetPay: boolean; minutes?: number }
export interface StatementData {
  title: string;
  result: AnalysisResult;
  site: { id: string; name: string; address: string };
  prefs: Record<string, unknown>;
  ytd: Record<string, { gross: number; net: number }>;
  ytdYear: number | null;
}
export interface ScheduleData { from: string; to: string; shifts: PortalShiftItem[]; timeOff: PortalTimeOffItem[]; unpublishedWeeks: string[] }
export interface TimeOffItem { id: string; start: string; end: string; reason: string; status: TimeOffStatus; requestedBy: "owner" | "employee"; createdAt: string; decidedAt: string | null }
