// Pay extras on the server: finalized timesheets are locked, owners reopen
// them with a reason, advances are committed on finalize (and reversed on
// reopen), plus the location's pay settings, rate history, YTD and the
// previous-period lookup.
//
// Everything is stored as JSON in app settings:
//   pay:settings:<siteId>  cash denominations, holidays, standing items, accounts, tip points
//   pay:advances:<siteId>  advances and loans with their repayments
//   pay:rates:<siteId>     saved-rate history by employee key
import type { Express, NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type AnalysisResult, type EmployeeConfig, type TimesheetDoc, employeeConfigSchema, timesheetDocSchema } from "@shared/schema";
import { computePayroll, employeeKey, normalizeName } from "@shared/engine";
import { docToMeta, rowToDoc } from "@shared/legacy";
import {
  type Advance, type PayContext, type PaySettings, type RateHistoryEntry, accountsSchema, advanceBalance, advanceInputSchema, advanceSchedules, advanceSchema,
  cashConfigSchema, commitRepayments, rateSegmentSchema, computeTimesheet, explicitRates, holidaySchema, paySettingsSchema, recordRateChange, recurringItemSchema, repaymentLines,
  reverseRepayments, snapshotOf, syncPayExtras, ytdTotals,
} from "@shared/payExtras";
import { db } from "./db";
import type { TimesheetRow } from "./db/types";
import * as settings from "./settings";
import { currentUser } from "./auth";
import { actorOf, audit } from "./audit";
import { canAccessSite } from "./users";

type Next = NextFunction;
const g = (fn: (req: Request, res: Response, next: Next) => Promise<unknown>) => (req: Request, res: Response, next: Next) => { fn(req, res, next).catch(next); };
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const PAY_KEYS = {
  settings: (siteId: string) => `pay:settings:${siteId}`,
  advances: (siteId: string) => `pay:advances:${siteId}`,
  rates: (siteId: string) => `pay:rates:${siteId}`,
};

export const LOCKED_MESSAGE = "This timesheet is finalized and locked. An owner can reopen it to make changes.";

// ── Storage helpers ──────────────────────────────────────────────────────────
const locks = new Map<string, Promise<unknown>>();
/** Run read-modify-writes on one key one at a time (in this process). */
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  locks.set(key, run.catch(() => undefined));
  return run;
}

async function readJson(key: string): Promise<unknown> {
  const raw = await (await db()).getSetting(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
const writeJson = async (key: string, v: unknown) => (await db()).setSetting(key, JSON.stringify(v));

export async function getPaySettings(siteId: string): Promise<PaySettings> {
  const p = paySettingsSchema.safeParse((await readJson(PAY_KEYS.settings(siteId))) ?? {});
  return p.success ? p.data : paySettingsSchema.parse({});
}

export async function getAdvances(siteId: string): Promise<Advance[]> {
  const raw = await readJson(PAY_KEYS.advances(siteId));
  return (Array.isArray(raw) ? raw : []).map((a) => advanceSchema.safeParse(a)).filter((r) => r.success).map((r) => r.data!);
}

export async function getRateHistory(siteId: string): Promise<Record<string, RateHistoryEntry>> {
  const raw = (await readJson(PAY_KEYS.rates(siteId))) as Record<string, any> | null;
  const out: Record<string, RateHistoryEntry> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) {
    const hist = z.array(z.any()).safeParse(v?.history);
    if (!hist.success) continue;
    const segs = hist.data.map((s) => rateSegmentSchema.safeParse(s)).filter((r) => r.success).map((r) => r.data!);
    out[k] = { name: String(v?.name ?? k), currentFrom: typeof v?.currentFrom === "string" ? v.currentFrom : "", history: segs };
  }
  return out;
}

export async function payContext(siteId: string, timesheetId?: string): Promise<PayContext> {
  const [s, advances, rates] = await Promise.all([getPaySettings(siteId), getAdvances(siteId), getRateHistory(siteId)]);
  return {
    holidays: s.holidays,
    recurring: s.recurring,
    advances: advanceSchedules(advances, timesheetId),
    rates: Object.fromEntries(Object.entries(rates).filter(([, v]) => v.history.length).map(([k, v]) => [k, v.history])),
    tipPoints: s.tipPoints,
  };
}

// ── Timesheet helpers ───────────────────────────────────────────────────────
async function docOf(row: TimesheetRow): Promise<TimesheetDoc> {
  const sites = await settings.getSites();
  const site = sites.find((s) => s.id === row.site_id) ?? sites.find((s) => s.id === settings.LEGACY_SITE_ID) ?? sites[0];
  return rowToDoc(row, { defaultSiteId: site.id, rules: site.rules });
}

const isFinal = (row: TimesheetRow | null) => row?.meta_json?.status === "final";

/** Sync a timesheet's extras with the location (as the workspace does) before it is finalized. */
async function syncForFinal(doc: TimesheetDoc, id: string | undefined): Promise<TimesheetDoc> {
  const categories = await settings.getCategories();
  const base = computePayroll({ shifts: doc.shifts, employees: doc.employees, manualEmployees: doc.manualEmployees, categories, rules: doc.rules });
  return syncPayExtras(doc, await payContext(doc.siteId, id), { start: base.periodStart || doc.periodStart, end: base.periodEnd || doc.periodEnd });
}

/** Record the advance repayments of a finalized timesheet. */
async function commitFinal(id: string) {
  const row = await (await db()).getTimesheet(id);
  if (!row || !isFinal(row)) return;
  const doc = await docOf(row);
  const result = computeTimesheet(doc, await settings.getCategories());
  const lines = repaymentLines(result);
  await withLock(PAY_KEYS.advances(doc.siteId), async () => {
    const list = await getAdvances(doc.siteId);
    const next = commitRepayments(list, id, result.periodEnd || doc.periodEnd, lines, new Date().toISOString());
    if (next.some((a, i) => a !== list[i])) await writeJson(PAY_KEYS.advances(doc.siteId), next);
  });
}

async function reverseFinal(id: string, siteId: string) {
  await withLock(PAY_KEYS.advances(siteId), async () => {
    const list = await getAdvances(siteId);
    const next = reverseRepayments(list, id);
    if (next.some((a, i) => a !== list[i])) await writeJson(PAY_KEYS.advances(siteId), next);
  });
}

/** Run `fn` after the route succeeded, before its response is sent. */
function beforeSuccessResponse(res: Response, fn: () => Promise<void>) {
  const json = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode >= 400) return json(body);
    fn().catch((err) => console.error("[pay] could not record advance repayments:", err)).finally(() => json(body));
    return res;
  }) as Response["json"];
}

// Computed results of finalized timesheets, by id + version.
const resultCache = new Map<string, AnalysisResult>();
async function resultOf(id: string, updatedAt: string | null): Promise<{ result: AnalysisResult; doc: TimesheetDoc } | null> {
  const row = await (await db()).getTimesheet(id);
  if (!row) return null;
  const doc = await docOf(row);
  const key = `${id}|${row.updated_at ?? updatedAt}`;
  let result = resultCache.get(key);
  if (!result) {
    result = computeTimesheet(doc, await settings.getCategories());
    if (resultCache.size > 1000) resultCache.clear();
    resultCache.set(key, result);
  }
  return { result, doc };
}

async function finalizedFor(siteId: string, excludeId?: string) {
  const store = await db();
  const def = await settings.defaultSiteId();
  const list = (await store.listTimesheets()).filter((t) => !t.deletedAt && t.status === "final" && (t.siteId ?? def) === siteId && t.id !== excludeId);
  const out: { id: string; label: string; periodStart: string; periodEnd: string; result: AnalysisResult }[] = [];
  for (const t of list) {
    const r = await resultOf(t.id, t.updatedAt);
    if (!r) continue;
    out.push({ id: t.id, label: r.doc.label || r.doc.filename || "Timesheet", periodStart: r.result.periodStart || r.doc.periodStart, periodEnd: r.result.periodEnd || r.doc.periodEnd || t.createdAt.slice(0, 10), result: r.result });
  }
  return out;
}

// ── Routes ───────────────────────────────────────────────────────────────────
export function registerPayRoutes(app: Express, deps: { rowFromDoc: (doc: TimesheetDoc) => Promise<Partial<TimesheetRow>> }) {
  // ── Lock: finalized timesheets are read-only ──────────────────────────────
  app.put("/api/timesheets/:id", g(async (req, res, next) => {
    const id = String(req.params.id);
    const row = await (await db()).getTimesheet(id);
    if (!row || row.meta_json?.deletedAt) return next();
    if (isFinal(row)) return res.status(409).json({ error: LOCKED_MESSAGE, locked: true });
    const parsed = timesheetDocSchema.safeParse(req.body?.doc);
    if (parsed.success && parsed.data.status === "final") {
      // Finalizing by saving: snapshot the extras, then commit the repayments.
      req.body.doc = await syncForFinal(parsed.data, id);
      beforeSuccessResponse(res, () => commitFinal(id));
    }
    next();
  }));

  app.patch("/api/timesheets/:id", g(async (req, res, next) => {
    const id = String(req.params.id);
    const store = await db();
    const row = await store.getTimesheet(id);
    if (!row || row.meta_json?.deletedAt) return next();
    const body = req.body ?? {};
    if (isFinal(row)) {
      if (body.status === "draft") return res.status(409).json({ error: "This timesheet is finalized. Only an owner can reopen it, with a reason.", locked: true });
      if (body.siteId !== undefined && body.siteId !== (row.site_id ?? undefined)) return res.status(409).json({ error: "Finalized timesheets can't be moved. An owner can reopen it first.", locked: true });
      return next(); // renaming is still allowed
    }
    if (body.status === "final") {
      const doc = await syncForFinal(await docOf(row), id);
      await store.updateTimesheet(id, await deps.rowFromDoc(doc));
      beforeSuccessResponse(res, () => commitFinal(id));
    }
    next();
  }));

  app.delete("/api/timesheets/:id", g(async (req, res, next) => {
    const row = await (await db()).getTimesheet(String(req.params.id));
    if (row && isFinal(row) && !row.meta_json?.deletedAt) {
      return res.status(409).json({ error: "Finalized timesheets can't be deleted. An owner can reopen it first.", locked: true });
    }
    next();
  }));

  app.post("/api/timesheets/:id/reopen", g(async (req, res) => {
    const user = currentUser(res)!;
    if (user.role !== "owner") return res.status(403).json({ error: "Only an owner can reopen a finalized timesheet." });
    const { reason } = z.object({ reason: z.string().trim().min(3, "Say briefly why it is being reopened.").max(300) }).parse(req.body ?? {});
    const store = await db();
    const id = String(req.params.id);
    const row = await store.getTimesheet(id);
    if (!row) return res.status(404).json({ error: "This timesheet no longer exists." });
    if (row.meta_json?.deletedAt) return res.status(410).json({ error: "This timesheet is in the Trash." });
    if (!isFinal(row)) return res.status(409).json({ error: "This timesheet is not finalized." });
    const doc = await docOf(row);
    doc.status = "draft";
    await reverseFinal(id, doc.siteId);
    const summary = await store.updateTimesheet(id, { meta_json: { ...docToMeta(doc), reopenedAt: new Date().toISOString(), reopenReason: reason } });
    audit({ ...actorOf(req, res), action: "timesheet.reopen", target: `timesheet:${id}`, detail: `${doc.label || doc.filename || "Timesheet"} · reason: ${reason}` });
    res.json(summary);
  }));

  // ── Previous finalized period (variance) ─────────────────────────────────
  app.get("/api/timesheets/:id/pay/previous", g(async (req, res) => {
    const id = String(req.params.id);
    const row = await (await db()).getTimesheet(id);
    if (!row) return res.status(404).json({ error: "This timesheet no longer exists." });
    const doc = await docOf(row);
    const q = z.object({ start: iso.optional() }).parse(req.query);
    const start = q.start || row.period_start || doc.periodStart;
    if (!start) return res.json(null);
    const prev = (await finalizedFor(doc.siteId, id)).filter((t) => t.periodEnd && t.periodEnd < start).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
    if (!prev) return res.json(null);
    res.json({ id: prev.id, label: prev.label, periodStart: prev.periodStart, periodEnd: prev.periodEnd, ...snapshotOf(prev.result) });
  }));

  // ── Location pay settings ───────────────────────────────────────────────
  const site404 = async (req: Request, res: Response) => {
    const site = await settings.getSite(String(req.params.id));
    if (!site) { res.status(404).json({ error: "Location not found." }); return null; }
    return site;
  };

  app.get("/api/sites/:id/pay/settings", g(async (req, res) => {
    const site = await site404(req, res);
    if (site) res.json(await getPaySettings(site.id));
  }));

  const settingsPatch = z.object({
    cash: cashConfigSchema.optional(),
    holidays: z.array(holidaySchema).max(400).optional(),
    recurring: z.array(recurringItemSchema).max(2000).optional(),
    accounts: accountsSchema.optional(),
    tipPoints: z.record(z.string().max(64), z.coerce.number().min(0).max(100)).optional(),
  }).strict();
  app.put("/api/sites/:id/pay/settings", g(async (req, res) => {
    const site = await site404(req, res);
    if (!site) return;
    const patch = settingsPatch.parse(req.body ?? {});
    if (patch.cash) patch.cash.denominations = [...new Set(patch.cash.denominations.map((d) => Math.round(d * 100) / 100))].sort((a, b) => b - a);
    if (patch.holidays) {
      const dates = new Set<string>();
      for (const h of patch.holidays) { if (dates.has(h.date)) return res.status(400).json({ error: `Two holidays on ${h.date}. Keep one per day.` }); dates.add(h.date); }
    }
    const next = await withLock(PAY_KEYS.settings(site.id), async () => {
      const merged = paySettingsSchema.parse({ ...(await getPaySettings(site.id)), ...patch });
      await writeJson(PAY_KEYS.settings(site.id), merged);
      return merged;
    });
    audit({ ...actorOf(req, res), action: "pay.settings", target: `site:${site.id}`, detail: Object.keys(patch).join(", ") });
    res.json(next);
  }));

  app.get("/api/sites/:id/pay/context", g(async (req, res) => {
    const site = await site404(req, res);
    if (!site) return;
    const q = z.object({ timesheetId: z.string().max(64).optional() }).parse(req.query);
    res.json(await payContext(site.id, q.timesheetId));
  }));

  // ── Advances and loans ──────────────────────────────────────────────────
  const withBalance = (a: Advance) => ({ ...a, ...advanceBalance(a) });
  app.get("/api/sites/:id/pay/advances", g(async (req, res) => {
    const site = await site404(req, res);
    if (site) res.json((await getAdvances(site.id)).map(withBalance));
  }));

  app.post("/api/sites/:id/pay/advances", g(async (req, res) => {
    const site = await site404(req, res);
    if (!site) return;
    const input = advanceInputSchema.parse(req.body ?? {});
    if (input.mode === "per_period" && !(input.perPeriod > 0)) return res.status(400).json({ error: "Enter how much to take back each pay period." });
    const user = currentUser(res)!;
    const adv = advanceSchema.parse({
      ...input, employee: normalizeName(input.employee), id: `adv_${randomUUID().slice(0, 10)}`, createdAt: new Date().toISOString(),
      createdBy: user.displayName || user.username, repayments: [],
    });
    await withLock(PAY_KEYS.advances(site.id), async () => writeJson(PAY_KEYS.advances(site.id), [...(await getAdvances(site.id)), adv]));
    audit({ ...actorOf(req, res), action: "pay.advance.create", target: `site:${site.id}`, detail: `${adv.employee} · ${adv.amount.toFixed(2)} on ${adv.date}` });
    res.json(withBalance(adv));
  }));

  app.patch("/api/sites/:id/pay/advances/:aid", g(async (req, res) => {
    const site = await site404(req, res);
    if (!site) return;
    const patch = z.object({ cancelled: z.boolean().optional(), note: z.string().max(200).optional() }).parse(req.body ?? {});
    const aid = String(req.params.aid);
    const updated = await withLock(PAY_KEYS.advances(site.id), async () => {
      const list = await getAdvances(site.id);
      const i = list.findIndex((a) => a.id === aid);
      if (i < 0) return null;
      const a = { ...list[i] };
      if (patch.note !== undefined) a.note = patch.note;
      if (patch.cancelled !== undefined) a.cancelledAt = patch.cancelled ? new Date().toISOString() : null;
      list[i] = a;
      await writeJson(PAY_KEYS.advances(site.id), list);
      return a;
    });
    if (!updated) return res.status(404).json({ error: "Advance not found." });
    audit({ ...actorOf(req, res), action: patch.cancelled ? "pay.advance.writeoff" : "pay.advance.update", target: `site:${site.id}`, detail: `${updated.employee} · ${updated.amount.toFixed(2)}` });
    res.json(withBalance(updated));
  }));

  app.delete("/api/sites/:id/pay/advances/:aid", g(async (req, res) => {
    const site = await site404(req, res);
    if (!site) return;
    const aid = String(req.params.aid);
    const r = await withLock(PAY_KEYS.advances(site.id), async () => {
      const list = await getAdvances(site.id);
      const a = list.find((x) => x.id === aid);
      if (!a) return "missing" as const;
      if (a.repayments.length) return "used" as const;
      await writeJson(PAY_KEYS.advances(site.id), list.filter((x) => x.id !== aid));
      return a;
    });
    if (r === "missing") return res.status(404).json({ error: "Advance not found." });
    if (r === "used") return res.status(409).json({ error: "Repayments were already taken from finalized timesheets. Write the advance off instead." });
    audit({ ...actorOf(req, res), action: "pay.advance.delete", target: `site:${site.id}`, detail: `${r.employee} · ${r.amount.toFixed(2)}` });
    res.json({ ok: true });
  }));

  // ── Saved rates with an effective date ──────────────────────────────────
  app.get("/api/sites/:id/pay/rates", g(async (req, res) => {
    const site = await site404(req, res);
    if (site) res.json(await getRateHistory(site.id));
  }));

  app.put("/api/sites/:id/pay/rates", g(async (req, res) => {
    const site = await site404(req, res);
    if (!site) return;
    const body = z.object({ effectiveFrom: iso.or(z.literal("")).default(""), entries: z.array(employeeConfigSchema).max(2000) }).parse(req.body ?? {});
    const categories = await settings.getCategories();
    const result = await withLock(PAY_KEYS.rates(site.id), async () => {
      const profile = await settings.getWageProfile(site.id);
      const byKey = new Map<string, EmployeeConfig>(profile.map((e) => [employeeKey(e.name), e]));
      const hist = await getRateHistory(site.id);
      let changed = 0;
      for (const e of body.entries) {
        const k = employeeKey(e.name);
        if (!k) continue;
        const old = byKey.get(k);
        const before = hist[k]?.history.length ?? 0;
        hist[k] = recordRateChange(hist[k], normalizeName(e.name), old ? explicitRates(old, categories) : null, explicitRates(e, categories), body.effectiveFrom);
        if ((hist[k].history.length ?? 0) !== before) changed++;
        byKey.set(k, e);
      }
      const saved = await settings.saveWageProfile(site.id, [...byKey.values()]);
      await writeJson(PAY_KEYS.rates(site.id), hist);
      return { saved, changed };
    });
    audit({ ...actorOf(req, res), action: "wages.update", target: `site:${site.id}`, detail: `${result.saved} saved${body.effectiveFrom ? `, effective ${body.effectiveFrom}` : ""}` });
    res.json(result);
  }));

  // ── Year to date ────────────────────────────────────────────────────────
  app.get("/api/sites/:id/pay/ytd", g(async (req, res) => {
    const site = await site404(req, res);
    if (!site) return;
    const user = currentUser(res)!;
    if (!canAccessSite(user, site.id)) return res.status(403).json({ error: "Your account doesn't have access to this location." });
    const q = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional(), excludeId: z.string().max(64).optional() }).parse(req.query);
    const year = q.year ?? new Date().getFullYear();
    const list = (await finalizedFor(site.id, q.excludeId)).filter((t) => t.periodEnd.slice(0, 4) === String(year));
    res.json({ year, timesheets: list.length, rows: ytdTotals(list.map((t) => t.result)) });
  }));
}
