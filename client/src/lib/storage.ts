// localStorage can be unavailable (private mode, sandboxed iframes). Fall back to memory.
const memory = new Map<string, string>();

function ls(): Storage | null {
  try {
    const s = window.localStorage;
    const k = "__probe__";
    s.setItem(k, k);
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}
const store = typeof window !== "undefined" ? ls() : null;

export const safeStorage = {
  get(key: string): string | null {
    try { return store ? store.getItem(key) : memory.get(key) ?? null; } catch { return memory.get(key) ?? null; }
  },
  set(key: string, value: string) {
    memory.set(key, value);
    try { store?.setItem(key, value); } catch { /* quota or blocked */ }
  },
  remove(key: string) {
    memory.delete(key);
    try { store?.removeItem(key); } catch { /* ignore */ }
  },
  getJSON<T>(key: string, fallback: T): T {
    const v = this.get(key);
    if (!v) return fallback;
    try { return JSON.parse(v) as T; } catch { return fallback; }
  },
  setJSON(key: string, value: unknown) {
    this.set(key, JSON.stringify(value));
  },
};
