// Append-only activity log.
//
// With the local SQLite database, entries are appended (one JSON line each) to
// DATA_DIR/audit/YYYY-MM.jsonl, so a write never rewrites the month. With
// Supabase (or AUDIT_STORAGE=settings) they are stored per month in the
// app_settings key/value table under "audit:YYYY-MM" (a JSON array, newest
// last, capped). Reads always merge both, so entries written before the switch
// to files (in "audit:YYYY-MM") still show. Writes are queued and applied one
// batch at a time in this process, so entries are never lost to concurrent
// read-modify-writes.
// Repeated saves of the same item by the same person within a few minutes are
// folded into one entry (with a count) so autosave doesn't flood the log.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import { db } from "./db";
import type { DataStore } from "./db/types";
import { DATA_DIR } from "./config";
import type { UserRecord } from "./users";

export interface AuditEntry {
  id: string;
  at: string;
  userId: string | null;
  userName: string;
  action: string;
  target: string;
  detail: string;
  ip: string;
  /** How many events were folded into this entry (coalesced autosaves). */
  count?: number;
}

export const AUDIT_PREFIX = "audit:";
export const MAX_PER_MONTH = Math.max(100, Number.parseInt(process.env.AUDIT_MAX_PER_MONTH || "", 10) || 20_000);
export const COALESCE_MS = 5 * 60_000;
/** Actions whose repeats are folded together. */
const COALESCE = new Set(["timesheet.update", "wages.update", "settings.update"]);

const monthKey = (iso: string) => `${AUDIT_PREFIX}${iso.slice(0, 7)}`;
const clip = (s: unknown, n = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

let queue: AuditEntry[] = [];
let flushing: Promise<void> = Promise.resolve();

/** Who did it, from a request (or explicitly). */
export function actorOf(req: Request, res: Response, user?: Pick<UserRecord, "id" | "username" | "displayName"> | null) {
  const u = user ?? (res.locals.user as UserRecord | undefined) ?? null;
  return { userId: u?.id ?? null, userName: u ? (u.displayName && u.displayName !== u.username ? `${u.displayName} (${u.username})` : u.username) : "", ip: req.ip ?? "" };
}

/** Record an event. Never throws; writing happens in the background. */
export function audit(e: { userId: string | null; userName: string; ip: string; action: string; target?: string; detail?: string; at?: string }) {
  queue.push({
    id: randomUUID().slice(0, 12),
    at: e.at ?? new Date().toISOString(),
    userId: e.userId,
    userName: clip(e.userName, 120),
    action: e.action,
    target: clip(e.target, 200),
    detail: clip(e.detail),
    ip: clip(e.ip, 64),
  });
  void flushAudit();
}

function parse(raw: string | null | undefined): AuditEntry[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function append(list: AuditEntry[], e: AuditEntry) {
  if (COALESCE.has(e.action)) {
    const t = Date.parse(e.at);
    for (let i = list.length - 1; i >= Math.max(0, list.length - 200); i--) {
      const p = list[i];
      if (t - Date.parse(p.at) > COALESCE_MS) break;
      if (p.action === e.action && p.userId === e.userId && p.target === e.target) {
        list.splice(i, 1);
        list.push({ ...p, at: e.at, detail: e.detail || p.detail, ip: e.ip || p.ip, count: (p.count ?? 1) + 1 });
        return;
      }
    }
  }
  list.push(e);
}

// ── Append-only files (local SQLite) ─────────────────────────────────────────
/** Append to files rather than rewriting a settings value (local database only). */
const useFiles = (store: DataStore) => store.kind === "sqlite" && process.env.AUDIT_STORAGE !== "settings";
const auditFile = (key: string) => path.join(DATA_DIR, "audit", `${key.slice(AUDIT_PREFIX.length).replace(/[^0-9-]/g, "")}.jsonl`);
/** How many recent entries per month are kept in memory to fold repeated autosaves. */
const TAIL = 200;
const tails = new Map<string, AuditEntry[]>();

async function readFileEntries(key: string): Promise<AuditEntry[]> {
  let text: string;
  try { text = await fs.promises.readFile(auditFile(key), "utf8"); } catch { return []; }
  const out: AuditEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && typeof e === "object" && e.id && e.at) out.push(e); } catch { /* a torn last line */ }
  }
  return out;
}

/** Settings entries, then appended ones; a later line with the same id (a folded autosave) replaces the earlier one. */
function mergeMonth(...lists: AuditEntry[][]): AuditEntry[] {
  const byId = new Map<string, AuditEntry>();
  for (const list of lists) for (const e of list) { byId.delete(e.id); byId.set(e.id, e); }
  const all = [...byId.values()];
  return all.length > MAX_PER_MONTH ? all.slice(all.length - MAX_PER_MONTH) : all;
}

async function appendToFile(store: DataStore, key: string, entries: AuditEntry[]) {
  const tk = `${store.label}|${key}`;
  let tail = tails.get(tk);
  if (!tail) tail = mergeMonth(parse(await store.getSetting(key)), await readFileEntries(key)).slice(-TAIL);
  const lines: string[] = [];
  for (const e of entries) {
    append(tail, e);
    lines.push(JSON.stringify(tail[tail.length - 1]));
  }
  if (tail.length > TAIL) tail.splice(0, tail.length - TAIL);
  tails.set(tk, tail);
  await fs.promises.mkdir(path.dirname(auditFile(key)), { recursive: true, mode: 0o700 });
  await fs.promises.appendFile(auditFile(key), `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

/** Audit files from before the mode was tightened are 0644: make the folder and its files private (best effort). */
export function hardenAuditFiles() {
  const dir = path.dirname(auditFile(AUDIT_PREFIX));
  try {
    fs.chmodSync(dir, 0o700);
    for (const name of fs.readdirSync(dir)) {
      try { fs.chmodSync(path.join(dir, name), 0o600); } catch { /* ignore */ }
    }
  } catch { /* no audit folder yet, or a file system without modes */ }
}

/** Write everything queued so far. Resolves when it is stored (or dropped after an error). */
export function flushAudit(): Promise<void> {
  flushing = flushing.then(async () => {
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    try {
      const store = await db();
      const byMonth = new Map<string, AuditEntry[]>();
      for (const e of batch) {
        const k = monthKey(e.at);
        byMonth.set(k, [...(byMonth.get(k) ?? []), e]);
      }
      if (useFiles(store)) {
        for (const [k, entries] of byMonth) await appendToFile(store, k, entries);
        return;
      }
      for (const [k, entries] of byMonth) {
        const list = parse(await store.getSetting(k));
        for (const e of entries) append(list, e);
        if (list.length > MAX_PER_MONTH) list.splice(0, list.length - MAX_PER_MONTH);
        await store.setSetting(k, JSON.stringify(list));
      }
    } catch (err: any) {
      console.error(`[audit] could not record ${batch.length} event(s): ${err?.message ?? err}`);
    }
  });
  return flushing;
}

export interface AuditQuery { user?: string; action?: string; from?: string; to?: string; q?: string; limit?: number; offset?: number }

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = to.slice(0, 7).split("-").map(Number);
  const stop = from.slice(0, 7);
  for (let i = 0; i < 120; i++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push(`${AUDIT_PREFIX}${key}`);
    if (key <= stop) break;
    m--; if (m === 0) { m = 12; y--; }
  }
  return out;
}

/** Newest first, with filters and paging. Without `from`, looks back two years. */
export async function queryAudit(q: AuditQuery): Promise<{ entries: AuditEntry[]; total: number; actions: string[] }> {
  await flushAudit();
  const store = await db();
  const to = q.to || new Date().toISOString().slice(0, 10);
  const from = q.from || new Date(Date.parse(`${to}T00:00:00Z`) - 730 * 86_400_000).toISOString().slice(0, 10);
  const day = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const keys = monthsBetween(day(from, -1), day(to, 1)); // entries are filed by UTC month
  const raw = await store.getSettings(keys);
  const files = useFiles(store) ? await Promise.all(keys.map(readFileEntries)) : keys.map(() => []);
  let all: AuditEntry[] = keys.flatMap((k, i) => mergeMonth(parse(raw[k]), files[i]));
  const actions = [...new Set(all.map((e) => e.action))].sort();
  const fromT = Date.parse(`${from}T00:00:00`);
  const toT = Date.parse(`${to}T23:59:59.999`);
  all = all.filter((e) => { const t = Date.parse(e.at); return t >= fromT && t <= toT; });
  if (q.user) {
    const u = q.user.toLowerCase();
    all = all.filter((e) => e.userId === q.user || e.userName.toLowerCase().includes(u));
  }
  if (q.action) all = all.filter((e) => e.action === q.action || e.action.startsWith(`${q.action}.`));
  if (q.q) {
    const s = q.q.toLowerCase();
    all = all.filter((e) => `${e.target} ${e.detail} ${e.ip}`.toLowerCase().includes(s));
  }
  all.sort((a, b) => b.at.localeCompare(a.at));
  const offset = Math.max(0, q.offset ?? 0);
  const limit = Math.min(500, Math.max(1, q.limit ?? 50));
  return { entries: all.slice(offset, offset + limit), total: all.length, actions };
}

// ── Automatic entries for API changes ────────────────────────────────────────
interface Hook {
  method: string;
  path: RegExp;
  action: string | ((req: Request, body: any) => string);
  target?: (req: Request, body: any, m: RegExpMatchArray) => string;
  detail?: (req: Request, body: any) => string;
}

const keys = (o: unknown) => (o && typeof o === "object" ? Object.keys(o).join(", ") : "");
const ts = (_r: Request, _b: any, m: RegExpMatchArray) => `timesheet:${decodeURIComponent(m[1])}`;
const site = (_r: Request, _b: any, m: RegExpMatchArray) => `site:${decodeURIComponent(m[1])}`;

const HOOKS: Hook[] = [
  { method: "POST", path: /^\/timesheets$/, action: "timesheet.create", target: (_r, b) => `timesheet:${b?.id ?? ""}`, detail: (r) => r.body?.doc?.label || r.body?.doc?.filename || "" },
  { method: "PUT", path: /^\/timesheets\/([^/]+)$/, action: "timesheet.update", target: ts, detail: (r) => r.body?.doc?.label || "" },
  {
    method: "PATCH", path: /^\/timesheets\/([^/]+)$/, target: ts,
    action: (r) => (r.body?.status === "final" ? "timesheet.finalize" : r.body?.status === "draft" ? "timesheet.reopen" : r.body?.siteId ? "timesheet.move" : "timesheet.rename"),
    detail: (r) => [r.body?.label !== undefined ? `label "${r.body.label}"` : "", r.body?.siteId ? `location ${r.body.siteId}` : ""].filter(Boolean).join(", "),
  },
  { method: "POST", path: /^\/timesheets\/([^/]+)\/duplicate$/, action: "timesheet.duplicate", target: ts, detail: (_r, b) => (b?.id ? `copy ${b.id}` : "") },
  { method: "POST", path: /^\/timesheets\/([^/]+)\/restore$/, action: "timesheet.restore", target: ts },
  { method: "DELETE", path: /^\/timesheets\/([^/]+)$/, action: (r) => (r.query.permanent === "1" ? "timesheet.delete" : "timesheet.trash"), target: ts },
  { method: "DELETE", path: /^\/trash$/, action: "timesheet.empty-trash", detail: (_r, b) => `${b?.removed ?? 0} removed` },
  { method: "PUT", path: /^\/prefs$/, action: "settings.update", target: () => "preferences", detail: (r) => keys(r.body) },
  { method: "POST", path: /^\/sites$/, action: "site.create", target: (_r, b) => `site:${b?.id ?? ""}`, detail: (r) => r.body?.name ?? "" },
  { method: "PUT", path: /^\/sites\/([^/]+)$/, action: "site.update", target: site, detail: (r) => keys(r.body) },
  { method: "DELETE", path: /^\/sites\/([^/]+)$/, action: "site.delete", target: site },
  { method: "PUT", path: /^\/categories$/, action: "categories.update", target: () => "categories", detail: (r) => (Array.isArray(r.body) ? `${r.body.length} categories` : "") },
  { method: "PUT", path: /^\/sites\/([^/]+)\/wages$/, action: "wages.update", target: site, detail: (_r, b) => `${b?.saved ?? 0} saved` },
  { method: "PUT", path: /^\/sites\/([^/]+)\/square$/, action: "square.connect", target: site },
  { method: "DELETE", path: /^\/sites\/([^/]+)\/square$/, action: "square.disconnect", target: site },
  { method: "POST", path: /^\/database\/switch$/, action: "database.switch", target: (r) => `database:${r.body?.config?.kind ?? ""}`, detail: (r) => (r.body?.copyData ? "data copied" : "") },
  { method: "GET", path: /^\/backup$/, action: "backup.export", detail: (r) => (r.query.secrets === "1" ? "including secrets" : "") },
  { method: "POST", path: /^\/backup\/restore$/, action: "backup.restore", target: () => "uploaded file", detail: (_r, b) => (b ? `${b.settings ?? 0} settings, ${b.timesheets ?? 0} timesheets` : "") },
  { method: "POST", path: /^\/backups$/, action: "backup.create", target: () => "server backup" },
  { method: "GET", path: /^\/backups\/([^/]+)$/, action: "backup.download", target: (_r, _b, m) => decodeURIComponent(m[1]) },
  { method: "POST", path: /^\/backups\/([^/]+)\/restore$/, action: "backup.restore", target: (_r, _b, m) => decodeURIComponent(m[1]), detail: (_r, b) => (b ? `${b.settings ?? 0} settings, ${b.timesheets ?? 0} timesheets` : "") },
];

/** Middleware: after a successful change, record it. Mount on /api after authentication. */
export function auditTrail() {
  return (req: Request, res: Response, next: NextFunction) => {
    const hook = HOOKS.find((h) => h.method === req.method && h.path.test(req.path));
    if (!hook) return next();
    const m = req.path.match(hook.path)!;
    let body: unknown;
    const json = res.json.bind(res);
    res.json = (b: unknown) => { body = b; return json(b); };
    res.on("finish", () => {
      if (res.statusCode >= 400) return;
      try {
        audit({
          ...actorOf(req, res),
          action: typeof hook.action === "function" ? hook.action(req, body) : hook.action,
          target: hook.target?.(req, body, m) ?? "",
          detail: hook.detail?.(req, body) ?? "",
        });
      } catch (err) {
        console.error("[audit]", err);
      }
    });
    next();
  };
}
