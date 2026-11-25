// Kiosk ↔ server. The device token lives in localStorage and is sent as
// X-Kiosk-Token; the kiosk never uses the admin session.
//
// Offline: punches that can't be sent are kept in a local queue with the
// device's timestamp and a client-generated id, and are replayed in order when
// the connection is back. The server ignores ids it has already stored.
import type { ClockStatus, PunchType } from "@shared/punches";
import { safeStorage } from "@/lib/storage";

const TOKEN_KEY = "kiosk.token";
const STATE_KEY = "kiosk.state";
const QUEUE_KEY = "kiosk.queue";
const OFFSET_KEY = "kiosk.clockOffset";

export interface RosterEmployee { id: string; name: string; role: string; status: ClockStatus; since: string | null }
export interface KioskState {
  device: { id: string; name: string };
  site: { id: string; name: string; color: string; timezone: string; loginMode: "pin" | "name_pin"; enabled: boolean };
  serverTime: string;
  employees: RosterEmployee[];
}
export interface Identified {
  employee: { id: string; name: string; role: string };
  status: ClockStatus;
  since: string | null;
  shiftStart?: string | null;
  todayMinutes: number;
  actions: PunchType[];
  ticket?: string;
}
export interface PunchResult {
  punch: { id: string; type: PunchType; at: string };
  employee: { id: string; name: string };
  status: ClockStatus;
  since: string | null;
  todayMinutes: number;
  duplicate: boolean;
}
export interface QueuedPunch { id: string; type: PunchType; employeeId: string; name: string; pin: string; at: string; tries: number }

export class KioskError extends Error {
  constructor(public status: number, message: string, public code?: string, public body?: any) { super(message); }
  /** No answer from the server (offline, timeout, or the server is down). */
  get offline() { return this.status === 0 || this.status >= 502; }
}

export const token = {
  get: () => safeStorage.get(TOKEN_KEY),
  set: (t: string) => safeStorage.set(TOKEN_KEY, t),
  clear: () => { safeStorage.remove(TOKEN_KEY); safeStorage.remove(STATE_KEY); },
};

export async function request<T>(method: string, url: string, body?: unknown, timeoutMs = 8000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const headers: Record<string, string> = {};
  const t = token.get();
  if (t) headers["X-Kiosk-Token"] = t;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal, cache: "no-store" });
  } catch {
    throw new KioskError(0, "No connection to the server.");
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => "");
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new KioskError(res.status, json?.error || res.statusText || "Something went wrong.", json?.code, json);
  return json as T;
}

// ── Cached state (used while offline) ─────────────────────────────────────────
export const cache = {
  get: () => safeStorage.getJSON<KioskState | null>(STATE_KEY, null),
  set: (s: KioskState) => safeStorage.setJSON(STATE_KEY, s),
};

/** Server clock minus device clock, so offline punches carry server-aligned times. */
export const clockOffset = {
  get: () => Number(safeStorage.get(OFFSET_KEY)) || 0,
  set: (ms: number) => safeStorage.set(OFFSET_KEY, String(Math.round(ms))),
};
export const serverNow = () => Date.now() + clockOffset.get();

// ── Offline queue ─────────────────────────────────────────────────────────────
export const queue = {
  all: () => safeStorage.getJSON<QueuedPunch[]>(QUEUE_KEY, []),
  save: (q: QueuedPunch[]) => safeStorage.setJSON(QUEUE_KEY, q),
  add(p: QueuedPunch) { this.save([...this.all(), p]); },
};

/** A random v4 UUID. crypto.randomUUID needs HTTPS; getRandomValues works everywhere. */
export function uuid(): string {
  const c: Crypto | undefined = (globalThis as any).crypto;
  if (c?.randomUUID) { try { return c.randomUUID(); } catch { /* insecure context */ } }
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface FlushResult { sent: number; rejected: { item: QueuedPunch; message: string }[]; unpaired: boolean; remaining: number }

let flushing: Promise<FlushResult> | null = null;
/** Send queued punches in order. Stops at the first one that can't be sent yet. */
export function flushQueue(): Promise<FlushResult> {
  if (flushing) return flushing;
  flushing = (async () => {
    const out: FlushResult = { sent: 0, rejected: [], unpaired: false, remaining: 0 };
    for (;;) {
      const q = queue.all();
      const item = q[0];
      if (!item) break;
      try {
        await request<PunchResult>("POST", "/api/kiosk/punch", { id: item.id, type: item.type, pin: item.pin, employeeId: item.employeeId, at: item.at });
        out.sent++;
        queue.save(queue.all().filter((x) => x.id !== item.id));
      } catch (err) {
        const e = err as KioskError;
        if (e.code === "device") { out.unpaired = true; break; }
        if (e.offline || e.status === 429 || e.status >= 500) {
          queue.save(queue.all().map((x) => (x.id === item.id ? { ...x, tries: x.tries + 1 } : x)));
          break;
        }
        // The server answered and refused it (wrong PIN, impossible sequence, too old): drop it.
        out.rejected.push({ item, message: e.message });
        queue.save(queue.all().filter((x) => x.id !== item.id));
      }
    }
    out.remaining = queue.all().length;
    return out;
  })().finally(() => { flushing = null; });
  return flushing;
}
