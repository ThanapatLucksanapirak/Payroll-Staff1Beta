// Emailing a finalized payroll's PDFs to the accountant, and how app emails handle replies.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-share-"));
process.env.DATA_DIR = dir;
process.env.BACKUPS = "off";
delete process.env.SETUP_CODE;
delete process.env.SUPABASE_URL;
delete process.env.APP_PASSWORD;

let base = "";
let server: Server;
const jar: Record<string, string> = {};
const sent: any[] = [];
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
let ts = "";
const pdf = (s = "hello") => Buffer.from(`%PDF-1.4\n% ${s}\n%%EOF`).toString("base64");

before(async () => {
  const express = (await import("express")).default;
  const { createServer } = await import("node:http");
  const routes = await import("../server/routes");
  const { initDatabase } = await import("../server/db");
  const users = await import("../server/users");
  const email = await import("../server/email");
  await initDatabase();
  await users.createUser(null, { username: "owner", password: "owner password", role: "owner", displayName: "Hashi", notificationEmail: "hashi@example.com" });
  await users.createUser(null, { username: "acct", password: "acct password", role: "accountant", displayName: "Dana", notificationEmail: "dana@example.com" });
  await users.createUser(null, { username: "acct2", password: "acct2 password", role: "accountant", displayName: "No Email" });
  await users.createUser(null, { username: "viewer", password: "viewer password", role: "viewer", notificationEmail: "viewer@example.com" });
  await users.createUser(null, { username: "admin", password: "admin password", role: "admin" });
  email.setEmailSenderForTests(async (_cfg, msg) => {
    if (failSend) throw Object.assign(new Error(failSend), { code: "ECONNECTION" });
    sent.push(msg);
  });
  const app = express();
  app.use(express.json({ limit: "26mb" }));
  routes.registerRoutes(app);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const [as, p] of [["owner", "owner password"], ["acct", "acct password"], ["viewer", "viewer password"], ["admin", "admin password"]]) await login(as, as, p);
  siteId = (await call("GET", "/api/bootstrap", undefined, "owner")).body.defaultSiteId;
  const doc = {
    siteId, label: "Week 1", filename: "week1.csv", source: "csv", status: "draft", notes: "", periodStart: "2026-01-05", periodEnd: "2026-01-11",
    shifts: [{ id: "s1", employee: "Ana Ruiz", date: "2026-01-05", start: 600, end: 1260, breakMinutes: 0, role: "", source: "csv", note: "" }],
    employees: [{ name: "Ana Ruiz", categoryId: "custom", payBasis: "day_rate", fullDayRate: 120, halfDayRate: 60, hourlyRate: 0, isNetPay: true, excluded: false, adjustments: {}, bonuses: [], deductions: [] }],
    manualEmployees: [], rules: {},
  };
  ts = (await call("POST", "/api/timesheets", { doc }, "owner")).body.id;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  const { closeDatabase } = await import("../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

const acctId = async () => (await call("GET", "/api/users", undefined, "owner")).body.find((u: any) => u.username === "acct").id;
const share = (body: object, as = "owner") => call("POST", `/api/timesheets/${ts}/share`, body, as);

test("needs email set up and a finalized timesheet", async () => {
  const id = await acctId();
  const r = await share({ recipientIds: [id], files: [{ kind: "report", data: pdf() }] });
  assert.equal(r.status, 409, "draft");
  await call("PATCH", `/api/timesheets/${ts}`, { status: "final" }, "owner");
  assert.match((await share({ recipientIds: [id], files: [{ kind: "report", data: pdf() }] })).body.error, /Email isn't set up/);
  const put = await call("PUT", "/api/email", { config: { enabled: true, host: "smtp.example.com", username: "u", password: "p4ssword", fromAddress: "contact@shijiri.com", appUrl: "https://payroll.example.com" } }, "owner");
  assert.equal(put.status, 200, JSON.stringify(put.body));
});

test("only owners and administrators can send", async () => {
  const id = await acctId();
  const body = { recipientIds: [id], files: [{ kind: "report", data: pdf() }] };
  assert.equal((await share(body, "acct")).status, 403);
  assert.equal((await share(body, "viewer")).status, 403);
  assert.equal((await share(body, "admin")).status, 200);
});

test("preview shows the email and sends nothing", async () => {
  sent.length = 0;
  const id = await acctId();
  const r = await share({ recipientIds: [id], files: [{ kind: "report", data: pdf() }, { kind: "statements", data: pdf("two") }], message: "Hi <b>Dana</b>", copyMe: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sent.length, 0, "a preview never sends");
  assert.deepEqual(r.body.to, [{ name: "Dana", email: "dana@example.com" }]);
  assert.deepEqual(r.body.cc, ["hashi@example.com"]);
  assert.equal(r.body.replyTo, "hashi@example.com", "the accountant can reply to the sender");
  assert.match(r.body.subject, /^Payroll documents/);
  assert.match(r.body.subject, /Jan 5, 2026 – Jan 11, 2026$/, "the subject uses the timesheet's pay period, not just the days with shifts");
  assert.deepEqual(r.body.attachments.map((a: any) => a.filename), ["Main Location Week 1 - Full report.pdf", "Main Location Week 1 - Pay statements.pdf"].map((n) => r.body.attachments[0].filename.startsWith("Main") ? n : n.replace(/^Main Location /, "")));
  assert.ok(r.body.html.includes("Hi &lt;b&gt;Dana&lt;/b&gt;"), "the message is escaped");
  assert.ok(!r.body.html.includes("<b>Dana"), "no raw HTML from the message");
});

test("sending attaches the PDFs", async () => {
  sent.length = 0;
  const id = await acctId();
  const r = await share({ recipientIds: [id], files: [{ kind: "payout", data: pdf("payout") }], send: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ["dana@example.com"]);
  assert.equal(sent[0].attachments.length, 1);
  assert.equal(sent[0].attachments[0].contentType, "application/pdf");
  assert.ok(sent[0].attachments[0].content.toString().startsWith("%PDF-"));
  assert.equal(sent[0].replyTo, "hashi@example.com");
  const log = await call("GET", "/api/audit?limit=20", undefined, "owner");
  assert.ok(log.text.includes("timesheet.share"));
});

test("only accountants with access and an email; only real PDFs", async () => {
  const users = (await call("GET", "/api/users", undefined, "owner")).body;
  const viewer = users.find((u: any) => u.username === "viewer").id;
  const noEmail = users.find((u: any) => u.username === "acct2").id;
  const id = await acctId();
  const file = [{ kind: "report", data: pdf() }];
  assert.equal((await share({ recipientIds: [viewer], files: file })).status, 400, "not an accountant");
  assert.equal((await share({ recipientIds: [noEmail], files: file })).status, 400, "no email");
  assert.equal((await share({ recipientIds: ["made-up"], files: file })).status, 400);
  assert.equal((await share({ recipientIds: [id], files: [{ kind: "report", data: Buffer.from("<html>").toString("base64") }] })).status, 400, "not a PDF");
  assert.equal((await share({ recipientIds: [id], files: [{ kind: "report", data: pdf() }, { kind: "report", data: pdf() }] })).status, 400, "twice");
  assert.equal((await share({ recipientIds: [id], files: [{ kind: "virus", data: pdf() }] })).status, 400);
  assert.equal((await share({ recipientIds: [id], files: [] })).status, 400);
});

test("any email address can get it, up to 10", async () => {
  sent.length = 0;
  const id = await acctId();
  const file = [{ kind: "summary", data: pdf() }];
  const r = await share({ emails: ["bookkeeper@firm.example", "Dana@example.com"], recipientIds: [id], files: file, send: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(sent[0].to, ["dana@example.com", "bookkeeper@firm.example"], "each address once");
  assert.equal((await share({ emails: [], files: file })).status, 400, "nobody");
  assert.equal((await share({ emails: ["not-an-email"], files: file })).status, 400);
  const many = Array.from({ length: 11 }, (_, i) => `p${i}@example.com`);
  assert.equal((await share({ emails: many, files: file })).status, 400, "too many");
  const log = await call("GET", "/api/audit?limit=20", undefined, "owner");
  assert.ok(log.text.includes("bookkeeper@firm.example"), "recipients are in the activity log");
});

test("sends are limited per hour", async () => {
  const { resetShareLimit } = await import("../server/share");
  resetShareLimit();
  const body = { emails: ["x@example.com"], files: [{ kind: "summary", data: pdf() }], send: true };
  for (let i = 0; i < 10; i++) assert.equal((await share(body)).status, 200);
  assert.equal((await share(body)).status, 429);
  assert.equal((await share({ ...body, send: false })).status, 200, "previews still work");
  resetShareLimit();
});

test("an oversize PDF gets the friendly message, and failed sends don't count toward the limit", async () => {
  const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(12 * 1024 * 1024, 32)]).toString("base64");
  const r = await share({ emails: ["x@example.com"], files: [{ kind: "report", data: big }], send: true });
  assert.equal(r.status, 413);
  assert.match(r.body.error, /too big to email \(the limit is 10 MB\)/);
  const { resetShareLimit } = await import("../server/share");
  resetShareLimit();
  const body = { emails: ["x@example.com"], files: [{ kind: "summary", data: pdf() }], send: true };
  failSend = "down";
  try { for (let i = 0; i < 12; i++) assert.equal((await share(body)).status, 502); } finally { failSend = null; }
  assert.equal((await share(body)).status, 200, "failures didn't use up the limit");
  resetShareLimit();
});

test("finalizing again (even at the same moment) is logged once", async () => {
  const count = async () => ((await call("GET", "/api/audit?limit=200", undefined, "owner")).text.match(/timesheet\.finalize/g) ?? []).length;
  const before = await count();
  const rs = await Promise.all([1, 2, 3].map(() => call("PATCH", `/api/timesheets/${ts}`, { status: "final" }, "owner")));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(await count(), before, "already final: nothing new logged");
});

test("a failed send says so", async () => {
  failSend = "down";
  try {
    const r = await share({ recipientIds: [await acctId()], files: [{ kind: "report", data: pdf() }], send: true });
    assert.equal(r.status, 502);
  } finally { failSend = null; }
});

test("app emails block replies unless a person sent them", async () => {
  const { replyPolicy, brandedHtml, NO_REPLY_NOTE } = await import("../server/email");
  const html = brandedHtml({ brand: "Shijiri Payroll Service", heading: "Hi", paragraphs: ["x"] });
  const blocked = replyPolicy({ fromAddress: "contact@shijiri.com", blockReplies: true }, { text: "Body", html });
  assert.equal(blocked.replyTo, "no-reply@shijiri.com");
  assert.equal(blocked.headers["Auto-Submitted"], "auto-generated");
  assert.ok(blocked.text.endsWith(NO_REPLY_NOTE));
  assert.ok(blocked.html!.includes("please don&#39;t reply"));
  const person = replyPolicy({ fromAddress: "contact@shijiri.com", blockReplies: true }, { text: "Body", html, replyTo: "hashi@example.com" });
  assert.equal(person.replyTo, "hashi@example.com");
  assert.ok(!person.html!.includes("don&#39;t reply"));
  const open = replyPolicy({ fromAddress: "contact@shijiri.com", blockReplies: false }, { text: "Body", html });
  assert.equal(open.replyTo, undefined);
  assert.equal(open.text, "Body");
  // Sign-in and publish emails go through the same policy.
  sent.length = 0;
  await call("POST", "/api/email/test", { to: "hashi@example.com" }, "owner");
  assert.equal(sent.at(-1).replyTo, "no-reply@shijiri.com");
});
