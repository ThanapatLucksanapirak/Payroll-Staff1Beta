// Face data for face recognition: the photo gallery, consent, reference photos
// (checked to be one clear face of the same person), who may do what, deleting
// face data, and retention. Runs a real server on a temporary SQLite database
// with the real face model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { closestDistance, faceConsentNotice, faceDistance, normalizeFaceRetention, FACE_MATCH_MAX_DISTANCE } from "../shared/face";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-face-data-"));
process.env.DATA_DIR = dir;
process.env.BACKUPS = "off";
process.env.PHOTO_CLEANUP = "off";
delete process.env.SETUP_CODE;
delete process.env.SUPABASE_URL;
delete process.env.KIOSK_HOST;
delete process.env.PUNCH_PHOTO_DIR;
delete process.env.FACE_DATA_DIR;

const fixture = (f: string) => `data:image/jpeg;base64,${fs.readFileSync(path.join(import.meta.dirname, "fixtures", f)).toString("base64")}`;

let server: Server;
let base = "";
let admin = "";
let manager = "";
let viewer = "";
let siteId = "";
let site2 = "";
let token = "";
let ana = "";
let ben = "";
/** Ana's punches by fixture name. */
const shots: Record<string, string> = {};
let benPunch = "";

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const hs: Record<string, string> = { ...headers };
  if (body !== undefined) hs["Content-Type"] = "application/json";
  const res = await fetch(base + url, { method, headers: hs, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try { json = buf.length ? JSON.parse(buf.toString("utf8")) : null; } catch { json = null; }
  return { status: res.status, body: json, raw: buf, headers: res.headers };
}
const as = (cookie: string) => (method: string, url: string, body?: unknown) => call(method, url, body, { Cookie: cookie, "X-Requested-With": "payroll" });
const A = (method: string, url: string, body?: unknown) => as(admin)(method, url, body);
const K = (method: string, url: string, body?: unknown) => call(method, url, body, { "X-Kiosk-Token": token });

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
  token = (await A("POST", `/api/sites/${siteId}/kiosk-devices`, { name: "Door" })).body.token;
  for (const [username, role, sites] of [["manny", "manager", [siteId]], ["vera", "viewer", [siteId]], ["uma", "manager", [site2]]] as const) {
    const r = await A("POST", "/api/users", { username, password: "long password 1", role, siteIds: sites, displayName: username });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  manager = await signIn("manny", "long password 1");
  viewer = await signIn("vera", "long password 1");

  // Ana punches six times with different photos (the kiosk takes one each time).
  const types = ["in", "out"] as const;
  const files = ["face.jpg", "face-2.jpg", "face-3.jpg", "face-4.jpg", "other-face.jpg", "two-faces.jpg"];
  for (let i = 0; i < files.length; i++) {
    const id = randomUUID();
    const r = await K("POST", "/api/kiosk/punch", { id, type: types[i % 2], pin: "1234", photo: fixture(files[i]!) });
    assert.equal(r.status, 200, `${files[i]}: ${JSON.stringify(r.body)}`);
    shots[files[i]!] = id;
  }
  benPunch = randomUUID();
  assert.equal((await K("POST", "/api/kiosk/punch", { id: benPunch, type: "in", pin: "5678", photo: fixture("face-2.jpg") })).status, 200);
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  const { closeDatabase } = await import("../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("shared rules: distances, retention bounds, consent notice", () => {
  assert.equal(faceDistance([0, 0], [3, 4]), 5);
  assert.equal(faceDistance([0], [0, 1]), Infinity);
  assert.equal(closestDistance([0, 0], [[3, 4], [0, 1]]), 1);
  assert.equal(closestDistance([0, 0], []), Infinity);
  assert.equal(normalizeFaceRetention(undefined), 365);
  assert.equal(normalizeFaceRetention(5), 30);
  assert.equal(normalizeFaceRetention(5000), 1095);
  const notice = faceConsentNotice("Sushi Bar", 365);
  assert.match(notice, /Sushi Bar/);
  assert.match(notice, /1 year after your last punch/);
  assert.match(notice, /never sold/);
  assert.match(faceConsentNotice("", 730), /2 years/);
  assert.ok(FACE_MATCH_MAX_DISTANCE > 0.3 && FACE_MATCH_MAX_DISTANCE < 0.6);
});

test("photo gallery: newest first, per employee or the whole location, editors only", async () => {
  const all = await A("GET", `/api/sites/${siteId}/photos`);
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(all.body.photos.length, 7);
  const ats = all.body.photos.map((p: any) => p.at);
  assert.deepEqual(ats, [...ats].sort().reverse(), "newest first");
  assert.equal(all.body.photos[0].punchId, benPunch);
  assert.ok(all.body.photos.every((p: any) => p.reference === false));

  const mine = await A("GET", `/api/sites/${siteId}/photos?employeeId=${ana}`);
  assert.equal(mine.body.photos.length, 6);
  assert.ok(mine.body.photos.every((p: any) => p.employeeId === ana && p.employeeName === "Ana Ruiz"));

  // Paging: a small page continues where it left off (pages end at a window boundary)
  const page = await A("GET", `/api/sites/${siteId}/photos?limit=2`);
  assert.equal(page.status, 200);
  assert.ok(page.body.photos.length >= 2);
  assert.ok(page.body.nextBefore, "more to look through, back to the retention period");
  const rest = await A("GET", `/api/sites/${siteId}/photos?before=${encodeURIComponent(page.body.nextBefore)}`);
  assert.equal(rest.body.photos.length, 0, "everything was in the newest window");
  assert.equal(rest.body.nextBefore, null);

  assert.equal((await as(manager)("GET", `/api/sites/${siteId}/photos`)).status, 200, "managers (editors) see photos");
  assert.equal((await as(viewer)("GET", `/api/sites/${siteId}/photos`)).status, 403, "viewers don't");
  assert.equal((await A("GET", `/api/sites/${siteId}/photos?before=yesterday`)).status, 400);
  assert.equal((await A("GET", `/api/sites/nope/photos`)).status, 404);
});

test("reference photos need consent, one clear face, and the same person", async () => {
  const url = `/api/sites/${siteId}/employees/${ana}/face`;
  const start = await A("GET", url);
  assert.equal(start.status, 200);
  assert.equal(start.body.consentAt, null);
  assert.equal(start.body.refs, 0);
  assert.match(start.body.notice, /Face recognition at the time clock/);

  const early = await A("POST", `${url}/refs`, { punchId: shots["face.jpg"] });
  assert.equal(early.status, 409, "no consent yet");
  assert.equal(early.body.code, "consent");
  assert.equal((await A("POST", `${url}/consent`, {})).status, 400, "must confirm");
  assert.equal((await as(manager)("POST", `${url}/consent`, { confirm: true })).status, 403, "managers can't, without employees.manage");
  const consent = await A("POST", `${url}/consent`, { confirm: true });
  assert.equal(consent.status, 200, JSON.stringify(consent.body));
  assert.ok(consent.body.consentAt);
  assert.equal(consent.body.consentBy, "owner");

  const first = await A("POST", `${url}/refs`, { punchId: shots["face.jpg"] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.refs, 1);
  assert.equal((await A("POST", `${url}/refs`, { punchId: shots["face.jpg"] })).body.code, "duplicate");

  const two = await A("POST", `${url}/refs`, { punchId: shots["two-faces.jpg"] });
  assert.equal(two.status, 422);
  assert.equal(two.body.code, "faces");
  const other = await A("POST", `${url}/refs`, { punchId: shots["other-face.jpg"] });
  assert.equal(other.status, 422, "a different person's face is refused");
  assert.equal(other.body.code, "different");
  const notHers = await A("POST", `${url}/refs`, { punchId: benPunch });
  assert.equal(notHers.status, 404, "someone else's punch");
  assert.equal((await A("POST", `${url}/refs`, { punchId: "../../etc" })).status, 400);

  for (const f of ["face-2.jpg", "face-3.jpg", "face-4.jpg"]) {
    const r = await A("POST", `${url}/refs`, { punchId: shots[f] });
    assert.equal(r.status, 200, `${f}: ${JSON.stringify(r.body)}`);
  }
  const now = await A("GET", url);
  assert.equal(now.body.refs, 4);
  assert.equal(now.body.refList.length, 4);
  assert.equal(now.body.refList[0].punchId, shots["face-4.jpg"], "newest first");
  assert.equal(JSON.stringify(now.body).includes("\"d\""), false, "face templates never leave the server");

  const photo = await as(manager)("GET", `${url}/refs/${now.body.refList[0].id}/photo`);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get("content-type"), "image/jpeg");
  assert.equal(photo.raw[0], 0xff);
  assert.equal((await as(viewer)("GET", `${url}/refs/${now.body.refList[0].id}/photo`)).status, 403);

  const gallery = await A("GET", `/api/sites/${siteId}/photos?employeeId=${ana}`);
  assert.equal(gallery.body.photos.filter((p: any) => p.reference).length, 4);
  const sums = await A("GET", `/api/sites/${siteId}/face`);
  assert.deepEqual(sums.body.map((s: any) => [s.employeeId, s.refs, s.required]), [[ana, 4, false]]);

  // Removing one
  const gone = await A("DELETE", `${url}/refs/${now.body.refList[0].id}`);
  assert.equal(gone.status, 200);
  assert.equal(gone.body.refs, 3);
  assert.equal((await A("DELETE", `${url}/refs/${now.body.refList[0].id}`)).status, 404);
  assert.equal((await A("GET", `${url}/refs/${now.body.refList[0].id}/photo`)).status, 404, "its photo copy is gone too");
});

test("face data is encrypted on disk and kept out of the database", async () => {
  const folder = path.join(dir, "face-data", siteId, ana);
  const enc = fs.readFileSync(path.join(folder, "profile.enc"), "utf8");
  assert.match(enc, /^v1\./);
  assert.equal(enc.includes("consentAt"), false);
  assert.equal(fs.readdirSync(path.join(folder, "refs")).length, 3);
  const { db } = await import("../server/db");
  const store = await db();
  const all = await store.allSettings();
  assert.ok(all.length > 0);
  assert.equal(JSON.stringify(all).includes("consentAt"), false);
  assert.equal(all.some((s) => /face/i.test(s.key)), false);
});

test("deleting face data, and the punch photos with it", async () => {
  // Ben: consent and a reference, then delete only the face data
  const benUrl = `/api/sites/${siteId}/employees/${ben}/face`;
  await A("POST", `${benUrl}/consent`, { confirm: true });
  assert.equal((await A("POST", `${benUrl}/refs`, { punchId: benPunch })).status, 200);
  assert.equal((await as(manager)("DELETE", benUrl)).status, 403);
  const del = await A("DELETE", benUrl);
  assert.deepEqual(del.body, { ok: true, punchPhotos: 0 });
  const after1 = await A("GET", benUrl);
  assert.equal(after1.body.consentAt, null);
  assert.equal(after1.body.refs, 0);
  assert.equal((await A("GET", `/api/sites/${siteId}/photos?employeeId=${ben}`)).body.photos.length, 1, "punch photo kept");

  // Ana: delete face data and her punch photos (the punches stay)
  const anaUrl = `/api/sites/${siteId}/employees/${ana}/face`;
  const del2 = await A("DELETE", `${anaUrl}?punchPhotos=1`);
  assert.equal(del2.status, 200);
  assert.equal(del2.body.punchPhotos, 6);
  await new Promise((r) => setTimeout(r, 50)); // photo files are removed in the background
  assert.equal((await A("GET", `/api/sites/${siteId}/photos?employeeId=${ana}`)).body.photos.length, 0);
  assert.equal(fs.existsSync(path.join(dir, "face-data", siteId, ana)), false);
  const { db } = await import("../server/db");
  assert.ok(await (await db()).getPunch(shots["face.jpg"]!), "the punch itself is kept");
  assert.deepEqual((await A("GET", `/api/sites/${siteId}/face`)).body, []);
});

test("retention: removed employees and people who stopped punching", async () => {
  const { purgeExpiredFaceData } = await import("../server/faceData");
  const url = (id: string) => `/api/sites/${siteId}/employees/${id}/face`;
  // Ben gets face data again; removing him deletes it
  await A("POST", `${url(ben)}/consent`, { confirm: true });
  assert.equal((await A("POST", `${url(ben)}/refs`, { punchId: benPunch })).status, 200);
  // He's clocked in, so removing him is refused unless he's clocked out with it
  const refused = await A("DELETE", `/api/sites/${siteId}/employees/${ben}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "clocked_in");
  // Older data can still have someone removed while clocked in: make that state directly
  const { deleteEmployee } = await import("../server/employees");
  assert.equal(await deleteEmployee(siteId, ben), true);
  assert.equal(fs.existsSync(path.join(dir, "face-data", siteId, ben)), false, "deleted with the employee");
  const kept = (await A("GET", `/api/sites/${siteId}/photos`)).body.photos.find((p: any) => p.punchId === benPunch);
  assert.ok(kept, "his punch photo is kept (a pay record) until photo retention");
  assert.equal(kept.employeeName, "Ben Lee");
  assert.equal(kept.removed, true);
  // Removed while clocked in: Live still lists him (so he can be clocked out), marked as not in the list
  const live = await A("GET", `/api/sites/${siteId}/timeclock`);
  const benNow = live.body.employees.find((e: any) => e.id === ben);
  assert.equal(benNow?.status, "in");
  assert.equal(benNow?.inDirectory, false);
  // A manager can clock him out (only that), so the hours he worked are paid
  const M = as(manager);
  const addPunch = (type: string) => M("POST", `/api/sites/${siteId}/punches`, { employeeId: ben, type, at: new Date().toISOString(), note: "Left before he was removed" });
  for (const type of ["in", "break_start", "break_end"]) assert.equal((await addPunch(type)).status, 404, `${type} refused for a removed employee`);
  const out = await addPunch("out");
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.employeeName, "Ben Lee");
  assert.equal(out.body.type, "out");
  const again = await addPunch("out");
  assert.equal(again.status, 404, "no open shift left");
  assert.match(again.body.error, /isn't clocked in/);
  assert.equal((await as(viewer)("POST", `/api/sites/${siteId}/punches`, { employeeId: ben, type: "out", at: new Date().toISOString(), note: "x" })).status, 403, "same permission as adding a punch");
  assert.equal((await A("POST", `/api/sites/${siteId}/punches`, { employeeId: "nobody-here", type: "out", at: new Date().toISOString(), note: "x" })).status, 404, "never punched here");
  const after = (await A("GET", `/api/sites/${siteId}/timeclock`)).body.employees.find((e: any) => e.id === ben);
  assert.notEqual(after?.status, "in");

  // Removing someone who's clocked in, with the clock-out: the shift is closed first
  const cara = (await A("POST", `/api/sites/${siteId}/employees`, { name: "Cara Diaz", pin: "4321" })).body.id;
  assert.equal((await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", pin: "4321", photo: fixture("face-3.jpg") })).status, 200);
  assert.equal((await A("DELETE", `/api/sites/${siteId}/employees/${cara}`)).status, 409);
  const gone = await A("DELETE", `/api/sites/${siteId}/employees/${cara}?clockOut=1`);
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.equal(gone.body.ok, true);
  assert.ok(gone.body.clockedOut);
  const caraNow = (await A("GET", `/api/sites/${siteId}/timeclock`)).body.employees.find((e: any) => e.id === cara);
  assert.notEqual(caraNow?.status, "in");
  assert.notEqual(caraNow?.status, "break");

  // Ana: consent only. Nothing expires today; a year and a bit from now she hasn't punched, so it goes.
  await A("POST", `${url(ana)}/consent`, { confirm: true });
  assert.equal(await purgeExpiredFaceData(), 0);
  assert.equal(await purgeExpiredFaceData(Date.now() + 200 * 86_400_000), 0, "inside the 365-day default");
  assert.equal((await A("PUT", `/api/sites/${siteId}/kiosk-config`, { faceRetentionDays: 10 })).status, 400, "at least 30 days");
  assert.equal((await A("PUT", `/api/sites/${siteId}/kiosk-config`, { faceRetentionDays: 90 })).body.faceRetentionDays, 90);
  // Nobody at the location punched in those 90 days: that's an old or empty database, not Ana leaving
  const later = Date.now() + 100 * 86_400_000;
  assert.equal(await purgeExpiredFaceData(later), 0, "kept while the location has no recent punches at all");
  // Someone else did punch then, so the location is in use and Ana's data goes
  const { db: store } = await import("../server/db");
  const at = new Date(later - 5 * 86_400_000).toISOString();
  await (await store()).insertPunch({ id: randomUUID(), siteId, employeeId: cara, employeeName: "Cara Diaz", type: "in", at, source: "kiosk", deviceId: null, note: "", createdAt: at, editedAt: null, edits: [] });
  assert.equal(await purgeExpiredFaceData(later), 1);
  assert.equal((await A("GET", url(ana))).body.consentAt, null);
});

test("database switch or older backup: face data isn't purged", async () => {
  const { purgeExpiredFaceData, FACE_MISSING_GRACE_DAYS } = await import("../server/faceData");
  const url = (id: string) => `/api/sites/${siteId}/employees/${id}/face`;
  const dee = (await A("POST", `/api/sites/${siteId}/employees`, { name: "Dee Park", pin: "2468" })).body.id;
  await A("POST", `${url(dee)}/consent`, { confirm: true });
  const faceDir = (site: string, id: string) => path.join(dir, "face-data", site, id);
  assert.ok(fs.existsSync(path.join(faceDir(siteId, dee), "profile.enc")));
  const day = 86_400_000;
  const now = Date.now();
  const far = now + 2000 * day;

  // A location the database in use doesn't have, and one with no employees (a switch to an empty database)
  fs.cpSync(faceDir(siteId, dee), faceDir("not-in-this-db", dee), { recursive: true });
  fs.cpSync(faceDir(siteId, dee), faceDir(site2, dee), { recursive: true });
  assert.equal(await purgeExpiredFaceData(far), 0);
  assert.ok(fs.existsSync(faceDir("not-in-this-db", dee)), "location missing: kept");
  assert.ok(fs.existsSync(faceDir(site2, dee)), "no employees there: kept");

  // Someone not in the employee list (an older backup without them): kept for the grace period, then deleted
  const ghost = "not-an-employee-1";
  fs.cpSync(faceDir(siteId, dee), faceDir(siteId, ghost), { recursive: true });
  assert.equal(await purgeExpiredFaceData(now), 0, "first seen missing: only marked");
  assert.ok(fs.existsSync(path.join(faceDir(siteId, ghost), "missing-since")));
  assert.equal(await purgeExpiredFaceData(now + (FACE_MISSING_GRACE_DAYS - 1) * day), 0, "inside the grace period");
  assert.ok(fs.existsSync(faceDir(siteId, ghost)));
  assert.equal(await purgeExpiredFaceData(now + (FACE_MISSING_GRACE_DAYS + 1) * day), 1, "deleted after the grace period");
  assert.equal(fs.existsSync(faceDir(siteId, ghost)), false);
  assert.equal(fs.existsSync(path.join(faceDir(siteId, dee), "missing-since")), false, "people in the list are never marked");
  assert.ok(fs.existsSync(path.join(faceDir(siteId, dee), "profile.enc")), "Dee's own data is untouched");

  // Back in the list (switched back): the mark is cleared and the clock starts over
  fs.cpSync(faceDir(siteId, dee), faceDir(siteId, ghost), { recursive: true });
  fs.writeFileSync(path.join(faceDir(siteId, dee), "missing-since"), new Date(now - 100 * day).toISOString());
  await purgeExpiredFaceData(now);
  assert.equal(fs.existsSync(path.join(faceDir(siteId, dee), "missing-since")), false);
  fs.rmSync(faceDir(siteId, ghost), { recursive: true, force: true });
  fs.rmSync(path.join(dir, "face-data", "not-in-this-db"), { recursive: true, force: true });
  fs.rmSync(faceDir(site2, dee), { recursive: true, force: true });
});
