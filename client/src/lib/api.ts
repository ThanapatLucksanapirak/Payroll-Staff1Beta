import { QueryClient } from "@tanstack/react-query";
import { safeStorage } from "./storage";

const RAW_BASE: string = (window as any).__API_BASE__ ?? "";
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);
if (RAW_BASE.startsWith("__PORT_") && !LOCAL.has(location.hostname) && location.protocol !== "http:") {
  console.error("Backend proxy placeholder was not rewritten");
}
const API_BASE = RAW_BASE.startsWith("__PORT_") ? "" : RAW_BASE;
const TOKEN_KEY = "payroll.session";

let token: string | null = safeStorage.get(TOKEN_KEY);
const listeners = new Set<() => void>();

export const session = {
  get: () => token,
  set(t: string, persist = true) {
    token = t;
    if (persist) safeStorage.set(TOKEN_KEY, t);
    else safeStorage.remove(TOKEN_KEY);
    listeners.forEach((l) => l());
  },
  clear() {
    token = null;
    safeStorage.remove(TOKEN_KEY);
    listeners.forEach((l) => l());
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};

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
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.raw) { body = opts.raw as BodyInit; headers["Content-Type"] = opts.contentType ?? "application/octet-stream"; }
  else if (data !== undefined) { body = JSON.stringify(data); headers["Content-Type"] = "application/json"; }
  const attempts = method === "GET" ? 3 : 1;
  try {
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(`${API_BASE}${url}`, { method, headers, body, signal: controller.signal });
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
