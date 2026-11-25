import { QueryClient } from "@tanstack/react-query";
import { safeStorage } from "./storage";

// The API is always served from the same origin as the app.
const API_BASE = "";
/** Phase 1 kept a bearer token here. It is sent once more so the server can swap it for a cookie. */
const LEGACY_TOKEN_KEY = "payroll.session";
/** Sent on every request; the server refuses state changes without it (CSRF protection). */
const CSRF_HEADERS = { "X-Requested-With": "payroll" };

let legacyToken: string | null = safeStorage.get(LEGACY_TOKEN_KEY);
let epoch = 0;
const listeners = new Set<() => void>();
const notify = () => { epoch++; listeners.forEach((l) => l()); };

/**
 * The session itself is an httpOnly cookie the page can't read. This only
 * tells the app when to re-check who is signed in.
 */
export const session = {
  /** Changes whenever the sign-in state may have changed. */
  get: () => epoch,
  /** Call after signing in (the server has set the cookie). The argument is ignored. */
  set(_ignored?: unknown, _persist?: boolean) { notify(); },
  /** Forget the local session state (after a 401 or signing out). */
  clear() {
    legacyToken = null;
    safeStorage.remove(LEGACY_TOKEN_KEY);
    notify();
  },
  /** The server has confirmed a cookie session; the old stored token is no longer needed. */
  dropLegacyToken() {
    legacyToken = null;
    safeStorage.remove(LEGACY_TOKEN_KEY);
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};

/** Sign out on this device, or on every device. */
export async function signOut(everywhere = false) {
  try { await api("POST", everywhere ? "/api/auth/logout-all" : "/api/auth/logout"); } catch { /* signed out locally anyway */ }
  session.clear();
  queryClient.clear();
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: any) {
    super(message);
    this.name = "ApiError";
  }
}

interface Opts { timeoutMs?: number; signal?: AbortSignal; raw?: Blob | ArrayBuffer; contentType?: string }

export async function apiRequest(method: string, url: string, data?: unknown, opts: Opts = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const headers: Record<string, string> = { ...CSRF_HEADERS };
  if (legacyToken) headers.Authorization = `Bearer ${legacyToken}`;
  let body: BodyInit | undefined;
  if (opts.raw) { body = opts.raw as BodyInit; headers["Content-Type"] = opts.contentType ?? "application/octet-stream"; }
  else if (data !== undefined) { body = JSON.stringify(data); headers["Content-Type"] = "application/json"; }
  const attempts = method === "GET" ? 3 : 1;
  try {
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(`${API_BASE}${url}`, { method, headers, body, signal: controller.signal, credentials: "same-origin" });
        if (!res.ok) {
          const text = await res.text();
          let parsed: any = null;
          try { parsed = JSON.parse(text); } catch { /* not json */ }
          if (res.status === 401 && !url.startsWith("/api/auth/")) session.clear();
          if (res.status >= 500 && res.status !== 501 && i < attempts - 1) throw new ApiError(res.status, "retry");
          throw new ApiError(res.status, parsed?.error || text || res.statusText || "Request failed", parsed);
        }
        return res;
      } catch (err) {
        const retryable = !(err instanceof ApiError) || err.message === "retry";
        if (controller.signal.aborted || !retryable || i >= attempts - 1) {
          if (err instanceof ApiError && err.message === "retry") throw new ApiError(err.status, "The server had a problem. Please try again.");
          throw err;
        }
        await new Promise((r) => setTimeout(r, 300 * 2 ** i));
      }
    }
  } catch (err) {
    if (controller.signal.aborted && !opts.signal?.aborted) throw new ApiError(408, "The request timed out. Check your connection and try again.");
    if (err instanceof TypeError) throw new ApiError(0, "Can't reach the server. Check your connection.");
    throw err;
  } finally {
    window.clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

export async function api<T = any>(method: string, url: string, data?: unknown, opts?: Opts): Promise<T> {
  const res = await apiRequest(method, url, data, opts);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? "Something went wrong");
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: ({ queryKey }) => api("GET", queryKey.join("/")),
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 1,
    },
    mutations: { retry: false },
  },
});
