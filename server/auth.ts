import { createHmac, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { getAuthSecret, loadConfig, saveConfig } from "./config";
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

// Simple in-memory brute-force protection
const attempts = new Map<string, { n: number; until: number }>();
export function loginThrottle(ip: string): string | null {
  const a = attempts.get(ip);
  if (a && a.until > Date.now() && a.n >= 8) return `Too many attempts. Try again in ${Math.ceil((a.until - Date.now()) / 60000)} minute(s).`;
  return null;
}
export function recordLogin(ip: string, ok: boolean) {
  if (ok) { attempts.delete(ip); return; }
  const a = attempts.get(ip);
  if (!a || a.until < Date.now()) attempts.set(ip, { n: 1, until: Date.now() + 5 * 60000 });
  else a.n++;
}
