// One password counter per account: sign-in and "enter your password" checks
// share it, and nothing typed as a username can reach another account's counter.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-acct-"));
process.env.DATA_DIR = dir;
process.env.BACKUPS = "off";
process.env.SETUP_CODE = "ABCDE-FGHJK";
delete process.env.SUPABASE_URL;

let base = "";
let server: Server;
let cookie = "";
let siteId = "";

async function call(method: string, url: string, body?: unknown, auth = true, ip = "198.51.100.1") {
  // Each test uses its own address (trust proxy is on), so only the account counters are in play.
  const headers: Record<string, string> = { "X-Requested-With": "payroll", "X-Forwarded-For": ip };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

before(async () => {
  const express = (await import("express")).default;
  const { createServer } = await import("node:http");
  const routes = await import("../server/routes");
  const { initDatabase } = await import("../server/db");
  await initDatabase();
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "8mb" }));
  routes.registerRoutes(app);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const res = await fetch(`${base}/api/auth/setup`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "payroll" }, body: JSON.stringify({ password: "correct horse", setupCode: "ABCDE-FGHJK" }) });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  siteId = (await call("GET", "/api/bootstrap")).body.sites[0].id;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  const { closeDatabase } = await import("../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});


async function login(username: string, password: string, ip?: string) {
  return call("POST", "/api/auth/login", { username, password }, false, ip);
}
const me = async () => (await call("GET", "/api/auth/me")).body;

test("wrong sign-ins and wrong change-password tries share one budget", async () => {
  for (let i = 0; i < 4; i++) assert.equal((await login("admin", "wrong")).status, 401);
  for (let i = 0; i < 4; i++) assert.equal((await call("POST", "/api/auth/change-password", { current: "wrong", next: "brand new password 1" })).status, 400);
  assert.equal((await login("ADMIN", "correct horse")).status, 429, "8 failures in total lock the account, whichever way they came");
  assert.equal((await call("POST", "/api/auth/change-password", { current: "correct horse", next: "brand new password 1" })).status, 429);
});

test("a username shaped like an internal key can't lock someone else", async () => {
  const { accountKey, recordLogin } = await import("../server/auth");
  const { id } = await me();
  // Clear the admin account (a success on its own counter) before trying.
  const { passwordKey } = await import("../server/auth");
  recordLogin(passwordKey({ userId: id }), true);
  for (const name of [`id:${id}`, `pw:id:${id}`, `2fa:id:${id}`]) {
    for (let i = 0; i < 9; i++) await login(name, "wrong", `203.0.113.${i + 1}`);
  }
  assert.equal((await login("admin", "correct horse", "198.51.100.9")).status, 200, "the real account isn't locked");
  assert.equal((await call("POST", "/api/auth/change-password", { current: "wrong", next: "brand new password 1" }, true, "198.51.100.9")).status, 400, "its password checks aren't locked either");
  void accountKey;
});
