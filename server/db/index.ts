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
      for (const s of settings) await next.setSetting(s.key, s.value);
      const rows = await prev.allTimesheets();
      for (const r of rows) {
        const { id, created_at, updated_at: _u, ...rest } = r;
        await next.insertTimesheet({ ...rest, id, created_at });
      }
      copied = { settings: settings.length, timesheets: rows.length };
    } else {
      // Always carry the admin password so the user is not locked out
      const pw = settings.find((s) => s.key === "password_hash");
      if (pw && !(await next.getSetting("password_hash"))) await next.setSetting("password_hash", pw.value);
    }
  }
  active = next;
  activeConfig = cfg;
  initError = null;
  saveConfig({ database: cfg });
  if (prev && prev !== next) prev.close();
  return { health: await next.health(), copied };
}
