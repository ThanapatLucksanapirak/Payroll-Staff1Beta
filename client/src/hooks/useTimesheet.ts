import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { TimesheetDoc, TimesheetSummary } from "@shared/schema";
import { api, ApiError, errorMessage, queryClient } from "@/lib/api";
import { toast } from "@/hooks/use-toast";
import { safeStorage } from "@/lib/storage";

const unsavedKey = (id: string) => `payroll.unsaved.${id}`;

interface State {
  doc: TimesheetDoc | null;
  past: TimesheetDoc[];
  future: TimesheetDoc[];
  version: number;
  lastKey: string | null;
  lastAt: number;
}

type Action =
  | { type: "load"; doc: TimesheetDoc }
  | { type: "edit"; fn: (d: TimesheetDoc) => TimesheetDoc; key?: string }
  | { type: "undo" }
  | { type: "redo" };

const LIMIT = 80;

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "load":
      return { doc: a.doc, past: [], future: [], version: 0, lastKey: null, lastAt: 0 };
    case "edit": {
      if (!s.doc) return s;
      const next = a.fn(s.doc);
      if (next === s.doc) return s;
      const now = Date.now();
      const coalesce = a.key && a.key === s.lastKey && now - s.lastAt < 1500;
      return {
        doc: next,
        past: coalesce ? s.past : [...s.past.slice(-LIMIT), s.doc],
        future: [],
        version: s.version + 1,
        lastKey: a.key ?? null,
        lastAt: now,
      };
    }
    case "undo": {
      if (!s.doc || !s.past.length) return s;
      const prev = s.past[s.past.length - 1];
      return { ...s, doc: prev, past: s.past.slice(0, -1), future: [s.doc, ...s.future], version: s.version + 1, lastKey: null };
    }
    case "redo": {
      if (!s.doc || !s.future.length) return s;
      const [next, ...rest] = s.future;
      return { ...s, doc: next, past: [...s.past, s.doc], future: rest, version: s.version + 1, lastKey: null };
    }
  }
}

export type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";

export function useTimesheet(id: string, opts: { autosave: boolean; /** Edits, undo and redo do nothing (also while the timesheet is final). */ frozen?: boolean }) {
  const [state, dispatch] = useReducer(reducer, { doc: null, past: [], future: [], version: 0, lastKey: null, lastAt: 0 });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [legacy, setLegacy] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const savedVersion = useRef(0);
  const updatedAt = useRef<string | null>(null);
  const inflight = useRef<Promise<boolean> | null>(null);
  const retryTimer = useRef<number | null>(null);
  const retryDelay = useRef(3000);
  const mounted = useRef(true);
  const stateRef = useRef(state);
  stateRef.current = state;

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await api<{ doc: TimesheetDoc; updatedAt: string | null; legacy: boolean }>("GET", `/api/timesheets/${id}`);
      updatedAt.current = r.updatedAt;
      savedVersion.current = 0;
      setLegacy(r.legacy);
      setLastSavedAt(r.updatedAt);
      setSaveState("saved");
      dispatch({ type: "load", doc: r.doc });
      // Offer back edits that could not be saved when the timesheet was last closed.
      const raw = safeStorage.get(unsavedKey(id));
      if (raw) {
        safeStorage.remove(unsavedKey(id));
        try {
          const kept = JSON.parse(raw) as { at: number; doc: TimesheetDoc };
          if (kept?.doc && Date.now() - kept.at < 7 * 86_400_000) {
            dispatch({ type: "edit", fn: () => kept.doc });
            toast({ title: "Restored unsaved changes", description: "Edits that couldn't be saved last time are back. Use Undo to discard them." });
          }
        } catch { /* ignore a damaged copy */ }
      }
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (force = false): Promise<boolean> => {
    if (inflight.current) { await inflight.current; }
    const { doc, version } = stateRef.current;
    if (!doc) return false;
    if (version === savedVersion.current && !force) return true;
    setSaveState("saving");
    const p = (async () => {
      try {
        const r = await api<TimesheetSummary>("PUT", `/api/timesheets/${id}`, { doc, baseUpdatedAt: updatedAt.current, force });
        updatedAt.current = r.updatedAt;
        savedVersion.current = version;
        setLastSavedAt(r.updatedAt);
        setLegacy(false);
        setSaveError(null);
        retryDelay.current = 3000;
        setSaveState(stateRef.current.version === version ? "saved" : "dirty");
        queryClient.setQueryData<TimesheetSummary[]>(["/api/timesheets"], (old) => old?.map((t) => (t.id === id ? { ...t, ...r } : t)));
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.body?.locked) { setSaveState("error"); setSaveError(e.message); return false; }
        if (e instanceof ApiError && e.status === 409) { setSaveState("conflict"); setSaveError(e.message); return false; }
        setSaveState("error");
        setSaveError(errorMessage(e));
        // Retry only problems that can clear up by themselves (network, timeouts, server errors).
        const permanent = e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
        if (!permanent && mounted.current) {
          if (retryTimer.current) window.clearTimeout(retryTimer.current);
          retryTimer.current = window.setTimeout(() => { void save(); }, retryDelay.current);
          retryDelay.current = Math.min(retryDelay.current * 2, 60000);
        }
        return false;
      } finally {
        inflight.current = null;
      }
    })();
    inflight.current = p;
    return p;
  }, [id]);

  // Debounced autosave
  useEffect(() => {
    if (!state.doc || state.version === savedVersion.current) return;
    if (saveState === "saved") setSaveState("dirty");
    if (!opts.autosave || saveState === "conflict") return;
    const t = window.setTimeout(() => { void save(); }, 1200);
    return () => window.clearTimeout(t);
  }, [state.version, state.doc, opts.autosave, save, saveState]);

  // Warn before closing with unsaved changes; flush on unmount
  useEffect(() => {
    const fn = (e: BeforeUnloadEvent) => {
      if (stateRef.current.version !== savedVersion.current) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("beforeunload", fn);
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.removeEventListener("beforeunload", fn);
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
      // Leaving the timesheet with unsaved edits: save them, and say so if that fails,
      // because the editor (and its error banner) is no longer on screen.
      if (stateRef.current.version !== savedVersion.current && opts.autosave) {
        const doc = stateRef.current.doc;
        void save().then((ok) => {
          if (ok || !doc) return;
          safeStorage.set(unsavedKey(id), JSON.stringify({ at: Date.now(), base: updatedAt.current, doc }));
          toast({ title: "Your last changes weren't saved", description: "They are kept on this device. Open the timesheet again to restore them.", variant: "destructive" });
        });
      }
    };
  }, [save, opts.autosave]);

  // A finalized timesheet is locked (the server refuses changes too); reopening reloads it.
  const isFrozen = !!opts.frozen || state.doc?.status === "final";
  const frozen = useRef(isFrozen);
  frozen.current = isFrozen;
  const edit = useCallback((fn: (d: TimesheetDoc) => TimesheetDoc, key?: string) => { if (!frozen.current) dispatch({ type: "edit", fn, key }); }, []);
  const undo = useCallback(() => { if (!frozen.current) dispatch({ type: "undo" }); }, []);
  const redo = useCallback(() => { if (!frozen.current) dispatch({ type: "redo" }); }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA";
      if (e.key.toLowerCase() === "s") { e.preventDefault(); void save(); return; }
      if (typing) return;
      if (e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((e.key.toLowerCase() === "z" && e.shiftKey) || e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [save, undo, redo]);

  return {
    doc: state.doc, edit, undo, redo, canUndo: !isFrozen && state.past.length > 0, canRedo: !isFrozen && state.future.length > 0,
    save, reload: load, loadError, legacy, saveState, saveError, lastSavedAt,
    dirty: state.version !== savedVersion.current,
  };
}
