import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  type TimesheetDoc, categorySchema, databaseConfigSchema, employeeConfigSchema, prefsSchema, siteInputSchema, siteRulesSchema, timesheetDocSchema,
} from "@shared/schema";
import { computePayroll } from "@shared/engine";
import { docToMeta, rowToDoc, shiftsToCsv } from "@shared/legacy";
import { parseScheduleItems } from "@shared/importers/schedule";
import { configIsPersistent, managedSupabase, loadConfig } from "./config";
import { db, dbStatus, retryInit, switchDatabase, testDatabase } from "./db";
import { SETUP_SQL, type TimesheetRow } from "./db/types";
import * as settings from "./settings";
import { checkPassword, currentPasswordHash, issueToken, loginThrottle, recordLogin, requireAuth, resetTagCache, setPassword, verifyToken } from "./auth";
import { listLocations, pullTimecards } from "./square";
import { extractPdfText } from "./pdf";

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function ctxFor(sites: Awaited<ReturnType<typeof settings.getSites>>, siteId: string | null | undefined) {
  const site = sites.find((s) => s.id === siteId) ?? sites.find((s) => s.id === settings.LEGACY_SITE_ID) ?? sites[0];
  return { defaultSiteId: site.id, rules: site.rules };
}

async function rowFromDoc(doc: TimesheetDoc) {
  const categories = await settings.getCategories();
  const result = computePayroll({ shifts: doc.shifts, employees: doc.employees, manualEmployees: doc.manualEmployees, categories, rules: doc.rules });
  return {
    filename: doc.filename || doc.label || "Timesheet",
    custom_label: doc.label || null,
    period_start: result.periodStart || doc.periodStart || null,
    period_end: result.periodEnd || doc.periodEnd || null,
    employee_count: result.totals.employees,
    total_pay: result.totals.totalPay,
    result_json: { periodStart: result.periodStart, periodEnd: result.periodEnd, employees: result.employees, totals: result.totals },
    wages_json: doc.employees,
    manual_employees_json: doc.manualEmployees,
    csv_data: shiftsToCsv(doc.shifts),
    site_id: doc.siteId,
    meta_json: docToMeta(doc),
  };
}

async function applyRetention(siteId: string, keepId: string) {
  const prefs = await settings.getPrefs();
  if (!prefs.retentionPerSite) return 0;
  const store = await db();
  const def = await settings.defaultSiteId();
  const list = (await store.listTimesheets()).filter((t) => (t.siteId ?? def) === siteId && t.status !== "final");
  const extra = list.slice(prefs.retentionPerSite).filter((t) => t.id !== keepId);
  for (const t of extra) await store.deleteTimesheet(t.id);
  return extra.length;
}

export function registerRoutes(app: Express) {
  const PUBLIC = new Set(["/health", "/auth/status", "/auth/login", "/auth/setup"]);
  app.use("/api", requireAuth(PUBLIC));

  // ── Public ──────────────────────────────────────────────────────────────────
  app.get("/api/health", h(async (_req, res) => {
    const st = dbStatus();
    res.json({ ok: true, db: { connected: st.connected, kind: st.kind } });
  }));

  app.get("/api/auth/status", h(async (req, res) => {
    const hash = await currentPasswordHash();
    let appName = "Payroll Admin";
    try { appName = (await settings.getPrefs()).appName; } catch { /* db down */ }
    const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
    res.json({ setupRequired: !hash, authenticated: await verifyToken(token), appName, db: dbStatus() });
  }));

  app.post("/api/auth/login", h(async (req, res) => {
    const ip = req.ip ?? "unknown";
    const blocked = loginThrottle(ip);
    if (blocked) return res.status(429).json({ error: blocked });
    const { password, remember } = z.object({ password: z.string().min(1).max(200), remember: z.boolean().optional() }).parse(req.body);
    const ok = await checkPassword(password);
    recordLogin(ip, ok);
    if (!ok) return res.status(401).json({ error: "Incorrect password." });
    let days = 30;
    try { days = (await settings.getPrefs()).sessionDays; } catch { /* default */ }
    res.json(await issueToken(remember === false ? 1 : days));
  }));

  app.post("/api/auth/setup", h(async (req, res) => {
    if (await currentPasswordHash()) return res.status(409).json({ error: "An administrator password is already set." });
    const { password } = z.object({ password: z.string().min(6, "Use at least 6 characters.").max(200) }).parse(req.body);
    await setPassword(password);
    resetTagCache();
    res.json(await issueToken(30));
  }));

  // ── Session & bootstrap ─────────────────────────────────────────────────────
  app.post("/api/auth/change-password", h(async (req, res) => {
    const { current, next } = z.object({ current: z.string().min(1), next: z.string().min(6, "Use at least 6 characters.").max(200) }).parse(req.body);
    if (!(await checkPassword(current))) return res.status(400).json({ error: "Current password is incorrect." });
    await setPassword(next);
    resetTagCache();
    res.json({ ...(await issueToken((await settings.getPrefs()).sessionDays)), message: "Password updated. Other devices have been signed out." });
  }));

  app.get("/api/bootstrap", h(async (_req, res) => {
    const [sites, categories, prefs] = await Promise.all([settings.getSites(), settings.getCategories(), settings.getPrefs()]);
    const squareConnected: Record<string, boolean> = {};
    await Promise.all(sites.map(async (s) => { squareConnected[s.id] = !!(await settings.getSquareToken(s.id)); }));
    res.json({ sites, categories, prefs, squareConnected, defaultSiteId: await settings.defaultSiteId(), db: dbStatus() });
  }));

  app.put("/api/prefs", h(async (req, res) => {
    res.json(await settings.savePrefs(prefsSchema.partial().parse(req.body)));
  }));

  // ── Sites ───────────────────────────────────────────────────────────────────
  app.post("/api/sites", h(async (req, res) => {
    const input = siteInputSchema.parse(req.body);
    res.json(await settings.createSite(input));
  }));
  app.put("/api/sites/:id", h(async (req, res) => {
    const patch = siteInputSchema.partial().parse(req.body);
    if (patch.rules) patch.rules = siteRulesSchema.parse({ ...((await settings.getSite(String(req.params.id)))?.rules ?? {}), ...patch.rules });
    const site = await settings.updateSite(String(req.params.id), patch as any);
    if (!site) return res.status(404).json({ error: "Location not found." });
    res.json(site);
  }));
  app.delete("/api/sites/:id", h(async (req, res) => {
    await settings.deleteSite(String(req.params.id));
    res.json({ ok: true });
  }));

  // ── Categories ──────────────────────────────────────────────────────────────
  app.put("/api/categories", h(async (req, res) => {
    const cats = z.array(categorySchema).max(500).parse(req.body);
    await settings.saveCategories(cats);
    res.json(cats);
  }));

  // ── Saved wage profiles ─────────────────────────────────────────────────────
  app.get("/api/sites/:id/wages", h(async (req, res) => {
    res.json(await settings.getWageProfile(String(req.params.id)));
  }));
  app.put("/api/sites/:id/wages", h(async (req, res) => {
    const entries = z.array(employeeConfigSchema).max(2000).parse(req.body);
    res.json({ saved: await settings.saveWageProfile(String(req.params.id), entries) });
  }));

  // ── Square ──────────────────────────────────────────────────────────────────
  app.put("/api/sites/:id/square", h(async (req, res) => {
    const { token } = z.object({ token: z.string().min(10).max(400) }).parse(req.body);
    const locations = await listLocations(token.trim());
    await settings.setSquareToken(String(req.params.id), token.trim());
    const site = await settings.getSite(String(req.params.id));
    if (site && !site.squareLocationId && locations[0]) {
      await settings.updateSite(site.id, { squareLocationId: locations[0].id, squareLocationName: locations[0].name });
    }
    res.json({ connected: true, locations });
  }));
  app.delete("/api/sites/:id/square", h(async (req, res) => {
    await settings.setSquareToken(String(req.params.id), null);
    res.json({ connected: false });
  }));
  app.get("/api/sites/:id/square/locations", h(async (req, res) => {
    const token = await settings.getSquareToken(String(req.params.id));
    if (!token) return res.status(400).json({ error: "Square is not connected for this location." });
    res.json(await listLocations(token));
  }));
  app.get("/api/sites/:id/square/pull", h(async (req, res) => {
    const { start, end } = z.object({ start: iso, end: iso }).parse(req.query);
    if (end < start) return res.status(400).json({ error: "The end date is before the start date." });
    const site = await settings.getSite(String(req.params.id));
    if (!site) return res.status(404).json({ error: "Location not found." });
    const token = await settings.getSquareToken(site.id);
    if (!token) return res.status(400).json({ error: "Square is not connected for this location. Add a token in Settings → Locations." });
    res.json(await pullTimecards(token, { locationId: site.squareLocationId || undefined, start, end, timezone: site.rules.timezone }));
  }));

  // ── Import: schedule / time-entry PDFs ──────────────────────────────────────
  app.post("/api/import/pdf", express.raw({ type: ["application/pdf", "application/octet-stream"], limit: "25mb" }), h(async (req, res) => {
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length < 100) return res.status(400).json({ error: "Upload a PDF file." });
    if (buf.subarray(0, 1024).toString("latin1").indexOf("%PDF") < 0) return res.status(400).json({ error: "That file is not a PDF." });
    const q = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional(), weekStart: iso.optional(), weekStartsOn: z.coerce.number().int().min(0).max(6).optional() }).parse(req.query);
    let items;
    try { items = await extractPdfText(buf); } catch (err: any) {
      return res.status(400).json({ error: /password/i.test(err?.message ?? "") ? "This PDF is password protected." : "Could not read this PDF. It may be damaged." });
    }
    res.json(parseScheduleItems(items, q));
  }));

  // ── Timesheets ──────────────────────────────────────────────────────────────
  // Older (v1) rows stored M/D/YY periods that sort wrongly and totals from the old
  // engine. Derive correct values in memory (never written back until the user saves).
  const legacyCache = new Map<string, { periodStart: string | null; periodEnd: string | null; totalPay: number; employeeCount: number }>();
  app.get("/api/timesheets", h(async (_req, res) => {
    const store = await db();
    const def = await settings.defaultSiteId();
    const list = await store.listTimesheets();
    const isIso = (v: string | null) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v);
    const legacy = list.filter((t) => !isIso(t.periodStart) || !isIso(t.periodEnd));
    if (legacy.length) {
      const [sites, categories] = await Promise.all([settings.getSites(), settings.getCategories()]);
      await Promise.all(legacy.map(async (t) => {
        const key = `${t.id}|${t.updatedAt}`;
        if (legacyCache.has(key)) return;
        try {
          const row = await store.getTimesheet(t.id);
          if (!row) return;
          const doc = rowToDoc(row, ctxFor(sites, row.site_id));
          const r = computePayroll({ shifts: doc.shifts, employees: doc.employees, manualEmployees: doc.manualEmployees, categories, rules: doc.rules });
          legacyCache.set(key, { periodStart: r.periodStart || null, periodEnd: r.periodEnd || null, totalPay: r.totals.totalPay, employeeCount: r.totals.employees });
        } catch { /* keep stored values */ }
      }));
    }
    res.json(list.map((t) => ({ ...t, siteId: t.siteId ?? def, ...(legacyCache.get(`${t.id}|${t.updatedAt}`) ?? {}) })));
  }));

  app.get("/api/timesheets/:id", h(async (req, res) => {
    const store = await db();
    const row = await store.getTimesheet(String(req.params.id));
    if (!row) return res.status(404).json({ error: "This timesheet no longer exists." });
    const sites = await settings.getSites();
    const doc = rowToDoc(row, ctxFor(sites, row.site_id));
    res.json({ id: row.id, doc, createdAt: row.created_at, updatedAt: row.updated_at, legacy: !(row.meta_json?.version >= 2) });
  }));

  app.post("/api/timesheets", h(async (req, res) => {
    const doc = timesheetDocSchema.parse(req.body.doc);
    const store = await db();
    const summary = await store.insertTimesheet(await rowFromDoc(doc));
    const removed = await applyRetention(doc.siteId, summary.id);
    res.json({ ...summary, removedByRetention: removed });
  }));

  app.put("/api/timesheets/:id", h(async (req, res) => {
    const body = z.object({ doc: timesheetDocSchema, baseUpdatedAt: z.string().nullable().optional(), force: z.boolean().optional() }).parse(req.body);
    const store = await db();
    const id = String(req.params.id);
    const cur = await store.getTimesheet(id);
    if (!cur) return res.status(404).json({ error: "This timesheet was deleted." });
    if (!body.force && body.baseUpdatedAt && cur.updated_at && Date.parse(cur.updated_at) !== Date.parse(body.baseUpdatedAt)) {
      return res.status(409).json({ error: "This timesheet was changed somewhere else (another tab or device).", updatedAt: cur.updated_at });
    }
    const summary = await store.updateTimesheet(id, await rowFromDoc(body.doc));
    res.json(summary);
  }));

  app.patch("/api/timesheets/:id", h(async (req, res) => {
    const patch = z.object({ label: z.string().max(120).optional(), siteId: z.string().optional(), status: z.enum(["draft", "final"]).optional() }).parse(req.body);
    const store = await db();
    const id = String(req.params.id);
    const cur = await store.getTimesheet(id);
    if (!cur) return res.status(404).json({ error: "This timesheet no longer exists." });
    const update: Partial<TimesheetRow> = {};
    if (patch.label !== undefined) update.custom_label = patch.label.trim() || null;
    if (patch.siteId !== undefined || patch.status !== undefined) {
      const sites = await settings.getSites();
      if (patch.siteId && !sites.some((s) => s.id === patch.siteId)) return res.status(400).json({ error: "Unknown location." });
      const doc = rowToDoc(cur, ctxFor(sites, cur.site_id));
      if (patch.siteId) doc.siteId = patch.siteId;
      if (patch.status) doc.status = patch.status;
      Object.assign(update, { site_id: doc.siteId, meta_json: docToMeta(doc) });
    }
    res.json(await store.updateTimesheet(id, update));
  }));

  app.post("/api/timesheets/:id/duplicate", h(async (req, res) => {
    const store = await db();
    const cur = await store.getTimesheet(String(req.params.id));
    if (!cur) return res.status(404).json({ error: "This timesheet no longer exists." });
    const doc = rowToDoc(cur, ctxFor(await settings.getSites(), cur.site_id));
    doc.label = `${doc.label || doc.filename || "Timesheet"} (copy)`;
    doc.status = "draft";
    res.json(await store.insertTimesheet(await rowFromDoc(doc)));
  }));

  app.delete("/api/timesheets/:id", h(async (req, res) => {
    const store = await db();
    const ok = await store.deleteTimesheet(String(req.params.id));
    res.json({ ok });
  }));

  // ── Database ────────────────────────────────────────────────────────────────
  app.get("/api/database", h(async (_req, res) => {
    const st = dbStatus();
    let health = null;
    try { health = await (await db()).health(); } catch (err: any) { health = { ok: false, error: err.message }; }
    const cfg = loadConfig().database;
    const managed = managedSupabase();
    res.json({
      status: st,
      health,
      current: cfg?.kind === "supabase" ? { kind: "supabase", url: cfg.url, keyHint: `…${cfg.key.slice(-4)}` } : st.config,
      managedAvailable: !!managed,
      managedLabel: managed?.label ?? null,
      persistent: configIsPersistent(),
      setupSql: SETUP_SQL,
    });
  }));
  app.post("/api/database/test", h(async (req, res) => {
    const cfg = databaseConfigSchema.parse(req.body.config);
    res.json(await testDatabase(cfg));
  }));
  app.post("/api/database/switch", h(async (req, res) => {
    const { config, copyData } = z.object({ config: databaseConfigSchema, copyData: z.boolean().default(false) }).parse(req.body);
    const result = await switchDatabase(config, { copyData });
    settings.invalidateSettingsCache();
    resetTagCache();
    await settings.getSites();
    res.json({ ...result, ...(await issueToken((await settings.getPrefs()).sessionDays)) });
  }));
  app.post("/api/database/reconnect", h(async (_req, res) => {
    await retryInit();
    res.json(dbStatus());
  }));

  // ── Backups ─────────────────────────────────────────────────────────────────
  app.get("/api/backup", h(async (req, res) => {
    const includeSecrets = req.query.secrets === "1";
    const store = await db();
    const secret = (k: string) => k === "password_hash" || k.startsWith("square_token:") || k === "square_access_token";
    const all = await store.allSettings();
    res.json({
      app: "payroll-admin", version: 2, exportedAt: new Date().toISOString(),
      settings: all.filter((s) => includeSecrets || !secret(s.key)),
      timesheets: await store.allTimesheets(),
    });
  }));
  app.post("/api/backup/restore", express.json({ limit: "60mb" }), h(async (req, res) => {
    const body = z.object({
      app: z.literal("payroll-admin"),
      settings: z.array(z.object({ key: z.string(), value: z.string() })).default([]),
      timesheets: z.array(z.record(z.string(), z.any())).default([]),
    }).parse(req.body);
    const store = await db();
    for (const s of body.settings) await store.setSetting(s.key, s.value);
    let n = 0;
    for (const t of body.timesheets) {
      const { updated_at: _u, ...rest } = t as any;
      await store.insertTimesheet(rest);
      n++;
    }
    settings.invalidateSettingsCache();
    resetTagCache();
    res.json({ settings: body.settings.length, timesheets: n });
  }));

  // ── Errors ──────────────────────────────────────────────────────────────────
  app.use("/api", (_req: Request, res: Response) => res.status(404).json({ error: "Not found." }));
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof z.ZodError) {
      const first = err.issues[0];
      return res.status(400).json({ error: first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input.", details: err.issues.slice(0, 5) });
    }
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "That file is too large." });
    const status = Number(err?.status) || 500;
    if (status >= 500) console.error("[api]", err);
    res.status(status).json({ error: err?.message || "Something went wrong." });
  });
}
