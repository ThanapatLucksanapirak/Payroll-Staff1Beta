// Finalizing a timesheet is logged once: two finalizes at the same time, or
// finalizing one that's already final, add no second "timesheet.finalize" entry.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-finalize-audit-"));
process.env.DATA_DIR = dir;
process.env.BACKUPS = "off";
process.env.SETUP_CODE = "ABCDE-FGHJK";
delete process.env.SUPABASE_URL;

let base = "";
let server: Server;
let cookie = "";
let siteId = "";

async function call(method: string, url: string, body?: unknown) {
  const headers: Record<string, string> = { "X-Requested-With": "payroll", ...(cookie ? { Cookie: cookie } : {}) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
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
  const ok = await call("POST", "/api/auth/setup", { password: "correct horse", setupCode: "ABCDE-FGHJK" });
  cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0];
  siteId = (await call("GET", "/api/bootstrap")).body.sites[0].id;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  const { closeDatabase } = await import("../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function finalizeEntries(id: string) {
  const { flushAudit } = await import("../server/audit");
  await new Promise((r) => setTimeout(r, 50));
  await flushAudit();
  const log = await call("GET", "/api/audit?action=timesheet.finalize&limit=500");
  const entries: any[] = Array.isArray(log.body) ? log.body : log.body.entries ?? log.body.items ?? [];
  return entries.filter((e) => e.action === "timesheet.finalize" && e.target === `timesheet:${id}`);
}

const doc = () => ({
  version: 2, siteId, label: "Week", filename: "w.csv", source: "manual", status: "draft", notes: "", periodStart: "2026-11-02", periodEnd: "2026-11-08",
  shifts: [{ id: "s1", employee: "Ana Ruiz", date: "2026-11-02", start: 540, end: 1020, breakMinutes: 0, role: "", source: "manual", note: "" }],
  employees: [], manualEmployees: [], rules: {},
});

test("two finalizes at once and a repeat finalize log one entry", async () => {
  const made = await call("POST", "/api/timesheets", { doc: doc() });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = made.body.id;
  const both = await Promise.all([call("PATCH", `/api/timesheets/${id}`, { status: "final" }), call("PATCH", `/api/timesheets/${id}`, { status: "final" })]);
  for (const r of both) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await finalizeEntries(id)).length, 1, "parallel finalizes: one entry");
  assert.equal((await call("PATCH", `/api/timesheets/${id}`, { status: "final" })).status, 200);
  assert.equal((await finalizeEntries(id)).length, 1, "finalizing a final sheet again: no new entry");
  // The same with the whole doc in the body (label and location unchanged): still no new entry
  const cur = (await call("GET", `/api/timesheets/${id}`)).body;
  const whole = { ...cur.doc, label: cur.doc.label, siteId: cur.doc.siteId, status: "final" };
  const pair = await Promise.all([call("PATCH", `/api/timesheets/${id}`, whole), call("PATCH", `/api/timesheets/${id}`, whole)]);
  for (const r of pair) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await finalizeEntries(id)).length, 1, "whole-doc finalize of a final sheet: no new entry");
  // A fresh draft finalized twice at once with whole-doc bodies: one entry
  const d2 = (await call("POST", "/api/timesheets", { doc: doc() })).body.id;
  const cur2 = (await call("GET", `/api/timesheets/${d2}`)).body;
  const body2 = { ...cur2.doc, status: "final" };
  await Promise.all([call("PATCH", `/api/timesheets/${d2}`, body2), call("PATCH", `/api/timesheets/${d2}`, body2)]);
  assert.equal((await finalizeEntries(d2)).length, 1, "whole-doc parallel finalizes: one entry");
  // A rename of a final sheet is still logged
  assert.equal((await call("PATCH", `/api/timesheets/${id}`, { label: "Renamed" })).status, 200);
  const { flushAudit } = await import("../server/audit");
  await flushAudit();
  const all = (await call("GET", "/api/audit?limit=500")).body;
  const list: any[] = Array.isArray(all) ? all : all.entries ?? all.items ?? [];
  assert.ok(list.some((e) => e.action === "timesheet.rename" && e.target === `timesheet:${id}`));
});
