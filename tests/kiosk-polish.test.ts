// Feedback polish: cancel an open clock-in from Live, owner-only PIN look-up
// (password re-entry, audit log, encrypted copy), and live punches needing a photo.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { middayZone } from "./clock-helpers";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-polish-"));
process.env.DATA_DIR = dir;
process.env.BACKUPS = "off";
process.env.PHOTO_CLEANUP = "off";
delete process.env.SETUP_CODE;
delete process.env.SUPABASE_URL;
delete process.env.KIOSK_HOST;
delete process.env.PIN_KEY;

// ── API ───────────────────────────────────────────────────────────────────────
let base = "";
let server: Server;
let admin = "";
let manager = "";
let viewer = "";
let siteId = "";
let site2 = "";
let token = "";
let deviceId = "";
let ana = "";
let ben = "";
let owner2 = "";

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const hs: Record<string, string> = { ...headers };
  if (body !== undefined) hs["Content-Type"] = "application/json";
  const res = await fetch(base + url, { method, headers: hs, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  const text = buf.toString("utf8");
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, raw: buf, headers: res.headers };
}
const as = (cookie: string) => (method: string, url: string, body?: unknown) => call(method, url, body, { Cookie: cookie, "X-Requested-With": "payroll" });
const A = (method: string, url: string, body?: unknown) => as(admin)(method, url, body);
const K = (method: string, url: string, body?: unknown, t = token) => call(method, url, body, { "X-Kiosk-Token": t });

/** A tiny but valid-looking JPEG (magic bytes plus padding). */
// A real photo with a face in it: the server checks punch photos for a face.
const JPEG = `data:image/jpeg;base64,${fs.readFileSync(path.join(import.meta.dirname, "fixtures", "face.jpg")).toString("base64")}`;

async function signIn(username: string, password: string) {
  const r = await call("POST", "/api/auth/login", { username, password }, { "X-Requested-With": "payroll" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return (r.headers.get("set-cookie") ?? "").split(";")[0];
}

let adminUser = "";

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
  const code = (await import("../server/auth")).getSetupCode();
  const setup = await call("POST", "/api/auth/setup", { username: "owner", password: "correct horse", setupCode: code }, { "X-Requested-With": "payroll" });
  admin = (setup.headers.get("set-cookie") ?? "").split(";")[0];
  siteId = (await A("GET", "/api/bootstrap")).body.sites[0].id;
  const tzSet = await A("PUT", `/api/sites/${siteId}`, { rules: { timezone: middayZone() } }); // "today" covers the last few hours
  assert.equal(tzSet.status, 200, JSON.stringify(tzSet.body));
  site2 = (await A("POST", "/api/sites", { name: "Uptown" })).body.id;
  await A("PUT", `/api/sites/${siteId}`, { timeSource: "kiosk", kioskLoginMode: "pin" });
  ana = (await A("POST", `/api/sites/${siteId}/employees`, { name: "Ana Ruiz", pin: "1234" })).body.id;
  ben = (await A("POST", `/api/sites/${siteId}/employees`, { name: "Ben Lee", pin: "5678" })).body.id;
  const dev = await A("POST", `/api/sites/${siteId}/kiosk-devices`, { name: "Door" });
  token = dev.body.token;
  deviceId = dev.body.device.id;
  for (const [username, role, sites] of [["manny", "manager", [siteId]], ["vera", "viewer", [siteId]], ["adam", "admin", [siteId]], ["olive", "owner", []]] as const) {
    const r = await A("POST", "/api/users", { username, password: "long password 1", role, siteIds: sites, displayName: username });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  manager = await signIn("manny", "long password 1");
  viewer = await signIn("vera", "long password 1");
  adminUser = await signIn("adam", "long password 1");
  owner2 = await signIn("olive", "long password 1");
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  const { closeDatabase } = await import("../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("cancel an open clock-in (kiosk offline): removes the clock-in and breaks, audited", async () => {
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
  // Ana clocked in 3 hours ago and went on a break (queued punches from an offline kiosk)
  assert.equal((await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", pin: "1234", at: at(180) })).status, 200);
  assert.equal((await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "break_start", pin: "1234", at: at(60) })).status, 200);
  let live = await A("GET", `/api/sites/${siteId}/timeclock`);
  assert.equal(live.body.employees.find((e: any) => e.id === ana).status, "break");

  const url = `/api/sites/${siteId}/employees/${ana}/cancel-shift`;
  assert.equal((await A("POST", url, {})).status, 400, "a note is required");
  assert.equal((await as(viewer)("POST", url, { note: "x" })).status, 403, "viewers can't");
  assert.equal((await call("POST", url, { note: "x" }, { "X-Requested-With": "payroll" })).status, 401);
  assert.equal((await as(manager)("POST", `/api/sites/${site2}/employees/${ana}/cancel-shift`, { note: "x" })).status, 403, "other location");

  const r = await as(manager)("POST", url, { note: "Clocked in by mistake, kiosk was offline" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.removed.map((p: any) => p.type), ["in", "break_start"]);
  live = await A("GET", `/api/sites/${siteId}/timeclock`);
  const now = live.body.employees.find((e: any) => e.id === ana);
  assert.equal(now.status, "out");
  assert.equal(now.minutes, 0, "no hours counted");

  // Nothing open any more
  const again = await A("POST", url, { note: "again" });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /aren't clocked in/);

  // An earlier, closed shift is untouched
  await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", pin: "5678", at: at(300) });
  await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "out", pin: "5678", at: at(200) });
  await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", pin: "5678", at: at(10) });
  const b = await A("POST", `/api/sites/${siteId}/employees/${ben}/cancel-shift`, { note: "test" });
  assert.deepEqual(b.body.removed.map((p: any) => p.type), ["in"]);
  live = await A("GET", `/api/sites/${siteId}/timeclock`);
  assert.equal(live.body.punches.filter((p: any) => p.employeeId === ben).length, 2, "the closed shift stays");

  const { flushAudit } = await import("../server/audit");
  await flushAudit();
  const log = await A("GET", "/api/audit?action=punch");
  assert.ok(log.body.entries.some((e: any) => e.action === "punch.cancel-shift" && /Ana Ruiz/.test(e.detail) && /kiosk was offline/.test(e.detail)), JSON.stringify(log.body).slice(0, 500));
});

test("owners can see employee PINs after re-entering their password; nobody else can", async () => {
  const url = `/api/sites/${siteId}/employee-pins/reveal`;
  const list = await A("GET", `/api/sites/${siteId}/employees`);
  assert.equal(list.body.find((e: any) => e.id === ana).pinViewable, true);
  assert.ok(!JSON.stringify(list.body).includes("1234"), "the list never carries PINs");
  assert.ok(!JSON.stringify(list.body).includes("pinEnc"));

  assert.equal((await A("POST", url, {})).status, 400, "password needed");
  const wrong = await A("POST", url, { password: "nope" });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.needPassword, true);
  assert.equal((await as(adminUser)("POST", url, { password: "long password 1" })).status, 403, "administrators can't");
  assert.equal((await as(manager)("POST", url, { password: "long password 1" })).status, 403);
  assert.equal((await as(viewer)("POST", url, { password: "long password 1" })).status, 403);
  assert.equal((await call("POST", url, { password: "x" }, { "X-Requested-With": "payroll" })).status, 401);

  const r = await A("POST", url, { password: "correct horse" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.headers.get("cache-control"), "no-store");
  const pins = Object.fromEntries(r.body.pins.map((p: any) => [p.name, p.pin]));
  assert.deepEqual(pins, { "Ana Ruiz": "1234", "Ben Lee": "5678" });
  const one = await as(owner2)("POST", url, { password: "long password 1", employeeId: ben });
  assert.deepEqual(one.body.pins.map((p: any) => p.pin), ["5678"]);

  // Changing a PIN updates the viewable copy; removing it clears it
  await A("PUT", `/api/sites/${siteId}/employees/${ben}`, { pin: "8642" });
  assert.equal((await A("POST", url, { password: "correct horse", employeeId: ben })).body.pins[0].pin, "8642");
  await A("PUT", `/api/sites/${siteId}/employees/${ben}`, { pin: null });
  const cleared = (await A("POST", url, { password: "correct horse", employeeId: ben })).body.pins[0];
  assert.equal(cleared.pin, null);
  assert.equal(cleared.hasPin, false);

  // Stored encrypted, not in plain text; the key is not in the database or backups
  const store = await (await import("../server/db")).db();
  const raw = (await store.getSetting(`employees:${siteId}`)) ?? "";
  assert.ok(!raw.includes('"1234"') && /"pinEnc":"v1\./.test(raw), raw.slice(0, 300));
  const backup = await A("GET", "/api/backup?secrets=1");
  const { getPinKey } = await import("../server/config");
  assert.ok(!JSON.stringify(backup.body).includes(getPinKey().toString("base64url")), "key never in backups");

  // A copy that can't be read (PIN set before this feature, or another server's key) shows as not viewable
  const dirData = JSON.parse(raw);
  dirData.employees = dirData.employees.map((e: any) => (e.id === ana ? { ...e, pinEnc: undefined } : e));
  await store.setSetting(`employees:${siteId}`, JSON.stringify(dirData));
  (await import("../server/employees")).invalidateEmployeeCache();
  const old = (await A("POST", url, { password: "correct horse", employeeId: ana })).body.pins[0];
  assert.equal(old.pin, null);
  assert.equal(old.hasPin, true);
  assert.equal((await A("GET", `/api/sites/${siteId}/employees`)).body.find((e: any) => e.id === ana).pinViewable, false);
  // The kiosk still works with the hashed PIN
  assert.equal((await K("POST", "/api/kiosk/identify", { pin: "1234" })).status, 200);
  // A PIN copied to another employee doesn't decrypt (bound to the employee)
  const { encryptPin, decryptPin } = await import("../server/employees");
  assert.equal(decryptPin(encryptPin("4444", siteId, ana), siteId, ben), null);
  assert.equal(decryptPin(encryptPin("4444", siteId, ana), siteId, ana), "4444");

  const { flushAudit } = await import("../server/audit");
  await flushAudit();
  const log = await A("GET", "/api/audit?action=employee");
  assert.ok(log.body.entries.filter((e: any) => e.action === "employee.pins-viewed").length >= 4, "every look-up is logged");
});

test("photos on: live punches need a photo, offline queued punches are still kept", async () => {
  await A("PUT", `/api/sites/${siteId}/kiosk-devices/${deviceId}/options`, { photo: true });
  const r = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", pin: "1234", photo: null });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, "photo");
  const live = await A("GET", `/api/sites/${siteId}/timeclock`);
  assert.equal(live.body.employees.find((e: any) => e.id === ana).status, "out", "no punch recorded");
  const q = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", pin: "1234", photo: null, at: new Date(Date.now() - 15 * 60_000).toISOString() });
  assert.equal(q.status, 200);
  assert.equal(q.body.punch.photo, "none");
  const ok = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "out", pin: "1234", photo: JPEG, at: new Date(Date.now() - 10 * 60_000).toISOString() });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.punch.photo, "saved");
  await A("PUT", `/api/sites/${siteId}/kiosk-devices/${deviceId}/options`, { photo: false });
});

test("PIN_KEY must be 32 random bytes", async () => {
  const { getPinKey } = await import("../server/config");
  const keep = process.env.PIN_KEY;
  try {
    process.env.PIN_KEY = "my weak passphrase";
    assert.throws(() => getPinKey(), /32 random bytes/);
    process.env.PIN_KEY = Buffer.alloc(16, 1).toString("base64url");
    assert.throws(() => getPinKey(), /32 random bytes/);
    const good = Buffer.alloc(32, 7);
    process.env.PIN_KEY = good.toString("base64url");
    assert.ok(getPinKey().equals(good));
    process.env.PIN_KEY = good.toString("base64");
    assert.ok(getPinKey().equals(good), "standard base64 works too");
  } finally {
    if (keep === undefined) delete process.env.PIN_KEY; else process.env.PIN_KEY = keep;
  }
});

test("photos on: a queued punch without a photo is marked 'no photo' for managers", async () => {
  await A("PUT", `/api/sites/${siteId}/kiosk-devices/${deviceId}/options`, { photo: true });
  try {
    const q = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", pin: "1234", at: new Date(Date.now() - 5 * 60_000).toISOString() });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    assert.equal(q.body.punch.photo, "none", "no photo field at all still shows as no photo");
    const out = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "out", pin: "1234", photo: JPEG });
    assert.equal(out.body.punch.photo, "saved");
  } finally {
    await A("PUT", `/api/sites/${siteId}/kiosk-devices/${deviceId}/options`, { photo: false });
  }
});
