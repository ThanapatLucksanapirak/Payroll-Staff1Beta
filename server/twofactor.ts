// Two-factor sign-in with an authenticator app (TOTP, RFC 6238).
//
// - SHA-1, 6 digits, 30-second steps; a code from the step before or after is
//   accepted for clock drift, and a step is never accepted twice (replay).
// - 10 one-time recovery codes, stored as SHA-256 hashes.
// - Sign-in becomes two steps: the password check answers with a short-lived
//   signed ticket; the code (or a recovery code) is then exchanged for the
//   session. Code attempts are rate limited like passwords.
// - "Remember this device for 30 days" sets a signed cookie tied to the
//   account's device version, so resetting 2FA or "forget devices" ends it.
// - Owners and administrators can be required to use it (off by default);
//   an account that must use it but hasn't set it up enrolls during sign-in.
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { db } from "./db";
import { getAuthSecret } from "./config";
import * as settings from "./settings";
import { actorOf, audit } from "./audit";
import { loginThrottle, recordLogin, setSessionCookie, currentUser } from "./auth";
import { safeEqual, verifyHash } from "./passwords";
import { type TwoFactorState, type UserRecord, UserError, getUser, isAdmin, mutateUser, toPublic } from "./users";

// ── TOTP (RFC 6238 / RFC 4226) ───────────────────────────────────────────────
export const STEP_SECONDS = 30;
export const DIGITS = 6;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("Invalid base32 secret.");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** HOTP value for a counter (RFC 4226). */
export function hotp(key: Buffer, counter: number, digits = DIGITS, algorithm: "sha1" | "sha256" | "sha512" = "sha1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, key).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const stepAt = (ms: number) => Math.floor(ms / 1000 / STEP_SECONDS);

/** TOTP code for a base32 secret at a time. */
export function totp(secret: string, ms = Date.now()): string {
  return hotp(base32Decode(secret), stepAt(ms));
}

/**
 * The step a code matches within ±1 step of `ms`, if it is newer than
 * `lastStep` (so a code can't be replayed). Null if it doesn't match.
 */
export function matchTotp(secret: string, code: string, ms = Date.now(), lastStep = 0): number | null {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secret);
  const now = stepAt(ms);
  for (const s of [now - 1, now, now + 1]) {
    if (s <= lastStep) continue;
    if (safeEqual(hotp(key, s), c)) return s;
  }
  return null;
}

export const newSecret = () => base32Encode(randomBytes(20));

export function otpauthUrl(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// ── Recovery codes ───────────────────────────────────────────────────────────
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const RECOVERY_COUNT = 10;
const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");
const hashCode = (c: string) => createHash("sha256").update(`payroll-recovery:${normCode(c)}`).digest("hex");

export function newRecoveryCodes(n = RECOVERY_COUNT): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const chars = [...randomBytes(10)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    codes.push(`${chars.slice(0, 5)}-${chars.slice(5)}`);
  }
  return { codes, hashes: codes.map(hashCode) };
}

// ── Policy ───────────────────────────────────────────────────────────────────
export const POLICY_KEY = "twofactor:policy";
export interface TwoFactorPolicy { requireForAdmins: boolean }

export async function getPolicy(): Promise<TwoFactorPolicy> {
  try {
    const raw = await (await db()).getSetting(POLICY_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return { requireForAdmins: v?.requireForAdmins === true };
  } catch {
    return { requireForAdmins: false };
  }
}

export async function savePolicy(p: TwoFactorPolicy) {
  await (await db()).setSetting(POLICY_KEY, JSON.stringify({ requireForAdmins: !!p.requireForAdmins }));
}

/** True when this account must use two-factor sign-in. */
export async function isRequiredFor(user: Pick<UserRecord, "role">) {
  return isAdmin(user) && (await getPolicy()).requireForAdmins;
}

const emptyState = (): TwoFactorState => ({
  enabled: false, secret: null, pendingSecret: null, pendingAt: null, lastStep: 0, recovery: [], enabledAt: null, deviceVersion: 0,
});

// ── Account changes ──────────────────────────────────────────────────────────
const PENDING_MS = 15 * 60_000;

/** Start enrollment: a new secret is kept as pending until a code confirms it. */
export async function beginEnrollment(userId: string): Promise<{ secret: string }> {
  const secret = newSecret();
  await mutateUser(userId, (u) => {
    const st = u.twoFactor ?? emptyState();
    u.twoFactor = { ...st, pendingSecret: secret, pendingAt: new Date().toISOString() };
  });
  return { secret };
}

/** Confirm enrollment with a code from the app. Returns fresh recovery codes. */
export async function confirmEnrollment(userId: string, code: string, now = Date.now()): Promise<string[]> {
  const { codes, hashes } = newRecoveryCodes();
  await mutateUser(userId, (u) => {
    const st = u.twoFactor ?? emptyState();
    if (!st.pendingSecret || !st.pendingAt || now - Date.parse(st.pendingAt) > PENDING_MS) {
      throw new UserError("Setup timed out. Start again to get a new QR code.", 400);
    }
    const step = matchTotp(st.pendingSecret, code, now, 0);
    if (step === null) throw new UserError("That code didn't match. Check the time on your phone and try the newest code.", 400);
    u.twoFactor = {
      ...st, enabled: true, secret: st.pendingSecret, pendingSecret: null, pendingAt: null, lastStep: step,
      recovery: hashes, enabledAt: new Date(now).toISOString(), deviceVersion: st.deviceVersion + 1,
    };
  });
  return codes;
}

/**
 * Check a sign-in code: a 6-digit app code (never the same step twice) or an
 * unused recovery code (used up on success).
 */
export async function useCode(userId: string, code: string, now = Date.now()): Promise<"app" | "recovery" | null> {
  return mutateUser(userId, (u) => {
    const st = u.twoFactor;
    if (!st?.enabled || !st.secret) return null;
    const digits = code.replace(/\s/g, "");
    if (/^\d{6}$/.test(digits)) {
      const step = matchTotp(st.secret, digits, now, st.lastStep);
      if (step === null) return null;
      u.twoFactor = { ...st, lastStep: step };
      return "app";
    }
    if (normCode(code).length !== 10) return null;
    const h = hashCode(code);
    const i = st.recovery.findIndex((x) => safeEqual(x, h));
    if (i < 0) return null;
    u.twoFactor = { ...st, recovery: st.recovery.filter((_, j) => j !== i) };
    return "recovery";
  });
}

/** Turn two-factor off (own account, owner reset or command line). */
export async function disableTwoFactor(userId: string): Promise<UserRecord> {
  return mutateUser(userId, (u) => {
    const dv = (u.twoFactor?.deviceVersion ?? 0) + 1;
    u.twoFactor = { ...emptyState(), deviceVersion: dv };
    return { ...u };
  });
}

export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  const { codes, hashes } = newRecoveryCodes();
  await mutateUser(userId, (u) => {
    if (!u.twoFactor?.enabled) throw new UserError("Two-factor sign-in is not on for this account.", 400);
    u.twoFactor = { ...u.twoFactor, recovery: hashes };
  });
  return codes;
}

export async function forgetDevices(userId: string) {
  await mutateUser(userId, (u) => {
    if (u.twoFactor) u.twoFactor = { ...u.twoFactor, deviceVersion: u.twoFactor.deviceVersion + 1 };
  });
}

// ── Signed tokens (sign-in ticket, remembered device) ────────────────────────
const sign = (tag: string, payload: string) => createHmac("sha256", getAuthSecret()).update(`${tag}.${payload}`).digest("base64url");

function makeToken(tag: string, data: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${payload}.${sign(tag, payload)}`;
}

function readToken(tag: string, token: unknown): Record<string, any> | null {
  if (typeof token !== "string" || token.length > 2000) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !safeEqual(sig, sign(tag, payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

const TICKET_TAG = "payroll-2fa-ticket";
const DEVICE_TAG = "payroll-2fa-device";
const TICKET_MS = 10 * 60_000;
export const DEVICE_DAYS = 30;
const MAX_TICKET_TRIES = 5;
const ticketTries = new Map<string, { n: number; exp: number }>();
setInterval(() => { const now = Date.now(); for (const [k, v] of ticketTries) if (v.exp < now) ticketTries.delete(k); }, 5 * 60_000).unref();

export type LoginStep = "verify" | "setup";

export function issueTicket(user: Pick<UserRecord, "id" | "sessionVersion">, step: LoginStep, remember: boolean): string {
  return makeToken(TICKET_TAG, { u: user.id, s: user.sessionVersion, k: step, r: remember, n: randomBytes(9).toString("base64url"), exp: Date.now() + TICKET_MS });
}

/** The account a ticket belongs to, if it is still valid and has tries left. */
async function ticketUser(token: unknown, step: LoginStep): Promise<{ user: UserRecord; remember: boolean; nonce: string } | null> {
  const t = readToken(TICKET_TAG, token);
  if (!t || t.k !== step || typeof t.u !== "string" || typeof t.n !== "string") return null;
  const tries = ticketTries.get(t.n);
  if (tries && tries.n >= MAX_TICKET_TRIES) return null;
  const user = await getUser(t.u, { fresh: true });
  if (!user || !user.active || user.sessionVersion !== t.s) return null;
  return { user, remember: t.r !== false, nonce: t.n };
}

function countTry(nonce: string) {
  const cur = ticketTries.get(nonce);
  ticketTries.set(nonce, { n: (cur?.n ?? 0) + 1, exp: Date.now() + TICKET_MS });
}

const deviceCookie = (userId: string) => `payroll_2fa_${userId.replace(/[^A-Za-z0-9_]/g, "")}`;

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}

export function rememberedDevice(req: Request, user: UserRecord): boolean {
  const st = user.twoFactor;
  if (!st?.enabled) return false;
  const t = readToken(DEVICE_TAG, readCookie(req, deviceCookie(user.id)));
  return !!t && t.u === user.id && t.d === st.deviceVersion;
}

function rememberDevice(req: Request, res: Response, user: UserRecord) {
  const token = makeToken(DEVICE_TAG, { u: user.id, d: user.twoFactor?.deviceVersion ?? 0, exp: Date.now() + DEVICE_DAYS * 86400000 });
  res.cookie(deviceCookie(user.id), token, { httpOnly: true, sameSite: "lax", secure: req.secure, path: "/api/auth", maxAge: DEVICE_DAYS * 86400000 });
}

/**
 * Called after a correct password. Returns null when the session can be
 * issued now, or the second step the client must complete.
 */
export async function loginStep(req: Request, user: UserRecord, remember: boolean): Promise<{ twoFactor: LoginStep; ticket: string } | null> {
  if (user.twoFactor?.enabled) {
    if (rememberedDevice(req, user)) return null;
    return { twoFactor: "verify", ticket: issueTicket(user, "verify", remember) };
  }
  if (await isRequiredFor(user)) return { twoFactor: "setup", ticket: issueTicket(user, "setup", remember) };
  return null;
}

// ── Routes ───────────────────────────────────────────────────────────────────
/** Paths (under /api) that work without a session: the second sign-in step. */
export const TWO_FACTOR_PUBLIC = ["/auth/2fa/login/verify", "/auth/2fa/login/setup", "/auth/2fa/login/enable"];

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function me(res: Response): UserRecord {
  const u = currentUser(res);
  if (!u) throw new UserError("Your session has expired. Please sign in again.", 401);
  return u;
}

async function sessionDays() {
  try { return (await settings.getPrefs()).sessionDays; } catch { return 30; }
}

async function issuer() {
  try { return (await settings.getPrefs()).appName || "Payroll Admin"; } catch { return "Payroll Admin"; }
}

/** Check the account password before a sensitive change (rate limited like sign-in). */
async function checkPassword(req: Request, user: UserRecord, password: unknown) {
  const ip = req.ip ?? "unknown";
  const blocked = loginThrottle(ip);
  if (blocked) throw new UserError(blocked, 429);
  const fresh = await getUser(user.id, { fresh: true });
  const ok = !!fresh && typeof password === "string" && !!password && (await verifyHash(password, fresh.passwordHash));
  recordLogin(ip, ok);
  if (!ok) throw new UserError("Your password is incorrect.", 400);
  return fresh!;
}

const codeSchema = z.string().trim().min(6).max(40);
const expired = "This sign-in has expired. Enter your password again.";

export function registerTwoFactorRoutes(app: Express) {
  // ── Sign-in, second step (public) ──────────────────────────────────────────
  app.post("/api/auth/2fa/login/verify", h(async (req, res) => {
    const ip = req.ip ?? "unknown";
    const blocked = loginThrottle(ip);
    if (blocked) return res.status(429).json({ error: blocked });
    const body = z.object({ ticket: z.string().max(2000), code: codeSchema, rememberDevice: z.boolean().optional() }).parse(req.body);
    const t = await ticketUser(body.ticket, "verify");
    if (!t) return res.status(401).json({ error: expired, expired: true });
    countTry(t.nonce);
    const used = await useCode(t.user.id, body.code);
    recordLogin(ip, !!used);
    if (!used) {
      audit({ userId: t.user.id, userName: t.user.username, ip, action: "auth.login-failed", detail: "wrong two-factor code" });
      return res.status(401).json({ error: "That code didn't work. Use the newest code from your app, or a recovery code." });
    }
    ticketTries.delete(t.nonce);
    const user = (await getUser(t.user.id, { fresh: true })) ?? t.user;
    const { expiresAt } = setSessionCookie(req, res, user, { days: await sessionDays(), remember: t.remember });
    if (body.rememberDevice) rememberDevice(req, res, user);
    const left = user.twoFactor?.recovery.length ?? 0;
    audit({ ...actorOf(req, res, user), action: "auth.login", target: `user:${user.id}`, detail: used === "recovery" ? `two-factor (recovery code, ${left} left)` : "two-factor" });
    res.json({ user: toPublic(user), expiresAt, recoveryCodesLeft: used === "recovery" ? left : undefined });
  }));

  // Required but not set up yet: enroll during sign-in.
  app.post("/api/auth/2fa/login/setup", h(async (req, res) => {
    const { ticket } = z.object({ ticket: z.string().max(2000) }).parse(req.body);
    const t = await ticketUser(ticket, "setup");
    if (!t) return res.status(401).json({ error: expired, expired: true });
    const { secret } = await beginEnrollment(t.user.id);
    res.json({ secret, otpauthUrl: otpauthUrl(secret, t.user.username, await issuer()) });
  }));

  app.post("/api/auth/2fa/login/enable", h(async (req, res) => {
    const ip = req.ip ?? "unknown";
    const blocked = loginThrottle(ip);
    if (blocked) return res.status(429).json({ error: blocked });
    const body = z.object({ ticket: z.string().max(2000), code: codeSchema }).parse(req.body);
    const t = await ticketUser(body.ticket, "setup");
    if (!t) return res.status(401).json({ error: expired, expired: true });
    countTry(t.nonce);
    let codes: string[];
    try { codes = await confirmEnrollment(t.user.id, body.code); } catch (err) { recordLogin(ip, false); throw err; }
    recordLogin(ip, true);
    ticketTries.delete(t.nonce);
    const user = (await getUser(t.user.id, { fresh: true })) ?? t.user;
    const { expiresAt } = setSessionCookie(req, res, user, { days: await sessionDays(), remember: t.remember });
    audit({ ...actorOf(req, res, user), action: "user.2fa-enable", target: `user:${user.id}`, detail: "set up while signing in" });
    audit({ ...actorOf(req, res, user), action: "auth.login", target: `user:${user.id}`, detail: "two-factor" });
    res.json({ user: toPublic(user), expiresAt, recoveryCodes: codes });
  }));

  // ── Own account ────────────────────────────────────────────────────────────
  app.get("/api/auth/2fa", h(async (_req, res) => {
    const u = (await getUser(me(res).id, { fresh: true })) ?? me(res);
    const policy = await getPolicy();
    res.json({
      enabled: !!u.twoFactor?.enabled,
      enabledAt: u.twoFactor?.enabledAt ?? null,
      recoveryCodesLeft: u.twoFactor?.enabled ? u.twoFactor.recovery.length : 0,
      required: isAdmin(u) && policy.requireForAdmins,
      policy,
    });
  }));

  app.post("/api/auth/2fa/setup", h(async (req, res) => {
    const u = me(res);
    await checkPassword(req, u, req.body?.password);
    const { secret } = await beginEnrollment(u.id);
    res.json({ secret, otpauthUrl: otpauthUrl(secret, u.username, await issuer()) });
  }));

  app.post("/api/auth/2fa/enable", h(async (req, res) => {
    const u = me(res);
    const { code } = z.object({ code: codeSchema }).parse(req.body);
    const codes = await confirmEnrollment(u.id, code);
    audit({ ...actorOf(req, res), action: "user.2fa-enable", target: `user:${u.id}` });
    res.json({ enabled: true, recoveryCodes: codes });
  }));

  app.post("/api/auth/2fa/disable", h(async (req, res) => {
    const u = me(res);
    await checkPassword(req, u, req.body?.password);
    if (await isRequiredFor(u)) return res.status(409).json({ error: "Two-factor sign-in is required for owners and administrators. Turn off the requirement first." });
    await disableTwoFactor(u.id);
    audit({ ...actorOf(req, res), action: "user.2fa-disable", target: `user:${u.id}` });
    res.json({ enabled: false });
  }));

  app.post("/api/auth/2fa/recovery-codes", h(async (req, res) => {
    const u = me(res);
    await checkPassword(req, u, req.body?.password);
    const codes = await regenerateRecoveryCodes(u.id);
    audit({ ...actorOf(req, res), action: "user.2fa-recovery", target: `user:${u.id}`, detail: "new recovery codes" });
    res.json({ recoveryCodes: codes });
  }));

  app.post("/api/auth/2fa/forget-devices", h(async (req, res) => {
    const u = me(res);
    await forgetDevices(u.id);
    res.clearCookie(deviceCookie(u.id), { httpOnly: true, sameSite: "lax", secure: req.secure, path: "/api/auth" });
    audit({ ...actorOf(req, res), action: "user.2fa-devices", target: `user:${u.id}`, detail: "forgot remembered devices" });
    res.json({ ok: true });
  }));

  // ── Owner / admin (no POLICY rule: owners and administrators) ──────────────
  app.put("/api/auth/2fa/policy", h(async (req, res) => {
    const actor = me(res);
    const { requireForAdmins } = z.object({ requireForAdmins: z.boolean() }).parse(req.body);
    if (requireForAdmins) {
      const fresh = await getUser(actor.id, { fresh: true });
      if (!fresh?.twoFactor?.enabled) return res.status(409).json({ error: "Turn on two-factor sign-in for your own account first." });
    }
    await savePolicy({ requireForAdmins });
    audit({ ...actorOf(req, res), action: "settings.2fa-policy", target: "twofactor", detail: requireForAdmins ? "required for owners and administrators" : "optional" });
    res.json({ requireForAdmins });
  }));

  /** Only an owner can reset someone else's two-factor sign-in (e.g. a lost phone). */
  app.post("/api/users/:id/2fa/reset", h(async (req, res) => {
    const actor = me(res);
    if (actor.role !== "owner") return res.status(403).json({ error: "Only an owner can reset two-factor sign-in." });
    const target = await getUser(String(req.params.id), { fresh: true });
    if (!target) return res.status(404).json({ error: "That user no longer exists." });
    if (target.id === actor.id) return res.status(400).json({ error: "Turn off your own two-factor sign-in under Account & password." });
    const user = await disableTwoFactor(target.id);
    audit({ ...actorOf(req, res), action: "user.2fa-reset", target: `user:${user.id}`, detail: `${user.username}: two-factor sign-in reset` });
    res.json(toPublic(user));
  }));
}
