// Holds the active data store and lets Settings switch databases at runtime.
import path from "node:path";
import type { DatabaseConfig, DatabaseHealth } from "@shared/schema";
import { DATA_DIR, effectiveDatabaseConfig, managedSupabase, saveConfig } from "../config";
import { SqliteStore } from "./sqlite";
import { SupabaseStore } from "./supabase";
import { type DataStore, StoreError } from "./types";

let active: DataStore | null = null;
let activeConfig: DatabaseConfig | null = null;
let initError: string | null = null;
let initPromise: Promise<void> | null = null;

export function createStore(cfg: DatabaseConfig): DataStore {
  if (cfg.kind === "sqlite") return new SqliteStore(cfg.path ? path.resolve(DATA_DIR, cfg.path) : path.join(DATA_DIR, "payroll.db"));
  if (cfg.kind === "supabase") return new SupabaseStore(cfg.url, cfg.key);
  const m = managedSupabase();
  if (!m) throw new StoreError("No managed database credentials are available on this server.", 400);
  const proxy = Object.keys(process.env).some((k) => /^CUSTOM_CRED_.+_SUPABASE_CO_(TOKEN|PROXY_AUTH_KEY)$/.test(k) && process.env[k] === m.key);
  return new SupabaseStore(m.url, m.key, { label: `${m.label} (managed)`, proxy });
}

export function initDatabase(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const cfg = effectiveDatabaseConfig();
    try {
      const store = createStore(cfg);
      await store.init();
      active = store;
      activeConfig = cfg;
      initError = null;
    } catch (err: any) {
      initError = err.message;
      activeConfig = cfg;
      console.error("[db] could not connect:", err.message);
    }
  })();
  return initPromise;
}

/** Retry a failed startup connection (e.g. the network was down). */
export async function retryInit() {
  if (active) return;
  initPromise = null;
  await initDatabase();
}

export async function db(): Promise<DataStore> {
  await initDatabase();
  if (!active) {
    await retryInit();
    if (!active) throw new StoreError(`Database is not connected: ${initError ?? "unknown error"}. Check Settings → Database.`, 503);
  }
  return active;
}

/** Close the active store (used on shutdown). */
export function closeDatabase() {
  try { active?.close(); } catch { /* ignore */ }
  active = null;
  initPromise = null;
}

export function dbStatus() {
  return { config: activeConfig, connected: !!active, error: initError, label: active?.label ?? null, kind: active?.kind ?? activeConfig?.kind ?? null };
}

export async function testDatabase(cfg: DatabaseConfig): Promise<DatabaseHealth> {
  let store: DataStore | null = null;
  try {
    store = createStore(cfg);
    await store.init().catch(() => undefined); // health() reports the specifics
    return await store.health();
  } catch (err: any) {
    return { ok: false, kind: cfg.kind, label: cfg.kind, latencyMs: null, error: err.message, missingTables: [], missingColumns: [], timesheetCount: null };
  } finally {
    if (store && store !== active) store.close();
  }
}

export interface SwitchResult { health: DatabaseHealth; copied: { settings: number; timesheets: number } | null }

export async function switchDatabase(cfg: DatabaseConfig, opts: { copyData: boolean }): Promise<SwitchResult> {
  const next = createStore(cfg);
  await next.init().catch(() => undefined);
  const health = await next.health();
  if (!health.ok) { next.close(); throw new StoreError(health.error ?? "Could not connect to the database.", 400); }

  let copied: SwitchResult["copied"] = null;
  const prev = active;
  if (prev) {
    const settings = await prev.allSettings();
    if (opts.copyData) {
      const rows = await prev.allTimesheets();
      const timesheets = rows.map(({ updated_at: _u, ...rest }) => rest);
      try {
        copied = await next.importAll({ settings, timesheets });
      } catch (err: any) {
        next.close();
        throw new StoreError(`Nothing was switched: copying data failed (${err.message}).`, 400);
      }
    } else {
      // Always carry the sign-in accounts so nobody is locked out
      for (const key of ["password_hash", "users"]) {
        const v = settings.find((s) => s.key === key);
        if (v && !(await next.getSetting(key))) await next.setSetting(key, v.value);
      }
    }
  }
  active = next;
  activeConfig = cfg;
  initError = null;
  saveConfig({ database: cfg });
  if (prev && prev !== next) prev.close();
  return { health: await next.health(), copied };
}
