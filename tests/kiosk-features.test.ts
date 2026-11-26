// Kiosk extras: wrong-action guard, hours today / breaks, break reminders,
// device options, stations, photos, shift notes and fix requests. Pure logic
// first, then the API on a real server with a temporary SQLite database.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Punch, PunchType } from "../shared/punches";
import {
  acknowledge, breakDue, checkAction, daySummary, fixTimeProblem, matchStation, normalizeDeviceOptions, normalizeSiteConfig, notesFor,
  photoExpired, pruneFixRequests, pruneNotes, type FixRequest, type ShiftNote,
} from "../shared/kiosk";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-kiosk-features-"));
process.env.DATA_DIR = dir;
process.env.BACKUPS = "off";
process.env.PHOTO_CLEANUP = "off";
delete process.env.SETUP_CODE;
delete process.env.SUPABASE_URL;
delete process.env.KIOSK_HOST;
delete process.env.PUNCH_PHOTO_DIR;

// ── Pure logic ────────────────────────────────────────────────────────────────
const T0 = Date.parse("2026-03-02T09:00:00Z");
const H = 3600_000;
let n = 0;
const p = (type: PunchType, offsetMs: number, meta?: Punch["meta"]): Punch => ({
  id: `p${String(++n).padStart(8, "0")}`, siteId: "s", employeeId: "e1", employeeName: "Ana", type, at: new Date(T0 + offsetMs).toISOString(),
  source: "kiosk", deviceId: null, note: "", createdAt: new Date(T0).toISOString(), editedAt: null, edits: [], ...(meta ? { meta } : {}),
});

test("wrong-action guard explains and suggests the right action", () => {
  assert.deepEqual(checkAction("out", "in"), { ok: true });
  assert.deepEqual(checkAction("in", "out"), { ok: true });
  assert.deepEqual(checkAction("break", "out"), { ok: true }, "clocking out from a break is fine");
  assert.deepEqual(checkAction("in", "in"), { ok: false, message: "You're already clocked in.", question: "Clock out instead?", suggest: "out" });
  assert.equal(checkAction("in", "break_end").suggest, "break_start");
  assert.equal(checkAction("in", "break_end").message, "You're not on a break.");
  assert.equal(checkAction("break", "in").suggest, "break_end");
  assert.equal(checkAction("break", "break_start").question, "End your break instead?");
  for (const t of ["break_start", "break_end", "out"] as const) {
    const c = checkAction("out", t);
    assert.equal(c.ok, false);
    assert.equal(c.suggest, "in");
    assert.equal(c.question, "Clock in instead?");
  }
});

test("daySummary: worked and break minutes, clipped to the day, open shifts count until now", () => {
  const list = [p("in", 0), p("break_start", 3 * H), p("break_end", 3.5 * H), p("out", 8 * H)];
  assert.deepEqual(daySummary(list, T0 - H, T0 + 24 * H, T0 + 10 * H), { workedMinutes: 450, breakMinutes: 30, breaks: 1 });
  // Mid-break right now
  assert.deepEqual(daySummary(list.slice(0, 2), T0 - H, T0 + 24 * H, T0 + 3.25 * H), { workedMinutes: 180, breakMinutes: 15, breaks: 1 });
  // Clipped at the start of the window (overnight shift)
  assert.equal(daySummary(list, T0 + 2 * H, T0 + 24 * H, T0 + 10 * H).workedMinutes, 330);
  // Clock-out during a break ends the break
  const outOnBreak = [p("in", 0), p("break_start", 2 * H), p("out", 3 * H)];
  assert.deepEqual(daySummary(outOnBreak, T0 - H, T0 + 24 * H, T0 + 5 * H), { workedMinutes: 120, breakMinutes: 60, breaks: 1 });
  // A forgotten open shift stops counting after 16 hours
  assert.equal(daySummary([p("in", 0)], T0 - H, T0 + 48 * H, T0 + 30 * H).workedMinutes, 0);
  assert.deepEqual(daySummary([], 0, 1, 1), { workedMinutes: 0, breakMinutes: 0, breaks: 0 });
});

test("breakDue: hours without a break, reset by a break, off without a rule", () => {
  const list = [p("in", 0)];
  assert.equal(breakDue(list, 5, T0 + 4 * H).due, false);
  const due = breakDue(list, 5, T0 + 5 * H + 60_000);
  assert.equal(due.due, true);
  assert.equal(due.minutesWithoutBreak, 301);
  assert.equal(due.dueAt, new Date(T0 + 5 * H).toISOString());
  assert.equal(breakDue(list, null, T0 + 9 * H).due, false, "no rule");
  assert.equal(breakDue(list, 0, T0 + 9 * H).due, false, "rule of 0 is off");
  const withBreak = [p("in", 0), p("break_start", 4 * H), p("break_end", 4.5 * H)];
  assert.equal(breakDue(withBreak, 5, T0 + 6 * H).due, false, "the clock restarts after a break");
  assert.equal(breakDue(withBreak, 5, T0 + 9.6 * H).due, true);
  assert.equal(breakDue(withBreak.slice(0, 2), 1, T0 + 6 * H).due, false, "on a break is never due");
  assert.equal(breakDue([...list, p("out", 6 * H)], 5, T0 + 7 * H).due, false, "clocked out is never due");
});

test("device and location options are normalised", () => {
  assert.deepEqual(normalizeDeviceOptions(undefined), { photo: false, loginMode: "site", idleSeconds: 10, stations: true });
  assert.deepEqual(normalizeDeviceOptions({ photo: true, loginMode: "pin", idleSeconds: 2, stations: false }), { photo: true, loginMode: "pin", idleSeconds: 5, stations: false });
  assert.equal(normalizeDeviceOptions({ idleSeconds: 9999, loginMode: "nope" }).idleSeconds, 120);
  assert.equal(normalizeDeviceOptions({ loginMode: "nope" }).loginMode, "site");
  const c = normalizeSiteConfig({ stations: [" Sushi  bar ", "sushi bar", "", "Kitchen"], breakReminderHours: 5.1, photoRetentionDays: 0 });
  assert.deepEqual(c, { stations: ["Sushi bar", "Kitchen"], breakReminderHours: 5, photoRetentionDays: 90 });
  assert.equal(normalizeSiteConfig({ breakReminderHours: -1 }).breakReminderHours, null);
  assert.equal(matchStation(c.stations, "kitchen"), "Kitchen");
  assert.equal(matchStation(c.stations, "Bar"), null);
  assert.equal(matchStation([], "Kitchen"), null);
});

test("shift notes: targeting, expiry, acknowledgement, pruning", () => {
  const now = T0;
  const base: ShiftNote = { id: "n1", text: "Fish delivery at 10", employeeIds: [], createdAt: new Date(now - H).toISOString(), createdBy: "owner", expiresAt: null, acks: [] };
  const targeted: ShiftNote = { ...base, id: "n2", employeeIds: ["e2"], createdAt: new Date(now - 2 * H).toISOString() };
  const expired: ShiftNote = { ...base, id: "n3", expiresAt: new Date(now - 1).toISOString() };
  assert.deepEqual(notesFor([base, targeted, expired], "e1", now).map((x) => x.id), ["n1"]);
  assert.deepEqual(notesFor([base, targeted, expired], "e2", now).map((x) => x.id), ["n2", "n1"], "oldest first");
  const seen = acknowledge(base, "e1", "Ana", new Date(now).toISOString());
  assert.equal(seen.acks.length, 1);
  assert.equal(acknowledge(seen, "e1", "Ana", new Date(now).toISOString()), seen, "idempotent");
  assert.deepEqual(notesFor([seen], "e1", now), [], "shown once");
  const old: ShiftNote = { ...base, id: "n4", expiresAt: new Date(now - 40 * 86_400_000).toISOString() };
  assert.deepEqual(pruneNotes([base, old, expired], now).map((x) => x.id).sort(), ["n1", "n3"]);
});

test("fix requests: time window and pruning keeps pending ones", () => {
  const now = T0;
  assert.equal(fixTimeProblem(now - H, now), null);
  assert.match(fixTimeProblem(now + H, now)!, /future/);
  assert.match(fixTimeProblem(now - 15 * 86_400_000, now)!, /14 days/);
  assert.equal(fixTimeProblem(Number.NaN, now), "Pick a time.");
  const mk = (id: string, status: FixRequest["status"], decidedDaysAgo: number | null): FixRequest => ({
    id, employeeId: "e1", employeeName: "Ana", type: "in", at: new Date(now).toISOString(), note: "", createdAt: new Date(now).toISOString(), deviceId: null,
    status, decidedAt: decidedDaysAgo == null ? null : new Date(now - decidedDaysAgo * 86_400_000).toISOString(), decidedBy: null, reason: "", punchId: null,
  });
  const kept = pruneFixRequests([mk("a", "pending", null), mk("b", "approved", 10), mk("c", "declined", 90)], now);
  assert.deepEqual(kept.map((r) => r.id), ["a", "b"]);
  const many = [mk("p", "pending", null), ...Array.from({ length: 10 }, (_, i) => mk(`d${i}`, "approved", i))];
  const capped = pruneFixRequests(many, now, 60, 4);
  assert.equal(capped.length, 4);
  assert.ok(capped.some((r) => r.id === "p"), "pending survives the cap");
  assert.ok(capped.some((r) => r.id === "d0") && !capped.some((r) => r.id === "d9"), "newest decided kept");
});

test("photo retention", () => {
  assert.equal(photoExpired(T0 - 91 * 86_400_000, 90, T0), true);
  assert.equal(photoExpired(T0 - 89 * 86_400_000, 90, T0), false);
});

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
  site2 = (await A("POST", "/api/sites", { name: "Uptown" })).body.id;
  await A("PUT", `/api/sites/${siteId}`, { timeSource: "kiosk", kioskLoginMode: "pin" });
  ana = (await A("POST", `/api/sites/${siteId}/employees`, { name: "Ana Ruiz", pin: "1234" })).body.id;
  ben = (await A("POST", `/api/sites/${siteId}/employees`, { name: "Ben Lee", pin: "5678" })).body.id;
  const dev = await A("POST", `/api/sites/${siteId}/kiosk-devices`, { name: "Door" });
  token = dev.body.token;
  deviceId = dev.body.device.id;

  for (const [username, role, sites] of [["manny", "manager", [siteId]], ["vera", "viewer", [siteId]], ["uma", "manager", [site2]]] as const) {
    const r = await A("POST", "/api/users", { username, password: "long password 1", role, siteIds: sites, displayName: username });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  manager = await signIn("manny", "long password 1");
  viewer = await signIn("vera", "long password 1");
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  const { closeDatabase } = await import("../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("device options: defaults, admin-only changes, reflected in the kiosk state", async () => {
  const list = await A("GET", `/api/sites/${siteId}/kiosk-devices`);
  // New devices take a photo with each punch (and so run the face check) unless an admin turns it off.
  assert.deepEqual(list.body[0].options, { photo: true, loginMode: "site", idleSeconds: 10, stations: true });
  let st = await K("GET", "/api/kiosk/state");
  assert.equal(st.body.site.loginMode, "pin");
  assert.deepEqual(st.body.options, { photo: true, idleSeconds: 10, stations: [], breakReminderHours: null });
  assert.equal((await A("PUT", `/api/sites/${siteId}/kiosk-devices/${deviceId}/options`, { photo: false })).status, 200);
  assert.equal((await K("GET", "/api/kiosk/state")).body.options.photo, false, "an admin can turn photos off");

  assert.equal((await as(manager)("PUT", `/api/sites/${siteId}/kiosk-devices/${deviceId}/options`, { photo: true })).status, 403, "managers can't change devices");
  assert.equal((await A("PUT", `/api/sites/${siteId}/kiosk-devices/${deviceId}/options`, { idleSeconds: 1 })).status, 400);
  assert.equal((await A("PUT", `/api/sites/${siteId}/kiosk-devices/${deviceId}/options`, { bogus: 1 })).status, 400);
  assert.equal((await A("PUT", `/api/sites/${site2}/kiosk-devices/${deviceId}/options`, { photo: true })).status, 404, "device belongs to another location");
  const r = await A("PUT", `/api/sites/${siteId}/kiosk-devices/${deviceId}/options`, { photo: true, loginMode: "name_pin", idleSeconds: 20 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.options, { photo: true, loginMode: "name_pin", idleSeconds: 20, stations: true });

  assert.equal((await A("PUT", `/api/sites/${siteId}/kiosk-config`, { stations: ["Sushi bar", "Kitchen", "Front"], breakReminderHours: 5 })).status, 200);
  assert.equal((await as(manager)("PUT", `/api/sites/${siteId}/kiosk-config`, { stations: [] })).status, 403, "location kiosk settings are admin-only");
  st = await K("GET", "/api/kiosk/state");
  assert.equal(st.body.site.loginMode, "name_pin", "device sign-in overrides the location's");
  assert.deepEqual(st.body.options, { photo: true, idleSeconds: 20, stations: ["Sushi bar", "Kitchen", "Front"], breakReminderHours: 5 });
  await A("PUT", `/api/sites/${siteId}/kiosk-devices/${deviceId}/options`, { stations: false });
  assert.deepEqual((await K("GET", "/api/kiosk/state")).body.options.stations, [], "station list off for this device");
  await A("PUT", `/api/sites/${siteId}/kiosk-devices/${deviceId}/options`, { stations: true });
  // Location settings are part of backups (not secret)
  const backup = await A("GET", "/api/backup");
  assert.ok(backup.body.settings.some((s: any) => s.key === `kiosk_config:${siteId}`));
});

test("punch with station and photo; photo served only to editors; not in backups", async () => {
  const pid = randomUUID();
  const r = await K("POST", "/api/kiosk/punch", { id: pid, type: "in", pin: "1234", station: "sushi BAR", photo: JPEG });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.punch.station, "Sushi bar");
  assert.equal(r.body.punch.photo, "saved");
  assert.equal(r.body.station, "Sushi bar");
  assert.equal(r.body.status, "in");
  assert.equal(typeof r.body.breakMinutes, "number");
  const file = path.join(dir, "punch-photos", siteId, `${pid}.jpg`);
  assert.ok(fs.existsSync(file), "photo stored as a file under the data dir");

  const photo = await A("GET", `/api/punches/${pid}/photo`);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get("content-type"), "image/jpeg");
  assert.equal(photo.raw[0], 0xff);
  assert.equal((await as(manager)("GET", `/api/punches/${pid}/photo`)).status, 200);
  assert.equal((await as(viewer)("GET", `/api/punches/${pid}/photo`)).status, 403, "viewers can't see photos");
  assert.equal((await call("GET", `/api/punches/${pid}/photo`)).status, 401);
  assert.equal((await K("GET", `/api/punches/${pid}/photo`)).status, 401, "kiosk token can't read photos");
  const uma = await signIn("uma", "long password 1");
  assert.equal((await as(uma)("GET", `/api/punches/${pid}/photo`)).status, 403, "other location's manager");

  // Live shows the station and the punch meta
  const live = await A("GET", `/api/sites/${siteId}/timeclock`);
  const anaNow = live.body.employees.find((e: any) => e.id === ana);
  assert.equal(anaNow.station, "Sushi bar");
  assert.equal(anaNow.breakDue, false);
  assert.deepEqual(live.body.punches.find((x: any) => x.id === pid).meta, { station: "Sushi bar", photo: "saved" });

  // Camera blocked / no face (no photo sent): a live punch is refused and says why
  const blocked = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "break_start", pin: "1234", photo: null });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.code, "photo");
  assert.match(blocked.body.error, /Face not detected/);
  assert.equal((await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "break_start", pin: "1234" })).status, 422, "no photo field at all");
  // Garbage instead of a JPEG: refused too
  const junk = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "break_start", pin: "1234", photo: "data:image/jpeg;base64,AAAA" });
  assert.equal(junk.status, 422);
  // A punch queued while offline is never lost over a photo: accepted, recorded as "no photo"
  const queued = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "break_start", pin: "1234", photo: null, at: new Date().toISOString() });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  assert.equal(queued.body.punch.photo, "none");
  const back = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "break_end", pin: "1234", photo: JPEG });
  assert.equal(back.status, 200);
  // The server checks the photo for a face: no face, no punch (same on every device)
  const photoOf = (f: string) => `data:image/jpeg;base64,${fs.readFileSync(path.join(import.meta.dirname, "fixtures", f)).toString("base64")}`;
  for (const f of ["no-face.jpg", "palm.jpg"]) {
    const r = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "break_start", pin: "1234", photo: photoOf(f) });
    assert.equal(r.status, 422, f);
    assert.equal(r.body.code, "photo");
    assert.equal(r.body.reason, "no_face");
    assert.match(r.body.error, /Face not detected/);
  }
  // Saved offline with no face: kept (never lose a punch), flagged for the manager
  const offline = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "break_start", pin: "1234", photo: photoOf("no-face.jpg"), at: new Date().toISOString() });
  assert.equal(offline.status, 200, JSON.stringify(offline.body));
  const flagged = (await A("GET", `/api/sites/${siteId}/timeclock`)).body.punches.find((x: any) => x.id === offline.body.punch.id);
  assert.deepEqual(flagged.meta, { photo: "saved", face: "missing" });
  // An offline time can't be used to dodge the check for long: the server only takes one from the last 24 hours, not ahead of its clock
  const ahead = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "break_end", pin: "1234", photo: photoOf("no-face.jpg"), at: new Date(Date.now() + 5 * 60_000).toISOString() });
  assert.equal(ahead.status, 422);
  assert.equal(ahead.body.code, "time");
  const old = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "break_end", pin: "1234", photo: photoOf("no-face.jpg"), at: new Date(Date.now() - 25 * 3600_000).toISOString() });
  assert.equal(old.status, 422);
  assert.equal(old.body.code, "time");
  assert.equal((await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "break_end", pin: "1234", photo: JPEG })).status, 200);
  // Unknown station is ignored, not an error
  const benIn = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", pin: "5678", station: "Roof", photo: JPEG });
  assert.equal(benIn.status, 200);
  assert.equal(benIn.body.punch.station, null);

  // Editing a punch keeps its meta
  const edited = await A("PATCH", `/api/punches/${pid}`, { at: new Date(Date.now() - 60_000).toISOString(), note: "adjust" });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.meta.station, "Sushi bar");
  assert.equal(edited.body.edits.length, 1);

  // Backups keep the punch meta but never the photo bytes
  const backup = await A("GET", "/api/backup");
  const text = JSON.stringify(backup.body);
  assert.ok(!text.includes(JPEG.slice(30, 80)), "no photo data in backups");
  assert.equal(backup.body.punches.find((x: any) => x.id === pid).meta.photo, "saved");

  // Deleting the punch removes its photo
  await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "out", pin: "1234", photo: JPEG });
  const del = await A("DELETE", `/api/punches/${pid}?force=1`, { note: "test" });
  assert.equal(del.body.ok, true);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!fs.existsSync(file), "photo deleted with the punch");

  // Photos are ignored when the device has photos turned off
  await A("PUT", `/api/sites/${siteId}/kiosk-devices/${deviceId}/options`, { photo: false });
  const off = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", pin: "1234", photo: JPEG });
  assert.equal(off.body.punch.photo, null);
  await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "out", pin: "1234" });
});

test("photo retention removes old files", async () => {
  const { purgeOldPhotos, savePhoto, photoPath } = await import("../server/kioskPhotos");
  assert.equal(photoPath("../etc", "x"), null, "unsafe ids are refused");
  assert.equal(savePhoto(siteId, "old_photo_1", Buffer.from([0xff, 0xd8, 0xff])), true);
  assert.equal(savePhoto(siteId, "new_photo_1", Buffer.from([0xff, 0xd8, 0xff])), true);
  const old = photoPath(siteId, "old_photo_1")!;
  const t = (Date.now() - 100 * 86_400_000) / 1000;
  fs.utimesSync(old, t, t);
  assert.equal(await purgeOldPhotos(), 1);
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(photoPath(siteId, "new_photo_1")!));
});

test("wrong-action guard: the server refuses and suggests the right action", async () => {
  const id = await K("POST", "/api/kiosk/identify", { pin: "5678" });
  assert.equal(id.body.status, "in");
  const r = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", ticket: id.body.ticket });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "You're already clocked in.");
  assert.equal(r.body.question, "Clock out instead?");
  assert.equal(r.body.suggest, "out");
  assert.deepEqual(r.body.actions, ["break_start", "out"]);
  assert.ok(r.body.ticket, "a fresh ticket so the suggested action can be sent without the PIN");
  const ok = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: r.body.suggest, ticket: r.body.ticket });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, "out");
  const notOnBreak = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "break_end", pin: "5678" });
  assert.equal(notOnBreak.status, 409);
  assert.equal(notOnBreak.body.suggest, "in");
});

test("two devices punching the same employee moments apart are handled in arrival order", async () => {
  const back = (await A("POST", `/api/sites/${siteId}/kiosk-devices`, { name: "Back door" })).body;
  const other = back.token;
  // This test is about ordering, not photos: turn photos off for the new device.
  assert.equal((await A("PUT", `/api/sites/${siteId}/kiosk-devices/${back.device.id}/options`, { photo: false })).status, 200);
  for (let round = 0; round < 5; round++) {
    const id = await K("POST", "/api/kiosk/identify", { pin: "5678" }, other);
    assert.equal(id.body.status, "out");
    // Device 1: clock in with the PIN (slow: hashing). Device 2, right after: clock out with a ticket (fast).
    const a = K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", pin: "5678", employeeId: ben });
    await new Promise((r) => setTimeout(r, 2));
    const b = K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "out", ticket: id.body.ticket, employeeId: ben }, other);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.status, 200, JSON.stringify(ra.body));
    assert.equal(rb.status, 200, `round ${round}: ${JSON.stringify(rb.body)}`);
    assert.equal(rb.body.status, "out");
    assert.ok(Date.parse(rb.body.punch.at) >= Date.parse(ra.body.punch.at), "stamped in arrival order");
  }
});

test("break reminders: identify and Live flag a due break", async () => {
  // Cara clocked in 6 hours ago (offline replay), with a 5 hour rule
  const cara = (await A("POST", `/api/sites/${siteId}/employees`, { name: "Cara Diaz", pin: "2468" })).body.id;
  const at = new Date(Date.now() - 6 * 3600_000).toISOString();
  const first = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", pin: "2468", at });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const id = await K("POST", "/api/kiosk/identify", { pin: "2468" });
  assert.equal(id.body.breakDue, true);
  assert.ok(id.body.minutesWithoutBreak >= 359);
  const live = await A("GET", `/api/sites/${siteId}/timeclock`);
  assert.equal(live.body.employees.find((e: any) => e.id === cara).breakDue, true);
  assert.equal(live.body.employees.find((e: any) => e.id === ana).breakDue, false);
  const brk = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "break_start", ticket: id.body.ticket });
  assert.equal(brk.body.breakDue, false);
  await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "out", pin: "2468" });
});

test("shift notes: posted by managers, shown once at clock-in, acknowledged", async () => {
  const M = as(manager);
  assert.equal((await as(viewer)("POST", `/api/sites/${siteId}/kiosk-notes`, { text: "hi" })).status, 403);
  assert.equal((await M("POST", `/api/sites/${siteId}/kiosk-notes`, { text: "" })).status, 400);
  assert.equal((await M("POST", `/api/sites/${siteId}/kiosk-notes`, { text: "x", expiresAt: new Date(Date.now() - 1000).toISOString() })).status, 400);
  const all = await M("POST", `/api/sites/${siteId}/kiosk-notes`, { text: "Fish delivery at 10" });
  assert.equal(all.status, 200, JSON.stringify(all.body));
  const forBen = await M("POST", `/api/sites/${siteId}/kiosk-notes`, { text: "Ben: please restock the bar", employeeIds: [ben, "nobody"], expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  assert.deepEqual(forBen.body.employeeIds, [ben], "unknown employees dropped");
  assert.equal((await as(signInCache.uma ?? (signInCache.uma = await signIn("uma", "long password 1")))("POST", `/api/sites/${siteId}/kiosk-notes`, { text: "x" })).status, 403, "other location's manager");

  const anaIn = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", pin: "1234" });
  assert.deepEqual(anaIn.body.notes.map((x: any) => x.text), ["Fish delivery at 10"]);
  assert.ok(anaIn.body.ticket);
  const ack = await K("POST", `/api/kiosk/notes/${all.body.id}/ack`, { ticket: anaIn.body.ticket });
  assert.equal(ack.status, 200, JSON.stringify(ack.body));
  assert.equal((await K("POST", `/api/kiosk/notes/nope/ack`, { ticket: anaIn.body.ticket })).status, 404);
  assert.equal((await K("POST", `/api/kiosk/notes/${all.body.id}/ack`, { pin: "0000" })).status, 403, "needs the employee's PIN or ticket");
  await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "out", pin: "1234" });
  const again = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", pin: "1234" });
  assert.deepEqual(again.body.notes, [], "shown once");
  await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "out", pin: "1234" });

  const benIn = await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", pin: "5678" });
  assert.deepEqual(benIn.body.notes.map((x: any) => x.text), ["Fish delivery at 10", "Ben: please restock the bar"]);
  await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "out", pin: "5678" });

  const list = await as(viewer)("GET", `/api/sites/${siteId}/kiosk-notes`);
  assert.equal(list.status, 200);
  const seen = list.body.find((x: any) => x.id === all.body.id);
  assert.deepEqual(seen.acks.map((a: any) => a.name), ["Ana Ruiz"]);
  assert.equal(seen.active, true);
  assert.equal((await M("DELETE", `/api/sites/${siteId}/kiosk-notes/${forBen.body.id}`)).status, 200);
  assert.equal((await M("DELETE", `/api/sites/${siteId}/kiosk-notes/${forBen.body.id}`)).status, 404);
  const audit = await A("GET", "/api/audit?action=kiosk");
  assert.equal(audit.status, 200);
  assert.ok(audit.body.entries.some((e: any) => e.action === "kiosk.note.create" && e.userName.includes("manny")), JSON.stringify(audit.body).slice(0, 300));
  assert.ok(audit.body.entries.some((e: any) => e.action === "kiosk.note.delete"));
});
const signInCache: Record<string, string> = {};

test("fix requests: kiosk asks, manager approves (creates the punch) or declines", async () => {
  const { todayISO, addDays } = await import("../shared/dates");
  const tz = (await A("GET", "/api/bootstrap")).body.sites.find((s: any) => s.id === siteId).rules.timezone;
  const today = todayISO(tz);
  const id = await K("POST", "/api/kiosk/identify", { pin: "1234" });
  // Validation
  assert.equal((await K("POST", "/api/kiosk/fix-requests", { ticket: id.body.ticket, type: "in", date: addDays(today, 1), minutes: 540 })).status, 400, "future");
  assert.equal((await K("POST", "/api/kiosk/fix-requests", { ticket: id.body.ticket, type: "in", date: addDays(today, -30), minutes: 540 })).status, 400, "too old");
  assert.equal((await K("POST", "/api/kiosk/fix-requests", { type: "in", date: addDays(today, -1), minutes: 540, pin: "0000" })).status, 403, "needs a PIN");

  const r1 = await K("POST", "/api/kiosk/fix-requests", { ticket: id.body.ticket, type: "in", date: addDays(today, -2), minutes: 540, note: "I forgot to clock in at 9:00" });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.status, "pending");
  const r2 = await K("POST", "/api/kiosk/fix-requests", { ticket: id.body.ticket, type: "out", date: addDays(today, -2), minutes: 17 * 60, note: "Left at 5" });
  const r3 = await K("POST", "/api/kiosk/fix-requests", { ticket: id.body.ticket, type: "out", date: addDays(today, -3), minutes: 17 * 60 });

  const M = as(manager);
  const list = await as(viewer)("GET", `/api/sites/${siteId}/fix-requests`);
  assert.equal(list.status, 200);
  assert.equal(list.body.filter((x: any) => x.status === "pending").length, 3);
  assert.equal((await as(viewer)("POST", `/api/sites/${siteId}/fix-requests/${r1.body.id}/approve`, {})).status, 403, "viewers can't approve");

  // Out before the in is approved would not fit: approving the clock-out first is refused
  const early = await M("POST", `/api/sites/${siteId}/fix-requests/${r2.body.id}/approve`, {});
  assert.equal(early.status, 409, JSON.stringify(early.body));
  assert.match(early.body.error, /doesn't fit/);

  const ok1 = await M("POST", `/api/sites/${siteId}/fix-requests/${r1.body.id}/approve`, {});
  assert.equal(ok1.status, 200, JSON.stringify(ok1.body));
  assert.equal(ok1.body.status, "approved");
  assert.equal(ok1.body.decidedBy, "manny");
  const punch = (await A("GET", `/api/sites/${siteId}/punches?start=${addDays(today, -2)}&end=${addDays(today, -2)}`)).body.find((x: any) => x.id === ok1.body.punchId);
  assert.ok(punch, "punch created");
  assert.equal(punch.source, "admin");
  assert.equal(punch.type, "in");
  assert.equal(punch.meta.fixRequestId, r1.body.id);
  assert.match(punch.note, /I forgot to clock in/);
  assert.equal((await M("POST", `/api/sites/${siteId}/fix-requests/${r1.body.id}/approve`, {})).status, 409, "already decided");

  // Manager adjusts the time when approving
  const adj = new Date(Date.parse(r2.body.at) + 15 * 60_000).toISOString();
  const ok2 = await M("POST", `/api/sites/${siteId}/fix-requests/${r2.body.id}/approve`, { at: adj });
  assert.equal(ok2.status, 200, JSON.stringify(ok2.body));
  assert.equal(ok2.body.at, adj);

  const dec = await M("POST", `/api/sites/${siteId}/fix-requests/${r3.body.id}/decline`, { reason: "You were off that day" });
  assert.equal(dec.status, 200);
  assert.equal(dec.body.status, "declined");
  assert.equal((await M("POST", `/api/sites/${siteId}/fix-requests/nope/decline`, {})).status, 404);

  const shifts = await A("GET", `/api/sites/${siteId}/punches/shifts?start=${addDays(today, -2)}&end=${addDays(today, -2)}`);
  const s = shifts.body.shifts.find((x: any) => x.employee === "Ana Ruiz");
  assert.ok(s, JSON.stringify(shifts.body));
  assert.equal(s.end - s.start, 8 * 60 + 15);
  assert.equal(s.note, "Includes an edited punch");

  // Stored in settings, included in backups
  const backup = await A("GET", "/api/backup");
  assert.ok(backup.body.settings.some((x: any) => x.key === `kiosk_fix_requests:${siteId}`));
  assert.ok(backup.body.settings.some((x: any) => x.key === `kiosk_notes:${siteId}`));
});

test("manager PIN: parallel guesses can't race the lockout, and a locked device refuses even the right PIN", async () => {
  const { PIN_MAX_FAILS } = await import("../server/kiosk");
  assert.equal((await A("PUT", `/api/sites/${siteId}/kiosk-manager-pin`, { pin: "2580" })).status, 200);
  const dev = (await A("POST", `/api/sites/${siteId}/kiosk-devices`, { name: "Burst" })).body.token;
  // 150 guesses at once, with the right PIN deep inside the burst.
  const guesses = Array.from({ length: 150 }, (_, i) => String(3000 + i));
  guesses[100] = "2580";
  const results = await Promise.all(guesses.map((pin) => K("POST", "/api/kiosk/manager-unlock", { pin }, dev)));
  const count = (s: number) => results.filter((r) => r.status === s).length;
  assert.equal(count(200), 0, "the right PIN must not get through once the lock trips");
  assert.equal(count(403), PIN_MAX_FAILS - 1);
  assert.equal(count(429), 150 - (PIN_MAX_FAILS - 1));
  const after = await K("POST", "/api/kiosk/manager-unlock", { pin: "2580" }, dev);
  assert.equal(after.status, 429, "still locked: the correct PIN didn't clear the lockout");
  // Manager guessing doesn't lock employees out of punching on that device
  assert.equal((await K("POST", "/api/kiosk/identify", { pin: "1234" }, dev)).status, 200);
  // Employee PINs: a burst can't find a PIN either
  const dev2 = (await A("POST", `/api/sites/${siteId}/kiosk-devices`, { name: "Burst 2" })).body.token;
  const emp = Array.from({ length: 120 }, (_, i) => String(6000 + i));
  emp[80] = "5678";
  const er = await Promise.all(emp.map((pin) => K("POST", "/api/kiosk/identify", { pin }, dev2)));
  assert.equal(er.filter((r) => r.status === 200).length, 0);
  // The normal path still works on a fresh device
  const dev3 = (await A("POST", `/api/sites/${siteId}/kiosk-devices`, { name: "Fine" })).body.token;
  assert.equal((await K("POST", "/api/kiosk/manager-unlock", { pin: "2580" }, dev3)).status, 200);
});

test("manager PIN: weak PINs refused, and it can't match an employee PIN (either way)", async () => {
  const { weakPinReason } = await import("../shared/kiosk");
  for (const p of ["0000", "1111", "1234", "4321", "9876", "8901", "1212", "123456", "13131313"]) assert.ok(weakPinReason(p), p);
  for (const p of ["2580", "1357", "7391", "2468", "190452"]) assert.equal(weakPinReason(p), null, p);
  for (const p of ["1234", "0000", "1212"]) {
    const r = await A("PUT", `/api/sites/${siteId}/kiosk-manager-pin`, { pin: p });
    assert.equal(r.status, 400, p);
    assert.equal(r.body.code, "weak_pin");
  }
  const emp = await A("POST", `/api/sites/${siteId}/employees`, { name: "Dee Park", pin: "7391" });
  assert.equal(emp.status, 200, JSON.stringify(emp.body));
  const clash = await A("PUT", `/api/sites/${siteId}/kiosk-manager-pin`, { pin: "7391" });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.code, "pin_in_use");
  assert.equal((await A("PUT", `/api/sites/${siteId}/kiosk-manager-pin`, { pin: "8264" })).status, 200);
  const back = await A("POST", `/api/sites/${siteId}/employees`, { name: "Eli Moss", pin: "8264" });
  assert.equal(back.status, 409, "an employee PIN can't be the manager PIN");
  assert.match(back.body.error, /manager PIN/);
  assert.equal((await A("PUT", `/api/sites/${siteId}/employees/${emp.body.id}`, { pin: "8264" })).status, 409);
  // The same PIN at another location is fine
  assert.equal((await A("POST", `/api/sites/${site2}/employees`, { name: "Eli Moss", pin: "8264" })).status, 200);
});
