// "Update now": the app writes DATA_DIR/update-request for the installer's systemd path unit.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-upd-"));
process.env.DATA_DIR = dir;
process.env.BACKUPS = "off";
process.env.SETUP_CODE = "ABCDE-FGHJK";
delete process.env.SUPABASE_URL;
delete process.env.PAYROLL_MANAGED;

let base = "";
let server: Server;
let cookie = "";
async function call(method: string, url: string, body?: unknown, auth = true) {
  const headers: Record<string, string> = { "X-Requested-With": "payroll" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && cookie) headers.Cookie = cookie;
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

before(async () => {
  const express = (await import("express")).default;
  const { createServer } = await import("node:http");
  const routes = await import("../server/routes");
  const { initDatabase } = await import("../server/db");
  await initDatabase();
  const app = express();
  app.use(express.json());
  routes.registerRoutes(app);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const s = await call("POST", "/api/auth/setup", { username: "owner", password: "correct horse", setupCode: "ABCDE-FGHJK" }, false);
  cookie = (s.headers.get("set-cookie") ?? "").split(";")[0];
});
after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  (await import("../server/db")).closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Update now: refused without the installer, writes the request with it", async () => {
  assert.equal((await call("GET", "/api/system/update", undefined, false)).status, 401);
  const plain = await call("GET", "/api/system/update");
  assert.equal(plain.body.managed, false);
  assert.equal((await call("POST", "/api/system/update")).status, 409);
  assert.ok(!fs.existsSync(path.join(dir, "update-request")));

  process.env.PAYROLL_MANAGED = "1";
  fs.writeFileSync(path.join(dir, "update-status.json"), JSON.stringify({ state: "ok", from: "a".repeat(40), to: "b".repeat(40), at: new Date().toISOString(), message: "" }));
  const info = await call("GET", "/api/system/update");
  assert.equal(info.body.managed, true);
  assert.equal(info.body.status.state, "ok");
  assert.equal(info.body.requested, false);
  assert.equal((await call("POST", "/api/system/update")).body.ok, true);
  assert.ok(fs.existsSync(path.join(dir, "update-request")), "request file written for payroll-update.path");
  assert.equal((await call("GET", "/api/system/update")).body.requested, true);
  assert.equal((await call("POST", "/api/system/update")).body.alreadyRunning, true, "a second click doesn't queue another");

  // A request nobody picked up for 50+ minutes is cleared
  const old = new Date(Date.now() - 60 * 60_000);
  fs.utimesSync(path.join(dir, "update-request"), old, old);
  assert.equal((await call("GET", "/api/system/update")).body.requested, false);
  delete process.env.PAYROLL_MANAGED;
});
