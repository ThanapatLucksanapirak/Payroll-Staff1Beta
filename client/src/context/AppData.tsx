import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Category, Prefs, Site } from "@shared/schema";
import { formatDate, formatTime } from "@shared/dates";
import { queryClient } from "@/lib/api";
import { safeStorage } from "@/lib/storage";

export interface Bootstrap {
  sites: Site[];
  categories: Category[];
  prefs: Prefs;
  squareConnected: Record<string, boolean>;
  defaultSiteId: string;
  db: { connected: boolean; kind: string | null; label: string | null; error: string | null };
}

interface AppData extends Bootstrap {
  site: Site;
  activeSites: Site[];
  setSiteId: (id: string) => void;
  refresh: () => Promise<unknown>;
  money: (n: number) => string;
  date: (iso: string | null | undefined) => string;
  time: (min: number | null | undefined) => string;
  categoriesFor: (siteId: string) => Category[];
}

const Ctx = createContext<AppData | null>(null);
const SITE_KEY = "payroll.site";

export function useApp(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside provider");
  return v;
}

export function applyTheme(theme: Prefs["theme"]) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", !!dark);
}

export function AppDataProvider({ children, fallback }: { children: ReactNode; fallback: (state: { error?: Error; loading: boolean; retry: () => void }) => ReactNode }) {
  const q = useQuery<Bootstrap>({ queryKey: ["/api/bootstrap"], staleTime: 60_000 });
  const [siteId, setSiteIdState] = useState<string>(() => safeStorage.get(SITE_KEY) ?? "");

  useEffect(() => {
    if (!q.data) return;
    applyTheme(q.data.prefs.theme);
    document.title = q.data.prefs.appName;
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const fn = () => applyTheme(q.data!.prefs.theme);
    mq?.addEventListener?.("change", fn);
    return () => mq?.removeEventListener?.("change", fn);
  }, [q.data]);

  const setSiteId = useCallback((id: string) => {
    setSiteIdState(id);
    safeStorage.set(SITE_KEY, id);
  }, []);

  const value = useMemo<AppData | null>(() => {
    if (!q.data) return null;
    const d = q.data;
    const activeSites = d.sites.filter((s) => !s.archived);
    const site = d.sites.find((s) => s.id === siteId) ?? d.sites.find((s) => s.id === d.prefs.defaultSiteId) ?? activeSites[0] ?? d.sites[0];
    const cur = d.prefs.currencySymbol;
    const nf = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return {
      ...d,
      site,
      activeSites: activeSites.length ? activeSites : d.sites,
      setSiteId,
      refresh: () => queryClient.invalidateQueries({ queryKey: ["/api/bootstrap"] }),
      money: (n: number) => `${n < 0 ? "-" : ""}${cur}${nf.format(Math.abs(n || 0))}`,
      date: (iso) => formatDate(iso, d.prefs.dateFormat),
      time: (m) => formatTime(m, d.prefs.timeFormat),
      categoriesFor: (sid: string) => d.categories.filter((c) => !c.siteId || c.siteId === sid),
    };
  }, [q.data, siteId, setSiteId]);

  if (!value) return <>{fallback({ error: (q.error as Error) ?? undefined, loading: q.isLoading, retry: () => q.refetch() })}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
