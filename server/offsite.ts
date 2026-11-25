// Offsite backups: after each automatic (nightly) or manual backup, a copy of
// the export is also written to
//   - a folder (a mounted USB disk or network share), and/or
//   - an S3-compatible bucket (Amazon S3, Backblaze B2, Cloudflare R2, MinIO),
//     uploaded with a SigV4-signed PUT (node:crypto, no SDK).
// Each destination keeps the newest N copies. The copies leave out secrets
// (passwords, two-factor secrets, Square tokens, these credentials), which a
// restore never uses anyway. The configuration and last result live in app
// settings under "offsite:*", which are never put in any backup, and the
// secret key is never sent back to the browser.
import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { db } from "./db";
import { DATA_DIR } from "./config";
import { actorOf, audit } from "./audit";
import { type BackupFile, BACKUP_DIR, listBackups, onBackupWritten } from "./backup";

export const CONFIG_KEY = "offsite:config";
export const STATUS_KEY = "offsite:status";
const NAME = /^payroll-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-(?:manual|auto|pre-restore))?\.json\.gz$/;
/** An error with a message meant for the owner (answered as 400 by the routes). */
const bad = (message: string) => Object.assign(new Error(message), { status: 400 });

// ── Configuration ────────────────────────────────────────────────────────────
const keepSchema = z.coerce.number().int().min(1).max(365);
export const folderSchema = z.object({
  enabled: z.boolean().default(false),
  path: z.string().trim().max(500).default(""),
  keep: keepSchema.default(14),
});
export const s3Schema = z.object({
  enabled: z.boolean().default(false),
  /** e.g. https://s3.us-west-004.backblazeb2.com or https://<account>.r2.cloudflarestorage.com. Empty = Amazon S3 in `region`. */
  endpoint: z.string().trim().max(300).default(""),
  region: z.string().trim().max(60).default("us-east-1"),
  bucket: z.string().trim().max(100).default(""),
  prefix: z.string().trim().max(200).default("payroll/"),
  accessKeyId: z.string().trim().max(200).default(""),
  secretAccessKey: z.string().max(400).default(""),
  keep: keepSchema.default(30),
});
export const configSchema = z.object({ folder: folderSchema.default({}), s3: s3Schema.default({}) });
export type OffsiteConfig = z.infer<typeof configSchema>;
export type Target = "folder" | "s3";

export interface TargetStatus { lastSuccessAt: string | null; lastFailureAt: string | null; lastError: string | null; lastFile: string | null }
export type OffsiteStatus = Record<Target, TargetStatus>;
const emptyStatus = (): TargetStatus => ({ lastSuccessAt: null, lastFailureAt: null, lastError: null, lastFile: null });

function parse<T>(raw: string | null, schema: z.ZodType<T, z.ZodTypeDef, unknown>, fallback: T): T {
  if (!raw) return fallback;
  try { const r = schema.safeParse(JSON.parse(raw)); return r.success ? r.data : fallback; } catch { return fallback; }
}

export async function getConfig(): Promise<OffsiteConfig> {
  return parse((await (await db()).getSetting(CONFIG_KEY)), configSchema, configSchema.parse({}));
}
async function saveConfig(cfg: OffsiteConfig) {
  await (await db()).setSetting(CONFIG_KEY, JSON.stringify(configSchema.parse(cfg)));
}

export async function getStatus(): Promise<OffsiteStatus> {
  const raw = await (await db()).getSetting(STATUS_KEY).catch(() => null);
  let v: any = {};
  try { v = raw ? JSON.parse(raw) : {}; } catch { v = {}; }
  return { folder: { ...emptyStatus(), ...(v.folder ?? {}) }, s3: { ...emptyStatus(), ...(v.s3 ?? {}) } };
}

let statusChain: Promise<unknown> = Promise.resolve();
function recordStatus(target: Target, ok: boolean, detail: { file?: string; error?: string }) {
  const p = statusChain.then(async () => {
    const st = await getStatus();
    const now = new Date().toISOString();
    st[target] = ok
      ? { ...st[target], lastSuccessAt: now, lastError: null, lastFile: detail.file ?? st[target].lastFile }
      : { ...st[target], lastFailureAt: now, lastError: (detail.error ?? "Unknown error").slice(0, 300) };
    await (await db()).setSetting(STATUS_KEY, JSON.stringify(st));
  });
  statusChain = p.catch(() => undefined);
  return p;
}

/** What the browser may see: never the secret key. */
export function publicConfig(cfg: OffsiteConfig) {
  const { secretAccessKey, ...s3 } = cfg.s3;
  return { folder: cfg.folder, s3: { ...s3, hasSecret: !!secretAccessKey, secretHint: secretAccessKey ? `…${secretAccessKey.slice(-4)}` : "" } };
}

/** A destination is failing when its last attempt failed (shown on Backup and Home). */
export function failing(cfg: OffsiteConfig, st: OffsiteStatus): { target: Target; error: string; since: string }[] {
  const out: { target: Target; error: string; since: string }[] = [];
  for (const t of ["folder", "s3"] as const) {
    const s = st[t];
    if (!cfg[t].enabled || !s.lastFailureAt) continue;
    if (!s.lastSuccessAt || Date.parse(s.lastFailureAt) > Date.parse(s.lastSuccessAt)) out.push({ target: t, error: s.lastError ?? "", since: s.lastFailureAt });
  }
  return out;
}

// ── What gets copied ─────────────────────────────────────────────────────────
/** Settings left out of offsite copies (restore never uses them). */
export const isSecretSetting = (k: string) =>
  k === "password_hash" || k === "users" || k === "square_access_token" || k.startsWith("square_token:") ||
  k.startsWith("kiosk_manager_pin:") || k.startsWith("offsite:");

/** A backup export without secrets, gzipped. */
export function sanitizedExport(file: string): Buffer {
  const data = JSON.parse(gunzipSync(fs.readFileSync(file)).toString("utf8"));
  if (Array.isArray(data?.settings)) data.settings = data.settings.filter((s: any) => !isSecretSetting(String(s?.key ?? "")));
  return gzipSync(JSON.stringify(data));
}

// ── Folder ───────────────────────────────────────────────────────────────────
function checkFolder(dir: string): string {
  if (!dir) throw bad("Choose a folder.");
  if (!path.isAbsolute(dir)) throw bad("Use a full folder path, starting with /.");
  const resolved = path.resolve(dir);
  if (resolved === path.parse(resolved).root) throw bad("Choose a folder, not the whole disk.");
  const inside = (a: string, b: string) => a === b || a.startsWith(b + path.sep);
  if (inside(resolved, path.resolve(DATA_DIR)) || inside(resolved, BACKUP_DIR)) throw bad("Choose a folder outside the app's own data folder.");
  let st: fs.Stats;
  // Never create it: if a USB disk isn't mounted, writing to an empty mount point would fill the system disk.
  try { st = fs.statSync(resolved); } catch { throw bad("That folder doesn't exist (is the disk or share connected?)."); }
  if (!st.isDirectory()) throw bad("That path is not a folder.");
  return resolved;
}

export async function copyToFolder(cfg: OffsiteConfig["folder"], name: string, body: Buffer): Promise<void> {
  const dir = checkFolder(cfg.path);
  const tmp = path.join(dir, `.${name}.tmp`);
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, name));
  const ours = fs.readdirSync(dir).filter((n) => NAME.test(n)).sort().reverse();
  for (const old of ours.slice(cfg.keep)) {
    try { fs.unlinkSync(path.join(dir, old)); } catch { /* ignore */ }
  }
}

export async function testFolder(cfg: OffsiteConfig["folder"]): Promise<string> {
  const dir = checkFolder(cfg.path);
  const probe = path.join(dir, ".payroll-offsite-test");
  const text = `payroll offsite test ${new Date().toISOString()}`;
  fs.writeFileSync(probe, text, { mode: 0o600 });
  const back = fs.readFileSync(probe, "utf8");
  fs.unlinkSync(probe);
  if (back !== text) throw bad("The folder did not keep what was written.");
  let free = "";
  try {
    const s = fs.statfsSync(dir);
    free = ` ${(Number(s.bavail) * Number(s.bsize) / 1e9).toFixed(1)} GB free.`;
  } catch { /* statfs unsupported */ }
  return `Wrote and read a test file in ${dir}.${free}`;
}

// ── S3 (AWS Signature Version 4) ─────────────────────────────────────────────
const sha256hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
/** RFC 3986 encoding as SigV4 wants it. */
export const uriEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignInput {
  method: string;
  host: string;
  /** Already-encoded path, e.g. /bucket/key%20name. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  payloadHash: string;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
  date: Date;
}

/** Headers (including Authorization) for a SigV4-signed request. */
export function signV4(i: SignInput): Record<string, string> {
  const amzDate = i.date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const service = i.service ?? "s3";
  const headers: Record<string, string> = { ...(i.headers ?? {}), host: i.host, "x-amz-content-sha256": i.payloadHash, "x-amz-date": amzDate };
  const lower = Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const signedHeaders = lower.map(([k]) => k).join(";");
  const canonicalHeaders = lower.map(([k, v]) => `${k}:${v}\n`).join("");
  const query = Object.entries(i.query ?? {}).map(([k, v]) => [uriEncode(k), uriEncode(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [i.method, i.path, query, canonicalHeaders, signedHeaders, i.payloadHash].join("\n");
  const scope = `${day}/${i.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonical)].join("\n");
  const kDate = hmac(`AWS4${i.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, i.region), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() !== "host") out[k] = v;
  out.Authorization = `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}

function checkS3(cfg: OffsiteConfig["s3"]) {
  if (!cfg.bucket) throw bad("Enter the bucket name.");
  if (!/^[a-z0-9][a-z0-9.\-_]{1,98}[a-z0-9]$/i.test(cfg.bucket)) throw bad("That bucket name doesn't look right.");
  if (!cfg.accessKeyId || !cfg.secretAccessKey) throw bad("Enter the access key ID and secret key.");
  if (!cfg.region) throw bad("Enter the region (use \"auto\" for Cloudflare R2).");
  if (cfg.endpoint) {
    let u: URL;
    try { u = new URL(cfg.endpoint); } catch { throw bad("The endpoint must be a full address, like https://s3.us-west-004.backblazeb2.com."); }
    if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))) throw bad("The endpoint must use https://.");
  }
}

/** Base URL and path for a key: path-style on a custom endpoint, virtual-hosted on Amazon S3. */
function locate(cfg: OffsiteConfig["s3"], key: string | null): { origin: string; host: string; path: string } {
  const keyPath = key === null ? "" : `/${key.split("/").map(uriEncode).join("/")}`;
  if (cfg.endpoint) {
    const u = new URL(cfg.endpoint);
    const basePath = u.pathname.replace(/\/+$/, "");
    return { origin: u.origin, host: u.host, path: `${basePath}/${uriEncode(cfg.bucket)}${keyPath || (key === null ? "" : "/")}` };
  }
  const host = `${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
  return { origin: `https://${host}`, host, path: keyPath || "/" };
}

async function s3Request(cfg: OffsiteConfig["s3"], method: string, key: string | null, opts: { body?: Buffer; query?: Record<string, string>; contentType?: string; timeoutMs?: number } = {}) {
  const loc = locate(cfg, key);
  const body = opts.body ?? Buffer.alloc(0);
  const headers = signV4({
    method, host: loc.host, path: loc.path, query: opts.query, region: cfg.region,
    headers: opts.contentType ? { "content-type": opts.contentType } : {},
    payloadHash: sha256hex(body), accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, date: new Date(),
  });
  const qs = opts.query ? `?${Object.entries(opts.query).map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join("&")}` : "";
  const res = await fetch(`${loc.origin}${loc.path}${qs}`, {
    method, headers, body: method === "PUT" ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  const text = await res.text();
  if (!res.ok) {
    const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
    const msg = text.match(/<Message>([^<]+)<\/Message>/)?.[1];
    throw bad(`The storage service answered ${res.status}${code ? ` ${code}` : ""}${msg ? `: ${msg}` : ""}`);
  }
  return text;
}

const keyFor = (cfg: OffsiteConfig["s3"], name: string) => `${cfg.prefix.replace(/^\/+/, "")}${name}`;

export async function uploadToS3(cfg: OffsiteConfig["s3"], name: string, body: Buffer): Promise<void> {
  checkS3(cfg);
  await s3Request(cfg, "PUT", keyFor(cfg, name), { body, contentType: "application/gzip" });
  await pruneS3(cfg).catch((err) => console.warn("[offsite] could not remove old copies:", err.message));
}

/** Keep the newest `keep` backups under the prefix (other objects are never touched). */
async function pruneS3(cfg: OffsiteConfig["s3"]) {
  const prefix = cfg.prefix.replace(/^\/+/, "");
  const xml = await s3Request(cfg, "GET", null, { query: { "list-type": "2", prefix, "max-keys": "1000" }, timeoutMs: 30_000 });
  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1].replace(/&amp;/g, "&"))
    .filter((k) => k.startsWith(prefix) && NAME.test(k.slice(prefix.length)))
    .sort().reverse();
  for (const k of keys.slice(cfg.keep)) await s3Request(cfg, "DELETE", k, { timeoutMs: 30_000 });
}

export async function testS3(cfg: OffsiteConfig["s3"]): Promise<string> {
  checkS3(cfg);
  const key = keyFor(cfg, "payroll-offsite-test.txt");
  await s3Request(cfg, "PUT", key, { body: Buffer.from(`payroll offsite test ${new Date().toISOString()}\n`), contentType: "text/plain", timeoutMs: 30_000 });
  let cleaned = true;
  await s3Request(cfg, "DELETE", key, { timeoutMs: 30_000 }).catch(() => { cleaned = false; });
  return `Uploaded a test file to ${cfg.bucket}.${cleaned ? "" : " (It could not be deleted again; the key may not allow deleting, so old backups won't be removed.)"}`;
}

// ── Running ──────────────────────────────────────────────────────────────────
/** Copy one export backup to every enabled destination. Returns what happened per destination. */
export async function copyOffsite(file: BackupFile): Promise<Partial<Record<Target, { ok: boolean; error?: string }>>> {
  const cfg = await getConfig();
  const result: Partial<Record<Target, { ok: boolean; error?: string }>> = {};
  if (!cfg.folder.enabled && !cfg.s3.enabled) return result;
  const body = sanitizedExport(path.join(BACKUP_DIR, file.name));
  for (const target of ["folder", "s3"] as const) {
    if (!cfg[target].enabled) continue;
    try {
      if (target === "folder") await copyToFolder(cfg.folder, file.name, body);
      else await uploadToS3(cfg.s3, file.name, body);
      await recordStatus(target, true, { file: file.name });
      result[target] = { ok: true };
    } catch (err: any) {
      const error = err?.name === "TimeoutError" ? "Timed out." : err?.message ?? String(err);
      console.error(`[offsite] ${target} copy failed:`, error);
      await recordStatus(target, false, { error }).catch(() => undefined);
      result[target] = { ok: false, error };
    }
  }
  return result;
}

let hooked = false;
function hookBackups() {
  if (hooked) return;
  hooked = true;
  onBackupWritten(async (files) => {
    const exp = files.find((f) => f.kind === "export");
    if (exp) await copyOffsite(exp);
  });
}

// ── Routes (owner / admin: no POLICY rule, so the default applies) ───────────
type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

const inputSchema = z.object({
  folder: folderSchema.partial().optional(),
  s3: s3Schema.partial().optional(),
});

/** Merge a change onto the saved settings. A blank secret key keeps the saved one. */
function merge(cur: OffsiteConfig, input: z.infer<typeof inputSchema>): OffsiteConfig {
  const s3 = { ...cur.s3, ...(input.s3 ?? {}) };
  if (!input.s3?.secretAccessKey) s3.secretAccessKey = cur.s3.secretAccessKey;
  return configSchema.parse({ folder: { ...cur.folder, ...(input.folder ?? {}) }, s3 });
}

export function registerOffsiteRoutes(app: Express) {
  hookBackups();

  app.get("/api/offsite", h(async (_req, res) => {
    const [cfg, status] = await Promise.all([getConfig(), getStatus()]);
    res.json({ config: publicConfig(cfg), status, failing: failing(cfg, status) });
  }));

  app.put("/api/offsite", h(async (req, res) => {
    const input = inputSchema.parse(req.body ?? {});
    const before = await getConfig();
    const next = merge(before, input);
    if (next.folder.enabled) checkFolder(next.folder.path);
    if (next.s3.enabled) checkS3(next.s3);
    await saveConfig(next);
    const parts = [
      `folder ${next.folder.enabled ? `on (${next.folder.path}, keep ${next.folder.keep})` : "off"}`,
      `S3 ${next.s3.enabled ? `on (${next.s3.bucket}, keep ${next.s3.keep})` : "off"}`,
    ];
    if (input.s3?.secretAccessKey) parts.push("new secret key");
    audit({ ...actorOf(req, res), action: "settings.offsite", target: "offsite", detail: parts.join("; ") });
    res.json({ config: publicConfig(next), status: await getStatus() });
  }));

  /** Try a destination with the settings on screen (saved settings fill the gaps). */
  app.post("/api/offsite/test", h(async (req, res) => {
    const body = inputSchema.extend({ target: z.enum(["folder", "s3"]) }).parse(req.body ?? {});
    const cfg = merge(await getConfig(), body);
    try {
      const message = body.target === "folder" ? await testFolder(cfg.folder) : await testS3(cfg.s3);
      res.json({ ok: true, message });
    } catch (err: any) {
      res.json({ ok: false, message: err?.name === "TimeoutError" ? "Timed out." : err?.message ?? String(err) });
    }
  }));

  /** Copy the newest backup offsite now. */
  app.post("/api/offsite/run", h(async (req, res) => {
    const newest = listBackups().find((b) => b.kind === "export");
    if (!newest) return res.status(409).json({ error: "There is no backup yet. Make one first." });
    const result = await copyOffsite(newest);
    audit({ ...actorOf(req, res), action: "backup.offsite", target: newest.name, detail: Object.entries(result).map(([k, v]) => `${k}: ${v?.ok ? "ok" : "failed"}`).join(", ") });
    const [cfg, status] = await Promise.all([getConfig(), getStatus()]);
    res.json({ result, status, failing: failing(cfg, status) });
  }));
}
