// A database held locked past busy_timeout answers 503 "busy" (retryable),
// so the time clock queues the punch instead of showing an error.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-busy-"));
process.env.DATA_DIR = dir;
process.env.BACKUPS = "off";
delete process.env.SUPABASE_URL;
let server: Server;
let base = "";

before(async () => {
  const express = (await import("express")).default;
  const { createServer } = await import("node:http");
  const Database = (await import("better-sqlite3")).default;
  const routes = await import("../server/routes");
  const app = express();
  // A real SQLITE_BUSY error from a second connection that can't get the write lock.
  const a = new Database(path.join(dir, "busy.db"));
  a.exec("create table if not exists t (x)");
  const b = new Database(path.join(dir, "busy.db"));
  b.pragma("busy_timeout = 0");
  app.post("/api/kiosk/punch", (_req, _res, next) => {
    a.exec("begin exclusive");
    try { b.exec("insert into t values (1)"); next(); } catch (err) { next(err); } finally { a.exec("rollback"); }
  });
  routes.registerRoutes(app);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("database is locked → 503 busy with Retry-After", async () => {
  const res = await fetch(`${base}/api/kiosk/punch`, { method: "POST" });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "5");
  const body = await res.json();
  assert.equal(body.code, undefined, "no code, so the kiosk queues the punch as offline");
  assert.equal(body.busy, true);
});
