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
import { currentUser, requireAuth, resetTagCache } from "./auth";
import { authorize, csrfGuard } from "./access";
import { AUDIT_PREFIX, auditTrail } from "./audit";
import { registerAuthRoutes } from "./authRoutes";
import { USERS_KEY, canAccessSite, toPublic } from "./users";
import { backupPath, listBackups, readBackup, runBackup } from "./backup";
import { listLocations, pullTimecards } from "./square";
import { extractPdfText } from "./pdf";
import { invalidateEmployeeCache } from "./employees";
import { type Punch, punchSchema } from "@shared/punches";
import { kioskHostGuard, registerKioskRoutes, registerTimeClockAdminRoutes } from "./kiosk";
import { registerScheduleRoutes } from "./schedule";
import { registerTimeclockRoutes } from "./timeclock";
import { registerKioskFeatureAdminRoutes } from "./kioskFeatures";

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

export const TRASH_DAYS = 30;

/** Move a timesheet to the Trash (kept for TRASH_DAYS, then removed). */
async function moveToTrash(id: string): Promise<boolean> {
  const store = await db();
  const cur = await store.getTimesheet(id);
  if (!cur) return false;
  if (cur.meta_json?.deletedAt) return true;
  const doc = rowToDoc(cur, ctxFor(await settings.getSites(), cur.site_id));
  await store.updateTimesheet(id, { site_id: doc.siteId, meta_json: { ...docToMeta(doc), deletedAt: new Date().toISOString() } });
  return true;
}

/** Retention never deletes outright: the oldest drafts go to the Trash. */
async function applyRetention(siteId: string, keepId: string) {
  const prefs = await settings.getPrefs();
  if (!prefs.retentionPerSite) return 0;
  const store = await db();
  const def = await settings.defaultSiteId();
  const list = (await store.listTimesheets()).filter((t) => !t.deletedAt && (t.siteId ?? def) === siteId && t.status !== "final");
  const extra = list.slice(prefs.retentionPerSite).filter((t) => t.id !== keepId);
  for (const t of extra) await moveToTrash(t.id);
  return extra.length;
}

/** Permanently remove timesheets that have been in the Trash longer than TRASH_DAYS. */
export async function purgeTrash(now = Date.now()): Promise<number> {
  const store = await db();
  const cutoff = now - TRASH_DAYS * 86_400_000;
  const old = (await store.listTimesheets()).filter((t) => t.deletedAt && Date.parse(t.deletedAt) < cutoff);
  for (const t of old) await store.deleteTimesheet(t.id);
  if (old.length) console.log(`[trash] permanently removed ${old.length} timesheet(s) older than ${TRASH_DAYS} days`);
  return old.length;
}

const restoreSchema = z.object({
  app: z.literal("payroll-admin"),
  settings: z.array(z.object({ key: z.string().min(1).max(200), value: z.string() })).default([]),
  timesheets: z.array(z.object({
    id: z.string().min(1).max(64).optional(),
    filename: z.string().max(500).default(""),
    custom_label: z.string().max(500).nullable().default(null),
    period_start: z.string().max(40).nullable().default(null),
    period_end: z.string().max(40).nullable().default(null),
    employee_count: z.coerce.number().default(0),
    total_pay: z.coerce.number().default(0),
    result_json: z.any().default(null),
    wages_json: z.any().default(null),
    manual_employees_json: z.any().default(null),
    csv_data: z.string().nullable().default(null),
    site_id: z.string().max(100).nullable().default(null),
    meta_json: z.any().default(null),
    created_at: z.string().optional(),
  }).passthrough()).default([]),
  punches: z.array(z.any()).default([]),
});

/** Restore an export. The current user accounts (and activity log) are always kept. */
async function restoreFrom(raw: unknown) {
  const body = restoreSchema.parse(raw);
  await runBackup("pre-restore").catch((err) => {
    throw Object.assign(new Error(`Restore cancelled: could not back up the current data first (${err.message}).`), { status: 500 });
  });
  const store = await db();
  const keep = new Set(["password_hash", USERS_KEY]);
  const result = await store.importAll({
    settings: body.settings.filter((x) => !keep.has(x.key) && !x.key.startsWith(AUDIT_PREFIX)),
    timesheets: body.timesheets.map(({ updated_at: _u, ...rest }: any) => rest),
  });
  // Time-clock punches: inserted by id, so restoring twice adds nothing.
  let punches = 0;
  for (const raw of body.punches) {
    const p = punchSchema.safeParse(raw);
    if (p.success && (await store.insertPunch(p.data as Punch)).created) punches++;
  }
  settings.invalidateSettingsCache();
  invalidateEmployeeCache();
  resetTagCache();
  return { ...result, punches };
}

export function registerRoutes(app: Express) {
  // /live checks its own short-lived ticket (EventSource cannot send headers).
  const PUBLIC = new Set(["/health", "/auth/status", "/auth/login", "/auth/setup", "/auth/logout", "/live"]);
  app.use(kioskHostGuard()); // KIOSK_HOST: serve only the kiosk on that hostname
  // Never cache API responses (payroll data) in browsers or at the Cloudflare edge.
  app.use("/api", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  // /api/kiosk/*: device-token auth (a custom header, so not exposed to CSRF), never the admin session
  registerKioskRoutes(app);
  app.use("/api", csrfGuard());
  app.use("/api", requireAuth(PUBLIC));
  app.use("/api", authorize(PUBLIC));
  app.use("/api", auditTrail());

  // ── Public ──────────────────────────────────────────────────────────────────
  app.get("/api/health", h(async (_req, res) => {
    const st = dbStatus();
    res.json({ ok: true, db: { connected: st.connected, kind: st.kind } });
  }));

  // ── Sign-in, users, activity log ────────────────────────────────────────────
  registerAuthRoutes(app);

  // ── Bootstrap ───────────────────────────────────────────────────────────────
  app.get("/api/bootstrap", h(async (_req, res) => {
    const user = currentUser(res)!;
    const [allSites, allCategories, prefs] = await Promise.all([settings.getSites(), settings.getCategories(), settings.getPrefs()]);
    const sites = allSites.filter((s) => canAccessSite(user, s.id));
    const categories = allCategories.filter((c) => !c.siteId || canAccessSite(user, c.siteId));
    const squareConnected: Record<string, boolean> = {};
    await Promise.all(sites.map(async (s) => { squareConnected[s.id] = !!(await settings.getSquareToken(s.id)); }));
    const def = await settings.defaultSiteId();
    res.json({ sites, categories, prefs, squareConnected, defaultSiteId: sites.some((s) => s.id === def) ? def : sites[0]?.id ?? def, db: dbStatus(), user: toPublic(user) });
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
  app.get("/api/timesheets", h(async (req, res) => {
    const store = await db();
    const def = await settings.defaultSiteId();
    const trash = req.query.trash === "1";
    const user = currentUser(res)!;
    const list = (await store.listTimesheets()).filter((t) => (trash ? !!t.deletedAt : !t.deletedAt) && canAccessSite(user, t.siteId ?? def));
    // Keep the cache to rows that still exist in their current version.
    const live = new Set(list.map((t) => `${t.id}|${t.updatedAt}`));
    for (const k of legacyCache.keys()) if (!live.has(k) && !trash) legacyCache.delete(k);
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
    res.json({ id: row.id, doc, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.meta_json?.deletedAt ?? null, legacy: !(row.meta_json?.version >= 2) });
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
    if (cur.meta_json?.deletedAt) return res.status(410).json({ error: "This timesheet is in the Trash. Restore it to make changes." });
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
    if (cur.meta_json?.deletedAt) return res.status(410).json({ error: "This timesheet is in the Trash. Restore it to make changes." });
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

  // Delete moves to the Trash. `?permanent=1` removes a timesheet that is already in the Trash.
  app.delete("/api/timesheets/:id", h(async (req, res) => {
    const store = await db();
    const id = String(req.params.id);
    if (req.query.permanent === "1") {
      const cur = await store.getTimesheet(id);
      if (!cur) return res.json({ ok: false });
      if (!cur.meta_json?.deletedAt) return res.status(409).json({ error: "Move the timesheet to the Trash first." });
      return res.json({ ok: await store.deleteTimesheet(id) });
    }
    res.json({ ok: await moveToTrash(id), trashed: true, trashDays: TRASH_DAYS });
  }));

  app.post("/api/timesheets/:id/restore", h(async (req, res) => {
    const store = await db();
    const id = String(req.params.id);
    const cur = await store.getTimesheet(id);
    if (!cur) return res.status(404).json({ error: "This timesheet no longer exists." });
    if (!cur.meta_json?.deletedAt) return res.json(await store.updateTimesheet(id, {}));
    const { deletedAt: _d, ...meta } = cur.meta_json;
    res.json(await store.updateTimesheet(id, { meta_json: meta }));
  }));

  app.delete("/api/trash", h(async (_req, res) => {
    const store = await db();
    const trashed = (await store.listTimesheets()).filter((t) => t.deletedAt);
    for (const t of trashed) await store.deleteTimesheet(t.id);
    res.json({ removed: trashed.length });
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
    res.json(result);
  }));
  app.post("/api/database/reconnect", h(async (_req, res) => {
    await retryInit();
    res.json(dbStatus());
  }));

  // ── Backups ─────────────────────────────────────────────────────────────────
  app.get("/api/backup", h(async (req, res) => {
    const includeSecrets = req.query.secrets === "1";
    const store = await db();
    const secret = (k: string) => k === "password_hash" || k === USERS_KEY || k.startsWith("square_token:") || k.startsWith("kiosk_manager_pin:") || k === "square_access_token";
    const all = await store.allSettings();
    res.json({
      app: "payroll-admin", version: 2, exportedAt: new Date().toISOString(),
      settings: all.filter((s) => includeSecrets || !secret(s.key)),
      timesheets: await store.allTimesheets(),
      punches: await store.allPunches(),
    });
  }));
  app.post("/api/backup/restore", express.json({ limit: "100mb" }), h(async (req, res) => {
    res.json(await restoreFrom(req.body));
  }));

  // ── Automatic backups on the server ─────────────────────────────────────────
  app.get("/api/backups", h(async (_req, res) => {
    res.json(listBackups());
  }));
  app.post("/api/backups", h(async (_req, res) => {
    res.json(await runBackup("manual"));
  }));
  app.get("/api/backups/:name", h(async (req, res) => {
    const p = backupPath(String(req.params.name));
    if (!p) return res.status(404).json({ error: "Backup not found." });
    res.download(p);
  }));
  app.post("/api/backups/:name/restore", h(async (req, res) => {
    res.json(await restoreFrom(readBackup(String(req.params.name))));
  }));

  registerTimeClockAdminRoutes(app); // employees, punches, kiosk devices, live updates
  registerScheduleRoutes(app); // schedule, time off, late alerts, labor vs. sales, forecast
  registerTimeclockRoutes(app); // auto clock-out, fix punches, approvals, overtime watch, pre-payroll checklist
  registerKioskFeatureAdminRoutes(app); // kiosk extras: stations, shift notes, fix requests, punch photos

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
