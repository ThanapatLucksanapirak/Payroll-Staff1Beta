// One Save bar for a settings page made of several parts that save to
// different endpoints (Settings → Locations: the location itself, kiosk device
// options, stations, break reminder, auto clock-out, employee portal…).
// Each part keeps its own draft and registers it here while it has unsaved
// changes; the page's Save button saves them all and Discard resets them all,
// so nothing on the page saves behind the person's back.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export interface PendingPart {
  /** Shown in the Save bar, e.g. "Kiosk options (Front door)". */
  label: string;
  /** Save this part. Throw (with a friendly message) to stop the Save. */
  save: () => Promise<void>;
  /** Throw away this part's unsaved changes. */
  discard: () => void;
}

interface Registry {
  set: (id: string, part: PendingPart | null) => void;
  get: (id: string) => PendingPart | undefined;
}

const Ctx = createContext<Registry | null>(null);

/** Provider state: the parts that currently have unsaved changes. */
export function usePendingRegistry() {
  const parts = useRef(new Map<string, PendingPart>());
  const [ids, setIds] = useState<string[]>([]);
  const registry = useMemo<Registry>(() => ({
    set: (id, part) => {
      if (part) parts.current.set(id, part);
      else parts.current.delete(id);
      setIds((cur) => {
        const has = cur.includes(id);
        if (part && !has) return [...cur, id];
        if (!part && has) return cur.filter((x) => x !== id);
        return cur;
      });
    },
    get: (id) => parts.current.get(id),
  }), []);
  const labels = ids.map((id) => parts.current.get(id)?.label ?? "").filter(Boolean);
  /** Save every pending part in the order they were changed. Stops at the first failure. */
  const saveAll = useCallback(async () => {
    for (const id of [...parts.current.keys()]) {
      const p = parts.current.get(id);
      if (p) await p.save();
    }
  }, []);
  const discardAll = useCallback(() => {
    for (const p of [...parts.current.values()]) p.discard();
  }, []);
  return { registry, count: ids.length, labels, saveAll, discardAll };
}

export function PendingChangesProvider({ registry, children }: { registry: Registry; children: React.ReactNode }) {
  return <Ctx.Provider value={registry}>{children}</Ctx.Provider>;
}

/**
 * Register a part's unsaved changes with the page's Save bar while `dirty`.
 * Without a provider (the part used on its own) this does nothing and returns
 * false, so the part can show its own Save button instead.
 */
export function usePendingChange(id: string, dirty: boolean, part: PendingPart): boolean {
  const reg = useContext(Ctx);
  const latest = useRef(part);
  latest.current = part;
  const stable = useMemo<PendingPart>(() => ({
    get label() { return latest.current.label; },
    save: () => latest.current.save(),
    discard: () => latest.current.discard(),
  }), []);
  useEffect(() => {
    if (!reg) return;
    reg.set(id, dirty ? stable : null);
  }, [reg, id, dirty, stable, part.label]);
  useEffect(() => () => { reg?.set(id, null); }, [reg, id]);
  return !!reg;
}

/** Small "Unsaved" marker next to a part's title. */
export function UnsavedDot({ show }: { show: boolean }) {
  if (!show) return null;
  return <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning" data-testid="badge-unsaved">Unsaved</span>;
}
