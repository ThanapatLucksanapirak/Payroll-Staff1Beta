// Client side of the pay extras: queries for the location's pay settings,
// advances, rate history and YTD, plus small helpers for the workspace.
import { useQuery } from "@tanstack/react-query";
import type { Advance, PayContext, PaySettings, RateHistoryEntry, YtdRow } from "@shared/payExtras";
import { DEFAULT_PAY_SETTINGS } from "@shared/payExtras";
import { api, queryClient } from "@/lib/api";

export type AdvanceView = Advance & { repaid: number; remaining: number };
export interface PreviousPeriod { id: string; label: string; periodStart: string; periodEnd: string; totalPay: number; employees: { name: string; totalPay: number }[] }
export interface YtdResponse { year: number; timesheets: number; rows: YtdRow[] }

export const payKeys = {
  settings: (siteId: string) => ["/api/sites", siteId, "pay/settings"],
  advances: (siteId: string) => ["/api/sites", siteId, "pay/advances"],
  rates: (siteId: string) => ["/api/sites", siteId, "pay/rates"],
  ytd: (siteId: string, year: number, excludeId?: string) => ["pay-ytd", siteId, year, excludeId ?? ""],
};

export function usePaySettings(siteId: string) {
  const q = useQuery<PaySettings>({ queryKey: payKeys.settings(siteId), staleTime: 60_000 });
  return { ...q, settings: q.data ?? DEFAULT_PAY_SETTINGS };
}

export function useAdvances(siteId: string, enabled = true) {
  return useQuery<AdvanceView[]>({ queryKey: payKeys.advances(siteId), enabled });
}

export function useRateHistory(siteId: string, enabled = true) {
  return useQuery<Record<string, RateHistoryEntry>>({ queryKey: payKeys.rates(siteId), enabled });
}

export function useYtd(siteId: string, year: number, excludeId?: string, enabled = true) {
  return useQuery<YtdResponse>({
    queryKey: payKeys.ytd(siteId, year, excludeId),
    queryFn: () => api("GET", `/api/sites/${siteId}/pay/ytd?year=${year}${excludeId ? `&excludeId=${encodeURIComponent(excludeId)}` : ""}`),
    enabled,
    staleTime: 60_000,
  });
}

export function usePreviousPeriod(timesheetId: string, start: string, enabled = true) {
  return useQuery<PreviousPeriod | null>({
    queryKey: ["pay-previous", timesheetId, start],
    queryFn: () => api("GET", `/api/timesheets/${timesheetId}/pay/previous${start ? `?start=${start}` : ""}`),
    enabled: enabled && !!start,
    staleTime: 60_000,
  });
}

export const fetchPayContext = (siteId: string, timesheetId: string) =>
  api<PayContext>("GET", `/api/sites/${siteId}/pay/context?timesheetId=${encodeURIComponent(timesheetId)}`);

export async function savePaySettings(siteId: string, patch: Partial<PaySettings>) {
  const next = await api<PaySettings>("PUT", `/api/sites/${siteId}/pay/settings`, patch);
  queryClient.setQueryData(payKeys.settings(siteId), next);
  return next;
}

export function invalidatePay(siteId: string) {
  void queryClient.invalidateQueries({ queryKey: payKeys.advances(siteId) });
  void queryClient.invalidateQueries({ queryKey: ["pay-ytd", siteId] });
  void queryClient.invalidateQueries({ queryKey: ["pay-previous"] });
}

/** Denomination label: "$100", "25¢" (for currencies with cents). */
export function denomLabel(v: number, symbol: string) {
  if (v < 1 && symbol === "$") return `${Math.round(v * 100)}¢`;
  return `${symbol}${Number.isInteger(v) ? v : v.toFixed(2)}`;
}

/** Ask an open workspace to re-sync its extras (after rates or advances change elsewhere). */
export const PAY_RESYNC_EVENT = "payroll:pay-resync";
export function requestPayResync() {
  try { window.dispatchEvent(new Event(PAY_RESYNC_EVENT)); } catch { /* not in a browser */ }
}
