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
  for (let i = 0; i < 5; i++) codes.push((await K("POST", "/api/kiosk/identify", { pin: "0000" }, t)).status);
  assert.deepEqual(codes, [403, 403, 403, 403, 429]);
  const locked = await K("POST", "/api/kiosk/identify", { pin: "1234" }, t);
  assert.equal(locked.status, 429, "even the right PIN waits");
  assert.equal(locked.body.code, "locked");
  assert.ok(Number(locked.headers.get("retry-after")) > 0);
  // Punching with a PIN is covered by the same lock
  assert.equal((await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", pin: "1234" }, t)).status, 429);
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
