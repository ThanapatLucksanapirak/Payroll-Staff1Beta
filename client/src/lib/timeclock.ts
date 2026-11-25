// Client side of the time-clock review routes (server/timeclock.ts).
import type { IssueFix, OvertimeStatus, PunchIssue } from "@shared/punchIssues";
import type { AutoCloseConfig } from "@shared/punchIssues";
import type { ChecklistItem } from "@shared/payrollChecklist";
import { api, queryClient } from "./api";

export interface ShiftView {
  inId: string; outId: string | null; in: string; out: string | null; open: boolean; superseded: boolean;
  breakMinutes: number; workedMinutes: number; autoClosed: boolean;
}
export interface DayView {
  employeeId: string; employeeName: string; date: string; workedMinutes: number; working: boolean;
  approved: boolean; approvalStale: boolean; approvable: boolean; clean: boolean;
  approval: { at: string; byName: string } | null;
  punchIds: string[];
  shifts: ShiftView[];
  issues: PunchIssue[];
}
export interface ReviewData {
  site: { id: string; name: string; timezone: string };
  start: string; end: string; today: string; now: string;
  autoClose: AutoCloseConfig;
  days: DayView[];
  issues: PunchIssue[];
  counts: { fix: number; review: number; days: number; approved: number; clean: number };
}
export interface OvertimeData {
  enabled: boolean; weekStart: string; weekEnd: string; today: string; weeklyHours: number; dailyHours: number;
  employees: OvertimeStatus[];
}
export interface ChecklistData { start: string; end: string; timeSource: string; items: ChecklistItem[] }
export interface AutoCloseData { config: AutoCloseConfig; lastRun: { at: string; closed: number } | null; lookbackDays: number }

const qs = (o: Record<string, string | undefined>) => {
  const s = Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
  return s ? `?${s}` : "";
};

/** Query keys (joined with "/" by the default query function). */
export const tcKeys = {
  all: (siteId: string) => ["/api/sites", siteId, "timeclock"],
  review: (siteId: string, start?: string, end?: string) => ["/api/sites", siteId, `timeclock/review${qs({ start, end })}`],
  overtime: (siteId: string) => ["/api/sites", siteId, "timeclock/overtime"],
  checklist: (siteId: string, start: string, end: string) => ["/api/sites", siteId, `timeclock/checklist${qs({ start, end })}`],
  autoClose: (siteId: string) => ["/api/sites", siteId, "timeclock/auto-close"],
};

/** Refresh everything time-clock related for a location (Live, review, overtime, checklist). */
export function invalidateTimeclock(siteId: string) {
  return queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "/api/sites" && q.queryKey[1] === siteId && String(q.queryKey[2] ?? "").startsWith("timeclock") });
}

export async function setApproval(siteId: string, days: { employeeId: string; date: string }[], approve = true) {
  const r = await api<{ changed: number; skipped: { employeeId: string; date: string; reason: string }[] }>("POST", `/api/sites/${siteId}/timeclock/approvals`, { approve, days });
  await invalidateTimeclock(siteId);
  return r;
}

export async function approveClean(siteId: string, start: string, end: string) {
  const r = await api<{ changed: number }>("POST", `/api/sites/${siteId}/timeclock/approvals`, { clean: { start, end } });
  await invalidateTimeclock(siteId);
  return r;
}

/**
 * Apply a fix through the normal punch routes (so every change keeps its note
 * and edit history). Linked punches (an automatic break end at the same moment
 * as an automatic clock-out) move too, in an order that keeps the sequence valid.
 */
export async function applyFix(siteId: string, employeeId: string, fix: IssueFix, at: string | null, note: string, force = false) {
  if (fix.kind === "delete") {
    // Latest first, so an earlier punch is never left without its partner in between.
    for (const id of [...fix.punchIds].reverse()) await api("DELETE", `/api/punches/${id}${force ? "?force=1" : ""}`, { note, force });
  } else if (fix.kind === "add") {
    await api("POST", `/api/sites/${siteId}/punches`, { employeeId, type: fix.type, at, note, force });
  } else {
    const linked = fix.linkedPunchIds ?? [];
    const earlier = at != null && Date.parse(at) < Date.parse(fix.suggestedAt);
    const order = earlier ? [...linked, fix.punchId] : [fix.punchId, ...linked];
    for (const id of order) await api("PATCH", `/api/punches/${id}`, { at, note, force, ...(id === fix.punchId ? { type: fix.type } : {}) });
  }
  await invalidateTimeclock(siteId);
}

export const hm = (min: number) => { const m = Math.max(0, Math.round(min)); const h = Math.floor(m / 60), r = m % 60; return h ? `${h}h ${String(r).padStart(2, "0")}m` : `${r}m`; };
