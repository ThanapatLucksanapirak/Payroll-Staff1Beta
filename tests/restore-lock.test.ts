// Restore and database switch pause other changes: a punch that arrives while
// one runs gets a 503 "try again" (the time clock keeps it and sends it again),
// so nothing confirmed is lost. A Supabase restore that fails part-way says so.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-restore-lock-"));
process.env.DATA_DIR = dir;
process.env.BACKUPS = "off";
process.env.PHOTO_CLEANUP = "off";
process.env.SETUP_CODE = "ABCDE-FGHJK";
delete process.env.SUPABASE_URL;
delete process.env.KIOSK_HOST;

let base = "";
let server: Server;
let admin = "";
let token = "";
let siteId = "";

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const hs: Record<string, string> = { ...headers };
  if (body !== undefined) hs["Content-Type"] = "application/json";
  const res = await fetch(base + url, { method, headers: hs, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const A = (method: string, url: string, body?: unknown) => call(method, url, body, { Cookie: admin, "X-Requested-With": "payroll" });
const K = (method: string, url: string, body?: unknown) => call(method, url, body, { "X-Kiosk-Token": token });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const setup = await call("POST", "/api/auth/setup", { username: "owner", password: "correct horse", setupCode: "ABCDE-FGHJK" }, { "X-Requested-With": "payroll" });
  admin = (setup.headers.get("set-cookie") ?? "").split(";")[0];
  siteId = (await A("GET", "/api/bootstrap")).body.sites[0].id;
  await A("PUT", `/api/sites/${siteId}`, { timeSource: "kiosk", kioskLoginMode: "pin" });
  for (const [name, pin] of [["Ana Ruiz", "1234"], ["Ben Lee", "5678"]]) await A("POST", `/api/sites/${siteId}/employees`, { name, pin });
  const dev = await A("POST", `/api/sites/${siteId}/kiosk-devices`, { name: "Front" });
  await A("PUT", `/api/sites/${siteId}/kiosk-devices/${dev.body.device.id}/options`, { photo: false });
  token = (await call("POST", "/api/kiosk/pair", { code: dev.body.pairCode })).body.token;
  assert.ok(token);
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  const { closeDatabase } = await import("../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Make the store's importAll slow (or fail) for one call. */
async function patchImport(fn: (orig: (...a: any[]) => Promise<any>, ...a: any[]) => Promise<any>) {
  const { db } = await import("../server/db");
  const store: any = await db();
  const orig = store.importAll.bind(store);
  store.importAll = async (...a: any[]) => { store.importAll = orig; return fn(orig, ...a); };
  return () => { store.importAll = orig; };
}

test("a punch during a restore is refused with a retryable 503, then goes through", async () => {
  const backup = (await A("GET", "/api/backup")).body;
  let entered = false;
  await patchImport(async (orig, ...a) => { entered = true; await sleep(600); return orig(...a); });
  const restoring = A("POST", "/api/backup/restore", backup);
  while (!entered) await sleep(10);
  const id = randomUUID();
  const during = await K("POST", "/api/kiosk/punch", { id, type: "in", pin: "1234" });
  assert.equal(during.status, 503, JSON.stringify(during.body));
  assert.equal(during.body.busy, true);
  assert.equal(during.body.code, undefined, "no code: the time clock keeps the punch and sends it again");
  assert.equal(during.headers.get("retry-after"), "5");
  // Admin changes wait too
  assert.equal((await A("POST", `/api/sites/${siteId}/employees`, { name: "Cara Diaz", pin: "4321" })).status, 503);
  // A second restore or a switch at the same time is refused
  const second = await A("POST", "/api/backup/restore", backup);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "maintenance");
  // Reads still work
  assert.equal((await A("GET", "/api/bootstrap")).status, 200);
  const done = await restoring;
  assert.equal(done.status, 200, JSON.stringify(done.body));
  // The time clock sends it again: now it's saved, and it survives
  const again = await K("POST", "/api/kiosk/punch", { id, type: "in", pin: "1234" });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const { db } = await import("../server/db");
  assert.ok(await (await db()).getPunch(id));
});

test("a restore waits for a punch already being saved, so it's in the pre-restore backup", async () => {
  const { withMaintenance, maintenanceGate, maintenanceState } = await import("../server/maintenance");
  // A change under way: hold a fake request open through the gate
  const gate = maintenanceGate(() => false);
  const { EventEmitter } = await import("node:events");
  const res: any = new EventEmitter();
  res.setHeader = () => res; res.status = () => res; res.json = () => res;
  let passed = false;
  gate({ method: "POST", path: "/kiosk/punch" } as any, res, () => { passed = true; });
  assert.ok(passed);
  assert.equal(maintenanceState().inFlight, 1);
  let ran = false;
  const job = withMaintenance("restore", async () => { ran = true; });
  await sleep(50);
  assert.equal(ran, false, "waits for the change under way");
  res.emit("finish");
  await job;
  assert.equal(ran, true);
  assert.deepEqual(maintenanceState(), { active: null, inFlight: 0 });
});

test("changes that don't finish in time: the restore gives up and changes nothing", async () => {
  const m = await import("../server/maintenance");
  const old = m.maintenanceLimits.drainMs;
  m.maintenanceLimits.drainMs = 100;
  const { EventEmitter } = await import("node:events");
  const res: any = new EventEmitter();
  m.maintenanceGate(() => false)({ method: "PUT", path: "/x" } as any, res, () => undefined);
  let ran = false;
  await assert.rejects(m.withMaintenance("restore", async () => { ran = true; }), (err: any) => err.status === 503);
  assert.equal(ran, false);
  assert.equal(m.maintenanceActive(), null, "unlocked again");
  res.emit("close");
  m.maintenanceLimits.drainMs = old;
});

test("a failed SQLite restore says nothing changed; a Supabase one says run it again", async () => {
  const backup = (await A("GET", "/api/backup")).body;
  await patchImport(async () => { throw new Error("injected failure"); });
  const sqlite = await A("POST", "/api/backup/restore", backup);
  assert.equal(sqlite.status, 500);
  assert.match(sqlite.body.error, /Nothing was restored.*unchanged/);

  const { db } = await import("../server/db");
  const store: any = await db();
  Object.defineProperty(store, "kind", { value: "supabase", configurable: true });
  try {
    await patchImport(async () => { throw new Error("injected failure"); });
    const supa = await A("POST", "/api/backup/restore", backup);
    assert.equal(supa.status, 502);
    assert.equal(supa.body.code, "partial_restore");
    assert.match(supa.body.error, /stopped part-way.*Run the same restore again/);
  } finally {
    Object.defineProperty(store, "kind", { value: "sqlite", configurable: true });
  }
  // Unlocked afterwards
  assert.equal((await K("POST", "/api/kiosk/punch", { id: randomUUID(), type: "in", pin: "5678" })).status, 200);
});

test("a punch during a database switch is refused, and nothing is lost", async () => {
  const dbMod = await import("../server/db");
  const target = path.join(dir, "second.db");
  let entered = false;
  const store: any = await dbMod.db();
  const orig = store.allPunches.bind(store);
  store.allPunches = async () => { entered = true; await sleep(500); store.allPunches = orig; return orig(); };
  const switching = A("POST", "/api/database/switch", { config: { kind: "sqlite", path: target }, copyData: true });
  while (!entered) await sleep(10);
  const id = randomUUID();
  const during = await K("POST", "/api/kiosk/punch", { id, type: "out", pin: "1234" });
  assert.equal(during.status, 503);
  const done = await switching;
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const again = await K("POST", "/api/kiosk/punch", { id, type: "out", pin: "1234" });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.ok(await (await dbMod.db()).getPunch(id), "saved in the new database");
});
