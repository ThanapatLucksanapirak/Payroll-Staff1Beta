// Settings → Email: "Connect with Google" (send through Gmail without an App password).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-google-"));
process.env.DATA_DIR = dir;
process.env.BACKUPS = "off";
delete process.env.SETUP_CODE;
delete process.env.SUPABASE_URL;
delete process.env.APP_PASSWORD;

let base = "";
let server: Server;
const jar: Record<string, string> = {};
const sent: { to: string[]; provider: string; account: string; refreshToken: string }[] = [];
const tokenCalls: Record<string, string>[] = [];
let tokenReply: { ok: boolean; status: number; body: any } = { ok: true, status: 200, body: {} };

async function call(method: string, url: string, body?: unknown, as?: string) {
  const headers: Record<string, string> = { "X-Requested-With": "payroll" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (as) headers.Cookie = jar[as] ?? "";
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, text, location: res.headers.get("location") ?? "" };
}

async function login(as: string, username: string, password: string) {
  const res = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "payroll" }, body: JSON.stringify({ username, password }) });
  assert.equal(res.status, 200, `login ${username}: ${await res.text()}`);
  jar[as] = (res.headers.get("set-cookie") ?? "").split(";")[0];
}

const idToken = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const goodTokens = () => ({
  access_token: "ya29.access", refresh_token: "1//refresh-secret-token", expires_in: 3599, token_type: "Bearer",
  scope: "https://mail.google.com/ openid https://www.googleapis.com/auth/userinfo.email",
  id_token: idToken({ email: "contact@shijiri.com", email_verified: true }),
});

before(async () => {
  const express = (await import("express")).default;
  const { createServer } = await import("node:http");
  const routes = await import("../server/routes");
  const { initDatabase } = await import("../server/db");
  const users = await import("../server/users");
  const email = await import("../server/email");
  const google = await import("../server/emailGoogle");
  await initDatabase();
  await users.createUser(null, { username: "owner", password: "owner password", role: "owner", notificationEmail: "owner@example.com" });
  await users.createUser(null, { username: "acct", password: "acct password", role: "accountant", notificationEmail: "acct@example.com" });
  email.setEmailSenderForTests(async (cfg, msg) => {
    sent.push({ to: msg.to, provider: cfg.provider, account: cfg.googleAccount, refreshToken: cfg.googleRefreshToken });
  });
  google.setGoogleFetchForTests(async (_url, init) => {
    tokenCalls.push(Object.fromEntries(new URLSearchParams(init.body)));
    return { ok: tokenReply.ok, status: tokenReply.status, json: async () => tokenReply.body };
  });
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  routes.registerRoutes(app);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await login("owner", "owner", "owner password");
  await login("acct", "acct", "acct password");
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  const { closeDatabase } = await import("../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

const googleCfg = { enabled: true, provider: "google", googleClientId: "123-abc.apps.googleusercontent.com", googleClientSecret: "GOCSPX-client-secret", appUrl: "https://payroll.example.com", fromAddress: "contact@shijiri.com" };

async function start() {
  const r = await call("POST", "/api/email/google/start", {}, "owner");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return new URL(r.body.url);
}

test("Google settings save without exposing the secret, and the connection can't be set from the browser", async () => {
  const r = await call("PUT", "/api/email", { config: { ...googleCfg, googleRefreshToken: "forged", googleAccount: "evil@example.com" } }, "owner");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!r.text.includes("GOCSPX"), "secret never returned");
  assert.ok(!r.text.includes("forged"));
  assert.equal(r.body.config.hasGoogleSecret, true);
  assert.equal(r.body.config.googleConnected, false);
  assert.equal(r.body.config.googleAccount, "");
  assert.equal(r.body.ready, false, "not ready until connected");
});

test("only owners and admins can start Google sign-in; the consent URL asks for Gmail", async () => {
  assert.equal((await call("POST", "/api/email/google/start", {}, "acct")).status, 403);
  const url = await start();
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), googleCfg.googleClientId);
  assert.equal(url.searchParams.get("redirect_uri"), "https://payroll.example.com/api/email/google/callback");
  assert.match(url.searchParams.get("scope")!, /https:\/\/mail\.google\.com\//);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.ok((url.searchParams.get("state") ?? "").length >= 40);
});

test("the callback needs a state we issued", async () => {
  const r = await call("GET", "/api/email/google/callback?code=abc&state=made-up");
  assert.equal(r.status, 303);
  assert.equal(r.location, "https://payroll.example.com/?google=expired#/settings/email");
  assert.equal(tokenCalls.length, 0, "Google is never asked");
});

test("cancelling at Google and missing Gmail permission don't connect", async () => {
  let state = (await start()).searchParams.get("state")!;
  let r = await call("GET", `/api/email/google/callback?error=access_denied&state=${state}`);
  assert.match(r.location, /google=denied/);
  state = (await start()).searchParams.get("state")!;
  tokenReply = { ok: true, status: 200, body: { ...goodTokens(), scope: "openid email" } };
  r = await call("GET", `/api/email/google/callback?code=abc&state=${state}`);
  assert.match(r.location, /google=scope/);
  assert.equal((await call("GET", "/api/email", undefined, "owner")).body.config.googleConnected, false);
});

test("connecting saves the account and sends through Gmail", async () => {
  tokenCalls.length = 0;
  tokenReply = { ok: true, status: 200, body: goodTokens() };
  const state = (await start()).searchParams.get("state")!;
  const r = await call("GET", `/api/email/google/callback?code=4%2Fcode&state=${state}`);
  assert.equal(r.status, 303);
  assert.equal(r.location, "https://payroll.example.com/?google=connected#/settings/email");
  assert.deepEqual(tokenCalls[0], {
    code: "4/code", client_id: googleCfg.googleClientId, client_secret: googleCfg.googleClientSecret,
    redirect_uri: "https://payroll.example.com/api/email/google/callback", grant_type: "authorization_code",
  });
  // A state works once.
  assert.match((await call("GET", `/api/email/google/callback?code=again&state=${state}`)).location, /google=expired/);

  const info = await call("GET", "/api/email", undefined, "owner");
  assert.equal(info.body.config.googleConnected, true);
  assert.equal(info.body.config.googleAccount, "contact@shijiri.com");
  assert.equal(info.body.ready, true);
  assert.ok(!info.text.includes("refresh-secret-token"), "refresh token never returned");

  sent.length = 0;
  const t = await call("POST", "/api/email/test", { to: "owner@example.com" }, "owner");
  assert.equal(t.body.ok, true, JSON.stringify(t.body));
  assert.deepEqual(sent[0], { to: ["owner@example.com"], provider: "google", account: "contact@shijiri.com", refreshToken: "1//refresh-secret-token" });

  const log = await call("GET", "/api/audit?limit=50", undefined, "owner");
  assert.ok(!log.text.includes("refresh-secret-token") && !log.text.includes("GOCSPX"), "no secrets in the activity log");
});

test("a new client ID drops the connection; disconnect clears it", async () => {
  // Saving other fields keeps it.
  let r = await call("PUT", "/api/email", { config: { fromName: "Shijiri Payroll Service" } }, "owner");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.config.googleConnected, true);
  r = await call("PUT", "/api/email", { config: { googleClientId: "999-other.apps.googleusercontent.com" } }, "owner");
  assert.equal(r.status, 400, "the old secret belonged to the old client, so a new one is needed");
  r = await call("PUT", "/api/email", { config: { googleClientId: "999-other.apps.googleusercontent.com", googleClientSecret: "GOCSPX-other" } }, "owner");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.config.googleConnected, false);

  // Connect again, then disconnect.
  await call("PUT", "/api/email", { config: googleCfg }, "owner");
  tokenReply = { ok: true, status: 200, body: goodTokens() };
  const state = (await start()).searchParams.get("state")!;
  assert.match((await call("GET", `/api/email/google/callback?code=c&state=${state}`)).location, /google=connected/);
  assert.equal((await call("POST", "/api/email/google/disconnect", {}, "acct")).status, 403);
  assert.equal((await call("POST", "/api/email/google/disconnect", {}, "owner")).status, 200);
  const info = await call("GET", "/api/email", undefined, "owner");
  assert.equal(info.body.config.googleConnected, false);
  assert.equal(info.body.ready, false);
});

test("a bad client secret is reported plainly", async () => {
  tokenReply = { ok: false, status: 401, body: { error: "invalid_client" } };
  const state = (await start()).searchParams.get("state")!;
  assert.match((await call("GET", `/api/email/google/callback?code=c&state=${state}`)).location, /google=client/);
});
