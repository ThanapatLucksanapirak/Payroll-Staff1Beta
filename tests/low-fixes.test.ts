// Small checks from the stability report: real dates and time zones only,
// employee changes in the activity log, and a signed-out status that doesn't
// describe the database.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-low-"));
process.env.DATA_DIR = dir;
process.env.BACKUPS = "off";
process.env.SETUP_CODE = "ABCDE-FGHJK";
delete process.env.SUPABASE_URL;

let base = "";
let server: Server;
let cookie = "";
let siteId = "";

async function call(method: string, url: string, body?: unknown, auth = true) {
  const headers: Record<string, string> = { "X-Requested-With": "payroll" };
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

test("a holiday on a date that doesn't exist is refused", async () => {
  const bad = await call("PUT", `/api/sites/${siteId}/pay/settings`, { holidays: [{ id: "h1", date: "2026-13-45", name: "Nope" }] });
  assert.equal(bad.status, 400);
  assert.equal((await call("PUT", `/api/sites/${siteId}/pay/settings`, { holidays: [{ id: "h1", date: "2026-02-30", name: "Nope" }] })).status, 400);
  assert.equal((await call("PUT", `/api/sites/${siteId}/pay/settings`, { holidays: [{ id: "h1", date: "2026-12-25", name: "Christmas" }] })).status, 200);
});

test("an unknown time zone is refused", async () => {
  const bad = await call("PUT", `/api/sites/${siteId}`, { rules: { timezone: "Mars/Olympus_Mons" } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /isn't a time zone/);
  assert.equal((await call("PUT", `/api/sites/${siteId}`, { rules: { timezone: "Asia/Bangkok" } })).status, 200);
  assert.equal((await call("POST", "/api/sites", { name: "Bad tz", rules: { timezone: "Nowhere/Land" } })).status, 400);
});

test("employee add, change, PIN change and removal are in the activity log", async () => {
  const e = await call("POST", `/api/sites/${siteId}/employees`, { name: "Dee Park" });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal((await call("PUT", `/api/sites/${siteId}/employees/${e.body.id}`, { role: "Cook" })).status, 200);
  assert.equal((await call("PUT", `/api/sites/${siteId}/employees/${e.body.id}`, { pin: "4829" })).status, 200);
  assert.equal((await call("DELETE", `/api/sites/${siteId}/employees/${e.body.id}`)).status, 200);
  const { queryAudit } = await import("../server/audit");
  const log = await queryAudit({} as any);
  const items: any[] = Array.isArray(log) ? log : (log as any).entries ?? (log as any).items ?? [];
  const actions = items.filter((x) => x.target === `employee:${e.body.id}`).map((x) => x.action).sort();
  assert.deepEqual(actions, ["employee.create", "employee.delete", "employee.pin", "employee.update"]);
  assert.ok(!JSON.stringify(items).includes("4829"), "the PIN itself is never logged");
});

test("signed out, the status says only whether the database is up", async () => {
  const st = await call("GET", "/api/auth/status", undefined, false);
  assert.deepEqual(Object.keys(st.body.db).sort(), ["connected", "error"]);
  assert.equal(st.body.db.connected, true);
  const signedIn = await call("GET", "/api/auth/status");
  assert.ok("label" in signedIn.body.db);
});

test("the database file is private to the server's user", { skip: process.platform === "win32" }, () => {
  assert.equal(fs.statSync(path.join(dir, "payroll.db")).mode & 0o777, 0o600);
});
