// Role permissions, two-factor sign-in and offsite backups.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-access-"));
process.env.DATA_DIR = dir;
process.env.BACKUPS = "off";
process.env.SETUP_CODE = "ACCESS-TEST";
delete process.env.SUPABASE_URL;
delete process.env.APP_PASSWORD;

import {
  DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, normalizeRolePermissions, permissionsForRole,
} from "../shared/permissions";

let base = "";
let server: Server;
const jar: Record<string, string[]> = {}; // name -> cookies

function storeCookies(as: string, res: Response) {
  const list = (res.headers as any).getSetCookie?.() as string[] | undefined ?? [];
  const cur = new Map((jar[as] ?? []).map((c) => [c.split("=")[0], c]));
  for (const raw of list) {
    const c = raw.split(";")[0];
    const name = c.split("=")[0];
    if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(raw) || c.endsWith("=")) cur.delete(name);
    else cur.set(name, c);
  }
  jar[as] = [...cur.values()];
}

async function call(method: string, url: string, body?: unknown, o: { as?: string } = {}) {
  const headers: Record<string, string> = { "X-Requested-With": "payroll" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (o.as) headers.Cookie = (jar[o.as] ?? []).join("; ");
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (o.as) storeCookies(o.as, res);
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

const login = (as: string, username: string, password: string, extra: Record<string, unknown> = {}) =>
  call("POST", "/api/auth/login", { username, password, ...extra }, { as });

function sampleDoc(siteId: string, label: string) {
  return {
    version: 2, siteId, label, filename: `${label}.csv`, source: "csv", status: "draft", notes: "",
    periodStart: "2026-01-05", periodEnd: "2026-01-05",
    shifts: [{ id: "s1", employee: "Ana Ruiz", date: "2026-01-05", start: 600, end: 1260, breakMinutes: 0, role: "", source: "csv", note: "" }],
    employees: [{ name: "Ana Ruiz", categoryId: "custom", payBasis: "day_rate", fullDayRate: 120, halfDayRate: 60, hourlyRate: 0, isNetPay: true, excluded: false, adjustments: {}, bonuses: [{ description: "Tip", amount: 15 }], deductions: [] }],
    manualEmployees: [],
    rules: {},
  };
}

let tf: typeof import("../server/twofactor");
let offsite: typeof import("../server/offsite");

before(async () => {
  const express = (await import("express")).default;
  const { createServer } = await import("node:http");
  const routes = await import("../server/routes");
  const { initDatabase } = await import("../server/db");
  tf = await import("../server/twofactor");
  offsite = await import("../server/offsite");
  await initDatabase();
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

// ── Pure ─────────────────────────────────────────────────────────────────────
test("permission table: defaults, unknown keys, requirements", () => {
  assert.deepEqual(normalizeRolePermissions(null), DEFAULT_ROLE_PERMISSIONS);
  assert.deepEqual(normalizeRolePermissions({ manager: { bogus: true }, admin: { "pay.view": false } }), DEFAULT_ROLE_PERMISSIONS);
  const t = normalizeRolePermissions({ viewer: { "pay.view": false } });
  assert.equal(t.viewer.export, false, "exports need pay");
  assert.equal(t.viewer["timesheets.edit"], false);
  assert.equal(t.viewer["reports.view"], true);
  const t2 = normalizeRolePermissions({ manager: { "pay.view": false } });
  assert.equal(t2.manager["timesheets.edit"], false, "editing timesheets needs pay");
  assert.equal(t2.manager["punches.edit"], true);
  assert.deepEqual(permissionsForRole("owner", t2), [...PERMISSIONS]);
  assert.deepEqual(permissionsForRole("admin", t2), [...PERMISSIONS]);
  assert.deepEqual(permissionsForRole("nobody", t2), []);
});

test("TOTP matches the RFC 6238 test vectors (SHA-1)", () => {
  const key = Buffer.from("12345678901234567890");
  for (const [t, code] of [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]] as const) {
    assert.equal(tf.hotp(key, tf.stepAt(t * 1000), 8), code, `T=${t}`);
  }
  const secret = tf.base32Encode(key);
  assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.deepEqual(tf.base32Decode(secret.toLowerCase()), key);
  assert.equal(tf.totp(secret, 59_000), "287082");
});

test("TOTP accepts one step either side and never the same step twice", () => {
  const secret = tf.newSecret();
  const now = Date.parse("2026-11-25T12:00:10Z");
  const step = tf.stepAt(now);
  assert.equal(tf.matchTotp(secret, tf.totp(secret, now), now), step);
  assert.equal(tf.matchTotp(secret, tf.totp(secret, now - 30_000), now), step - 1);
  assert.equal(tf.matchTotp(secret, tf.totp(secret, now + 30_000), now), step + 1);
  assert.equal(tf.matchTotp(secret, tf.totp(secret, now - 60_000), now), null, "two steps old");
  assert.equal(tf.matchTotp(secret, tf.totp(secret, now), now, step), null, "replay");
  assert.equal(tf.matchTotp(secret, "12345", now), null);
  const url = tf.otpauthUrl(secret, "alex", "Payroll Admin");
  assert.match(url, /^otpauth:\/\/totp\/Payroll%20Admin%3Aalex\?secret=[A-Z2-7]+&issuer=Payroll%20Admin/);
  const { codes, hashes } = tf.newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.ok(hashes.every((h) => /^[0-9a-f]{64}$/.test(h)));
});

test("SigV4 matches the AWS documentation example", () => {
  const headers = offsite.signV4({
    method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt",
    headers: { range: "bytes=0-9" },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    date: new Date("2013-05-24T00:00:00Z"),
  });
  assert.equal(headers.Authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assert.equal(headers["x-amz-date"], "20130524T000000Z");
});

test("money is hidden by replacing numeric money fields", async () => {
  const { redactMoney } = await import("../server/permissions");
  const out = redactMoney({ totalPay: 10, employees: [{ fullDayRate: 5, hourlyRate: 2, name: "A", bonuses: [{ amount: 3 }], adjustments: { d: { dockAmount: 1 } } }], employeeCount: 3, payPeriod: "weekly", isNetPay: true, roundingMinutes: 15 });
  assert.deepEqual(out, { totalPay: 0, employees: [{ fullDayRate: 0, hourlyRate: 0, name: "A", bonuses: [{ amount: 0 }], adjustments: { d: { dockAmount: 0 } } }], employeeCount: 3, payPeriod: "weekly", isNetPay: true, roundingMinutes: 15 });
});

// ── Permissions over HTTP ────────────────────────────────────────────────────
let siteA = "", tsA = "", ownerId = "";
const ids: Record<string, string> = {};

test("default permissions keep every role's current access", async () => {
  const setup = await call("POST", "/api/auth/setup", { username: "owner", password: "owner-pass-1", setupCode: "ACCESS-TEST" }, { as: "owner" });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  ownerId = setup.body.user.id;
  siteA = (await call("GET", "/api/bootstrap", undefined, { as: "owner" })).body.sites[0].id;
  tsA = (await call("POST", "/api/timesheets", { doc: sampleDoc(siteA, "A1") }, { as: "owner" })).body.id;
  for (const [username, role] of [["adm", "admin"], ["mgr", "manager"], ["view", "viewer"]] as const) {
    const r = await call("POST", "/api/users", { username, password: "password-123", role }, { as: "owner" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    ids[username] = r.body.id;
    assert.equal((await login(username, username, "password-123")).status, 200);
  }
  const doc = (await call("GET", `/api/timesheets/${tsA}`, undefined, { as: "owner" })).body.doc;
  const pid = await (async () => {
    const emp = await call("POST", `/api/sites/${siteA}/employees`, { name: "Ana Ruiz" }, { as: "owner" });
    assert.equal(emp.status, 200, JSON.stringify(emp.body));
    const r = await call("POST", `/api/sites/${siteA}/punches`, { employeeId: emp.body.id, type: "in", at: "2026-01-05T15:00:00.000Z", note: "forgot" }, { as: "owner" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.id as string;
  })();

  // [method, url, body, manager allowed, viewer allowed]
  const cases: [string, string, unknown, boolean, boolean][] = [
    ["GET", "/api/timesheets", undefined, true, true],
    ["GET", `/api/timesheets/${tsA}`, undefined, true, true],
    ["PUT", `/api/timesheets/${tsA}`, { doc }, true, false],
    ["PATCH", `/api/timesheets/${tsA}`, { label: "x" }, true, false],
    ["POST", `/api/timesheets/${tsA}/duplicate`, undefined, true, false],
    ["GET", `/api/sites/${siteA}/wages`, undefined, true, true],
    ["PUT", `/api/sites/${siteA}/wages`, [], true, false],
    ["GET", `/api/sites/${siteA}/employees`, undefined, true, true],
    ["POST", `/api/sites/${siteA}/employees`, { name: "Zed" }, false, false],
    ["GET", `/api/sites/${siteA}/employee-suggestions`, undefined, false, false],
    ["GET", `/api/sites/${siteA}/punches`, undefined, true, true],
    ["PATCH", `/api/punches/${pid}`, { note: "fixed" }, true, false],
    ["PUT", "/api/prefs", { appName: "Payroll Admin" }, false, false],
    ["GET", "/api/users", undefined, false, false],
    ["GET", "/api/permissions", undefined, false, false],
    ["GET", "/api/offsite", undefined, false, false],
    ["GET", "/api/backups", undefined, false, false],
  ];
  for (const [method, url, body, mgr, view] of cases) {
    for (const [as, expect] of [["mgr", mgr], ["view", view], ["adm", true]] as const) {
      const r = await call(method, url, body, { as });
      assert.equal(r.status !== 403, expect, `${as} ${method} ${url} → ${r.status} ${JSON.stringify(r.body)}`);
    }
  }
  const mgrBoot = (await call("GET", "/api/bootstrap", undefined, { as: "mgr" })).body;
  assert.deepEqual(mgrBoot.user.permissions, PERMISSIONS.filter((p) => DEFAULT_ROLE_PERMISSIONS.manager[p]));
  assert.deepEqual((await call("GET", "/api/auth/me", undefined, { as: "view" })).body.permissions, PERMISSIONS.filter((p) => DEFAULT_ROLE_PERMISSIONS.viewer[p]));
  assert.deepEqual((await call("GET", "/api/auth/status", undefined, { as: "adm" })).body.user.permissions, [...PERMISSIONS]);
  assert.equal((await call("GET", `/api/timesheets/${tsA}`, undefined, { as: "view" })).body.doc.employees[0].fullDayRate, 120, "pay is visible by default");
});

test("toggling permissions takes effect straight away", async () => {
  // Viewers may edit timesheets; managers may manage employees.
  let r = await call("PUT", "/api/permissions", { viewer: { "timesheets.edit": true }, manager: { "employees.manage": true } }, { as: "owner" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call("POST", "/api/timesheets", { doc: sampleDoc(siteA, "by viewer") }, { as: "view" })).status, 200);
  assert.equal((await call("POST", `/api/sites/${siteA}/employees`, { name: "Mia Chen" }, { as: "mgr" })).status, 200);
  assert.ok((await call("GET", "/api/bootstrap", undefined, { as: "view" })).body.user.permissions.includes("timesheets.edit"));

  // Managers lose pay: amounts become 0, and editing timesheets goes with it.
  r = await call("PUT", "/api/permissions", { manager: { "pay.view": false } }, { as: "adm" });
  assert.equal(r.body.roles.manager["timesheets.edit"], false);
  const one = await call("GET", `/api/timesheets/${tsA}`, undefined, { as: "mgr" });
  assert.equal(one.status, 200);
  assert.equal(one.body.doc.employees[0].fullDayRate, 0);
  assert.equal(one.body.doc.employees[0].bonuses[0].amount, 0);
  assert.equal(one.body.doc.employees[0].name, "Ana Ruiz");
  assert.equal(one.headers.get("x-pay-hidden"), "1");
  assert.ok((await call("GET", "/api/timesheets", undefined, { as: "mgr" })).body.every((t: any) => t.totalPay === 0));
  assert.equal((await call("PUT", `/api/timesheets/${tsA}`, { doc: one.body.doc }, { as: "mgr" })).status, 403, "can't save over hidden rates");
  assert.equal((await call("GET", `/api/timesheets/${tsA}`, undefined, { as: "owner" })).body.doc.employees[0].fullDayRate, 120, "owners still see pay");

  // Punches can be taken away from managers.
  await call("PUT", "/api/permissions", { manager: { "punches.edit": false } }, { as: "owner" });
  const deny = await call("POST", `/api/sites/${siteA}/punches`, { employeeName: "Ana Ruiz", type: "in", at: "2026-01-06T15:00:00.000Z" }, { as: "mgr" });
  assert.equal(deny.status, 403);
  assert.match(deny.body.error, /isn't allowed/);

  // Back to the defaults.
  r = await call("POST", "/api/permissions/reset", {}, { as: "owner" });
  assert.deepEqual(r.body.roles, DEFAULT_ROLE_PERMISSIONS);
  assert.equal((await call("POST", "/api/timesheets", { doc: sampleDoc(siteA, "x") }, { as: "view" })).status, 403);
  assert.equal((await call("GET", `/api/timesheets/${tsA}`, undefined, { as: "mgr" })).body.doc.employees[0].fullDayRate, 120);
  assert.equal((await call("PUT", "/api/permissions", { viewer: { export: false } }, { as: "mgr" })).status, 403, "only owners and admins change roles");
  await call("POST", "/api/permissions/reset", {}, { as: "owner" });
});

// ── Two-factor ───────────────────────────────────────────────────────────────
let ownerSecret = "";
let recovery: string[] = [];

test("two-factor: enroll with a code, then sign-in takes a second step", async () => {
  assert.equal((await call("POST", "/api/auth/2fa/setup", { password: "wrong-pass" }, { as: "owner" })).status, 400);
  const s = await call("POST", "/api/auth/2fa/setup", { password: "owner-pass-1" }, { as: "owner" });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  ownerSecret = s.body.secret;
  assert.match(s.body.otpauthUrl, /^otpauth:\/\/totp\//);
  assert.equal((await call("POST", "/api/auth/2fa/enable", { code: "000000" }, { as: "owner" })).status, 400);
  const en = await call("POST", "/api/auth/2fa/enable", { code: tf.totp(ownerSecret) }, { as: "owner" });
  assert.equal(en.status, 200, JSON.stringify(en.body));
  recovery = en.body.recoveryCodes;
  assert.equal(recovery.length, 10);
  const st = (await call("GET", "/api/auth/2fa", undefined, { as: "owner" })).body;
  assert.equal(st.enabled, true);
  assert.equal(st.recoveryCodesLeft, 10);
  const users = (await call("GET", "/api/users", undefined, { as: "owner" })).body;
  const me = users.find((u: any) => u.id === ownerId);
  assert.equal(me.twoFactorEnabled, true);
  assert.equal(me.twoFactor, undefined, "secrets are never sent");

  // Password alone no longer signs in.
  const step1 = await login("o2", "owner", "owner-pass-1");
  assert.equal(step1.status, 200);
  assert.equal(step1.body.twoFactor, "verify");
  assert.ok(step1.body.ticket);
  assert.equal(jar.o2?.some((c) => c.startsWith("payroll_session=")) ?? false, false, "no session yet");
  assert.equal((await call("GET", "/api/bootstrap", undefined, { as: "o2" })).status, 401);
  assert.equal((await call("POST", "/api/auth/2fa/login/verify", { ticket: step1.body.ticket, code: "123456" }, { as: "o2" })).status, 401);
  assert.equal((await call("POST", "/api/auth/2fa/login/verify", { ticket: "forged.ticket", code: "123456" }, { as: "o2" })).status, 401);
  // The code that enabled 2FA can't be replayed; the next step's code works.
  assert.equal((await call("POST", "/api/auth/2fa/login/verify", { ticket: step1.body.ticket, code: tf.totp(ownerSecret) }, { as: "o2" })).status, 401, "replay");
  const ok = await call("POST", "/api/auth/2fa/login/verify", { ticket: step1.body.ticket, code: tf.totp(ownerSecret, Date.now() + 30_000), rememberDevice: true }, { as: "o2" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await call("GET", "/api/bootstrap", undefined, { as: "o2" })).status, 200);
  assert.ok(jar.o2.some((c) => c.startsWith("payroll_2fa_")), "remembered device cookie");

  // A remembered device skips the second step.
  await call("POST", "/api/auth/logout", {}, { as: "o2" });
  const again = await login("o2", "owner", "owner-pass-1");
  assert.equal(again.body.twoFactor, undefined);
  assert.ok(again.body.user);

  // A recovery code works once.
  const s3 = await login("o3", "owner", "owner-pass-1");
  assert.equal(s3.body.twoFactor, "verify");
  const rc = await call("POST", "/api/auth/2fa/login/verify", { ticket: s3.body.ticket, code: recovery[0].toLowerCase() }, { as: "o3" });
  assert.equal(rc.status, 200, JSON.stringify(rc.body));
  assert.equal(rc.body.recoveryCodesLeft, 9);
  const s4 = await login("o4", "owner", "owner-pass-1");
  assert.equal((await call("POST", "/api/auth/2fa/login/verify", { ticket: s4.body.ticket, code: recovery[0] }, { as: "o4" })).status, 401);

  // A ticket allows only a few tries.
  for (let i = 0; i < 5; i++) await call("POST", "/api/auth/2fa/login/verify", { ticket: s4.body.ticket, code: "000000" }, { as: "o4" });
  assert.equal((await call("POST", "/api/auth/2fa/login/verify", { ticket: s4.body.ticket, code: recovery[1] }, { as: "o4" })).status, 401);
  // A fresh ticket (the password is known) doesn't give fresh tries: wrong codes
  // add up per account, so 8 in a row lock the second step, even for the right code.
  for (let i = 0; i < 3; i++) {
    const s = await login(`o5${i}`, "owner", "owner-pass-1");
    assert.equal((await call("POST", "/api/auth/2fa/login/verify", { ticket: s.body.ticket, code: "000000" }, { as: `o5${i}` })).status, 401);
  }
  const s5 = await login("o6", "owner", "owner-pass-1");
  assert.equal((await call("POST", "/api/auth/2fa/login/verify", { ticket: s5.body.ticket, code: recovery[1] }, { as: "o6" })).status, 429, "2FA locked for this account");
  // "Forget devices" ends remembered devices.
  await call("POST", "/api/auth/2fa/forget-devices", {}, { as: "owner" });
  await call("POST", "/api/auth/logout", {}, { as: "o2" });
  assert.equal((await login("o2", "owner", "owner-pass-1")).body.twoFactor, "verify");
});

test("two-factor: requirement for owners and admins, owner reset and the command line", async () => {
  // An admin can't require it before having it themselves.
  assert.equal((await call("PUT", "/api/auth/2fa/policy", { requireForAdmins: true }, { as: "adm" })).status, 409);
  assert.equal((await call("PUT", "/api/auth/2fa/policy", { requireForAdmins: true }, { as: "mgr" })).status, 403);
  assert.equal((await call("PUT", "/api/auth/2fa/policy", { requireForAdmins: true }, { as: "owner" })).status, 200);
  assert.equal((await call("POST", "/api/auth/2fa/disable", { password: "owner-pass-1" }, { as: "owner" })).status, 409, "can't turn it off while required");

  // The admin enrolls while signing in.
  const s = await login("adm2", "adm", "password-123");
  assert.equal(s.body.twoFactor, "setup");
  const setup = await call("POST", "/api/auth/2fa/login/setup", { ticket: s.body.ticket }, { as: "adm2" });
  assert.equal(setup.status, 200);
  const enable = await call("POST", "/api/auth/2fa/login/enable", { ticket: s.body.ticket, code: tf.totp(setup.body.secret) }, { as: "adm2" });
  assert.equal(enable.status, 200, JSON.stringify(enable.body));
  assert.equal(enable.body.recoveryCodes.length, 10);
  assert.equal((await call("GET", "/api/bootstrap", undefined, { as: "adm2" })).status, 200);
  // Managers and viewers are not affected.
  assert.ok((await login("mgr2", "mgr", "password-123")).body.user);

  // Only an owner can reset someone else's two-factor.
  assert.equal((await call("POST", `/api/users/${ids.adm}/2fa/reset`, {}, { as: "adm" })).status, 403);
  const reset = await call("POST", `/api/users/${ids.adm}/2fa/reset`, {}, { as: "owner" });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.twoFactorEnabled, false);

  await call("PUT", "/api/auth/2fa/policy", { requireForAdmins: false }, { as: "owner" });

  // Command line recovery.
  const cli = await import("../server/cli");
  const out: string[] = [];
  const io = { readStdin: async () => "", out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
  assert.equal(await cli.runAdminCli(["disable-2fa", "--username", "OWNER"], io), 0, out.join("\n"));
  assert.match(out.join("\n"), /now off/);
  assert.equal(await cli.runAdminCli(["disable-2fa", "--username", "nobody"], io), 1);
  const { invalidateUsersCache } = await import("../server/users");
  invalidateUsersCache();
  const plain = await login("o5", "owner", "owner-pass-1");
  assert.ok(plain.body.user, JSON.stringify(plain.body));
});

// ── Offsite backups ──────────────────────────────────────────────────────────
interface S3Object { body: Buffer; at: number }
const bucket = new Map<string, S3Object>();
let s3server: Server;
let s3base = "";
let badSignatures = 0;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => { const parts: Buffer[] = []; req.on("data", (c) => parts.push(c)); req.on("end", () => resolve(Buffer.concat(parts))); });
}

test("offsite: folder copy, retention, status, and secrets kept out", async () => {
  const usb = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-usb-"));
  try {
    // An older copy and an unrelated file: retention only removes our own old copies.
    fs.writeFileSync(path.join(usb, "payroll-2020-01-01T00-00-00-auto.json.gz"), "old");
    fs.writeFileSync(path.join(usb, "payroll-2020-01-02T00-00-00-auto.json.gz"), "old");
    fs.writeFileSync(path.join(usb, "notes.txt"), "keep me");

    assert.equal((await call("PUT", "/api/offsite", { folder: { enabled: true, path: "relative/path" } }, { as: "owner" })).status, 400);
    assert.equal((await call("PUT", "/api/offsite", { folder: { enabled: true, path: path.join(usb, "missing") } }, { as: "owner" })).status, 400);
    const t = await call("POST", "/api/offsite/test", { target: "folder", folder: { path: usb } }, { as: "owner" });
    assert.equal(t.body.ok, true, t.body.message);
    const saved = await call("PUT", "/api/offsite", { folder: { enabled: true, path: usb, keep: 2 } }, { as: "owner" });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    assert.equal((await call("POST", "/api/backups", {}, { as: "owner" })).status, 200);
    let names: string[] = [];
    for (let i = 0; i < 50; i++) {
      names = fs.readdirSync(usb).filter((n) => n.endsWith(".json.gz"));
      if (names.some((n) => n.endsWith("-manual.json.gz"))) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(names.length, 2, names.join(", "));
    assert.ok(names.includes("payroll-2020-01-02T00-00-00-auto.json.gz"));
    assert.ok(fs.existsSync(path.join(usb, "notes.txt")));
    const copy = JSON.parse(gunzipSync(fs.readFileSync(path.join(usb, names.find((n) => n.endsWith("-manual.json.gz"))!))).toString("utf8"));
    const keys = copy.settings.map((s: any) => s.key);
    assert.ok(!keys.includes("users"), "no accounts or password hashes offsite");
    assert.ok(!keys.some((k: string) => k.startsWith("offsite:")));
    assert.ok(copy.timesheets.length >= 1);

    // Status shows success, then a failure once the disk is gone.
    let st = (await call("GET", "/api/offsite", undefined, { as: "owner" })).body;
    for (let i = 0; i < 20 && !st.status.folder.lastSuccessAt; i++) { await new Promise((r) => setTimeout(r, 50)); st = (await call("GET", "/api/offsite", undefined, { as: "owner" })).body; }
    assert.ok(st.status.folder.lastSuccessAt);
    assert.deepEqual(st.failing, []);
    fs.rmSync(usb, { recursive: true, force: true });
    const run = await call("POST", "/api/offsite/run", {}, { as: "owner" });
    assert.equal(run.status, 200);
    assert.equal(run.body.result.folder.ok, false);
    assert.equal(run.body.failing[0].target, "folder");
    assert.match(run.body.failing[0].error, /doesn't exist/);
    await call("PUT", "/api/offsite", { folder: { enabled: false } }, { as: "owner" });
  } finally {
    fs.rmSync(usb, { recursive: true, force: true });
  }
});

test("offsite: S3 upload is signed, the secret stays on the server, and settings stay out of backups", async () => {
  s3server = createHttpServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url ?? "/", "http://x");
    const auth = String(req.headers.authorization ?? "");
    const signed = auth.match(/SignedHeaders=([^,]+)/)?.[1].split(";") ?? [];
    const hdrs: Record<string, string> = {};
    for (const h of signed) if (h !== "host" && h !== "x-amz-date" && h !== "x-amz-content-sha256") hdrs[h] = String(req.headers[h]);
    const amz = String(req.headers["x-amz-date"]);
    const date = new Date(`${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`);
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => { query[k] = v; });
    const expect = offsite.signV4({
      method: req.method!, host: String(req.headers.host), path: url.pathname, query, headers: hdrs,
      payloadHash: createHash("sha256").update(body).digest("hex"), region: "auto", accessKeyId: "KEYID", secretAccessKey: "s3cret-key-9876", date,
    });
    if (expect.Authorization !== auth || req.headers["x-amz-content-sha256"] !== createHash("sha256").update(body).digest("hex")) {
      badSignatures++;
      res.statusCode = 403;
      return res.end("<Error><Code>SignatureDoesNotMatch</Code><Message>bad</Message></Error>");
    }
    const key = decodeURIComponent(url.pathname.replace(/^\/my-bucket\/?/, ""));
    if (req.method === "PUT") { bucket.set(key, { body, at: Date.now() }); return res.end(); }
    if (req.method === "DELETE") { bucket.delete(key); res.statusCode = 204; return res.end(); }
    if (req.method === "GET" && query["list-type"] === "2") {
      const items = [...bucket.keys()].filter((k) => k.startsWith(query.prefix ?? "")).map((k) => `<Contents><Key>${k}</Key></Contents>`).join("");
      return res.end(`<?xml version="1.0"?><ListBucketResult>${items}</ListBucketResult>`);
    }
    res.statusCode = 400;
    res.end();
  });
  await new Promise<void>((r) => s3server.listen(0, "127.0.0.1", () => r()));
  s3base = `http://127.0.0.1:${(s3server.address() as AddressInfo).port}`;
  try {
    bucket.set("backups/payroll-2020-01-01T00-00-00-auto.json.gz", { body: Buffer.from("old"), at: 0 });
    bucket.set("backups/other.txt", { body: Buffer.from("x"), at: 0 });
    const s3 = { enabled: true, endpoint: s3base, region: "auto", bucket: "my-bucket", prefix: "backups/", accessKeyId: "KEYID", secretAccessKey: "s3cret-key-9876", keep: 1 };
    const wrong = await call("POST", "/api/offsite/test", { target: "s3", s3: { ...s3, secretAccessKey: "nope-nope" } }, { as: "owner" });
    assert.equal(wrong.body.ok, false);
    assert.match(wrong.body.message, /SignatureDoesNotMatch/);
    const t = await call("POST", "/api/offsite/test", { target: "s3", s3 }, { as: "owner" });
    assert.equal(t.body.ok, true, t.body.message);
    const saved = await call("PUT", "/api/offsite", { s3 }, { as: "owner" });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.config.s3.secretAccessKey, undefined);
    assert.equal(saved.body.config.s3.hasSecret, true);
    assert.equal(saved.body.config.s3.secretHint, "…9876");
    // Saving again without the secret keeps it.
    await call("PUT", "/api/offsite", { s3: { keep: 1, secretAccessKey: "" } }, { as: "owner" });
    const get = await call("GET", "/api/offsite", undefined, { as: "owner" });
    assert.ok(!JSON.stringify(get.body).includes("s3cret-key-9876"));

    badSignatures = 0;
    const run = await call("POST", "/api/offsite/run", {}, { as: "owner" });
    assert.equal(run.body.result.s3.ok, true, JSON.stringify(run.body));
    assert.equal(badSignatures, 0);
    const keys = [...bucket.keys()].sort();
    assert.equal(keys.length, 2, keys.join(", "));
    assert.ok(keys.includes("backups/other.txt"), "other objects are never removed");
    const uploaded = keys.find((k) => /payroll-.*-manual\.json\.gz$/.test(k))!;
    const data = JSON.parse(gunzipSync(bucket.get(uploaded)!.body).toString("utf8"));
    assert.ok(!data.settings.some((s: any) => s.key === "users" || s.key.startsWith("offsite:")));

    // Never in a downloaded backup either, even "with secrets".
    const dl = await call("GET", "/api/backup?secrets=1", undefined, { as: "owner" });
    assert.ok(!dl.body.settings.some((s: any) => s.key.startsWith("offsite:")));
    assert.ok(dl.body.settings.some((s: any) => s.key === "users"));
  } finally {
    await call("PUT", "/api/offsite", { s3: { enabled: false } }, { as: "owner" });
    await new Promise<void>((r) => s3server.close(() => r()));
  }
});

// ── Installable app ──────────────────────────────────────────────────────────
test("installable app: manifests, icons and service worker ship, and the kiosk host serves them", async () => {
  const pub = path.resolve(import.meta.dirname, "..", "client", "public");
  const main = JSON.parse(fs.readFileSync(path.join(pub, "manifest.webmanifest"), "utf8"));
  const kiosk = JSON.parse(fs.readFileSync(path.join(pub, "kiosk.webmanifest"), "utf8"));
  assert.equal(main.theme_color, "#ffffff");
  assert.equal(kiosk.scope, "/kiosk");
  assert.equal(kiosk.display, "fullscreen");
  for (const icon of [...main.icons, ...kiosk.icons]) assert.ok(fs.existsSync(path.join(pub, icon.src)), icon.src);
  assert.ok(main.icons.some((i: any) => i.purpose === "maskable"));
  const sw = fs.readFileSync(path.join(pub, "sw.js"), "utf8");
  assert.match(sw, /startsWith\("\/api\/"\)\) return; \/\/ never cache data/);

  const { request } = await import("node:http");
  const get = (p: string) => new Promise<{ status: number; type: string }>((resolve, reject) => {
    const u = new URL(base);
    const r = request({ host: u.hostname, port: u.port, path: p, headers: { Host: "clock.example.com" } }, (res) => { res.resume(); resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? "") }); });
    r.on("error", reject);
    r.end();
  });
  process.env.KIOSK_HOST = "clock.example.com";
  try {
    // Allowed paths fall through (no static files in tests); blocked ones get the guard's plain-text 404.
    for (const p of ["/kiosk.webmanifest", "/sw.js", "/icons/icon-192.png"]) assert.doesNotMatch((await get(p)).type, /text\/plain/, p);
    assert.match((await get("/manifest.webmanifest")).type, /text\/plain/);
  } finally {
    delete process.env.KIOSK_HOST;
  }
});
