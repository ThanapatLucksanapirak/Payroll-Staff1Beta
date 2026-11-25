// User accounts, roles, sessions, CSRF, activity log and the operator CLI.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-users-"));
process.env.DATA_DIR = dir;
process.env.BACKUPS = "off";
delete process.env.SETUP_CODE;
delete process.env.SUPABASE_URL;
delete process.env.APP_PASSWORD;

let base = "";
let server: Server;
const jar: Record<string, string> = {}; // name -> "payroll_session=..."

interface CallOpts { as?: string; csrf?: boolean; headers?: Record<string, string> }
async function call(method: string, url: string, body?: unknown, o: CallOpts = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.csrf !== false) headers["X-Requested-With"] = "payroll";
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (o.as) headers.Cookie = jar[o.as] ?? "";
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

async function login(as: string, username: string, password: string) {
  const r = await call("POST", "/api/auth/login", { username, password });
  if (r.status === 200) jar[as] = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return r;
}

function sampleDoc(siteId: string, label: string) {
  return {
    version: 2, siteId, label, filename: `${label}.csv`, source: "csv", status: "draft", notes: "",
    periodStart: "2026-01-05", periodEnd: "2026-01-05",
    shifts: [{ id: "s1", employee: "Ana Ruiz", date: "2026-01-05", start: 600, end: 1260, breakMinutes: 0, role: "", source: "csv", note: "" }],
    employees: [{ name: "Ana Ruiz", categoryId: "custom", payBasis: "day_rate", fullDayRate: 120, halfDayRate: 60, hourlyRate: 0, isNetPay: true, excluded: false, adjustments: {}, bonuses: [], deductions: [] }],
    manualEmployees: [],
    rules: {},
  };
}

let users: typeof import("../server/users");
let cli: typeof import("../server/cli");
let legacyHash = "";

before(async () => {
  const express = (await import("express")).default;
  const { createServer } = await import("node:http");
  const routes = await import("../server/routes");
  const { initDatabase, db } = await import("../server/db");
  const { hashPassword } = await import("../server/passwords");
  users = await import("../server/users");
  cli = await import("../server/cli");
  await initDatabase();
  // An install from before user accounts: only the single admin password exists.
  legacyHash = await hashPassword("legacy secret");
  await (await db()).setSetting("password_hash", legacyHash);
  const app = express();
  app.use((req, res, next) => (req.path.startsWith("/api/backup/restore") ? next() : express.json({ limit: "8mb" })(req, res, next)));
  routes.registerRoutes(app);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  const { closeDatabase } = await import("../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the legacy admin password becomes an owner account; password-only sign-in still works", async () => {
  const st = await call("GET", "/api/auth/status");
  assert.equal(st.body.setupRequired, false);
  assert.equal(st.body.authenticated, false);
  assert.equal(st.body.user, null);

  const r = await login("owner", "", "legacy secret");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.username, "admin");
  assert.equal(r.body.user.role, "owner");
  assert.equal(r.body.user.passwordHash, undefined, "hashes are never sent");

  const me = await call("GET", "/api/auth/status", undefined, { as: "owner" });
  assert.equal(me.body.authenticated, true);
  assert.equal(me.body.user.username, "admin");

  // Username is case-insensitive
  assert.equal((await login("owner2tab", "ADMIN", "legacy secret")).status, 200);
  assert.equal((await call("POST", "/api/auth/login", { username: "admin", password: "nope" })).status, 401);
  // Setup is closed once an owner exists
  assert.equal((await call("POST", "/api/auth/setup", { username: "x", password: "whatever123", setupCode: "x" })).status, 409);
});

test("a Phase 1 bearer token keeps working and is swapped for a cookie", async () => {
  const { getAuthSecret } = await import("../server/config");
  const secret = getAuthSecret();
  const pw = createHmac("sha256", secret).update(legacyHash).digest("base64url").slice(0, 10);
  const payload = Buffer.from(JSON.stringify({ p: "payroll-admin", exp: Date.now() + 86_400_000, pw })).toString("base64url");
  const token = `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
  const r = await call("GET", "/api/bootstrap", undefined, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("set-cookie") ?? "", /payroll_session=/);
  assert.equal(r.body.user.role, "owner");
});

test("state-changing requests need the CSRF header", async () => {
  const no = await call("PUT", "/api/prefs", { appName: "Blocked" }, { as: "owner", csrf: false });
  assert.equal(no.status, 403);
  const noLogin = await call("POST", "/api/auth/login", { password: "legacy secret" }, { csrf: false });
  assert.equal(noLogin.status, 403);
  const ok = await call("PUT", "/api/prefs", { appName: "Payroll Admin" }, { as: "owner" });
  assert.equal(ok.status, 200);
  // Reads don't need it
  assert.equal((await call("GET", "/api/bootstrap", undefined, { as: "owner", csrf: false })).status, 200);
});

let siteA = "", siteB = "", tsA = "", tsB = "";
const ids: Record<string, string> = {};

test("owners manage users; roles and locations are enforced", async () => {
  siteA = (await call("GET", "/api/bootstrap", undefined, { as: "owner" })).body.sites[0].id;
  siteB = (await call("POST", "/api/sites", { name: "Second" }, { as: "owner" })).body.id;
  tsA = (await call("POST", "/api/timesheets", { doc: sampleDoc(siteA, "A1") }, { as: "owner" })).body.id;
  tsB = (await call("POST", "/api/timesheets", { doc: sampleDoc(siteB, "B1") }, { as: "owner" })).body.id;
  assert.ok(tsA && tsB);

  for (const [username, role, siteIds] of [["boss2", "admin", []], ["mgr", "manager", [siteA]], ["view", "viewer", []]] as const) {
    const r = await call("POST", "/api/users", { username, displayName: username.toUpperCase(), password: "password-123", role, siteIds }, { as: "owner" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    ids[username] = r.body.id;
  }
  assert.equal((await call("POST", "/api/users", { username: "MGR", password: "password-123", role: "viewer" }, { as: "owner" })).status, 409, "usernames are unique, ignoring case");
  assert.equal((await call("POST", "/api/users", { username: "short", password: "short", role: "viewer" }, { as: "owner" })).status, 400);

  for (const u of ["boss2", "mgr", "view"]) assert.equal((await login(u, u, "password-123")).status, 200);

  // Viewer: read only
  assert.equal((await call("GET", "/api/timesheets", undefined, { as: "view" })).body.length, 2);
  assert.equal((await call("GET", `/api/timesheets/${tsB}`, undefined, { as: "view" })).status, 200);
  const vPost = await call("POST", "/api/timesheets", { doc: sampleDoc(siteA, "nope") }, { as: "view" });
  assert.equal(vPost.status, 403);
  assert.match(vPost.body.error, /view-only/);
  assert.equal((await call("PATCH", `/api/timesheets/${tsA}`, { label: "x" }, { as: "view" })).status, 403);
  assert.equal((await call("DELETE", `/api/timesheets/${tsA}`, undefined, { as: "view" })).status, 403);
  assert.equal((await call("PUT", "/api/prefs", { appName: "x" }, { as: "view" })).status, 403);
  assert.equal((await call("GET", "/api/users", undefined, { as: "view" })).status, 403);
  assert.equal((await call("GET", "/api/backup", undefined, { as: "view" })).status, 403);

  // Manager: edits only within the allowed location
  const list = (await call("GET", "/api/timesheets", undefined, { as: "mgr" })).body;
  assert.deepEqual(list.map((t: any) => t.id), [tsA]);
  const boot = (await call("GET", "/api/bootstrap", undefined, { as: "mgr" })).body;
  assert.deepEqual(boot.sites.map((s: any) => s.id), [siteA]);
  assert.equal(boot.user.role, "manager");
  assert.equal((await call("GET", `/api/timesheets/${tsB}`, undefined, { as: "mgr" })).status, 403);
  const got = (await call("GET", `/api/timesheets/${tsA}`, undefined, { as: "mgr" })).body;
  assert.equal((await call("PUT", `/api/timesheets/${tsA}`, { doc: { ...got.doc, label: "A1 edited" } }, { as: "mgr" })).status, 200);
  assert.equal((await call("PUT", `/api/timesheets/${tsA}`, { doc: { ...got.doc, siteId: siteB } }, { as: "mgr" })).status, 403);
  assert.equal((await call("PATCH", `/api/timesheets/${tsA}`, { siteId: siteB }, { as: "mgr" })).status, 403);
  assert.equal((await call("POST", "/api/timesheets", { doc: sampleDoc(siteB, "nope") }, { as: "mgr" })).status, 403);
  const created = await call("POST", "/api/timesheets", { doc: sampleDoc(siteA, "A2") }, { as: "mgr" });
  assert.equal(created.status, 200);
  assert.equal((await call("DELETE", `/api/timesheets/${created.body.id}`, undefined, { as: "mgr" })).status, 200, "managers can move to the Trash");
  assert.equal((await call("DELETE", `/api/timesheets/${created.body.id}?permanent=1`, undefined, { as: "mgr" })).status, 403);
  assert.equal((await call("GET", `/api/sites/${siteB}/wages`, undefined, { as: "mgr" })).status, 403);
  assert.equal((await call("PUT", `/api/sites/${siteA}/wages`, [], { as: "mgr" })).status, 200);
  assert.equal((await call("PUT", "/api/prefs", { appName: "x" }, { as: "mgr" })).status, 403);
  assert.equal((await call("GET", "/api/database", undefined, { as: "mgr" })).status, 403);
  assert.equal((await call("GET", "/api/audit", undefined, { as: "mgr" })).status, 403);
  // ...but can manage their own profile
  assert.equal((await call("PUT", "/api/auth/profile", { displayName: "Morgan" }, { as: "mgr" })).body.displayName, "Morgan");

  // Admin: everything except owners
  assert.equal((await call("GET", "/api/database", undefined, { as: "boss2" })).status, 200);
  assert.equal((await call("POST", "/api/users", { username: "o2", password: "password-123", role: "owner" }, { as: "boss2" })).status, 403);
  const ownerId = (await call("GET", "/api/auth/me", undefined, { as: "owner" })).body.id;
  assert.equal((await call("DELETE", `/api/users/${ownerId}`, undefined, { as: "boss2" })).status, 403);
  assert.equal((await call("POST", `/api/users/${ownerId}/password`, { password: "hijacked-1" }, { as: "boss2" })).status, 403);
  assert.equal((await call("PATCH", `/api/users/${ids.view}`, { role: "owner" }, { as: "boss2" })).status, 403);
  assert.equal((await call("PATCH", `/api/users/${ids.view}`, { role: "manager", siteIds: [siteB] }, { as: "boss2" })).status, 200);
  assert.equal((await call("GET", "/api/timesheets", undefined, { as: "view" })).body.length, 1, "location limits apply straight away");
  await call("PATCH", `/api/users/${ids.view}`, { role: "viewer", siteIds: [] }, { as: "boss2" });
});

test("the last owner can't be removed, demoted or deactivated; nobody can remove themselves", async () => {
  const ownerId = (await call("GET", "/api/auth/me", undefined, { as: "owner" })).body.id;
  assert.equal((await call("DELETE", `/api/users/${ownerId}`, undefined, { as: "owner" })).status, 400);
  assert.equal((await call("PATCH", `/api/users/${ownerId}`, { role: "admin" }, { as: "owner" })).status, 400);
  await assert.rejects(users.updateUser(null, ownerId, { role: "admin" }), /last owner/);
  await assert.rejects(users.updateUser(null, ownerId, { active: false }), /last owner/);
  await assert.rejects(users.deleteUser(null, ownerId), /last owner/);

  // With a second owner, one owner may remove the other
  const o2 = await call("POST", "/api/users", { username: "o2", password: "password-123", role: "owner" }, { as: "owner" });
  assert.equal(o2.status, 200);
  assert.equal((await call("PATCH", `/api/users/${o2.body.id}`, { role: "admin" }, { as: "owner" })).status, 200);
  assert.equal((await call("DELETE", `/api/users/${o2.body.id}`, undefined, { as: "owner" })).status, 200);
  // Deactivated users can't sign in, and their sessions end
  assert.equal((await call("PATCH", `/api/users/${ids.boss2}`, { active: false }, { as: "owner" })).status, 200);
  assert.equal((await call("GET", "/api/bootstrap", undefined, { as: "boss2" })).status, 401);
  assert.equal((await login("boss2", "boss2", "password-123")).status, 401);
  await call("PATCH", `/api/users/${ids.boss2}`, { active: true }, { as: "owner" });
});

test("sign out, sign out everywhere, and password changes end sessions", async () => {
  assert.equal((await login("v1", "view", "password-123")).status, 200);
  assert.equal((await login("v2", "view", "password-123")).status, 200);
  const out = await call("POST", "/api/auth/logout", undefined, { as: "v1" });
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie") ?? "", /payroll_session=;.*Expires=Thu, 01 Jan 1970/);

  assert.equal((await call("GET", "/api/bootstrap", undefined, { as: "v2" })).status, 200);
  assert.equal((await call("POST", "/api/auth/logout-all", undefined, { as: "v2" })).status, 200);
  assert.equal((await call("GET", "/api/bootstrap", undefined, { as: "v2" })).status, 401);
  assert.equal((await call("GET", "/api/bootstrap", undefined, { as: "view" })).status, 401, "every device is signed out");

  assert.equal((await login("v1", "view", "password-123")).status, 200);
  assert.equal((await login("v2", "view", "password-123")).status, 200);
  const ch = await call("POST", "/api/auth/change-password", { current: "password-123", next: "password-456" }, { as: "v1" });
  assert.equal(ch.status, 200);
  jar.v1 = (ch.headers.get("set-cookie") ?? "").split(";")[0];
  assert.equal((await call("GET", "/api/bootstrap", undefined, { as: "v1" })).status, 200, "this device stays signed in");
  assert.equal((await call("GET", "/api/bootstrap", undefined, { as: "v2" })).status, 401, "other devices are signed out");
});

test("activity log records sign-ins, changes and folds autosaves together", async () => {
  const got = (await call("GET", `/api/timesheets/${tsA}`, undefined, { as: "owner" })).body;
  for (let i = 0; i < 3; i++) {
    const r = await call("PUT", `/api/timesheets/${tsA}`, { doc: { ...got.doc, label: `Autosave ${i}` } }, { as: "owner" });
    assert.equal(r.status, 200);
  }
  await call("PATCH", `/api/timesheets/${tsA}`, { status: "final" }, { as: "owner" });

  const r = await call("GET", "/api/audit?limit=500", undefined, { as: "owner" });
  assert.equal(r.status, 200);
  const entries: any[] = r.body.entries;
  const has = (action: string, f: (e: any) => boolean = () => true) => entries.some((e) => e.action === action && f(e));
  assert.ok(has("auth.login", (e) => e.userName.includes("admin")));
  assert.ok(has("auth.login-failed"));
  assert.ok(has("auth.logout"));
  assert.ok(has("auth.logout-all"));
  assert.ok(has("user.create", (e) => e.detail.startsWith("mgr")));
  assert.ok(has("user.update", (e) => e.detail.includes("deactivated")));
  assert.ok(has("user.delete"));
  assert.ok(has("user.password"));
  assert.ok(has("timesheet.create", (e) => e.target === `timesheet:${tsA}`));
  assert.ok(has("timesheet.trash"));
  assert.ok(has("timesheet.finalize"));
  assert.ok(has("site.create"));
  assert.ok(has("settings.update"));
  const saves = entries.filter((e) => e.action === "timesheet.update" && e.target === `timesheet:${tsA}` && e.userName.includes("admin"));
  assert.equal(saves.length, 1, "autosaves within a few minutes are one entry");
  assert.equal(saves[0].count, 3);
  assert.equal(saves[0].detail, "Autosave 2");
  assert.ok(entries.every((e) => e.at && e.action && typeof e.ip === "string"));
  // Newest first
  assert.ok(entries[0].at >= entries[entries.length - 1].at);

  const auth = await call("GET", "/api/audit?action=auth", undefined, { as: "owner" });
  assert.ok(auth.body.entries.length > 0 && auth.body.entries.every((e: any) => e.action.startsWith("auth.")));
  const mine = await call("GET", "/api/audit?user=mgr&limit=2", undefined, { as: "owner" });
  assert.ok(mine.body.entries.length <= 2 && mine.body.total >= 2);
  const old = await call("GET", "/api/audit?from=2020-01-01&to=2020-01-31", undefined, { as: "owner" });
  assert.equal(old.body.total, 0);
});

function io(stdin = "") {
  const out: string[] = [], err: string[] = [];
  return { io: { readStdin: async () => stdin, out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

test("operator CLI: create an owner, reset a password, list", async () => {
  const a = io("cli password one\n");
  assert.equal(await cli.runAdminCli(["create", "--username", "ops", "--display-name", "Ops Person", "--password-stdin"], a.io), 0, a.err.join("\n"));
  const r = await login("ops", "ops", "cli password one");
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, "owner");
  assert.equal(r.body.user.displayName, "Ops Person");

  const dup = io("cli password one\n");
  assert.equal(await cli.runAdminCli(["create", "--username", "OPS", "--password-stdin"], dup.io), 1);
  assert.match(dup.err.join(""), /already taken/);
  const short = io("short\n");
  assert.equal(await cli.runAdminCli(["create", "--username", "ops2", "--password-stdin"], short.io), 1);
  assert.equal(await cli.runAdminCli(["create", "--username", "ops3"], io("x").io), 1, "--password-stdin is required");

  const b = io("cli password two\n");
  assert.equal(await cli.runAdminCli(["reset-password", "--username", "ops", "--password-stdin"], b.io), 0, b.err.join("\n"));
  assert.equal((await call("GET", "/api/bootstrap", undefined, { as: "ops" })).status, 401, "the reset signs the account out");
  assert.equal((await login("ops", "ops", "cli password one")).status, 401);
  assert.equal((await login("ops", "ops", "cli password two")).status, 200);
  assert.equal(await cli.runAdminCli(["reset-password", "--username", "ghost", "--password-stdin"], io("whatever-123").io), 1);

  const l = io();
  assert.equal(await cli.runAdminCli(["list"], l.io), 0);
  const text = l.out.join("\n");
  assert.match(text, /^ops\s+Owner\s+active\s+Ops Person/m);
  assert.match(text, /^admin\s+Owner/m);
  assert.equal(await cli.runAdminCli(["frobnicate"], io().io), 2);

  // With two owners, password-only sign-in needs a username
  const blank = await call("POST", "/api/auth/login", { password: "legacy secret" });
  assert.equal(blank.status, 401);
  assert.match(blank.body.error, /username/i);
});

test("first-run setup creates the owner account (fresh install)", async () => {
  // Simulate a fresh database: no accounts and no legacy password.
  const { db } = await import("../server/db");
  const { saveConfig } = await import("../server/config");
  const store = await db();
  const saved = await store.getSetting("users");
  await store.deleteSetting("users");
  await store.deleteSetting("password_hash");
  saveConfig({ passwordHashCache: undefined, usersCache: undefined });
  users.invalidateUsersCache();
  try {
    const st = await call("GET", "/api/auth/status");
    assert.equal(st.body.setupRequired, true);
    const { getSetupCode } = await import("../server/auth");
    const code = getSetupCode();
    const bad = await call("POST", "/api/auth/setup", { username: "first", password: "first-password", setupCode: "WRONG-CODE0" });
    assert.equal(bad.status, 403);
    const ok = await call("POST", "/api/auth/setup", { username: "first", displayName: "First Owner", password: "first-password", setupCode: code });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.user.role, "owner");
    assert.equal(ok.body.user.displayName, "First Owner");
    assert.match(ok.headers.get("set-cookie") ?? "", /payroll_session=/);
    assert.equal((await call("POST", "/api/auth/setup", { username: "second", password: "first-password", setupCode: code })).status, 409);
  } finally {
    if (saved) await store.setSetting("users", saved);
    users.invalidateUsersCache();
  }
});
