// Accountant role, publishing finalized payroll, and email notifications.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-accountant-"));
process.env.DATA_DIR = dir;
process.env.BACKUPS = "off";
delete process.env.SETUP_CODE;
delete process.env.SUPABASE_URL;
delete process.env.APP_PASSWORD;

let base = "";
let server: Server;
const jar: Record<string, string> = {};
const sent: { to: string[]; subject: string; text: string; host: string }[] = [];
let failSend: string | null = null;

async function call(method: string, url: string, body?: unknown, as?: string) {
  const headers: Record<string, string> = { "X-Requested-With": "payroll" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (as) headers.Cookie = jar[as] ?? "";
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, text };
}

async function login(as: string, username: string, password: string) {
  const res = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "payroll" }, body: JSON.stringify({ username, password }) });
  assert.equal(res.status, 200, `login ${username}: ${await res.text()}`);
  jar[as] = (res.headers.get("set-cookie") ?? "").split(";")[0];
}

function sampleDoc(siteId: string, label: string, day: string) {
  return {
    siteId, label, filename: `${label}.csv`, source: "csv", status: "draft", notes: "",
    periodStart: day, periodEnd: day,
    shifts: [{ id: "s1", employee: "Ana Ruiz", date: day, start: 600, end: 1260, breakMinutes: 0, role: "", source: "csv", note: "" }],
    employees: [{ name: "Ana Ruiz", categoryId: "custom", payBasis: "day_rate", fullDayRate: 120, halfDayRate: 60, hourlyRate: 0, isNetPay: true, excluded: false, adjustments: {}, bonuses: [], deductions: [] }],
    manualEmployees: [],
    rules: {},
  };
}

let siteId = "";
let otherSiteId = "";
let tsA = "";
let tsB = "";

before(async () => {
  const express = (await import("express")).default;
  const { createServer } = await import("node:http");
  const routes = await import("../server/routes");
  const { initDatabase } = await import("../server/db");
  const users = await import("../server/users");
  const email = await import("../server/email");
  await initDatabase();
  await users.createUser(null, { username: "owner", password: "owner password", role: "owner" });
  await users.createUser(null, { username: "acct", password: "acct password", role: "accountant", notificationEmail: "acct@example.com" });
  await users.createUser(null, { username: "viewer", password: "viewer password", role: "viewer", notificationEmail: "viewer@example.com" });
  email.setEmailSenderForTests(async (cfg, msg) => {
    if (failSend) throw Object.assign(new Error(failSend + " " + cfg.password), { code: "EAUTH", response: `535 ${failSend}` });
    sent.push({ to: msg.to, subject: msg.subject, text: msg.text, host: cfg.host });
  });
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  routes.registerRoutes(app);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await login("owner", "owner", "owner password");
  await login("acct", "acct", "acct password");
  const boot = await call("GET", "/api/bootstrap", undefined, "owner");
  siteId = boot.body.defaultSiteId;
  const other = await call("POST", "/api/sites", { name: "Second shop" }, "owner");
  otherSiteId = other.body.id;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  const { closeDatabase } = await import("../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("accountant role exists with fixed read-only permissions", async () => {
  const me = await call("GET", "/api/bootstrap", undefined, "acct");
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, "accountant");
  assert.deepEqual([...me.body.user.permissions].sort(), ["export", "pay.view", "reports.view"]);
  assert.equal(me.body.user.notificationEmail, "acct@example.com");
});

test("drafts and unpublished final timesheets are hidden from the accountant", async () => {
  const a = await call("POST", "/api/timesheets", { doc: sampleDoc(siteId, "Week 1", "2026-01-05") }, "owner");
  assert.equal(a.status, 200);
  tsA = a.body.id;
  const b = await call("POST", "/api/timesheets", { doc: sampleDoc(siteId, "Week 2", "2026-01-12") }, "owner");
  tsB = b.body.id;
  const list = await call("GET", "/api/timesheets", undefined, "acct");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, []);
  assert.equal((await call("GET", `/api/timesheets/${tsA}`, undefined, "acct")).status, 403);
  // Publishing needs a finalized timesheet.
  const early = await call("POST", `/api/timesheets/${tsA}/publish`, {}, "owner");
  assert.equal(early.status, 409);
  const fin = await call("PATCH", `/api/timesheets/${tsA}`, { status: "final" }, "owner");
  assert.equal(fin.status, 200);
  assert.deepEqual((await call("GET", "/api/timesheets", undefined, "acct")).body, []);
  assert.equal((await call("GET", `/api/timesheets/${tsA}`, undefined, "acct")).status, 403);
});

test("accountant can't reach anything else", async () => {
  const denied: [string, string, unknown?][] = [
    ["GET", `/api/sites/${siteId}/employees`],
    ["GET", `/api/sites/${siteId}/punches`],
    ["GET", `/api/sites/${siteId}/timeclock`],
    ["GET", `/api/sites/${siteId}/schedule/week/2026-01-05`],
    ["GET", `/api/sites/${siteId}/wages`],
    ["GET", `/api/sites/${siteId}/pay/advances`],
    ["POST", "/api/live/ticket", {}],
    ["GET", "/api/users"],
    ["GET", "/api/email"],
    ["GET", "/api/backup"],
    ["PUT", `/api/timesheets/${tsA}`, { doc: sampleDoc(siteId, "x", "2026-01-05") }],
    ["PATCH", `/api/timesheets/${tsA}`, { label: "renamed" }],
    ["DELETE", `/api/timesheets/${tsA}`],
    ["POST", "/api/timesheets", { doc: sampleDoc(siteId, "new", "2026-01-05") }],
    ["POST", `/api/timesheets/${tsA}/publish`, {}],
    ["DELETE", `/api/timesheets/${tsA}/publish`],
    ["GET", `/api/timesheets/${tsA}/publish`],
  ];
  for (const [m, u, b] of denied) {
    const r = await call(m, u, b, "acct");
    assert.equal(r.status, 403, `${m} ${u} should be denied, got ${r.status}`);
  }
  assert.deepEqual((await call("GET", "/api/timesheets?trash=1", undefined, "acct")).body, []);
});

test("email settings: saved server-side, password never returned", async () => {
  const off = await call("GET", "/api/email", undefined, "owner");
  assert.equal(off.body.ready, false);
  const bad = await call("PUT", "/api/email", { config: { enabled: true, host: "", fromAddress: "x" } }, "owner");
  assert.equal(bad.status, 400);
  const put = await call("PUT", "/api/email", { config: { enabled: true, host: "smtp.example.com", port: 587, security: "starttls", username: "me@example.com", password: "s3cret-app-pass", fromAddress: "payroll@example.com", fromName: "Payroll", appUrl: "https://payroll.example.com" } }, "owner");
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.config.hasPassword, true);
  assert.ok(!put.text.includes("s3cret-app-pass"));
  const get = await call("GET", "/api/email", undefined, "owner");
  assert.ok(!get.text.includes("s3cret-app-pass"));
  assert.equal(get.body.ready, true);
  // A blank password keeps the saved one.
  await call("PUT", "/api/email", { config: { fromName: "Shop payroll", password: "" } }, "owner");
  const { getEmailConfig } = await import("../server/email");
  assert.equal((await getEmailConfig()).password, "s3cret-app-pass");
  assert.equal((await getEmailConfig()).fromName, "Shop payroll");
  // Not in downloaded backups (without secrets), nor in the activity log.
  const backup = await call("GET", "/api/backup", undefined, "owner");
  assert.ok(!backup.text.includes("s3cret-app-pass"));
  const auditLog = await call("GET", "/api/audit?limit=50", undefined, "owner");
  assert.ok(!auditLog.text.includes("s3cret-app-pass"));
  const { isSecretSetting } = await import("../server/offsite");
  assert.equal(isSecretSetting("email:config"), true);
});

test("send test email", async () => {
  const r = await call("POST", "/api/email/test", { to: "owner@example.com" }, "owner");
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.deepEqual(sent.at(-1)!.to, ["owner@example.com"]);
  failSend = "Authentication failed";
  const f = await call("POST", "/api/email/test", { to: "owner@example.com" }, "owner");
  failSend = null;
  assert.equal(f.body.ok, false);
  assert.ok(!f.text.includes("s3cret-app-pass"), "the password is scrubbed from errors");
  const noTo = await call("POST", "/api/email/test", {}, "owner");
  assert.equal(noTo.status, 400);
});

test("publish shows the payroll to the accountant and emails them", async () => {
  sent.length = 0;
  const info = await call("GET", `/api/timesheets/${tsA}/publish`, undefined, "owner");
  assert.equal(info.status, 200);
  assert.equal(info.body.published, null);
  assert.deepEqual(info.body.accountants.map((a: any) => a.email), ["acct@example.com"]);
  const pub = await call("POST", `/api/timesheets/${tsA}/publish`, {}, "owner");
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  assert.ok(pub.body.published.at);
  assert.equal(pub.body.published.email.ok, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ["acct@example.com"], "only accountants are emailed");
  assert.match(sent[0].subject, /Payroll ready/);
  assert.match(sent[0].text, /https:\/\/payroll\.example\.com\/#\/timesheet\//);

  const list = await call("GET", "/api/timesheets", undefined, "acct");
  assert.deepEqual(list.body.map((t: any) => t.id), [tsA]);
  assert.ok(list.body[0].publishedAt);
  assert.ok(list.body[0].totalPay > 0, "accountants see pay");
  const one = await call("GET", `/api/timesheets/${tsA}`, undefined, "acct");
  assert.equal(one.status, 200);
  assert.ok(one.body.publishedAt);
  assert.equal((await call("GET", `/api/sites/${siteId}/pay/settings`, undefined, "acct")).status, 200);
  assert.equal((await call("GET", `/api/timesheets/${tsA}/pay/previous`, undefined, "acct")).status, 200);
  const ytd = await call("GET", `/api/sites/${siteId}/pay/ytd?year=2026`, undefined, "acct");
  assert.equal(ytd.status, 200);
  assert.equal(ytd.body.timesheets, 1);
  // Owners see publishedAt on the list too.
  const ownerList = await call("GET", "/api/timesheets", undefined, "owner");
  assert.ok(ownerList.body.find((t: any) => t.id === tsA).publishedAt);
  assert.equal(ownerList.body.find((t: any) => t.id === tsB).publishedAt, null);
});

test("unpublished final timesheets stay out of the accountant's YTD", async () => {
  await call("PATCH", `/api/timesheets/${tsB}`, { status: "final" }, "owner");
  const ytd = await call("GET", `/api/sites/${siteId}/pay/ytd?year=2026`, undefined, "acct");
  assert.equal(ytd.body.timesheets, 1);
  const ownerYtd = await call("GET", `/api/sites/${siteId}/pay/ytd?year=2026`, undefined, "owner");
  assert.equal(ownerYtd.body.timesheets, 2);
});

test("publishing still works when email fails or is off", async () => {
  failSend = "Server down";
  const r = await call("POST", `/api/timesheets/${tsB}/publish`, {}, "owner");
  failSend = null;
  assert.equal(r.status, 200);
  assert.equal(r.body.published.email.ok, false);
  assert.ok(!JSON.stringify(r.body).includes("s3cret-app-pass"));
  assert.equal((await call("GET", `/api/timesheets/${tsB}`, undefined, "acct")).status, 200);
  const st = await call("GET", "/api/email", undefined, "owner");
  assert.ok(st.body.status.lastError);

  await call("PUT", "/api/email", { config: { enabled: false } }, "owner");
  await call("DELETE", `/api/timesheets/${tsB}/publish`, undefined, "owner");
  assert.equal((await call("GET", `/api/timesheets/${tsB}`, undefined, "acct")).status, 403, "unpublished again");
  const again = await call("POST", `/api/timesheets/${tsB}/publish`, {}, "owner");
  assert.equal(again.status, 200);
  assert.equal(again.body.published.email.ok, false);
  assert.match(again.body.published.email.message, /not set up/);
  await call("PUT", "/api/email", { config: { enabled: true } }, "owner");
});

test("reopening unpublishes; finalizing again does not republish", async () => {
  const re = await call("POST", `/api/timesheets/${tsA}/reopen`, { reason: "fix a rate" }, "owner");
  assert.equal(re.status, 200, JSON.stringify(re.body));
  assert.equal((await call("GET", `/api/timesheets/${tsA}`, undefined, "acct")).status, 403);
  await call("PATCH", `/api/timesheets/${tsA}`, { status: "final" }, "owner");
  assert.equal((await call("GET", `/api/timesheets/${tsA}`, undefined, "acct")).status, 403);
  const list = await call("GET", "/api/timesheets", undefined, "acct");
  assert.deepEqual(list.body.map((t: any) => t.id), [tsB]);
});

test("accountants limited to a location only see that location's payroll and emails", async () => {
  const users = await import("../server/users");
  await users.createUser(null, { username: "acct2", password: "acct2 password", role: "accountant", siteIds: [otherSiteId], notificationEmail: "acct2@example.com" });
  await login("acct2", "acct2", "acct2 password");
  assert.deepEqual((await call("GET", "/api/timesheets", undefined, "acct2")).body, []);
  assert.equal((await call("GET", `/api/timesheets/${tsB}`, undefined, "acct2")).status, 403);
  sent.length = 0;
  await call("POST", `/api/timesheets/${tsA}/publish`, {}, "owner");
  assert.deepEqual(sent.flatMap((s) => s.to), ["acct@example.com"]);
});

test("people set their own notification email; admins set others'", async () => {
  const bad = await call("PUT", "/api/auth/profile", { notificationEmail: "not an email" }, "acct");
  assert.equal(bad.status, 400);
  // Changing the email needs the password (codes and notices go there).
  assert.equal((await call("PUT", "/api/auth/profile", { notificationEmail: "books@example.com" }, "acct")).status, 400);
  assert.equal((await call("PUT", "/api/auth/profile", { notificationEmail: "books@example.com", password: "wrong" }, "acct")).status, 400);
  const ok = await call("PUT", "/api/auth/profile", { notificationEmail: "books@example.com", password: "acct password" }, "acct");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.notificationEmail, "books@example.com");
  assert.equal(ok.body.displayName, "acct", "display name unchanged");
  const list = await call("GET", "/api/users", undefined, "owner");
  const acct = list.body.find((u: any) => u.username === "acct");
  // Changing someone's email needs your own password too.
  assert.equal((await call("PATCH", `/api/users/${acct.id}`, { notificationEmail: "" }, "owner")).status, 400);
  assert.equal((await call("PATCH", `/api/users/${acct.id}`, { notificationEmail: "", actorPassword: "wrong" }, "owner")).status, 400);
  const patch = await call("PATCH", `/api/users/${acct.id}`, { notificationEmail: "", actorPassword: "owner password" }, "owner");
  assert.equal(patch.body.notificationEmail, "");
  // The accountant can't make themselves an editor.
  assert.equal((await call("PATCH", `/api/users/${acct.id}`, { role: "admin" }, "acct")).status, 403);
});

test("the live feed refuses accountants (cookie)", async () => {
  const ctl = new AbortController();
  const res = await fetch(base + "/api/live", { headers: { Cookie: jar.acct }, signal: ctl.signal });
  assert.equal(res.status, 403);
  ctl.abort();
});

test("the saved password is only sent to the server it was entered for", async () => {
  const { resetTestEmailLimit, getEmailConfig } = await import("../server/email");
  resetTestEmailLimit();
  sent.length = 0;
  const moved = await call("POST", "/api/email/test", { to: "owner@example.com", config: { host: "attacker.example.net" } }, "owner");
  assert.equal(moved.status, 400);
  assert.match(moved.body.error, /password again/);
  assert.equal(sent.length, 0);
  const port = await call("PUT", "/api/email", { config: { port: 2525 } }, "owner");
  assert.equal(port.status, 400);
  assert.equal((await getEmailConfig()).port, 587, "nothing saved");
  // With the password typed again it works.
  const ok = await call("POST", "/api/email/test", { to: "owner@example.com", config: { host: "other.example.net", password: "new-pass" } }, "owner");
  assert.equal(ok.body.ok, true);
  assert.equal(sent.at(-1)!.host, "other.example.net");
  // Same server details: the saved password is still used.
  const same = await call("POST", "/api/email/test", { to: "owner@example.com", config: { fromName: "x" } }, "owner");
  assert.equal(same.body.ok, true);
});

test("test emails are rate limited and connection errors are generic", async () => {
  const { resetTestEmailLimit, cleanError } = await import("../server/email");
  resetTestEmailLimit();
  const codes = await Promise.all(Array.from({ length: 6 }, () => call("POST", "/api/email/test", { to: "owner@example.com" }, "owner")));
  assert.deepEqual(codes.map((c) => c.status).sort(), [200, 200, 200, 200, 200, 429]);
  resetTestEmailLimit();
  const msgs = ["ECONNREFUSED", "ETIMEDOUT", "EDNS", "ENOTFOUND"].map((code) => cleanError(Object.assign(new Error("connect " + code + " 10.0.0.5:22"), { code })));
  assert.equal(new Set(msgs).size, 1);
  assert.ok(!msgs[0].includes("10.0.0.5"));
});

test("restore keeps the email settings and refreshes published state", async () => {
  const { getEmailConfig } = await import("../server/email");
  const before = await getEmailConfig();
  const backup = await call("GET", "/api/backup", undefined, "owner");
  const r = await call("POST", "/api/backup/restore", backup.body, "owner");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = await getEmailConfig();
  assert.equal(after.host, before.host);
  assert.equal(after.password, before.password);
  assert.equal((await call("GET", `/api/timesheets/${tsB}`, undefined, "acct")).status, 200);
});

test("accountants don't get employees' standing bonuses and deductions", async () => {
  const put = await call("PUT", `/api/sites/${siteId}/pay/settings`, { recurring: [{ id: "r1", employee: "Ana Ruiz", kind: "deduction", label: "Uniform", amount: 10, active: true }] }, "owner");
  const owner = await call("GET", `/api/sites/${siteId}/pay/settings`, undefined, "owner");
  const acct = await call("GET", `/api/sites/${siteId}/pay/settings`, undefined, "acct");
  assert.equal(acct.status, 200);
  assert.deepEqual(acct.body.recurring, []);
  if (put.status === 200) assert.ok(owner.body.recurring.length >= 1);
});

// ── Two-step sign-in with emailed codes ──────────────────────────────────────
const lastCode = () => {
  const m = /(\d{3}) (\d{3})/.exec(sent.at(-1)?.subject ?? "");
  return m ? m[1] + m[2] : "";
};

test("emails come from Shijiri Payroll Service by default and look branded", async () => {
  const { emailConfigSchema, brandedHtml } = await import("../server/email");
  const d = emailConfigSchema.parse({});
  assert.equal(d.fromAddress, "contact@shijiri.com");
  assert.equal(d.fromName, "Shijiri Payroll Service");
  const html = brandedHtml({ brand: "Shijiri <Payroll>", heading: "Hi", paragraphs: ["a & b"], code: "123456", details: [["Period", "Nov 1"]] });
  assert.ok(html.includes("Shijiri &lt;Payroll&gt;") && html.includes("a &amp; b") && html.includes("123456"));
  assert.ok(!html.includes("<Payroll>"), "escaped");
});

test("an accountant turns on email codes and signs in with one", async () => {
  sent.length = 0;
  assert.equal((await call("PUT", "/api/auth/profile", { notificationEmail: "dana@example.com", password: "acct password" }, "acct")).status, 200);
  const st = await call("GET", "/api/auth/2fa", undefined, "acct");
  assert.equal(st.body.emailAvailable, true);
  assert.equal(st.body.email, "d•••@example.com");
  assert.equal((await call("POST", "/api/auth/2fa/email/setup", { password: "wrong" }, "acct")).status, 400);
  const setup = await call("POST", "/api/auth/2fa/email/setup", { password: "acct password" }, "acct");
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  assert.deepEqual(sent.at(-1)!.to, ["dana@example.com"]);
  const code = lastCode();
  assert.match(code, /^\d{6}$/);
  assert.ok(!JSON.stringify(setup.body).includes(code), "the code is never in the response");
  // Asking again straight away is refused.
  assert.equal((await call("POST", "/api/auth/2fa/email/setup", { password: "acct password" }, "acct")).status, 429);
  const wrong = code === "000000" ? "111111" : "000000";
  assert.equal((await call("POST", "/api/auth/2fa/email/enable", { code: wrong }, "acct")).status, 400);
  const on = await call("POST", "/api/auth/2fa/email/enable", { code }, "acct");
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.recoveryCodes.length, 10);
  assert.equal((await call("POST", "/api/auth/2fa/email/enable", { code }, "acct")).status, 400, "a code works once");
  assert.equal((await call("GET", "/api/auth/2fa", undefined, "acct")).body.method, "email");
  // The email can't be removed while it's used for codes.
  assert.equal((await call("PUT", "/api/auth/profile", { notificationEmail: "" }, "acct")).status, 400, "password needed");
  assert.equal((await call("PUT", "/api/auth/profile", { notificationEmail: "", password: "acct password" }, "acct")).status, 409);
  // A session alone can't move the codes to another address.
  assert.equal((await call("PUT", "/api/auth/profile", { notificationEmail: "evil@example.com" }, "acct")).status, 400);
  // The same email again needs no password.
  assert.equal((await call("PUT", "/api/auth/profile", { notificationEmail: "dana@example.com", displayName: "Dana" }, "acct")).status, 200);

  // Sign in: password, then the emailed code.
  const login = await call("POST", "/api/auth/login", { username: "acct", password: "acct password" });
  assert.equal(login.status, 200);
  assert.equal(login.body.twoFactor, "verify");
  assert.equal(login.body.method, "email");
  assert.equal(login.body.sentTo, "d•••@example.com");
  assert.ok(!login.body.user, "no session yet");
  const loginCode = lastCode();
  assert.equal((await call("POST", "/api/auth/2fa/login/resend", { ticket: login.body.ticket })).status, 429, "resend waits 30 s");
  const bad = await call("POST", "/api/auth/2fa/login/verify", { ticket: login.body.ticket, code: loginCode === "000000" ? "111111" : "000000" });
  assert.equal(bad.status, 401);
  const res = await fetch(base + "/api/auth/2fa/login/verify", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "payroll" }, body: JSON.stringify({ ticket: login.body.ticket, code: loginCode }) });
  assert.equal(res.status, 200);
  assert.ok((res.headers.get("set-cookie") ?? "").includes("="));
});

test("emailed codes allow 5 tries and expire", async () => {
  const users = await import("../server/users");
  const tf = await import("../server/twofactor");
  const u = (await users.listUsers({ fresh: true })).find((x) => x.username === "acct")!;
  const t0 = Date.now() + 120_000;
  sent.length = 0;
  const r = await tf.sendEmailCode(u.id, "login", t0);
  assert.equal(r.ok, true);
  const code = lastCode();
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) assert.equal(await tf.useCode(u.id, wrong, t0), null);
  assert.equal(await tf.useCode(u.id, code, t0), null, "locked after 5 wrong tries");
  await tf.sendEmailCode(u.id, "login", t0 + 60_000);
  const fresh = lastCode();
  assert.equal(await tf.useCode(u.id, fresh, t0 + 60_000 + tf.EMAIL_CODE_MS + 1), null, "expired");
});

test("a failed code email never logs the code", async () => {
  const users = await import("../server/users");
  const tf = await import("../server/twofactor");
  const u = (await users.listUsers({ fresh: true })).find((x) => x.username === "acct")!;
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  failSend = "Server down";
  try {
    const r = await tf.sendEmailCode(u.id, "login", Date.now() + 10 * 60_000);
    assert.equal(r.ok, false);
  } finally { failSend = null; console.error = orig; }
  assert.ok(logs.some((l) => l.includes("[email] could not send")), logs.join("\n"));
  assert.ok(!logs.some((l) => /\d{3} \d{3}/.test(l)), "no code in the log");
});

test("only an owner can change the email of someone using email codes", async () => {
  const users = await import("../server/users");
  await users.createUser(null, { username: "admin2", password: "admin2 password", role: "admin" });
  await login("admin2", "admin2", "admin2 password");
  const list = await call("GET", "/api/users", undefined, "owner");
  const acct = list.body.find((u: any) => u.username === "acct");
  assert.equal((await call("PATCH", `/api/users/${acct.id}`, { notificationEmail: "evil@example.com" }, "admin2")).status, 400, "a session alone can't");
  assert.equal((await call("PATCH", `/api/users/${acct.id}`, { notificationEmail: "evil@example.com", actorPassword: "admin2 password" }, "admin2")).status, 403);
  assert.equal((await call("PATCH", `/api/users/${acct.id}`, { notificationEmail: "books@example.com" }, "owner")).status, 400, "not even the owner's session alone");
  assert.equal((await call("PATCH", `/api/users/${acct.id}`, { notificationEmail: "books@example.com", actorPassword: "owner password" }, "owner")).status, 200);
  // Other changes still need no password.
  assert.equal((await call("PATCH", `/api/users/${acct.id}`, { displayName: "Dana R" }, "owner")).status, 200);
});
