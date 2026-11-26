// Pay extras on the server: finalized timesheets are locked, owners reopen with
// a reason (audit-logged), advances are committed on finalize and reversed on
// reopen, rate history, YTD and the previous-period lookup.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-pay-"));
process.env.DATA_DIR = dir;
process.env.BACKUPS = "off";
process.env.SETUP_CODE = "PAYTEST-CODE";
delete process.env.SUPABASE_URL;
delete process.env.APP_PASSWORD;

let base = "";
let server: Server;
const jar: Record<string, string> = {};
let siteId = "";

async function call(method: string, url: string, body?: unknown, as = "owner") {
  const headers: Record<string, string> = { "X-Requested-With": "payroll" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (jar[as]) headers.Cookie = jar[as];
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

function doc(label: string, dates: string[], extra: Record<string, unknown> = {}) {
  return {
    siteId, label, filename: `${label}.csv`, source: "csv", status: "draft", notes: "", periodStart: dates[0], periodEnd: dates.at(-1),
    shifts: dates.map((d, i) => ({ id: `s${i}`, employee: "Ana Ruiz", date: d, start: 600, end: 1260, breakMinutes: 0, role: "", source: "csv", note: "" })),
    employees: [{ name: "Ana Ruiz", categoryId: "custom", payBasis: "day_rate", fullDayRate: 100, halfDayRate: 50, hourlyRate: 0, isNetPay: true, excluded: false, adjustments: {}, bonuses: [], deductions: [] }],
    manualEmployees: [],
    rules: {},
    ...extra,
  };
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
  const code = "PAYTEST-CODE";
  const ok = await call("POST", "/api/auth/setup", { username: "boss", password: "correct horse", setupCode: code });
  jar.owner = (ok.headers.get("set-cookie") ?? "").split(";")[0];
  for (const [username, role] of [["admin1", "admin"], ["mgr1", "manager"], ["view1", "viewer"]]) {
    assert.equal((await call("POST", "/api/users", { username, password: "password-123", role })).status, 200);
    const r = await call("POST", "/api/auth/login", { username, password: "password-123" }, "none");
    jar[username] = (r.headers.get("set-cookie") ?? "").split(";")[0];
  }
  siteId = (await call("GET", "/api/bootstrap")).body.sites[0].id;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  const { closeDatabase } = await import("../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pay settings: defaults, validation, admin-only writes", async () => {
  const s = await call("GET", `/api/sites/${siteId}/pay/settings`, undefined, "view1");
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.cash.denominations, [100, 50, 20, 10, 5, 1, 0.25, 0.1, 0.05, 0.01]);
  assert.equal((await call("PUT", `/api/sites/${siteId}/pay/settings`, { cash: { denominations: [20], roundCash: true } }, "mgr1")).status, 403);
  assert.equal((await call("PUT", `/api/sites/${siteId}/pay/settings`, { bogus: 1 })).status, 400);
  const dup = await call("PUT", `/api/sites/${siteId}/pay/settings`, { holidays: [{ id: "a", date: "2026-07-04", name: "A" }, { id: "b", date: "2026-07-04", name: "B" }] });
  assert.equal(dup.status, 400);
  const put = await call("PUT", `/api/sites/${siteId}/pay/settings`, {
    cash: { denominations: [1, 20, 100, 20], roundCash: false },
    holidays: [{ id: "h1", date: "2026-03-03", name: "Founders Day", kind: "flat", flatBonus: 25 }],
    recurring: [{ id: "r1", employee: "Ana Ruiz", kind: "deduction", description: "Uniform", amount: 10 }],
  }, "admin1");
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.cash.denominations, [100, 20, 1]);
  assert.equal(put.body.recurring[0].active, true);
});

test("finalized timesheets are locked; only an owner reopens, with a reason", async () => {
  const created = await call("POST", "/api/timesheets", { doc: doc("Lock", ["2026-03-02", "2026-03-03"]) });
  const id = created.body.id;
  const fin = await call("PATCH", `/api/timesheets/${id}`, { status: "final" }, "mgr1");
  assert.equal(fin.status, 200);
  // Finalizing snapshots the location extras: holiday +25, uniform −10
  assert.equal(fin.body.totalPay, 200 + 25 - 10);
  const got = await call("GET", `/api/timesheets/${id}`);
  assert.equal(got.body.doc.status, "final");
  assert.equal(got.body.doc.payExtras.holidays[0].id, "h1");

  const put = await call("PUT", `/api/timesheets/${id}`, { doc: { ...got.body.doc, label: "Changed" }, force: true });
  assert.equal(put.status, 409);
  assert.match(put.body.error, /finalized and locked/);
  assert.equal(put.body.locked, true);
  assert.equal((await call("PUT", `/api/timesheets/${id}`, { doc: { ...got.body.doc, status: "draft" }, force: true })).status, 409);
  assert.equal((await call("PATCH", `/api/timesheets/${id}`, { status: "draft" })).status, 409, "no back door through PATCH");
  assert.equal((await call("PATCH", `/api/timesheets/${id}`, { siteId: "elsewhere" })).status, 409);
  assert.equal((await call("DELETE", `/api/timesheets/${id}`)).status, 409);
  assert.equal((await call("PATCH", `/api/timesheets/${id}`, { label: "Renamed" })).status, 200, "renaming is allowed");
  assert.equal((await call("POST", `/api/timesheets/${id}/duplicate`)).status, 200, "a draft copy can be made");

  assert.equal((await call("POST", `/api/timesheets/${id}/reopen`, { reason: "Fix hours" }, "mgr1")).status, 403);
  assert.equal((await call("POST", `/api/timesheets/${id}/reopen`, { reason: "Fix hours" }, "admin1")).status, 403);
  assert.equal((await call("POST", `/api/timesheets/${id}/reopen`, { reason: "" })).status, 400, "a reason is required");
  const re = await call("POST", `/api/timesheets/${id}/reopen`, { reason: "Ana's hours were wrong" });
  assert.equal(re.status, 200);
  assert.equal((await call("GET", `/api/timesheets/${id}`)).body.doc.status, "draft");
  assert.equal((await call("POST", `/api/timesheets/${id}/reopen`, { reason: "again" })).status, 409);

  const { flushAudit } = await import("../server/audit");
  await flushAudit();
  const log = await call("GET", "/api/audit?action=timesheet.reopen");
  assert.ok(log.body.entries.some((e: any) => /Ana's hours were wrong/.test(e.detail) && e.target === `timesheet:${id}`), JSON.stringify(log.body));

  const edit = await call("PUT", `/api/timesheets/${id}`, { doc: { ...(await call("GET", `/api/timesheets/${id}`)).body.doc, label: "Edited" } });
  assert.equal(edit.status, 200);
  await call("DELETE", `/api/timesheets/${id}`);
});

test("advances: repaid on finalize, reversed on reopen; balance visible", async () => {
  await call("PUT", `/api/sites/${siteId}/pay/settings`, { holidays: [], recurring: [] });
  assert.equal((await call("POST", `/api/sites/${siteId}/pay/advances`, { employee: "Ana Ruiz", amount: 100, date: "2026-04-01", mode: "per_period", perPeriod: 0 }, "mgr1")).status, 400);
  assert.equal((await call("POST", `/api/sites/${siteId}/pay/advances`, { employee: "Ana Ruiz", amount: 100, date: "2026-04-01", mode: "periods", periods: 3 }, "view1")).status, 403);
  const adv = await call("POST", `/api/sites/${siteId}/pay/advances`, { employee: "Ana  Ruiz", amount: 100, date: "2026-04-01", mode: "periods", periods: 3, note: "Rent" }, "mgr1");
  assert.equal(adv.status, 200);
  assert.equal(adv.body.employee, "Ana Ruiz");
  assert.equal(adv.body.remaining, 100);

  const ctx = await call("GET", `/api/sites/${siteId}/pay/context`);
  assert.deepEqual(ctx.body.advances.map((a: any) => [a.installment, a.remaining]), [[33.34, 100]]);

  // Finalize by saving the document (the workspace path)
  const t1 = await call("POST", "/api/timesheets", { doc: doc("Apr 1", ["2026-04-06", "2026-04-07"]) });
  const d1 = (await call("GET", `/api/timesheets/${t1.body.id}`)).body;
  const saved = await call("PUT", `/api/timesheets/${t1.body.id}`, { doc: { ...d1.doc, status: "final" }, baseUpdatedAt: d1.updatedAt });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.totalPay, 200 - 33.34);
  let list = (await call("GET", `/api/sites/${siteId}/pay/advances`)).body;
  assert.deepEqual([list[0].repaid, list[0].remaining], [33.34, 66.66]);

  // Finalize from the list (PATCH)
  const t2 = await call("POST", "/api/timesheets", { doc: doc("Apr 2", ["2026-04-13"]) });
  assert.equal((await call("PATCH", `/api/timesheets/${t2.body.id}`, { status: "final" })).status, 200);
  list = (await call("GET", `/api/sites/${siteId}/pay/advances`)).body;
  assert.deepEqual([list[0].repaid, list[0].remaining], [66.68, 33.32]);
  assert.equal(list[0].repayments.length, 2);

  // Deleting an advance with repayments is refused; writing it off works
  assert.equal((await call("DELETE", `/api/sites/${siteId}/pay/advances/${list[0].id}`)).status, 409);

  // Reopen reverses this timesheet's repayment only
  assert.equal((await call("POST", `/api/timesheets/${t2.body.id}/reopen`, { reason: "Recount" })).status, 200);
  list = (await call("GET", `/api/sites/${siteId}/pay/advances`)).body;
  assert.deepEqual([list[0].repaid, list[0].remaining], [33.34, 66.66]);

  // YTD from finalized timesheets of the year; previous period for variance
  const ytd = await call("GET", `/api/sites/${siteId}/pay/ytd?year=2026`, undefined, "view1");
  assert.equal(ytd.status, 200);
  const ana = ytd.body.rows.find((r: any) => r.name === "Ana Ruiz");
  assert.ok(ana);
  assert.equal(ytd.body.rows.length, 1);
  const prev = await call("GET", `/api/timesheets/${t2.body.id}/pay/previous`, undefined, "view1");
  assert.equal(prev.body.id, t1.body.id);
  assert.equal(prev.body.totalPay, 166.66);
  assert.equal((await call("GET", `/api/timesheets/${t1.body.id}/pay/previous`)).body?.id === t1.body.id, false);

  const off = await call("PATCH", `/api/sites/${siteId}/pay/advances/${list[0].id}`, { cancelled: true });
  assert.equal(off.body.remaining, 0);
  assert.equal((await call("PATCH", `/api/sites/${siteId}/pay/advances/${list[0].id}`, { cancelled: true }, "mgr1")).status, 403);
});

test("saved rates with an effective date drive later analyses", async () => {
  const e = (rate: number) => [{ name: "Bo Lee", categoryId: "custom", payBasis: "day_rate", fullDayRate: rate, halfDayRate: rate / 2, hourlyRate: 0, isNetPay: true, excluded: false, adjustments: {}, bonuses: [], deductions: [] }];
  assert.equal((await call("PUT", `/api/sites/${siteId}/pay/rates`, { effectiveFrom: "", entries: e(100) }, "view1")).status, 403);
  assert.equal((await call("PUT", `/api/sites/${siteId}/pay/rates`, { effectiveFrom: "", entries: e(100) }, "mgr1")).body.saved >= 1, true);
  const r = await call("PUT", `/api/sites/${siteId}/pay/rates`, { effectiveFrom: "2026-05-04", entries: e(120) }, "mgr1");
  assert.equal(r.status, 200);
  assert.equal(r.body.changed, 1);
  const wages = (await call("GET", `/api/sites/${siteId}/wages`)).body;
  assert.equal(wages.find((w: any) => w.name === "Bo Lee").fullDayRate, 120);
  const hist = (await call("GET", `/api/sites/${siteId}/pay/rates`)).body;
  assert.deepEqual(hist["bo lee"].history.map((h: any) => [h.until, h.fullDayRate]), [["2026-05-04", 100]]);
  const ctx = (await call("GET", `/api/sites/${siteId}/pay/context`)).body;
  assert.equal(ctx.rates["bo lee"].length, 1);

  // Finalizing syncs the history into the timesheet: old days at 100, new at 120
  const d = doc("Rates", ["2026-05-01", "2026-05-04"]);
  (d.shifts as any[]).forEach((s) => { s.employee = "Bo Lee"; });
  (d.employees as any[])[0] = { ...e(120)[0] };
  const t = await call("POST", "/api/timesheets", { doc: d });
  assert.equal(t.body.totalPay, 240);
  const fin = await call("PATCH", `/api/timesheets/${t.body.id}`, { status: "final" });
  assert.equal(fin.body.totalPay, 220);
});

test("a timesheet created already final gets the pay snapshot and repays advances", async () => {
  const adv = await call("POST", `/api/sites/${siteId}/pay/advances`, { employee: "Cy Moss", amount: 50, date: "2026-06-01", mode: "periods", periods: 1 }, "mgr1");
  assert.equal(adv.status, 200);
  const d = doc("Created final", ["2026-06-08"], { status: "final" });
  (d.shifts as any[]).forEach((s) => { s.employee = "Cy Moss"; });
  (d.employees as any[])[0] = { ...(d.employees as any[])[0], name: "Cy Moss" };
  const t = await call("POST", "/api/timesheets", { doc: d });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal(t.body.totalPay, 100 - 50, "advance deducted in the snapshot");
  const list = (await call("GET", `/api/sites/${siteId}/pay/advances`)).body;
  const a = list.find((x: any) => x.id === adv.body.id);
  assert.deepEqual([a.repaid, a.remaining], [50, 0], "repayment recorded");
});

test("created final and finalized from a draft save the same totals", async () => {
  const mk = async (name: string) => {
    const adv = await call("POST", `/api/sites/${siteId}/pay/advances`, { employee: name, amount: 30, date: "2026-07-01", mode: "periods", periods: 1 }, "mgr1");
    assert.equal(adv.status, 200);
    const d = doc(`Same ${name}`, ["2026-07-06", "2026-07-07"]);
    (d.shifts as any[]).forEach((s) => { s.employee = name; });
    (d.employees as any[])[0] = { ...(d.employees as any[])[0], name };
    return { d, advId: adv.body.id };
  };
  const a = await mk("Eve Ray");
  const b = await mk("Fay Ray");
  // A: created already final. B: created as a draft, then finalized from the list.
  const ta = await call("POST", "/api/timesheets", { doc: { ...a.d, status: "final" } });
  const tb = await call("POST", "/api/timesheets", { doc: b.d });
  assert.equal((await call("PATCH", `/api/timesheets/${tb.body.id}`, { status: "final" })).status, 200);
  const ga = (await call("GET", `/api/timesheets/${ta.body.id}`)).body;
  const gb = (await call("GET", `/api/timesheets/${tb.body.id}`)).body;
  const strip = (x: any) => JSON.parse(JSON.stringify(x ?? null).replaceAll("Eve Ray", "X").replaceAll("Fay Ray", "X").replaceAll(a.advId, "ADV").replaceAll(b.advId, "ADV"));
  assert.equal(ga.doc.status, "final");
  assert.equal(gb.doc.status, "final");
  assert.ok(JSON.stringify(ga.doc.payExtras ?? {}).includes("30"), "the snapshot holds the advance");
  assert.deepEqual(strip(ga.doc.payExtras), strip(gb.doc.payExtras), "same pay extras snapshot (advance deduction)");
  const list = (await call("GET", "/api/timesheets")).body;
  const sa = list.find((t: any) => t.id === ta.body.id);
  const sb = list.find((t: any) => t.id === tb.body.id);
  assert.equal(sa.totalPay, sb.totalPay);
  assert.equal(sa.totalPay, 200 - 30);
  const advs = (await call("GET", `/api/sites/${siteId}/pay/advances`)).body;
  const ra = advs.find((x: any) => x.id === a.advId);
  const rb = advs.find((x: any) => x.id === b.advId);
  assert.deepEqual([ra.repaid, ra.remaining], [rb.repaid, rb.remaining]);
  assert.deepEqual([ra.repaid, ra.remaining], [30, 0]);
});
