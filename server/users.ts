// User accounts and roles.
//
// Accounts are stored as one JSON array in the app_settings key/value table
// (key "users"), so they work the same on SQLite and Supabase and travel with
// "copy data" database switches. Every change is a read-modify-write that runs
// under an in-process lock, so concurrent requests never lose an update.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db";
import type { DataStore } from "./db/types";
import { loadConfig, saveConfig } from "./config";
import { MIN_PASSWORD, burnHash, hashPassword, isLegacyPlain, verifyHash } from "./passwords";

export const ROLES = ["owner", "admin", "manager", "viewer", "accountant"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = { owner: "Owner", admin: "Administrator", manager: "Manager", viewer: "Viewer", accountant: "Accountant" };

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  role: Role;
  /** Locations this user may see. Empty = all locations. Only applies to managers and viewers. */
  siteIds: string[];
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** Bumped by "sign out everywhere" and password changes; older sessions stop working. */
  sessionVersion: number;
  /** Two-factor sign-in (server/twofactor.ts). Missing on accounts that never set it up. */
  twoFactor?: TwoFactorState | null;
  /** Where email notifications go (e.g. "payroll published" for accountants). Empty = no emails. */
  notificationEmail?: string;
}

/** Stored two-factor state. The secret never leaves the server after enrollment. */
export interface TwoFactorState {
  enabled: boolean;
  /** Base32 TOTP secret (set once enabled). */
  secret: string | null;
  /** Secret shown during enrollment, until the first code confirms it. */
  pendingSecret: string | null;
  pendingAt: string | null;
  /** Last accepted 30-second step: a code can't be used twice. */
  lastStep: number;
  /** SHA-256 hashes of unused recovery codes. */
  recovery: string[];
  enabledAt: string | null;
  /** Bumped to forget every "remembered" device. */
  deviceVersion: number;
}

export type PublicUser = Omit<UserRecord, "passwordHash" | "sessionVersion" | "twoFactor"> & { twoFactorEnabled: boolean };

export const USERS_KEY = "users";
/** The account created from a v1/Phase 1 single admin password. */
export const LEGACY_OWNER_ID = "u_legacy_admin";

const recordSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  displayName: z.string().default(""),
  passwordHash: z.string().min(1),
  role: z.enum(ROLES),
  siteIds: z.array(z.string()).default([]),
  active: z.boolean().default(true),
  createdAt: z.string().default(() => new Date().toISOString()),
  lastLoginAt: z.string().nullable().default(null),
  sessionVersion: z.number().int().default(0),
  notificationEmail: z.string().max(200).default("").catch(""),
  twoFactor: z.object({
    enabled: z.boolean().default(false),
    secret: z.string().nullable().default(null),
    pendingSecret: z.string().nullable().default(null),
    pendingAt: z.string().nullable().default(null),
    lastStep: z.number().default(0),
    recovery: z.array(z.string()).default([]),
    enabledAt: z.string().nullable().default(null),
    deviceVersion: z.number().int().default(0),
  }).nullable().optional().catch(null),
});

export const usernameSchema = z.string().trim()
  .min(2, "Use at least 2 characters.").max(64)
  .regex(/^[A-Za-z0-9._@-]+$/, "Use letters, numbers, dots, dashes, underscores or @.");
export const passwordSchema = z.string().min(MIN_PASSWORD, `Use at least ${MIN_PASSWORD} characters.`).max(200);
export const displayNameSchema = z.string().trim().max(100);
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
/** An email address, or "" for none. */
export const notificationEmailSchema = z.string().trim().max(200).refine((v) => v === "" || EMAIL_RE.test(v), "Enter a valid email address, like name@example.com.");

export class UserError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export const toPublic = ({ passwordHash: _p, sessionVersion: _s, twoFactor, ...u }: UserRecord): PublicUser => ({ ...u, twoFactorEnabled: !!twoFactor?.enabled });
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const activeOwners = (users: UserRecord[]) => users.filter((u) => u.role === "owner" && u.active);

// ── Permissions ─────────────────────────────────────────────────────────────
export const isAdmin = (u: Pick<UserRecord, "role">) => u.role === "owner" || u.role === "admin";
/** Accountants only ever read published payroll (see ACCOUNTANT_RULES in access.ts). */
export const isAccountant = (u: Pick<UserRecord, "role">) => u.role === "accountant";
export const canEdit = (u: Pick<UserRecord, "role">) => u.role !== "viewer" && u.role !== "accountant";
export function canAccessSite(u: Pick<UserRecord, "role" | "siteIds">, siteId: string | null | undefined) {
  if (isAdmin(u) || !u.siteIds.length) return true;
  return !!siteId && u.siteIds.includes(siteId);
}

// ── Storage ─────────────────────────────────────────────────────────────────
function parseUsers(raw: unknown): UserRecord[] {
  let list: unknown = raw;
  if (typeof raw === "string") { try { list = JSON.parse(raw); } catch { list = []; } }
  if (!Array.isArray(list)) return [];
  return list.map((u) => recordSchema.safeParse(u)).filter((r) => r.success).map((r) => r.data as UserRecord);
}

let chain: Promise<unknown> = Promise.resolve();
/** Run fn after every earlier user write has finished (in this process). */
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
}

const CACHE_MS = 5_000;
let cache: { store: DataStore; users: UserRecord[]; at: number } | null = null;

export function invalidateUsersCache() { cache = null; }

/** The v1 / Phase 1 single admin password, if one exists. */
async function legacyPasswordHash(store: DataStore): Promise<string | null> {
  const v = await store.getSetting("password_hash");
  return v || loadConfig().passwordHashCache || process.env.APP_PASSWORD || null;
}

async function legacyOwner(hash: string): Promise<UserRecord> {
  return {
    id: LEGACY_OWNER_ID, username: "admin", displayName: "Administrator",
    passwordHash: isLegacyPlain(hash) ? await hashPassword(hash) : hash,
    role: "owner", siteIds: [], active: true, createdAt: new Date().toISOString(), lastLoginAt: null, sessionVersion: 0,
  };
}

function remember(store: DataStore, users: UserRecord[]) {
  cache = { store, users, at: Date.now() };
  if (JSON.stringify(loadConfig().usersCache ?? []) !== JSON.stringify(users)) saveConfig({ usersCache: users });
}

/** Read the accounts. Must run inside `locked`. Creates the owner from a legacy password on first use. */
async function loadUnlocked(store: DataStore): Promise<UserRecord[]> {
  const users = parseUsers(await store.getSetting(USERS_KEY));
  if (users.length) return users;
  const hash = await legacyPasswordHash(store);
  if (!hash) return users;
  const owner = await legacyOwner(hash);
  await store.setSetting(USERS_KEY, JSON.stringify([owner]));
  console.log(`[users] created owner account "admin" from the existing administrator password`);
  return [owner];
}

/** All accounts (cached for a few seconds; `fresh` re-reads the database). */
export async function listUsers(opts: { fresh?: boolean } = {}): Promise<UserRecord[]> {
  let store: DataStore;
  try {
    store = await db();
  } catch (err) {
    // Database unreachable: sign-in keeps working from the last known accounts.
    const cached = parseUsers(loadConfig().usersCache ?? []);
    if (cached.length) return cached;
    const hash = loadConfig().passwordHashCache || process.env.APP_PASSWORD;
    if (hash) return [await legacyOwner(hash)];
    throw err;
  }
  if (!opts.fresh && cache && cache.store === store && Date.now() - cache.at < CACHE_MS) return cache.users;
  return locked(async () => {
    const users = await loadUnlocked(store);
    remember(store, users);
    return users;
  });
}

export async function getUser(id: string, opts?: { fresh?: boolean }) {
  return (await listUsers(opts)).find((u) => u.id === id) ?? null;
}

export async function findUserByName(username: string) {
  return (await listUsers({ fresh: true })).find((u) => sameName(u.username, username)) ?? null;
}

/** True until the first account exists (or a legacy password can be migrated). */
/** Always re-reads the database: an owner may have just been created by the CLI in another process. */
export async function setupRequired(): Promise<boolean> {
  const users = await listUsers({ fresh: true }).catch(() => listUsers());
  return users.length === 0;
}

/** Change the accounts under the lock. `fn` may mutate the array it is given and returns a result. */
async function mutate<T>(fn: (users: UserRecord[]) => T | Promise<T>): Promise<T> {
  return locked(async () => {
    const store = await db();
    const users = (await loadUnlocked(store)).map((u) => ({
      ...u, siteIds: [...u.siteIds], twoFactor: u.twoFactor ? { ...u.twoFactor, recovery: [...u.twoFactor.recovery] } : u.twoFactor,
    }));
    const result = await fn(users);
    await store.setSetting(USERS_KEY, JSON.stringify(users));
    remember(store, users);
    return result;
  });
}

// ── Sign-in ─────────────────────────────────────────────────────────────────
export type AuthResult = { ok: true; user: UserRecord } | { ok: false; reason: "username-required" | "invalid"; username: string };

/**
 * Check a username and password. With a blank username, a single owner can
 * sign in with the password alone (how the app worked before user accounts).
 */
export async function authenticate(username: string, password: string): Promise<AuthResult> {
  const users = await listUsers({ fresh: true }).catch(() => listUsers());
  let user: UserRecord | undefined;
  const name = username.trim();
  if (!name) {
    const owners = activeOwners(users);
    if (owners.length !== 1) { await burnHash(password); return { ok: false, reason: "username-required", username: "" }; }
    user = owners[0];
  } else {
    user = users.find((u) => sameName(u.username, name));
  }
  if (!user || !user.active) { await burnHash(password); return { ok: false, reason: "invalid", username: name }; }
  if (!(await verifyHash(password, user.passwordHash))) return { ok: false, reason: "invalid", username: user.username };
  const id = user.id;
  const now = new Date().toISOString();
  const rehash = isLegacyPlain(user.passwordHash) ? await hashPassword(password) : null;
  await mutate((all) => {
    const u = all.find((x) => x.id === id);
    if (u) { u.lastLoginAt = now; if (rehash) u.passwordHash = rehash; }
  }).catch(() => undefined); // database down: still let them in
  return { ok: true, user: { ...user, lastLoginAt: now } };
}

// ── Management ──────────────────────────────────────────────────────────────
/** Who is making a change. `null` = the server operator (setup, CLI). */
export type Actor = Pick<UserRecord, "id" | "role"> | null;

export const createUserSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema.optional(),
  password: passwordSchema,
  role: z.enum(ROLES).default("viewer"),
  siteIds: z.array(z.string().max(100)).max(500).default([]),
  active: z.boolean().default(true),
  notificationEmail: notificationEmailSchema.optional(),
});
export type CreateUserInput = z.input<typeof createUserSchema>;

export const updateUserSchema = z.object({
  username: usernameSchema.optional(),
  displayName: displayNameSchema.optional(),
  role: z.enum(ROLES).optional(),
  siteIds: z.array(z.string().max(100)).max(500).optional(),
  active: z.boolean().optional(),
  notificationEmail: notificationEmailSchema.optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

function assertCanManage(actor: Actor, target: Pick<UserRecord, "role" | "id">) {
  if (!actor) return;
  if (!isAdmin(actor)) throw new UserError("Only an owner or administrator can manage users.", 403);
  if (actor.role !== "owner" && target.role === "owner" && actor.id !== target.id) throw new UserError("Only an owner can change an owner's account.", 403);
}

export async function createUser(actor: Actor, raw: CreateUserInput, opts: { onlyIfNoUsers?: boolean } = {}): Promise<UserRecord> {
  const input = createUserSchema.parse(raw);
  if (actor && input.role === "owner" && actor.role !== "owner") throw new UserError("Only an owner can add another owner.", 403);
  assertCanManage(actor, { role: input.role, id: "" });
  const passwordHash = await hashPassword(input.password);
  return mutate((users) => {
    if (opts.onlyIfNoUsers && users.length) throw new UserError("This app is already set up. Sign in instead.", 409);
    if (users.some((u) => sameName(u.username, input.username))) throw new UserError(`The username "${input.username}" is already taken.`, 409);
    const user: UserRecord = {
      id: `u_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      username: input.username,
      displayName: input.displayName || input.username,
      passwordHash,
      role: input.role,
      siteIds: input.role === "owner" || input.role === "admin" ? [] : input.siteIds,
      active: input.active,
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
      sessionVersion: 0,
      notificationEmail: input.notificationEmail ?? "",
    };
    users.push(user);
    return user;
  });
}

export async function updateUser(actor: Actor, id: string, raw: UpdateUserInput): Promise<{ before: UserRecord; after: UserRecord }> {
  const patch = updateUserSchema.parse(raw);
  return mutate((users) => {
    const u = users.find((x) => x.id === id);
    if (!u) throw new UserError("That user no longer exists.", 404);
    const before = { ...u, siteIds: [...u.siteIds] };
    assertCanManage(actor, u);
    if (actor && patch.role === "owner" && u.role !== "owner" && actor.role !== "owner") throw new UserError("Only an owner can make someone an owner.", 403);
    if (actor && actor.id === id && ((patch.role && patch.role !== u.role) || patch.active === false)) {
      throw new UserError("You can't change your own role or deactivate your own account.", 400);
    }
    if (patch.username && !sameName(patch.username, u.username) && users.some((x) => x.id !== id && sameName(x.username, patch.username!))) {
      throw new UserError(`The username "${patch.username}" is already taken.`, 409);
    }
    if (patch.username) u.username = patch.username;
    if (patch.displayName !== undefined) u.displayName = patch.displayName || u.username;
    if (patch.role) u.role = patch.role;
    if (patch.siteIds) u.siteIds = patch.siteIds;
    if (patch.active !== undefined) u.active = patch.active;
    if (patch.notificationEmail !== undefined) u.notificationEmail = patch.notificationEmail;
    if (isAdmin(u)) u.siteIds = [];
    if (before.role === "owner" && before.active && !activeOwners(users).length) {
      throw new UserError("This is the last owner. Make someone else an owner first.", 409);
    }
    if (before.active && !u.active) u.sessionVersion++; // sign a deactivated user out everywhere
    return { before, after: { ...u } };
  });
}

export async function deleteUser(actor: Actor, id: string): Promise<UserRecord> {
  return mutate((users) => {
    const i = users.findIndex((x) => x.id === id);
    if (i < 0) throw new UserError("That user no longer exists.", 404);
    const u = users[i];
    if (actor && actor.id === id) throw new UserError("You can't delete your own account.", 400);
    assertCanManage(actor, u);
    users.splice(i, 1);
    if (u.role === "owner" && u.active && !activeOwners(users).length) throw new UserError("This is the last owner and can't be deleted.", 409);
    return u;
  });
}

/** Set a password (signs the user out everywhere). Anyone may set their own; admins may set others'. */
export async function setUserPassword(actor: Actor, id: string, password: string, opts: { reactivate?: boolean } = {}): Promise<UserRecord> {
  passwordSchema.parse(password);
  const passwordHash = await hashPassword(password);
  return mutate((users) => {
    const u = users.find((x) => x.id === id);
    if (!u) throw new UserError("That user no longer exists.", 404);
    if (!actor || actor.id !== id) assertCanManage(actor, u);
    u.passwordHash = passwordHash;
    u.sessionVersion++;
    if (opts.reactivate) u.active = true;
    return { ...u };
  });
}

/** Change one account under the lock (used by two-factor sign-in). Throws 404 when it no longer exists. */
export async function mutateUser<T>(id: string, fn: (u: UserRecord) => T | Promise<T>): Promise<T> {
  return mutate(async (users) => {
    const u = users.find((x) => x.id === id);
    if (!u) throw new UserError("That user no longer exists.", 404);
    return fn(u);
  });
}

/** Sign a user out on every device. */
export async function bumpSessionVersion(id: string): Promise<UserRecord | null> {
  return mutate((users) => {
    const u = users.find((x) => x.id === id);
    if (!u) return null;
    u.sessionVersion++;
    return { ...u };
  });
}

export async function updateProfile(id: string, patch: { displayName?: string; notificationEmail?: string }): Promise<UserRecord> {
  const displayName = patch.displayName === undefined ? undefined : displayNameSchema.parse(patch.displayName);
  const email = patch.notificationEmail === undefined ? undefined : notificationEmailSchema.parse(patch.notificationEmail);
  return mutate((users) => {
    const u = users.find((x) => x.id === id);
    if (!u) throw new UserError("That user no longer exists.", 404);
    if (displayName !== undefined) u.displayName = displayName || u.username;
    if (email !== undefined) u.notificationEmail = email;
    return { ...u };
  });
}

/** Run migration of a legacy password at start-up (logs when it happens). */
export async function ensureUsers(): Promise<number> {
  return (await listUsers({ fresh: true })).length;
}
