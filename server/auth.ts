import { createHmac, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, getAuthSecret, loadConfig, saveConfig } from "./config";
import { db } from "./db";

const scrypt = promisify(nodeScrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function verifyHash(pw: string, stored: string): Promise<boolean> {
  if (!stored.startsWith("scrypt$")) return safeEqual(pw, stored); // legacy plain value
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  try {
    const expected = Buffer.from(hash, "base64url");
    const derived = await scrypt(pw, Buffer.from(salt, "base64url"), expected.length);
    return timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

/** Current password hash: database first, then the local cache (DB outage). */
export async function currentPasswordHash(): Promise<string | null> {
  try {
    const store = await db();
    const v = await store.getSetting("password_hash");
    if (v && v !== loadConfig().passwordHashCache) saveConfig({ passwordHashCache: v });
    if (v) return v;
  } catch { /* fall back to cache */ }
  return loadConfig().passwordHashCache ?? process.env.APP_PASSWORD ?? null;
}

export async function setPassword(pw: string) {
  const h = await hashPassword(pw);
  const store = await db();
  await store.setSetting("password_hash", h);
  saveConfig({ passwordHashCache: h });
}

export async function checkPassword(pw: string): Promise<boolean> {
  const stored = await currentPasswordHash();
  if (!stored) return false;
  const ok = await verifyHash(pw, stored);
  if (ok && !stored.startsWith("scrypt$")) await setPassword(pw).catch(() => undefined);
  return ok;
}

const sign = (payload: string) => createHmac("sha256", getAuthSecret()).update(payload).digest("base64url");
const pwTag = (hash: string | null) => (hash ? createHmac("sha256", getAuthSecret()).update(hash).digest("base64url").slice(0, 10) : "none");

export async function issueToken(days: number): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Date.now() + days * 86400000;
  const payload = Buffer.from(JSON.stringify({ p: "payroll-admin", exp: expiresAt, pw: pwTag(await currentPasswordHash()) })).toString("base64url");
  return { token: `${payload}.${sign(payload)}`, expiresAt };
}

let tagCache: { tag: string; at: number } | null = null;
async function currentTag() {
  if (tagCache && Date.now() - tagCache.at < 30000) return tagCache.tag;
  const tag = pwTag(await currentPasswordHash());
  tagCache = { tag, at: Date.now() };
  return tag;
}
export function resetTagCache() { tagCache = null; }

export async function verifyToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    const [payload, sig] = token.split(".");
    if (!payload || !sig || !safeEqual(sig, sign(payload))) return false;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data.p !== "payroll-admin" || typeof data.exp !== "number" || data.exp < Date.now()) return false;
    return data.pw === (await currentTag());
  } catch {
    return false;
  }
}

export function requireAuth(publicPaths: Set<string>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (publicPaths.has(req.path)) return next();
    const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!(await verifyToken(token))) return res.status(401).json({ error: "Your session has expired. Please sign in again." });
    next();
  };
}

// ── First-run setup code ─────────────────────────────────────────────────────
// Until an administrator password exists, creating one requires a one-time code.
// Without it, anyone who found the address first (e.g. through a Cloudflare
// Tunnel) could make themselves the administrator.
const SETUP_FILE = path.join(DATA_DIR, "setup-code.txt");

function newCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(10);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

/** The current setup code (created on first use). */
export function getSetupCode(): string {
  if (process.env.SETUP_CODE) return process.env.SETUP_CODE;
  let code = loadConfig().setupCode;
  if (!code) {
    code = newCode();
    saveConfig({ setupCode: code });
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETUP_FILE, `${code}\n`, { mode: 0o600 });
  } catch { /* the code is still printed to the log */ }
  return code;
}

const norm = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");
export function setupCodeMatches(input: string): boolean {
  return !!input && safeEqual(norm(input), norm(getSetupCode()));
}

export function clearSetupCode() {
  saveConfig({ setupCode: undefined });
  try { fs.unlinkSync(SETUP_FILE); } catch { /* already gone */ }
}

/** On start-up: if no administrator exists yet, print the setup code. */
export async function announceSetupCode() {
  if (await currentPasswordHash()) { clearSetupCode(); return; }
  const code = getSetupCode();
  console.log("");
  console.log("  ┌──────────────────────────────────────────────────────┐");
  console.log("  │  First-time setup: open the app and enter this code  │");
  console.log(`  │  Setup code: ${code.padEnd(40)}│`);
  console.log("  └──────────────────────────────────────────────────────┘");
  console.log("");
}

// ── Brute-force protection (per client address, in memory) ───────────────────
const MAX_TRIES = 8;
const WINDOW_MS = 15 * 60_000;
const attempts = new Map<string, { n: number; until: number }>();

function prune(now = Date.now()) {
  for (const [k, a] of attempts) if (a.until < now) attempts.delete(k);
}
setInterval(prune, 5 * 60_000).unref();

export function loginThrottle(ip: string): string | null {
  const a = attempts.get(ip);
  if (a && a.until > Date.now() && a.n >= MAX_TRIES) return `Too many attempts. Try again in ${Math.ceil((a.until - Date.now()) / 60000)} minute(s).`;
  return null;
}
export function recordLogin(ip: string, ok: boolean) {
  if (ok) { attempts.delete(ip); return; }
  if (attempts.size > 10_000) prune();
  const a = attempts.get(ip);
  if (!a || a.until < Date.now()) attempts.set(ip, { n: 1, until: Date.now() + WINDOW_MS });
  else { a.n++; a.until = Date.now() + WINDOW_MS; }
}
