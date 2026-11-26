// Local, server-only configuration (database connection, signing secret and a
// cached password hash so sign-in still works while a database is unreachable).
// Stored as JSON in DATA_DIR/config.json and written atomically.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { type DatabaseConfig, databaseConfigSchema } from "@shared/schema";

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

export interface LocalConfig {
  database?: DatabaseConfig;
  authSecret?: string;
  passwordHashCache?: string;
  /** Last known user accounts, so sign-in still works while the database is unreachable. */
  usersCache?: unknown[];
  setupCode?: string;
  /** Key that encrypts employee PINs so owners can look them up (kept here, never in the database or backups). */
  pinKey?: string;
}

let cache: LocalConfig | null = null;
let persistent = true;

export function configIsPersistent() {
  return persistent;
}

export function loadConfig(): LocalConfig {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const db = raw.database ? databaseConfigSchema.safeParse(raw.database) : null;
    cache = { ...raw, database: db?.success ? db.data : undefined };
  } catch {
    cache = {};
  }
  return cache!;
}

export function saveConfig(patch: Partial<LocalConfig>): void {
  const next = { ...loadConfig(), ...patch };
  cache = next;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, CONFIG_PATH);
    persistent = true;
  } catch (err) {
    persistent = false;
    console.warn("[config] could not persist config.json; keeping settings in memory", err);
  }
}

export function getAuthSecret(): string {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const cfg = loadConfig();
  if (cfg.authSecret) return cfg.authSecret;
  const secret = randomBytes(32).toString("base64url");
  saveConfig({ authSecret: secret });
  return secret;
}

/** Supabase credentials supplied by the hosting environment (if any). */
export function managedSupabase(): { url: string; key: string; label: string } | null {
  for (const [k, v] of Object.entries(process.env)) {
    const m = k.match(/^CUSTOM_CRED_(.+)_SUPABASE_CO_URL$/);
    if (m && v) {
      const token = process.env[`CUSTOM_CRED_${m[1]}_SUPABASE_CO_TOKEN`] || process.env[`CUSTOM_CRED_${m[1]}_SUPABASE_CO_PROXY_AUTH_KEY`];
      if (token) return { url: v, key: token, label: `${m[1].toLowerCase()}.supabase.co` };
    }
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (url && key) return { url, key, label: new URL(url).host };
  return null;
}

/** Which database to use when nothing has been chosen in Settings yet. */
export function effectiveDatabaseConfig(): DatabaseConfig {
  const cfg = loadConfig();
  if (cfg.database) return cfg.database;
  if (managedSupabase()) return { kind: "managed" };
  return { kind: "sqlite" };
}

/** 32-byte key for encrypting employee PINs (created on first use). */
export function getPinKey(): Buffer {
  const env = process.env.PIN_KEY;
  if (env) return Buffer.from(env, "base64url").length === 32 ? Buffer.from(env, "base64url") : createHash("sha256").update(env).digest();
  const cfg = loadConfig();
  if (cfg.pinKey) return Buffer.from(cfg.pinKey, "base64url");
  const key = randomBytes(32);
  saveConfig({ pinKey: key.toString("base64url") });
  return key;
}
