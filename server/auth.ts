// Sessions: an HMAC-signed token in an httpOnly cookie (a bearer header is
// still accepted for one release). The token names the user and that user's
// session version, so "sign out everywhere" and password changes end every
// older session.
import { createHmac, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, getAuthSecret, loadConfig, saveConfig } from "./config";
import { safeEqual } from "./passwords";
import { type UserRecord, getUser, invalidateUsersCache, listUsers, setupRequired } from "./users";
import { db } from "./db";

export const SESSION_COOKIE = "payroll_session";
const TOKEN_TAG = "payroll-admin";

const sign = (payload: string) => createHmac("sha256", getAuthSecret()).update(payload).digest("base64url");
/** Phase 1 tokens carried a tag of the single admin password hash. */
const pwTag = (hash: string) => createHmac("sha256", getAuthSecret()).update(hash).digest("base64url").slice(0, 10);

export function issueToken(user: Pick<UserRecord, "id" | "sessionVersion">, days: number): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + days * 86400000;
  const payload = Buffer.from(JSON.stringify({ p: TOKEN_TAG, v: 2, u: user.id, s: user.sessionVersion, exp: expiresAt })).toString("base64url");
  return { token: `${payload}.${sign(payload)}`, expiresAt };
}

// ── Signed-out sessions ───────────────────────────────────────────────────────
// Tokens are stateless, so signing out records the token's signature until it
// would have expired anyway. Kept in settings so it survives restarts.
const REVOKED_KEY = "revoked_sessions";
let revoked: Map<string, number> | null = null;
async function revokedSet(): Promise<Map<string, number>> {
  if (revoked) return revoked;
  const m = new Map<string, number>();
  try {
    const raw = JSON.parse((await (await db()).getSetting(REVOKED_KEY)) || "{}");
    for (const [k, v] of Object.entries(raw)) if (typeof v === "number") m.set(k, v);
  } catch { /* none */ }
  return (revoked = m);
}
export function invalidateRevokedCache() { revoked = null; }
/** End this one session on the server (the user's other devices stay signed in). */
export async function revokeToken(token: string | undefined) {
  if (!token) return;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return;
  let exp = Date.now() + 31 * 86400000;
  try { const d = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); if (typeof d.exp === "number") exp = d.exp; } catch { /* default */ }
  const m = await revokedSet();
  const now = Date.now();
  for (const [k, v] of m) if (v < now) m.delete(k);
  m.set(sig, exp);
  await (await db()).setSetting(REVOKED_KEY, JSON.stringify(Object.fromEntries(m)));
}

/** The user a token belongs to, if the token is valid and still current. */
export async function verifyToken(token: string | undefined): Promise<{ user: UserRecord; legacy: boolean } | null> {
  if (!token) return null;
  try {
    const [payload, sig] = token.split(".");
    if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
    if ((await revokedSet()).has(sig)) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data.p !== TOKEN_TAG || typeof data.exp !== "number" || data.exp < Date.now()) return null;
    if (data.v === 2 && typeof data.u === "string") {
      const user = await getUser(data.u);
      return user && user.active && user.sessionVersion === data.s ? { user, legacy: false } : null;
    }
    // Phase 1 token: valid while the owner's password is still the one it was issued for.
    if (typeof data.pw === "string") {
      const owner = (await listUsers()).find((u) => u.role === "owner" && u.active && pwTag(u.passwordHash) === data.pw);
      return owner ? { user: owner, legacy: true } : null;
    }
    return null;
  } catch {
    return null;
  }
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}

export function requestToken(req: Request): string | undefined {
  return readCookie(req, SESSION_COOKIE) || req.header("authorization")?.replace(/^Bearer\s+/i, "") || undefined;
}

/** Set the session cookie. `remember: false` makes a browser-session cookie. */
export function setSessionCookie(req: Request, res: Response, user: Pick<UserRecord, "id" | "sessionVersion">, opts: { days: number; remember: boolean }) {
  const { token, expiresAt } = issueToken(user, opts.remember ? opts.days : 1);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: req.secure, path: "/",
    ...(opts.remember ? { maxAge: opts.days * 86400000 } : {}),
  });
  return { expiresAt };
}

export function clearSessionCookie(req: Request, res: Response) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure: req.secure, path: "/" });
}

/** Signed-in user of this request (set by requireAuth). */
export function currentUser(res: Response): UserRecord | null {
  return (res.locals.user as UserRecord | undefined) ?? null;
}

/**
 * Attach the signed-in user to `res.locals.user`; answer 401 for anything that
 * is not public. A Phase 1 bearer token is swapped for a cookie session.
 */
export function requireAuth(publicPaths: Set<string>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const isPublic = publicPaths.has(req.path);
    let found: Awaited<ReturnType<typeof verifyToken>> = null;
    try { found = await verifyToken(requestToken(req)); } catch { found = null; }
    if (found) {
      res.locals.user = found.user;
      if (found.legacy) setSessionCookie(req, res, found.user, { days: 30, remember: true });
    }
    if (isPublic || found) return next();
    return res.status(401).json({ error: "Your session has expired. Please sign in again." });
  };
}

/** Kept for callers from Phase 1: forget cached accounts after a restore or database switch. */
export function resetTagCache() { invalidateUsersCache(); }

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
  if (!(await setupRequired())) { clearSetupCode(); return; }
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

// Checks still running count against the limit too, so parallel guesses can't
// all slip past before the first failure is recorded. A reservation lasts until
// the response closes (or PENDING_MS, as a backstop).
const PENDING_MS = 30_000;
const pending = new Map<string, Map<symbol, number>>();
const inFlight = (ip: string, now: number) => {
  const m = pending.get(ip);
  if (!m) return 0;
  for (const [k, exp] of m) if (exp <= now) m.delete(k);
  if (!m.size) pending.delete(ip);
  return m.size;
};

/**
 * Returns an error when this address must wait. Pass the response so the check
 * counts as in flight until it finishes; record the outcome with recordLogin.
 */
export function loginThrottle(ip: string, res?: { once(event: "close", fn: () => void): unknown }): string | null {
  const now = Date.now();
  const a = attempts.get(ip);
  const failed = a && a.until > now ? a.n : 0;
  if (failed + inFlight(ip, now) >= MAX_TRIES) {
    const until = a && a.until > now ? a.until : now + 60_000;
    return `Too many attempts. Try again in ${Math.ceil((until - now) / 60000)} minute(s).`;
  }
  if (res) {
    if (pending.size > 10_000) for (const k of [...pending.keys()]) inFlight(k, now);
    const token = Symbol();
    const m = pending.get(ip) ?? new Map<symbol, number>();
    m.set(token, now + PENDING_MS);
    pending.set(ip, m);
    res.once("close", () => { m.delete(token); if (!m.size && pending.get(ip) === m) pending.delete(ip); });
  }
  return null;
}
export function recordLogin(ip: string, ok: boolean) {
  if (ok) { attempts.delete(ip); return; }
  if (attempts.size > 10_000) prune();
  const a = attempts.get(ip);
  if (!a || a.until < Date.now()) attempts.set(ip, { n: 1, until: Date.now() + WINDOW_MS });
  else { a.n++; a.until = Date.now() + WINDOW_MS; }
}
