import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "throttle-"));
process.env.BACKUPS = "off";
const { accountKey, loginThrottle, recordLogin } = await import("../server/auth");

test("checks still running count against the login limit", () => {
  const ip = "203.0.113.7";
  const responses = Array.from({ length: 50 }, () => new EventEmitter());
  const allowed = responses.filter((r) => !loginThrottle(ip, r));
  assert.equal(allowed.length, 30, "parallel guesses can't all slip past");
  for (const r of allowed) { recordLogin(ip, false); r.emit("finish"); }
  assert.ok(loginThrottle(ip, new EventEmitter()), "30 failures block");
});

test("a finished check frees its slot", () => {
  const ip = accountKey("slot-test"); // an account allows 8 at once
  const rs = Array.from({ length: 8 }, () => new EventEmitter());
  for (const r of rs) assert.equal(loginThrottle(ip, r), null);
  assert.ok(loginThrottle(ip, new EventEmitter()));
  rs[0].emit("finish");
  assert.equal(loginThrottle(ip, new EventEmitter()), null);
});

test("a success on the address doesn't clear its failures (only the account's)", () => {
  const ip = "203.0.113.9";
  for (let i = 0; i < 29; i++) recordLogin(ip, false);
  recordLogin(ip, true); // signing in to your own account
  recordLogin(ip, false);
  assert.ok(loginThrottle(ip), "30 failures from one address block it, even with a success in between");
});

test("an account locks after 8 failures from any address, and its own success clears it", () => {
  const acct = accountKey("Ana");
  for (let i = 0; i < 8; i++) recordLogin(acct, false);
  assert.ok(loginThrottle(accountKey(" ana ")), "same account, any spelling");
  assert.equal(loginThrottle(accountKey("bob")), null, "other accounts are not affected");
  recordLogin(accountKey("bob"), true);
  assert.ok(loginThrottle(acct), "someone else's success doesn't unlock it");
  recordLogin(acct, true);
  assert.equal(loginThrottle(acct), null);
});
