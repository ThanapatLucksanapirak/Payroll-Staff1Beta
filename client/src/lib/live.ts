// Live updates from the server (Server-Sent Events). EventSource cannot send
// the Authorization header, so each connection first gets a short-lived ticket
// from POST /api/live/ticket. One shared connection serves every subscriber,
// and it reconnects by itself (with a fresh ticket) after any drop.
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Punch } from "@shared/punches";
import { api } from "./api";

export interface PunchEvent { type: "punch"; action: "created" | "updated" | "deleted"; siteId: string; punch: Punch; note?: string }
export type LiveEvent = PunchEvent | { type: string; siteId?: string; [k: string]: unknown };

type Listener = (e: LiveEvent) => void;
const listeners = new Set<Listener>();
const statusListeners = new Set<() => void>();
let connected = false;
let es: EventSource | null = null;
let retryTimer: number | null = null;
let attempt = 0;
let connecting = false;

function setConnected(v: boolean) {
  if (connected === v) return;
  connected = v;
  statusListeners.forEach((l) => l());
}

function dispatch(raw: MessageEvent) {
  try {
    const e = JSON.parse(raw.data) as LiveEvent;
    listeners.forEach((l) => l(e));
  } catch { /* ignore malformed */ }
}

async function connect() {
  if (es || connecting || !listeners.size) return;
  connecting = true;
  try {
    const { ticket } = await api<{ ticket: string }>("POST", "/api/live/ticket");
    if (!listeners.size) return;
    const source = new EventSource(`/api/live?ticket=${encodeURIComponent(ticket)}`);
    es = source;
    source.onopen = () => { attempt = 0; setConnected(true); };
    source.addEventListener("hello", () => { attempt = 0; setConnected(true); listeners.forEach((l) => l({ type: "hello" })); });
    source.addEventListener("punch", dispatch as EventListener);
    source.onerror = () => {
      // The ticket is single-connection in spirit and expires quickly: always start over.
      source.close();
      if (es === source) es = null;
      setConnected(false);
      schedule();
    };
  } catch {
    setConnected(false);
    schedule();
  } finally {
    connecting = false;
  }
}

function schedule() {
  if (retryTimer != null || !listeners.size) return;
  const delay = Math.min(30_000, [1000, 2000, 5000, 10_000, 20_000][attempt] ?? 30_000);
  attempt++;
  retryTimer = window.setTimeout(() => { retryTimer = null; void connect(); }, delay);
}

function disconnectIfIdle() {
  if (listeners.size) return;
  es?.close();
  es = null;
  if (retryTimer != null) { clearTimeout(retryTimer); retryTimer = null; }
  setConnected(false);
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => { if (!es && listeners.size) { attempt = 0; void connect(); } });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !es && listeners.size) { attempt = 0; if (retryTimer != null) { clearTimeout(retryTimer); retryTimer = null; } void connect(); } });
}

/** Subscribe to live events while the component is mounted. Returns whether the stream is connected. */
export function useLiveEvents(onEvent: Listener): boolean {
  const ref = useRef(onEvent);
  ref.current = onEvent;
  useEffect(() => {
    const l: Listener = (e) => ref.current(e);
    listeners.add(l);
    void connect();
    return () => { listeners.delete(l); disconnectIfIdle(); };
  }, []);
  return useSyncExternalStore((fn) => { statusListeners.add(fn); return () => { statusListeners.delete(fn); }; }, () => connected);
}
