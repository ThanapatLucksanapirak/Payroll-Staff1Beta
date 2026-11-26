// Face match at the time clock: the per-person switch, live punches refused
// when the face isn't theirs (with an alert on Live), offline punches kept but
// flagged, devices with photos off, and turning it off again. Real server,
// temporary SQLite database, real face model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-face-match-"));
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
    // Saved on the tablet a few hours ago (sent later), so today's live punches come after them
    const at = new Date(Date.now() - 3 * 3600_000 + i * 60_000).toISOString();
    const r = await K("POST", "/api/kiosk/punch", { id, type: types[i % 2], pin: "1234", photo: fixture(files[i]!), at });
    assert.equal(r.status, 200, `${files[i]}: ${JSON.stringify(r.body)}`);
    shots[files[i]!] = id;
  }
  benPunch = randomUUID();
  assert.equal((await K("POST", "/api/kiosk/punch", { id: benPunch, type: "in", pin: "5678", photo: fixture("face-2.jpg"), at: new Date(Date.now() - 3 * 3600_000).toISOString() })).status, 200);
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  const { closeDatabase } = await import("../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});


const punch = (type: string, file: string | null, extra: Record<string, unknown> = {}, pin = "1234") =>
  K("POST", "/api/kiosk/punch", { id: randomUUID(), type, pin, ...(file ? { photo: fixture(file) } : { photo: null }), ...extra });
const getPunch = async (id: string) => (await (await import("../server/db")).db()).getPunch(id);
const faceUrl = () => `/api/sites/${siteId}/employees/${ana}/face`;

test("the switch needs consent and three reference photos, and the right permission", async () => {
  const off = await A("PUT", `${faceUrl()}/required`, { required: true });
  assert.equal(off.status, 409);
  assert.equal(off.body.code, "consent");
  await A("POST", `${faceUrl()}/consent`, { confirm: true });
  for (const f of ["face.jpg", "face-2.jpg"]) assert.equal((await A("POST", `${faceUrl()}/refs`, { punchId: shots[f] })).status, 200);
  const two = await A("PUT", `${faceUrl()}/required`, { required: true });
  assert.equal(two.status, 409);
  assert.equal(two.body.code, "refs");
  assert.equal((await A("POST", `${faceUrl()}/refs`, { punchId: shots["face-4.jpg"] })).status, 200);
  assert.equal((await as(manager)("PUT", `${faceUrl()}/required`, { required: true })).status, 403);
  assert.equal((await A("PUT", `${faceUrl()}/required`, { required: "yes" })).status, 400);
  const on = await A("PUT", `${faceUrl()}/required`, { required: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.required, true);
  assert.deepEqual((await A("GET", `/api/sites/${siteId}/face`)).body.map((s: any) => [s.employeeId, s.required]), [[ana, true]]);
});

test("a punch saved offline is kept, but flagged when the face wasn't theirs", async () => {
  const at = new Date(Date.now() - 10 * 60_000).toISOString();
  const r = await punch("in", "other-face.jpg", { at });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = await getPunch(r.body.punch.id);
  assert.equal(p?.meta?.face, "mismatch");
  assert.ok((p?.meta?.faceMatch as number) > 0.5);
  assert.equal(p?.meta?.photo, "saved");
  assert.equal((await A("GET", `/api/sites/${siteId}/face-alerts`)).body.length, 0, "no alert: the punch itself is flagged");
  // A fresh `at` counts as live, so it can't skip the check
  const fresh = await punch("out", "other-face.jpg", { at: new Date(Date.now() - 30_000).toISOString() });
  assert.equal(fresh.status, 422);
  assert.equal(fresh.body.reason, "mismatch");
});

test("a live punch must be them: a match goes through, someone else is refused with an alert on Live", async () => {
  // Ana is clocked in (offline punch above). Her own face (a photo not used as a reference) matches.
  const ok = await punch("out", "face-3.jpg");
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const p = await getPunch(ok.body.punch.id);
  assert.equal(p?.meta?.face, undefined);
  assert.ok(typeof p?.meta?.faceMatch === "number" && p.meta.faceMatch <= 0.5, `distance ${p?.meta?.faceMatch}`);

  // A coworker using her PIN
  const bad = await punch("in", "other-face.jpg");
  assert.equal(bad.status, 422);
  assert.equal(bad.body.code, "photo");
  assert.equal(bad.body.reason, "mismatch");
  assert.match(bad.body.error, /Face not recognized/);
  const st = await K("POST", "/api/kiosk/identify", { pin: "1234" });
  assert.equal(st.body.status, "out", "the refused punch wasn't recorded");

  const alerts = await as(manager)("GET", `/api/sites/${siteId}/face-alerts`);
  assert.equal(alerts.status, 200);
  assert.equal(alerts.body.length, 2, "this one and the fresh-`at` one");
  const a = alerts.body[0];
  assert.equal(a.employeeId, ana);
  assert.equal(a.employeeName, "Ana Ruiz");
  assert.equal(a.type, "in");
  assert.equal(a.deviceName, "Door");
  assert.equal(a.photo, true);
  assert.ok(a.distance > 0.5);
  assert.equal(a.dismissedAt, null);
  const img = await as(manager)("GET", `/api/sites/${siteId}/face-alerts/${a.id}/photo`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/jpeg");
  assert.equal((await as(viewer)("GET", `/api/sites/${siteId}/face-alerts`)).status, 403);
  assert.equal((await as(viewer)("POST", `/api/sites/${siteId}/face-alerts/${a.id}/dismiss`)).status, 403);
  const dis = await as(manager)("POST", `/api/sites/${siteId}/face-alerts/${a.id}/dismiss`);
  assert.equal(dis.status, 200);
  assert.equal(dis.body.dismissedBy, "manny");
  assert.equal((await A("POST", `/api/sites/${siteId}/face-alerts/nope1234/dismiss`)).status, 404);

  // No face at all is still "Face not detected", not a mismatch
  const none = await punch("in", "no-face.jpg");
  assert.equal(none.status, 422);
  assert.equal(none.body.reason, "no_face");
  // Ben doesn't have face match: anyone's face goes through for him
  assert.equal((await punch("out", "other-face.jpg", {}, "5678")).status, 200);
});

test("a time clock with photos off still takes a photo for them, and checks it", async () => {
  const dev = await A("POST", `/api/sites/${siteId}/kiosk-devices`, { name: "Back door" });
  const devId = dev.body.device.id;
  const T = dev.body.token;
  assert.equal((await A("PUT", `/api/sites/${siteId}/kiosk-devices/${devId}/options`, { photo: false })).status, 200);
  const KB = (body: Record<string, unknown>) => call("POST", "/api/kiosk/punch", { id: randomUUID(), ...body }, { "X-Kiosk-Token": T });
  // The kiosk is told to take a photo for Ana (and only Ana)
  const who = await call("POST", "/api/kiosk/identify", { pin: "1234" }, { "X-Kiosk-Token": T });
  assert.equal(who.body.facePhoto, true);
  assert.equal((await call("POST", "/api/kiosk/identify", { pin: "5678" }, { "X-Kiosk-Token": T })).body.facePhoto, undefined);
  const state = await call("GET", "/api/kiosk/state", undefined, { "X-Kiosk-Token": T });
  assert.deepEqual(state.body.employees.filter((x: any) => x.facePhoto).map((x: any) => x.id), [ana]);
  // No photo: refused, not let through unchecked
  const none = await KB({ type: "in", pin: "1234" });
  assert.equal(none.status, 422);
  assert.equal(none.body.code, "photo");
  // Someone else's face: refused; her own: saved with the photo
  assert.equal((await KB({ type: "in", pin: "1234", photo: fixture("other-face.jpg") })).body.reason, "mismatch");
  const ok = await KB({ type: "in", pin: "1234", photo: fixture("face-3.jpg") });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const p = await getPunch(ok.body.punch.id);
  assert.equal(p?.meta?.face, undefined);
  assert.equal(p?.meta?.photo, "saved");
  assert.ok((p?.meta?.faceMatch as number) <= 0.5);
  // Ben (face match off) punches there without a photo, as before
  const b = await KB({ type: "in", pin: "5678" });
  assert.equal(b.status, 200);
  assert.equal((await getPunch(b.body.punch.id))?.meta?.photo, undefined);
});

test("turning it off, or dropping below three reference photos, stops the check", async () => {
  // Ana is clocked in now
  const detail = await A("GET", faceUrl());
  const gone = await A("DELETE", `${faceUrl()}/refs/${detail.body.refList[0].id}`);
  assert.equal(gone.body.refs, 2);
  assert.equal(gone.body.required, false, "switched off with fewer than three");
  assert.equal((await punch("break_start", "other-face.jpg")).status, 200);
  assert.equal((await A("POST", `${faceUrl()}/refs`, { punchId: shots["face-3.jpg"] })).status, 200);
  assert.equal((await A("PUT", `${faceUrl()}/required`, { required: true })).status, 200);
  assert.equal((await punch("break_end", "other-face.jpg")).status, 422);
  assert.equal((await A("PUT", `${faceUrl()}/required`, { required: false })).body.required, false);
  assert.equal((await punch("break_end", "other-face.jpg")).status, 200);
});

test("deleting face data with punch photos removes the alerts and their photos too", async () => {
  await A("PUT", `${faceUrl()}/required`, { required: true });
  assert.equal((await punch("out", "other-face.jpg")).status, 422);
  const before = (await A("GET", `/api/sites/${siteId}/face-alerts`)).body;
  assert.equal(before.length, 5);
  await A("DELETE", `${faceUrl()}?punchPhotos=1`);
  assert.deepEqual((await A("GET", `/api/sites/${siteId}/face-alerts`)).body, []);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await A("GET", `/api/sites/${siteId}/face-alerts/${before[0].id}/photo`)).status, 404);
  // And with no face data, Ana's punches are no longer checked
  assert.equal((await punch("out", "other-face.jpg")).status, 200);
});
