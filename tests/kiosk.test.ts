// Time clock: employees, device pairing and scoping, PIN lockout, punches,
// offline replay, live updates and KIOSK_HOST. Runs a real server on a
// temporary SQLite database.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { middayZone } from "./clock-helpers";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-kiosk-"));
process.env.DATA_DIR = dir;
process.env.BACKUPS = "off";
process.env.KIOSK_LOCK_MS = "60000";
delete process.env.SETUP_CODE;
delete process.env.SUPABASE_URL;
delete process.env.KIOSK_HOST;

let base = "";
let port = 0;
let server: Server;
let admin = "";
let siteId = "";
let site2 = "";
let kioskToken = "";

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const hs: Record<string, string> = { ...headers };
  if (body !== undefined) hs["Content-Type"] = "application/json";
  const res = await fetch(base + url, { method, headers: hs, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
// admin = the session cookie ("payroll_session=..."); state-changing calls carry the CSRF header.
const A = (method: string, url: string, body?: unknown) => call(method, url, body, { Cookie: admin, "X-Requested-With": "payroll" });
const K = (method: string, url: string, body?: unknown, token = kioskToken) => call(method, url, body, { "X-Kiosk-Token": token });

before(async () => {
  const express = (await import("express")).default;
  const { createServer } = await import("node:http");
  const routes = await import("../server/routes");
  const { initDatabase } = await import("../server/db");
  const { securityHeaders } = await import("../server/security");
  await initDatabase();
  const app = express();
  app.use(securityHeaders(true));
  app.use(express.json({ limit: "8mb" }));
  routes.registerRoutes(app);
  app.get("/{*path}", (_req, res) => { res.type("text/html").send("<!doctype html><p>admin app</p>"); });
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;

  const code = (await import("../server/auth")).getSetupCode();
  const setup = await call("POST", "/api/auth/setup", { username: "owner", password: "correct horse", setupCode: code }, { "X-Requested-With": "payroll" });
  admin = (setup.headers.get("set-cookie") ?? "").split(";")[0];
  assert.ok(admin, "setup signs in with a cookie");
  const boot = await A("GET", "/api/bootstrap");
  siteId = boot.body.sites[0].id;
  const tzSet = await A("PUT", `/api/sites/${siteId}`, { rules: { timezone: middayZone() } }); // "today" covers the last few hours
  assert.equal(tzSet.status, 200, JSON.stringify(tzSet.body));
  assert.equal(boot.body.sites[0].timeSource, "square", "existing locations default to Square");
  site2 = (await A("POST", "/api/sites", { name: "Uptown" })).body.id;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  const { closeDatabase } = await import("../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("employees: create, unique PIN per location, hashed, import names", async () => {
  const ana = await A("POST", `/api/sites/${siteId}/employees`, { name: "  Ana   Ruiz ", pin: "1234", role: "Cook" });
  assert.equal(ana.status, 200, JSON.stringify(ana.body));
  assert.equal(ana.body.name, "Ana Ruiz", "names are normalised like shift names");
  assert.equal(ana.body.hasPin, true);
  assert.equal(ana.body.pinHash, undefined, "PIN hash never leaves the server");
  assert.equal((await A("POST", `/api/sites/${siteId}/employees`, { name: "Ben Lee", pin: "1234" })).status, 409, "PIN unique per location");
  assert.equal((await A("POST", `/api/sites/${siteId}/employees`, { name: "ana ruiz", pin: "9999" })).status, 409, "name unique per location");
  assert.equal((await A("POST", `/api/sites/${siteId}/employees`, { name: "Ben Lee", pin: "12a4" })).status, 400);
  assert.equal((await A("POST", `/api/sites/${siteId}/employees`, { name: "Ben Lee", pin: "5678" })).status, 200);
  // Same PIN is fine at another location
  assert.equal((await A("POST", `/api/sites/${site2}/employees`, { name: "Zoe Uptown", pin: "1234" })).status, 200);

  const raw = fs.readFileSync(path.join(dir, "payroll.db")).toString("latin1");
  assert.ok(!raw.includes('"pin":"1234"'));

  // Seed from saved wages
  await A("PUT", `/api/sites/${siteId}/wages`, [{ name: "Cara Diaz" }, { name: "Ana Ruiz" }]);
  const sugg = await A("GET", `/api/sites/${siteId}/employee-suggestions`);
  assert.deepEqual(sugg.body.map((s: any) => s.name), ["Cara Diaz"]);
  const imp = await A("POST", `/api/sites/${siteId}/employees/import`, { names: ["Cara Diaz"] });
  assert.equal(imp.body.created.length, 1);
  assert.equal(imp.body.created[0].hasPin, false);
  const list = await A("GET", `/api/sites/${siteId}/employees`);
  assert.deepEqual(list.body.map((e: any) => e.name), ["Ana Ruiz", "Ben Lee", "Cara Diaz"]);
});

test("time source setting is saved on the location", async () => {
  const r = await A("PUT", `/api/sites/${siteId}`, { timeSource: "both", kioskLoginMode: "name_pin" });
  assert.equal(r.status, 200);
  assert.equal(r.body.timeSource, "both");
  assert.equal(r.body.kioskLoginMode, "name_pin");
  assert.equal((await A("PUT", `/api/sites/${siteId}`, { timeSource: "paper" })).status, 400);
  // Changing one field leaves the others alone (zod 4 .partial() fills defaults)
  await A("PUT", `/api/sites/${siteId}`, { rules: { clockInCutoff: 600 } });
  const renamed = await A("PUT", `/api/sites/${siteId}`, { name: "Main Location" });
  assert.equal(renamed.body.timeSource, "both");
  assert.equal(renamed.body.kioskLoginMode, "name_pin");
  assert.equal(renamed.body.rules.clockInCutoff, 600, "rules kept on rename");
  assert.equal(renamed.body.rules.timezone, middayZone(), "changing one rule keeps the others");
  await A("PUT", `/api/sites/${site2}`, { timeSource: "kiosk" });
});

test("device pairing: link token, short code exchange, revoke", async () => {
  const created = await A("POST", `/api/sites/${siteId}/kiosk-devices`, { name: "Front tablet" });
  assert.equal(created.status, 200);
  assert.match(created.body.pairCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.ok(created.body.token.length > 40);
  assert.equal(created.body.pairPath, `/kiosk#pair=${created.body.token}`);
  const listed = await A("GET", `/api/sites/${siteId}/kiosk-devices`);
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0].tokenHash, undefined);

  assert.equal((await call("POST", "/api/kiosk/pair", { code: "AAAA-AAAA" })).status, 403);
  const paired = await call("POST", "/api/kiosk/pair", { code: created.body.pairCode.toLowerCase() });
  assert.equal(paired.status, 200);
  assert.equal(paired.body.site.id, siteId);
  kioskToken = paired.body.token;
  // New devices take a photo with each punch; these tests punch without photos.
  assert.equal(created.body.device.options?.photo ?? (await A("GET", `/api/sites/${siteId}/kiosk-devices`)).body[0].options.photo, true, "photos on by default");
  assert.equal((await A("PUT", `/api/sites/${siteId}/kiosk-devices/${created.body.device.id}/options`, { photo: false })).status, 200);
  assert.equal((await K("GET", "/api/kiosk/state", undefined, created.body.token)).status, 401, "code exchange replaces the link token");
  assert.equal((await call("POST", "/api/kiosk/pair", { code: created.body.pairCode })).status, 403, "codes are single use");

  const st = await K("GET", "/api/kiosk/state");
  assert.equal(st.status, 200);
  assert.equal(st.body.site.name, "Main Location");
  assert.equal(st.body.site.loginMode, "name_pin");
  assert.deepEqual(st.body.employees.map((e: any) => e.name), ["Ana Ruiz", "Ben Lee"], "only active employees with a PIN");
  assert.ok(!JSON.stringify(st.body).match(/rate|pay|wage/i), "nothing about pay");

  // Revoke a second device
  const other = await A("POST", `/api/sites/${siteId}/kiosk-devices`, { name: "Spare" });
  assert.equal((await K("GET", "/api/kiosk/state", undefined, other.body.token)).status, 200);
  assert.equal((await A("DELETE", `/api/sites/${siteId}/kiosk-devices/${other.body.device.id}`)).body.ok, true);
  assert.equal((await K("GET", "/api/kiosk/state", undefined, other.body.token)).status, 401);
});

test("a kiosk token cannot use admin APIs or another location", async () => {
  for (const url of ["/api/bootstrap", "/api/timesheets", `/api/sites/${siteId}/employees`, `/api/sites/${siteId}/wages`, "/api/backup", `/api/sites/${siteId}/timeclock`]) {
    assert.equal((await K("GET", url)).status, 401, url);
    assert.equal((await call("GET", url, undefined, { Authorization: `Bearer ${kioskToken}` })).status, 401, url);
  }
  assert.ok([401, 403].includes((await K("POST", "/api/live/ticket")).status), "kiosk token cannot get a live ticket");
  assert.equal((await call("GET", "/api/kiosk/state", undefined, { Cookie: admin })).status, 401, "admin session is not a kiosk token");
  assert.equal((await K("GET", "/api/kiosk/nope")).status, 404);
  // Zoe's PIN (1234 at Uptown) is Ana's PIN here, so use an Uptown-only PIN
  await A("POST", `/api/sites/${site2}/employees`, { name: "Yan Uptown", pin: "4321" });
  const wrongSite = await K("POST", "/api/kiosk/identify", { pin: "4321" });
  assert.equal(wrongSite.status, 403, "employees of another location are not found");
  const zoe = (await A("GET", `/api/sites/${site2}/employees`)).body.find((e: any) => e.name === "Zoe Uptown");
  const r = await K("POST", "/api/kiosk/identify", { pin: "1234", employeeId: zoe.id });
  assert.equal(r.status, 403);
  // Reset failures with a good PIN
  assert.equal((await K("POST", "/api/kiosk/identify", { pin: "1234" })).status, 200);
});

test("punch flow with state validation and friendly messages", async () => {
  const id = await K("POST", "/api/kiosk/identify", { pin: "1234" });
  assert.equal(id.status, 200);
  assert.equal(id.body.employee.name, "Ana Ruiz");
  assert.equal(id.body.status, "out");
  assert.deepEqual(id.body.actions, ["in"]);
  const ticket = id.body.ticket;

  const pin = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", ticket });
  assert.equal(pin.status, 200, JSON.stringify(pin.body));
  assert.equal(pin.body.status, "in");
  const again = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", ticket });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "You're already clocked in.");
  const badEnd = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "break_end", pin: "1234" });
  assert.equal(badEnd.body.error, "You're not on a break.");
  assert.equal((await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "break_start", ticket })).body.status, "break");
  const id2 = await K("POST", "/api/kiosk/identify", { pin: "1234" });
  assert.deepEqual(id2.body.actions, ["break_end", "out"]);
  assert.equal((await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "out", ticket })).body.status, "out");
  // A forged ticket is rejected
  assert.equal((await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", ticket: "x.y" })).status, 401);
});

test("offline replay is idempotent and the device time must be sane", async () => {
  const pid = randomUUID();
  const at = new Date(Date.now() - 2 * 3600_000).toISOString();
  const first = await K("POST", "/api/kiosk/punch", { id: pid, type: "in", pin: "5678", at });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.punch.at, at, "device timestamp kept");
  assert.equal(first.body.duplicate, false);
  const replay = await K("POST", "/api/kiosk/punch", { id: pid, type: "in", pin: "5678", at });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
  const out = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "out", pin: "5678", at: new Date(Date.now() - 3600_000).toISOString() });
  assert.equal(out.status, 200);
  const today = await A("GET", `/api/sites/${siteId}/timeclock`);
  const ben = today.body.employees.find((e: any) => e.name === "Ben Lee");
  assert.equal(ben.status, "out");
  assert.ok(ben.minutes >= 59 && ben.minutes <= 61, String(ben.minutes));
  assert.equal(today.body.punches.filter((p: any) => p.id === pid).length, 1, "stored once");

  const future = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", pin: "5678", at: new Date(Date.now() + 10 * 60_000).toISOString() });
  assert.equal(future.status, 422);
  const old = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", pin: "5678", at: new Date(Date.now() - 25 * 3600_000).toISOString() });
  assert.equal(old.status, 422);
  assert.equal((await K("POST", "/api/kiosk/punch", { id: "bad id!", type: "in", pin: "5678" })).status, 400);
});

test("PIN attempts lock the device after repeated failures", async () => {
  const dev = await A("POST", `/api/sites/${siteId}/kiosk-devices`, { name: "Lock test" });
  const t = dev.body.token;
  const codes: number[] = [];
  const left: (number | undefined)[] = [];
  const msgs: string[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await K("POST", "/api/kiosk/identify", { pin: "0000" }, t);
    codes.push(r.status); left.push(r.body.triesLeft); msgs.push(r.body.error);
  }
  assert.deepEqual(codes, [403, 403, 403, 403, 429]);
  assert.deepEqual(left.slice(0, 4), [4, 3, 2, 1], "tries left before the lock");
  assert.equal(msgs[0], "That PIN didn't match. Try again.");
  assert.match(msgs[2], /2 tries left/);
  assert.match(msgs[3], /1 try left/);
  assert.ok(Number((await K("POST", "/api/kiosk/identify", { pin: "0000" }, t)).body.retryAfter) > 0, "the kiosk gets seconds to count down");
  const locked = await K("POST", "/api/kiosk/identify", { pin: "1234" }, t);
  assert.equal(locked.status, 429, "even the right PIN waits");
  assert.equal(locked.body.code, "locked");
  assert.ok(Number(locked.headers.get("retry-after")) > 0);
  // Punching with a PIN is covered by the same lock
  assert.equal((await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", pin: "1234" }, t)).status, 429);
  // A reloaded kiosk learns about the lock from its state, so the countdown comes back
  const st = await K("GET", "/api/kiosk/state", undefined, t);
  assert.ok(st.body.pinLockSeconds > 0 && st.body.pinLockSeconds <= 60, String(st.body.pinLockSeconds));
  assert.equal((await K("GET", "/api/kiosk/state")).body.pinLockSeconds, 0, "other devices aren't locked");
  // Other devices are not affected
  assert.equal((await K("POST", "/api/kiosk/identify", { pin: "1234" })).status, 200);
});

test("disabled when the location uses Square only", async () => {
  await A("PUT", `/api/sites/${siteId}`, { timeSource: "square" });
  const r = await K("POST", "/api/kiosk/identify", { pin: "1234" });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "disabled");
  assert.equal((await K("GET", "/api/kiosk/state")).body.site.enabled, false);
  await A("PUT", `/api/sites/${siteId}`, { timeSource: "both" });
});

/** Read SSE events from /api/live until `pred` matches or the timeout passes. */
function listen(url: string, pred: (ev: { event: string; data: any }) => boolean, timeoutMs = 4000) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; events: { event: string; data: any }[] }>((resolve, reject) => {
    const events: { event: string; data: any }[] = [];
    const req = http.get(base + url, (res) => {
      let buf = "";
      const done = () => { clearTimeout(timer); req.destroy(); resolve({ status: res.statusCode!, headers: res.headers, events }); };
      const timer = setTimeout(done, timeoutMs);
      if (res.statusCode !== 200) { res.resume(); return done(); }
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev && data) {
            const e = { event: ev, data: JSON.parse(data) };
            events.push(e);
            if (pred(e)) return done();
          }
        }
      });
    });
    req.on("error", reject);
  });
}

test("live updates: ticket-authenticated SSE stream receives punches", async () => {
  assert.ok([401, 403].includes((await call("POST", "/api/live/ticket")).status), "no ticket without a session");
  const bad = await listen("/api/live?ticket=nope", () => true, 1000);
  assert.equal(bad.status, 401);
  const { ticket } = (await A("POST", "/api/live/ticket")).body;
  const got = listen(`/api/live?ticket=${encodeURIComponent(ticket)}`, (e) => e.event === "punch");
  await new Promise((r) => setTimeout(r, 150));
  const punch = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", pin: "1234" });
  assert.equal(punch.status, 200, JSON.stringify(punch.body));
  const r = await got;
  assert.equal(r.status, 200);
  assert.match(String(r.headers["content-type"]), /text\/event-stream/);
  assert.equal(r.headers["x-accel-buffering"], "no");
  assert.match(String(r.headers["cache-control"]), /no-cache/);
  assert.equal(r.events[0].event, "hello");
  const ev = r.events.find((e) => e.event === "punch")!;
  assert.ok(ev, "punch event received");
  assert.equal(ev.data.action, "created");
  assert.equal(ev.data.siteId, siteId);
  assert.equal(ev.data.punch.employeeName, "Ana Ruiz");
});

test("admin fixes punches with a note, and punches become shifts", async () => {
  const today = await A("GET", `/api/sites/${siteId}/timeclock`);
  const ana = today.body.employees.find((e: any) => e.name === "Ana Ruiz");
  assert.equal(ana.status, "in");
  // Add a clock-out 30 minutes from the clock-in (rather than now) to make a real shift
  const inPunch = today.body.punches.find((p: any) => p.employeeId === ana.id && p.type === "in");
  const noNote = await A("POST", `/api/sites/${siteId}/punches`, { employeeId: ana.id, type: "out", at: new Date().toISOString() });
  assert.equal(noNote.status, 400);
  const added = await A("POST", `/api/sites/${siteId}/punches`, { employeeId: ana.id, type: "out", at: new Date().toISOString(), note: "Forgot to clock out" });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.source, "admin");
  const dupIn = await A("POST", `/api/sites/${siteId}/punches`, { employeeId: ana.id, type: "out", at: new Date().toISOString(), note: "x" });
  assert.equal(dupIn.status, 409);
  assert.match(dupIn.body.error, /they were not clocked in/);

  // Moving Ana's latest clock-in before her earlier shift would overlap it
  const overlap = await A("PATCH", `/api/punches/${inPunch.id}`, { at: new Date(Date.parse(inPunch.at) - 90 * 60_000).toISOString(), note: "x" });
  assert.equal(overlap.status, 409);
  // Ben actually started an hour earlier
  const benIn = today.body.punches.find((p: any) => p.employeeName === "Ben Lee" && p.type === "in");
  const edited = await A("PATCH", `/api/punches/${benIn.id}`, { at: new Date(Date.parse(benIn.at) - 60 * 60_000).toISOString(), note: "Started earlier" });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.edits.length, 1);
  assert.equal(edited.body.edits[0].before.at, benIn.at);
  assert.ok(edited.body.editedAt);

  const { todayISO, addDays } = await import("../shared/dates");
  const d = todayISO("America/New_York");
  const shifts = await A("GET", `/api/sites/${siteId}/punches/shifts?start=${addDays(d, -1)}&end=${addDays(d, 1)}`);
  assert.equal(shifts.status, 200);
  const anaShifts = shifts.body.shifts.filter((s: any) => s.employee === "Ana Ruiz");
  assert.ok(anaShifts.length >= 2, JSON.stringify(shifts.body));
  assert.ok(anaShifts.some((s: any) => s.note === "Includes an edited punch"), "the admin clock-out is flagged");
  assert.ok(shifts.body.shifts.some((s: any) => s.employee === "Ben Lee" && s.end - s.start === 120 && s.note === "Includes an edited punch"), JSON.stringify(shifts.body.shifts));

  // Deleting the clock-in would orphan the clock-out: needs force
  assert.equal((await A("DELETE", `/api/punches/${inPunch.id}`)).status, 409);
  assert.equal((await A("DELETE", `/api/punches/${added.body.id}`, { note: "test" })).body.ok, true);

  // Backups include punches
  const backup = await A("GET", "/api/backup");
  assert.ok(backup.body.punches.length >= 5);
});

function rawGet(p: string, host: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method: "GET", headers: { Host: host, "X-Kiosk-Token": kioskToken, Cookie: admin } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("KIOSK_HOST allows the kiosk's on-demand (dynamically imported) chunks", async () => {
  const { kioskAssetsFromManifest } = await import("../server/kiosk");
  const set = kioskAssetsFromManifest({
    "kiosk.html": { file: "assets/kiosk-1.js", css: ["assets/kiosk-1.css"], imports: ["_react.js"], dynamicImports: ["client/src/kiosk/lazy.ts"] },
    "_react.js": { file: "assets/react-1.js" },
    "client/src/kiosk/lazy.ts": { file: "assets/lazy-1.js" },
    "index.html": { file: "assets/admin-1.js" },
  });
  assert.deepEqual([...set].sort(), ["/assets/kiosk-1.css", "/assets/kiosk-1.js", "/assets/lazy-1.js", "/assets/react-1.js"]);
});

test("KIOSK_HOST serves only the kiosk on that hostname", async () => {
  process.env.KIOSK_HOST = "clock.example.com";
  try {
    const root = await rawGet("/", "clock.example.com");
    assert.equal(root.status, 302);
    assert.equal(root.headers.location, "/kiosk");
    assert.equal((await rawGet("/api/health", "clock.example.com")).status, 200);
    assert.equal((await rawGet("/api/kiosk/state", "clock.example.com")).status, 200);
    assert.equal((await rawGet("/api/bootstrap", "clock.example.com")).status, 404, "admin API hidden even with a valid session");
    assert.equal((await rawGet("/api/auth/status", "clock.example.com")).status, 404);
    assert.equal((await rawGet("/api/live?ticket=x", "clock.example.com")).status, 404);
    assert.equal((await rawGet("/settings", "clock.example.com")).status, 404);
    assert.equal((await rawGet("/assets/index-abc.js", "clock.example.com")).status, 404);
    // The main hostname is unaffected
    assert.equal((await rawGet("/api/bootstrap", `127.0.0.1:${port}`)).status, 200);
    assert.equal((await rawGet("/", `127.0.0.1:${port}`)).status, 200);
  } finally {
    delete process.env.KIOSK_HOST;
  }
});

test("assetlinks.json for the Android app, also on the kiosk hostname", async () => {
  const fp = "ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89";
  delete process.env.ANDROID_CERT_SHA256;
  assert.equal((await rawGet("/.well-known/assetlinks.json", `127.0.0.1:${port}`)).status, 404, "not configured yet");
  process.env.ANDROID_CERT_SHA256 = `${fp}, not-a-fingerprint, ${fp.replace(/:/g, "").toUpperCase()}`;
  process.env.KIOSK_HOST = "clock.example.com";
  try {
    const r = await rawGet("/.well-known/assetlinks.json", "clock.example.com");
    assert.equal(r.status, 200);
    assert.match(String(r.headers["content-type"]), /application\/json/);
    const body = JSON.parse(r.body);
    assert.deepEqual(body, [{
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: "com.shijirigroup.timeclock", sha256_cert_fingerprints: [fp.toUpperCase()] },
    }]);
    process.env.ANDROID_APP_PACKAGE = "bad package";
    assert.equal((await rawGet("/.well-known/assetlinks.json", "clock.example.com")).status, 404);
  } finally {
    delete process.env.KIOSK_HOST;
    delete process.env.ANDROID_CERT_SHA256;
    delete process.env.ANDROID_APP_PACKAGE;
  }
});

test("Android APK download link: only when the file is published", async () => {
  const { apkUrl } = await import("../server/android");
  assert.equal(apkUrl({ REPO_URL: "https://user:tok@github.com/acme/payroll.git" }), "https://github.com/acme/payroll/releases/download/time-clock-apk/time-clock.apk");
  assert.equal(apkUrl({ REPO_URL: "https://gitlab.com/acme/payroll.git" }), null);
  assert.equal(apkUrl({ KIOSK_APK_URL: "http://evil.example.com/a.apk" }), null, "plain http only for localhost");
  assert.equal(apkUrl({ KIOSK_APK_URL: "javascript:alert(1)" }), null);

  // A stand-in file host: /yes has the APK (redirects like GitHub), /no doesn't.
  const host = http.createServer((req, res) => {
    if (req.url === "/yes.apk") { res.writeHead(302, { Location: "https://objects.example/apk" }); return res.end(); }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => host.listen(0, "127.0.0.1", () => r()));
  const hp = (host.address() as AddressInfo).port;
  try {
    delete process.env.REPO_URL;
    delete process.env.KIOSK_APK_URL;
    assert.deepEqual((await call("GET", "/api/kiosk/app")).body, { url: null });
    process.env.KIOSK_APK_URL = `http://127.0.0.1:${hp}/no.apk`;
    assert.deepEqual((await call("GET", "/api/kiosk/app")).body, { url: null }, "not published yet");
    process.env.KIOSK_APK_URL = `http://127.0.0.1:${hp}/yes.apk`;
    assert.deepEqual((await call("GET", "/api/kiosk/app")).body, { url: `http://127.0.0.1:${hp}/yes.apk` });
    // Reachable on the kiosk-only hostname, without a device token
    process.env.KIOSK_HOST = "clock.example.com";
    const r = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const q = http.request({ host: "127.0.0.1", port, path: "/api/kiosk/app", headers: { Host: "clock.example.com" } }, (res) => {
        let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode!, body: b }));
      });
      q.on("error", reject); q.end();
    });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).url, `http://127.0.0.1:${hp}/yes.apk`);
  } finally {
    delete process.env.KIOSK_APK_URL;
    delete process.env.KIOSK_HOST;
    host.close();
  }
});

test("manager PIN guards kiosk settings and unpairing", async () => {
  const dev = await A("POST", `/api/sites/${siteId}/kiosk-devices`, { name: "Locked tablet" });
  const tok = dev.body.token;
  assert.equal((await K("GET", "/api/kiosk/state", undefined, tok)).body.site.managerPinSet, false);
  const none = await K("POST", "/api/kiosk/manager-unlock", { pin: "2468" }, tok);
  assert.equal(none.status, 409);
  assert.equal(none.body.code, "no_manager_pin");
  assert.equal((await K("POST", "/api/kiosk/unpair", { pin: "2468" }, tok)).status, 409, "cannot unpair without a manager PIN");

  // Only admins set it; kiosk tokens cannot
  assert.ok([401, 403].includes((await K("PUT", `/api/sites/${siteId}/kiosk-manager-pin`, { pin: "2468" }, tok)).status));
  assert.equal((await A("PUT", `/api/sites/${siteId}/kiosk-manager-pin`, { pin: "12" })).status, 400);
  assert.equal((await A("PUT", `/api/sites/${siteId}/kiosk-manager-pin`, { pin: "2468" })).body.set, true);
  assert.equal((await A("GET", `/api/sites/${siteId}/kiosk-manager-pin`)).body.set, true);
  assert.equal((await K("GET", "/api/kiosk/state", undefined, tok)).body.site.managerPinSet, true);
  const backup = await A("GET", "/api/backup");
  assert.ok(!backup.body.settings.some((s: any) => s.key.startsWith("kiosk_manager_pin:")), "manager PIN hash left out of backups");

  const wrong = await K("POST", "/api/kiosk/manager-unlock", { pin: "1111" }, tok);
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.code, "pin");
  assert.equal((await K("POST", "/api/kiosk/manager-unlock", { pin: "2468" }, tok)).body.ok, true);

  // Lockout after repeated wrong PINs, even for the right one
  for (let i = 0; i < 5; i++) await K("POST", "/api/kiosk/manager-unlock", { pin: "0000" }, tok);
  assert.equal((await K("POST", "/api/kiosk/manager-unlock", { pin: "2468" }, tok)).status, 429);

  // Unpair revokes the device on the server
  const dev2 = await A("POST", `/api/sites/${siteId}/kiosk-devices`, { name: "Spare 2" });
  assert.equal((await K("POST", "/api/kiosk/unpair", { pin: "1111" }, dev2.body.token)).status, 403);
  assert.equal((await K("GET", "/api/kiosk/state", undefined, dev2.body.token)).status, 200, "wrong PIN keeps the device");
  assert.equal((await K("POST", "/api/kiosk/unpair", { pin: "2468" }, dev2.body.token)).body.ok, true);
  assert.equal((await K("GET", "/api/kiosk/state", undefined, dev2.body.token)).status, 401, "unpaired device stops working");

  // Clearing the PIN locks settings again
  assert.equal((await A("PUT", `/api/sites/${siteId}/kiosk-manager-pin`, { pin: null })).body.set, false);
  await A("DELETE", `/api/sites/${siteId}/kiosk-devices/${dev.body.device.id}`);
});

test("kiosk: a refusal the server sent is shown, never queued as offline", async () => {
  const { KioskError } = await import("../client/src/kiosk/api");
  assert.equal(new KioskError(0, "x").offline, true, "no answer");
  assert.equal(new KioskError(502, "Bad gateway").offline, true, "proxy error, no code");
  assert.equal(new KioskError(503, "x").offline, true, "server down, no code");
  assert.equal(new KioskError(503, "The face check isn't working…", "photo").offline, false, "face check unavailable: shown");
  assert.equal(new KioskError(503, "The face check is busy…", "photo").offline, false, "face check busy: shown");
  assert.equal(new KioskError(422, "Face not detected", "photo").offline, false);
});
