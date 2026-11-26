// Automatic backups. Every day (and on demand) the whole database is written
// to DATA_DIR/backups as a compressed JSON export that can be restored from
// Settings → Data on any database type. Local SQLite databases also get an
// exact copy of the database file. Old backups are pruned.
import fs from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { DATA_DIR } from "./config";
import { db } from "./db";

export const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(DATA_DIR, "backups"));
const KEEP = Math.max(1, Number.parseInt(process.env.BACKUP_KEEP || "", 10) || 30);
const DAY = 86_400_000;
const NAME = /^payroll-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})(?:-(manual|auto|pre-restore))?\.(json\.gz|db)$/;

export interface BackupFile { name: string; size: number; createdAt: string; kind: "export" | "database"; reason: string }

export function exportPayload(settings: { key: string; value: string }[], timesheets: unknown[], punches: unknown[] = []) {
  return { app: "payroll-admin", version: 2, exportedAt: new Date().toISOString(), settings, timesheets, punches };
}

/** Settings that never go into a backup export (offsite credentials and status). */
export const NEVER_BACKED_UP = (key: string) => key.startsWith("offsite:");

type BackupHook = (files: BackupFile[], reason: "auto" | "manual") => Promise<void> | void;
const hooks: BackupHook[] = [];
/** Run after each automatic or manual backup (e.g. the offsite copy). Never blocks or fails the backup. */
export function onBackupWritten(fn: BackupHook) { hooks.push(fn); }

let running: Promise<BackupFile[]> | null = null;

/** Write a backup now. Concurrent calls share one run. */
export function runBackup(reason: "auto" | "manual" | "pre-restore" = "manual"): Promise<BackupFile[]> {
  if (running) return running;
  running = (async () => {
    const store = await db();
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    // One name per backup: two backups in the same second (e.g. several restores
    // in a row) take the next free second instead of overwriting each other.
    let t = Date.now();
    let base = "";
    for (let i = 0; i < 3600; i++, t += 1000) {
      const stamp = new Date(t).toISOString().slice(0, 19).replace(/:/g, "-");
      base = path.join(BACKUP_DIR, `payroll-${stamp}-${reason}`);
      if (!fs.existsSync(`${base}.json.gz`) && !fs.existsSync(`${base}.db`)) break;
    }
    const payload = exportPayload((await store.allSettings()).filter((s) => !NEVER_BACKED_UP(s.key)), await store.allTimesheets(), await store.allPunches().catch(() => []));
    const tmp = `${base}.json.gz.tmp`;
    fs.writeFileSync(tmp, gzipSync(JSON.stringify(payload)), { mode: 0o600 });
    fs.renameSync(tmp, `${base}.json.gz`);
    if (store.snapshotTo) await store.snapshotTo(`${base}.db`).catch((err) => console.warn("[backup] database copy failed:", err.message));
    prune();
    console.log(`[backup] ${reason} backup written (${payload.timesheets.length} timesheets)`);
    const files = listBackups().filter((b) => b.name.startsWith(path.basename(base)));
    if (reason !== "pre-restore") {
      for (const fn of hooks) {
        setImmediate(() => {
          Promise.resolve().then(() => fn(files, reason)).catch((err) => console.error("[backup] after-backup step failed:", err?.message ?? err));
        });
      }
    }
    return files;
  })().finally(() => { running = null; });
  return running;
}

export function listBackups(): BackupFile[] {
  let names: string[] = [];
  try { names = fs.readdirSync(BACKUP_DIR); } catch { return []; }
  const out: BackupFile[] = [];
  for (const name of names) {
    const m = name.match(NAME);
    if (!m) continue;
    try {
      const st = fs.statSync(path.join(BACKUP_DIR, name));
      out.push({
        name, size: st.size, createdAt: st.mtime.toISOString(),
        kind: m[3] === "db" ? "database" : "export", reason: m[2] ?? "auto",
      });
    } catch { /* removed meanwhile */ }
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

/** Resolve a backup name to a path inside BACKUP_DIR (rejects anything else). */
export function backupPath(name: string): string | null {
  if (!NAME.test(name)) return null;
  const p = path.join(BACKUP_DIR, name);
  return fs.existsSync(p) ? p : null;
}

export function readBackup(name: string): any {
  const p = backupPath(name);
  if (!p || !name.endsWith(".json.gz")) throw Object.assign(new Error("Backup not found."), { status: 404 });
  return JSON.parse(gunzipSync(fs.readFileSync(p)).toString("utf8"));
}

function prune() {
  for (const kind of ["export", "database"] as const) {
    const list = listBackups().filter((b) => b.kind === kind);
    for (const b of list.slice(KEEP)) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, b.name)); } catch { /* ignore */ }
    }
  }
}

let timer: NodeJS.Timeout | null = null;

/** Back up once a day; also right away if the newest automatic backup is older than a day. */
export function scheduleBackups() {
  if (process.env.BACKUPS === "off") return;
  const check = () => {
    const last = listBackups().find((b) => b.reason === "auto" && b.kind === "export");
    if (!last || Date.now() - Date.parse(last.createdAt) > DAY - 60_000) {
      runBackup("auto").catch((err) => console.error("[backup] automatic backup failed:", err.message));
    }
  };
  setTimeout(check, 30_000).unref();
  timer = setInterval(check, 60 * 60_000);
  timer.unref();
}

export function stopBackups() {
  if (timer) clearInterval(timer);
  timer = null;
}
