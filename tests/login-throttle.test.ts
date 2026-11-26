import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "throttle-"));
process.env.BACKUPS = "off";
const { loginThrottle, recordLogin } = await import("../server/auth");

test("checks still running count against the login limit", () => {
  const ip = "203.0.113.7";
  const responses = Array.from({ length: 50 }, () => new EventEmitter());
  const allowed = responses.filter((r) => !loginThrottle(ip, r));
  assert.equal(allowed.length, 8, "parallel guesses can't all slip past");
  for (const r of allowed) { recordLogin(ip, false); r.emit("finish"); }
  assert.ok(loginThrottle(ip, new EventEmitter()), "8 failures block");
});

test("a finished check frees its slot", () => {
  const ip = "203.0.113.8";
  const rs = Array.from({ length: 8 }, () => new EventEmitter());
  for (const r of rs) assert.equal(loginThrottle(ip, r), null);
  assert.ok(loginThrottle(ip, new EventEmitter()));
  rs[0].emit("finish");
  assert.equal(loginThrottle(ip, new EventEmitter()), null);
});
