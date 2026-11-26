// Sign-in, first-run setup, own account, user management and the activity log.
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { siteRulesSchema } from "@shared/schema";
import { dbStatus } from "./db";
import * as settings from "./settings";
import { clearSessionCookie, passwordKey, clearSetupCode, currentUser, loginThrottle, recordLogin, requestToken, revokeToken, setSessionCookie, setupCodeMatches, clearAccountLock } from "./auth";
import { actorOf, audit, queryAudit } from "./audit";
import { loginTargetId,
  type UserRecord, ROLE_LABELS, bumpSessionVersion, createUser, createUserSchema, deleteUser, displayNameSchema, getUser, listUsers,
  isAdmin, notificationEmailSchema, passwordSchema, setUserPassword, setupRequired, toPublic, updateProfile, updateUser, updateUserSchema, usernameSchema, authenticate,
} from "./users";
import { verifyHash } from "./passwords";
import { loginStep } from "./twofactor";

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

async function sessionDays() {
  try { return (await settings.getPrefs()).sessionDays; } catch { return 30; }
}

function me(res: Response): UserRecord {
  const u = currentUser(res);
  if (!u) throw Object.assign(new Error("Your session has expired. Please sign in again."), { status: 401 });
  return u;
}

const describe = (u: Pick<UserRecord, "username" | "role" | "siteIds" | "active">) =>
  `${ROLE_LABELS[u.role]}${u.siteIds.length ? `, ${u.siteIds.length} location(s)` : ""}${u.active ? "" : ", inactive"}`;

/**
 * Check the signed-in person's own password before a sensitive change (counts
 * against the sign-in limit). Sends the error response and returns false when
 * it doesn't match.
 */
async function confirmOwnPassword(req: Request, res: Response, userId: string, password: unknown): Promise<boolean> {
  if (typeof password !== "string" || !password) { res.status(400).json({ error: "Enter your password to change a notification email.", needPassword: true }); return false; }
  const ip = req.ip ?? "unknown";
  const blocked = loginThrottle(ip, res);
  if (blocked) { res.status(429).json({ error: blocked }); return false; }
  const acct = passwordKey({ userId });
  const acctBlocked = loginThrottle(acct, res);
  if (acctBlocked) { res.status(429).json({ error: acctBlocked }); return false; }
  const fresh = await getUser(userId, { fresh: true });
  const ok = !!fresh && password.length <= 200 && (await verifyHash(password, fresh.passwordHash));
  recordLogin(ip, ok);
  recordLogin(acct, ok);
  if (!ok) { res.status(400).json({ error: "Your password is incorrect.", needPassword: true }); return false; }
  return true;
}

export function registerAuthRoutes(app: Express) {
  app.get("/api/auth/status", h(async (_req, res) => {
    let appName = "Shijiri Payroll";
    try { appName = (await settings.getPrefs()).appName; } catch { /* db down */ }
    const user = currentUser(res);
    // Signed out, say only whether the database is up: its name, type and the raw
    // error (host names, paths) are for signed-in users.
    const st = dbStatus();
    const db = user ? st : { connected: st.connected, error: st.connected ? null : "The app can't reach its database right now. An administrator can check the server." };
    res.json({ setupRequired: await setupRequired().catch(() => false), authenticated: !!user, appName, db, user: user ? toPublic(user) : null });
  }));

  app.post("/api/auth/login", h(async (req, res) => {
    const ip = req.ip ?? "unknown";
    const blocked = loginThrottle(ip, res);
    if (blocked) return res.status(429).json({ error: blocked });
    const { username, password, remember } = z.object({
      username: z.string().max(100).default(""),
      password: z.string().min(1).max(200),
      remember: z.boolean().optional(),
    }).parse(req.body);
    // Also limit guesses per account, so many addresses can't share the work.
    const targetId = await loginTargetId(username);
    const acct = passwordKey(targetId ? { userId: targetId } : { unknownName: username });
    const acctBlocked = loginThrottle(acct, res);
    if (acctBlocked) return res.status(429).json({ error: acctBlocked });
    const r = await authenticate(username, password);
    recordLogin(ip, r.ok);
    recordLogin(acct, r.ok);
    if (!r.ok) {
      audit({ userId: null, userName: r.username || username.trim(), ip, action: "auth.login-failed", detail: r.reason === "username-required" ? "username missing" : "wrong username or password" });
      return res.status(401).json({ error: r.reason === "username-required" ? "Enter your username and password." : "Incorrect username or password. Use your sign-in username, not your display name." });
    }
    // Two-factor sign-in: answer with a ticket for the second step instead of a session.
    const step = await loginStep(req, r.user, remember !== false);
    if (step) return res.json(step);
    const { expiresAt } = setSessionCookie(req, res, r.user, { days: await sessionDays(), remember: remember !== false });
    audit({ ...actorOf(req, res, r.user), action: "auth.login", target: `user:${r.user.id}`, detail: r.user.twoFactor?.enabled ? "two-factor (remembered device)" : undefined });
    res.json({ user: toPublic(r.user), expiresAt });
  }));

  app.post("/api/auth/setup", h(async (req, res) => {
    const ip = req.ip ?? "unknown";
    const blocked = loginThrottle(ip, res);
    if (blocked) return res.status(429).json({ error: blocked });
    if (!(await setupRequired())) return res.status(409).json({ error: "This app is already set up. Sign in instead." });
    const body = z.object({
      username: usernameSchema.default("admin"),
      displayName: displayNameSchema.optional(),
      password: passwordSchema,
      setupCode: z.string().max(100).default(""),
      // The browser's time zone, so the first location doesn't start on New York time.
      timezone: z.string().max(64).optional(),
    }).parse(req.body);
    if (!setupCodeMatches(body.setupCode)) {
      recordLogin(ip, false);
      return res.status(403).json({ error: "That setup code is not right. It was printed by the installer, and is saved on the server in the data folder as setup-code.txt." });
    }
    if (!(await setupRequired())) return res.status(409).json({ error: "This app is already set up. Sign in instead." });
    const user = await createUser(null, { username: body.username, displayName: body.displayName, password: body.password, role: "owner" }, { onlyIfNoUsers: true });
    clearSetupCode();
    if (body.timezone && validTimeZone(body.timezone)) {
      const fallback = siteRulesSchema.parse({}).timezone;
      for (const site of await settings.getSites()) {
        if (site.rules.timezone === fallback && site.rules.timezone !== body.timezone) await settings.updateSite(site.id, { rules: { ...site.rules, timezone: body.timezone } });
      }
    }
    const { expiresAt } = setSessionCookie(req, res, user, { days: 30, remember: true });
    audit({ ...actorOf(req, res, user), action: "user.create", target: `user:${user.id}`, detail: "first owner (setup)" });
    res.json({ user: toPublic(user), expiresAt });
  }));

  app.post("/api/auth/logout", h(async (req, res) => {
    const u = currentUser(res);
    await revokeToken(requestToken(req));
    clearSessionCookie(req, res);
    if (u) audit({ ...actorOf(req, res), action: "auth.logout", target: `user:${u.id}` });
    res.json({ ok: true });
  }));

  app.post("/api/auth/logout-all", h(async (req, res) => {
    const u = me(res);
    await bumpSessionVersion(u.id);
    clearSessionCookie(req, res);
    audit({ ...actorOf(req, res), action: "auth.logout-all", target: `user:${u.id}` });
    res.json({ ok: true });
  }));

  app.get("/api/auth/me", h(async (_req, res) => {
    res.json(toPublic(me(res)));
  }));

  app.post("/api/auth/change-password", h(async (req, res) => {
    const u = me(res);
    const { current, next } = z.object({ current: z.string().min(1).max(200), next: passwordSchema }).parse(req.body);
    // Rate limited like sign-in, so a borrowed session can't guess the current password.
    const ip = req.ip ?? "unknown";
    const acct = passwordKey({ userId: u.id });
    const blocked = loginThrottle(ip, res) ?? loginThrottle(acct, res);
    if (blocked) return res.status(429).json({ error: blocked });
    const fresh = await getUser(u.id, { fresh: true });
    const ok = !!fresh && (await verifyHash(current, fresh.passwordHash));
    recordLogin(ip, ok);
    recordLogin(acct, ok);
    if (!ok) return res.status(400).json({ error: "Current password is incorrect." });
    const updated = await setUserPassword({ id: u.id, role: u.role }, u.id, next);
    const { expiresAt } = setSessionCookie(req, res, updated, { days: await sessionDays(), remember: true });
    audit({ ...actorOf(req, res), action: "user.password", target: `user:${u.id}`, detail: "changed own password" });
    res.json({ user: toPublic(updated), expiresAt, message: `Password updated. Next time, sign in as "${updated.username}" with the new password. Other devices have been signed out.` });
  }));

  app.put("/api/auth/profile", h(async (req, res) => {
    const u = me(res);
    const { password, ...body } = z.object({ displayName: displayNameSchema.optional(), username: usernameSchema.optional(), notificationEmail: notificationEmailSchema.optional(), password: z.string().max(200).optional() }).parse(req.body ?? {});
    // Changing the email needs the password: sign-in codes and payroll notices go there,
    // so a borrowed or stolen session must not be able to redirect them.
    // Only owners and administrators may change a sign-in username (their own included).
    if (body.username !== undefined && body.username.trim().toLowerCase() !== u.username.toLowerCase() && !isAdmin(u)) {
      return res.status(403).json({ error: "Only an owner or administrator can change a sign-in username." });
    }
    if (body.notificationEmail !== undefined) {
      const fresh = await getUser(u.id, { fresh: true });
      if (fresh && body.notificationEmail !== (fresh.notificationEmail ?? "") && !(await confirmOwnPassword(req, res, u.id, password))) return;
    }
    const updated = await updateProfile(u.id, body);
    const what = [body.username && updated.username !== u.username ? `username ${u.username} → ${updated.username}` : "", body.displayName !== undefined ? "display name" : "", body.notificationEmail !== undefined ? "notification email" : ""].filter(Boolean).join("; ");
    audit({ ...actorOf(req, res, updated), action: "user.update", target: `user:${u.id}`, detail: what || "no changes" });
    res.json(toPublic(updated));
  }));

  // ── Users (owner / admin; the authorize middleware checks the role) ─────────
  app.get("/api/users", h(async (_req, res) => {
    res.json((await listUsers({ fresh: true })).map(toPublic));
  }));

  app.post("/api/users", h(async (req, res) => {
    const actor = me(res);
    const input = createUserSchema.parse(req.body);
    const user = await createUser(actor, input);
    audit({ ...actorOf(req, res), action: "user.create", target: `user:${user.id}`, detail: `${user.username}: ${describe(user)}` });
    res.json(toPublic(user));
  }));

  app.patch("/api/users/:id", h(async (req, res) => {
    const actor = me(res);
    const patch = updateUserSchema.parse(req.body);
    // Sign-in codes can go to this email, so changing it needs the password of whoever is making the change.
    if (patch.notificationEmail !== undefined) {
      const target = await getUser(String(req.params.id), { fresh: true });
      if (target && patch.notificationEmail !== (target.notificationEmail ?? "") && !(await confirmOwnPassword(req, res, actor.id, req.body?.actorPassword))) return;
    }
    const { before, after } = await updateUser(actor, String(req.params.id), patch);
    const changes: string[] = [];
    if (before.username !== after.username) changes.push(`username ${before.username} → ${after.username}`);
    if (before.displayName !== after.displayName) changes.push("display name");
    if (before.role !== after.role) changes.push(`role ${before.role} → ${after.role}`);
    if (before.siteIds.join() !== after.siteIds.join()) changes.push(`locations: ${after.siteIds.length ? after.siteIds.join(", ") : "all"}`);
    if (before.active !== after.active) changes.push(after.active ? "activated" : "deactivated");
    if ((before.notificationEmail ?? "") !== (after.notificationEmail ?? "")) changes.push(after.notificationEmail ? "notification email set" : "notification email removed");
    audit({ ...actorOf(req, res), action: "user.update", target: `user:${after.id}`, detail: `${after.username}: ${changes.join("; ") || "no changes"}` });
    res.json(toPublic(after));
  }));

  app.post("/api/users/:id/password", h(async (req, res) => {
    const actor = me(res);
    const { password } = z.object({ password: passwordSchema }).parse(req.body);
    const user = await setUserPassword(actor, String(req.params.id), password);
    if (user.id === actor.id) setSessionCookie(req, res, user, { days: await sessionDays(), remember: true });
    audit({ ...actorOf(req, res), action: "user.password", target: `user:${user.id}`, detail: `${user.username}: password reset` });
    res.json(toPublic(user));
  }));

  app.post("/api/users/:id/logout-all", h(async (req, res) => {
    const actor = me(res);
    const target = await getUser(String(req.params.id), { fresh: true });
    if (!target) return res.status(404).json({ error: "That user no longer exists." });
    if (target.role === "owner" && actor.role !== "owner") return res.status(403).json({ error: "Only an owner can change an owner's account." });
    await bumpSessionVersion(target.id);
    audit({ ...actorOf(req, res), action: "auth.logout-all", target: `user:${target.id}`, detail: `${target.username}: signed out by an administrator` });
    res.json({ ok: true });
  }));

  // Anyone who knows a username can lock that account for 15 minutes by guessing; this lets an owner (or an admin, for accounts that aren't the owner's) lift it.
  app.post("/api/users/:id/clear-lock", h(async (req, res) => {
    const actor = me(res);
    const target = await getUser(String(req.params.id), { fresh: true });
    if (!target) return res.status(404).json({ error: "That user no longer exists." });
    if (target.role === "owner" && actor.role !== "owner") return res.status(403).json({ error: "Only an owner can change an owner's account." });
    clearAccountLock(target.id);
    audit({ ...actorOf(req, res), action: "user.clear-lock", target: `user:${target.id}`, detail: `${target.username}: sign-in lock cleared` });
    res.json({ ok: true });
  }));

  app.delete("/api/users/:id", h(async (req, res) => {
    const actor = me(res);
    const user = await deleteUser(actor, String(req.params.id));
    audit({ ...actorOf(req, res), action: "user.delete", target: `user:${user.id}`, detail: user.username });
    res.json({ ok: true });
  }));

  // ── Activity log (owner / admin) ────────────────────────────────────────────
  app.get("/api/audit", h(async (req, res) => {
    const q = z.object({
      user: z.string().max(100).optional(),
      action: z.string().max(100).optional(),
      q: z.string().max(200).optional(),
      from: iso.optional(),
      to: iso.optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }).parse(req.query);
    res.json(await queryAudit(q));
  }));
}

function validTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
