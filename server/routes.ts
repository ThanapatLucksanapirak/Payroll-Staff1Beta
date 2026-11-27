import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { parsePatch } from "@shared/patch";
import { z } from "zod";
import {
  type TimesheetDoc, categorySchema, databaseConfigSchema, employeeConfigSchema, prefsSchema, siteInputSchema, siteRulesSchema, timesheetDocSchema,
} from "@shared/schema";
import { computePayroll } from "@shared/engine";
import { computeTimesheet } from "@shared/payExtras";
import { docToMeta, rowToDoc, shiftsToCsv } from "@shared/legacy";
import { parseScheduleItems } from "@shared/importers/schedule";
import { configIsPersistent, managedSupabase, loadConfig } from "./config";
import { db, dbStatus, retryInit, switchDatabase, testDatabase } from "./db";
import { maintenanceGate, withMaintenance } from "./maintenance";
import { SETUP_SQL, type TimesheetRow } from "./db/types";
import * as settings from "./settings";
import { currentUser, requireAuth, resetTagCache } from "./auth";
import { authorize, csrfGuard } from "./access";
import { AUDIT_PREFIX, auditTrail } from "./audit";
import { registerAuthRoutes } from "./authRoutes";
import { registerUpdateRoutes } from "./updates";
import { registerAboutRoutes } from "./about";
import { USERS_KEY, canAccessSite, toPublic } from "./users";
import { NEVER_BACKED_UP, backupPath, listBackups, readBackup, runBackup } from "./backup";
import { listLocations, pullTimecards } from "./square";
import { extractPdfText } from "./pdf";
import { invalidateEmployeeCache } from "./employees";
import { type Punch, punchSchema } from "@shared/punches";
import { invalidateDeviceCache, kioskHostGuard, registerKioskRoutes, registerTimeClockAdminRoutes } from "./kiosk";
import { registerScheduleRoutes } from "./schedule";
import { registerTimeclockRoutes } from "./timeclock";
import { registerKioskFeatureAdminRoutes } from "./kioskFeatures";
import { registerFaceRoutes } from "./faceData";
import { registerAndroidRoutes } from "./android";
import { registerPayRoutes } from "./pay";
import { registerPermissionRoutes } from "./permissions";
import { TWO_FACTOR_PUBLIC, registerTwoFactorRoutes } from "./twofactor";
import { registerOffsiteRoutes } from "./offsite";
import { registerPortalAdminRoutes, registerPortalRoutes } from "./portal";
import { registerEmailRoutes } from "./email";
import { registerGoogleEmailRoutes } from "./emailGoogle";
import { registerShareRoutes } from "./share";
import { getPublishedMap, invalidatePublishedCache, publishedRecord, registerPublishRoutes } from "./publish";

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function ctxFor(sites: Awaited<ReturnType<typeof settings.getSites>>, siteId: string | null | undefined) {
  const site = sites.find((s) => s.id === siteId) ?? sites.find((s) => s.id === settings.LEGACY_SITE_ID) ?? sites[0];
  return { defaultSiteId: site.id, rules: site.rules };
}

async function rowFromDoc(doc: TimesheetDoc) {
  const categories = await settings.getCategories();
  const result = computeTimesheet(doc, categories);
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

/**
 * Restore an export: afterwards the data matches the backup exactly (timesheets
 * and settings added since are removed, edited punches go back). The current
 * user accounts, activity log, manager PINs, email settings and paired kiosk
 * devices are always kept, and so are Square tokens when the file was downloaded
 * without them.
 */
const NOT_A_BACKUP = "This file isn't a Payroll Admin backup. Use a file from Settings → Data → Download backup. Nothing was restored.";

async function restoreFrom(raw: unknown, opts: { allowEmpty?: boolean } = {}) {
  if (!raw || typeof raw !== "object" || (raw as any).app !== "payroll-admin") throw Object.assign(new Error(NOT_A_BACKUP), { status: 400 });
  const parsed = restoreSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw Object.assign(new Error(`This backup file is damaged or was edited${first ? ` (at ${first.path.slice(0, 3).join(".") || "the top"})` : ""}, so nothing was restored. Use a file from Download backup.`), { status: 400 });
  }
  const body = parsed.data;
  // A real export always has both lists; a file missing them would empty the database.
  const r0 = raw as any;
  if (!Array.isArray(r0?.settings) || !Array.isArray(r0?.timesheets) || !r0.settings.length) {
    throw Object.assign(new Error("That file isn't a complete backup (it has no settings or timesheets list), so nothing was restored."), { status: 400 });
  }
  // Every timesheet in a real backup has its id. One without (e.g. {"nonsense":true}) would
  // restore as a blank row in place of the real ones: refuse the whole file instead.
  const noId = body.timesheets.filter((t: any) => typeof t.id !== "string" || !t.id.trim()).length;
  if (noId) {
    throw Object.assign(new Error(`Nothing was restored: ${noId} of ${body.timesheets.length} timesheets in that file have no id, so the file isn't a backup from this app or was edited. Your current data is unchanged.`), { status: 400 });
  }
  const hasPunches = !!raw && typeof raw === "object" && Array.isArray((raw as any).punches);
  const punches: Punch[] = [];
  let badPunches = 0;
  let firstProblem = "";
  for (const r of body.punches) {
    const p = punchSchema.safeParse(r);
    if (p.success) punches.push(p.data as Punch);
    else { badPunches++; firstProblem ||= p.error.issues[0] ? `${p.error.issues[0].path.join(".") || "punch"}: ${p.error.issues[0].message}` : ""; }
  }
  // Restore replaces every punch, so a skipped row would be lost for good: refuse instead.
  if (badPunches) {
    throw Object.assign(new Error(`Nothing was restored: ${badPunches} of ${body.punches.length} time clock punches in that file can't be read${firstProblem ? ` (first problem: ${firstProblem})` : ""}. Your current data is unchanged.`), { status: 400 });
  }
  return withMaintenance("restore", () => restoreChecked(body, punches, hasPunches, opts));
}

/** The rest of a restore, with other changes paused (see maintenance.ts). */
async function restoreChecked(body: z.infer<typeof restoreSchema>, punches: Punch[], hasPunches: boolean, opts: { allowEmpty?: boolean }) {
  // An empty list replaces everything with nothing. A real backup of a store with
  // data never has one, so ask first (the app shows what would be deleted).
  if (!opts.allowEmpty) {
    const cur = await db();
    const haveTimesheets = (await cur.listTimesheets()).length;
    const havePunches = hasPunches && !punches.length ? (await cur.allPunches()).length : 0;
    const emptyTimesheets = !body.timesheets.length && haveTimesheets > 0;
    if (emptyTimesheets || havePunches > 0) {
      const lost = [emptyTimesheets ? (haveTimesheets === 1 ? "your 1 timesheet" : `all ${haveTimesheets} timesheets`) : "", havePunches ? (havePunches === 1 ? "your 1 time clock punch" : `all ${havePunches} time clock punches`) : ""].filter(Boolean).join(" and ");
      throw Object.assign(new Error(`This backup has no ${[emptyTimesheets ? "timesheets" : "", havePunches ? "punches" : ""].filter(Boolean).join(" or ")}, so restoring it would delete ${lost}. Nothing was restored.`), {
        status: 409, code: "empty_lists", wouldDelete: { timesheets: emptyTimesheets ? haveTimesheets : 0, punches: havePunches },
      });
    }
  }
  const pre = await runBackup("pre-restore").catch((err) => {
    throw Object.assign(new Error(`Restore cancelled: could not back up the current data first (${err.message}).`), { status: 500 });
  });
  const store = await db();
  // Square tokens are left out of default downloads: keep today's unless the file carries its own.
  const isSquareToken = (k: string) => k.startsWith("square_token:") || k === "square_access_token";
  const fileHasSquare = body.settings.some((x) => isSquareToken(x.key));
  // Paired kiosk devices always stay as they are now, so a restore can't bring back a removed device.
  const keepSetting = (k: string) => k === "password_hash" || k === USERS_KEY || k === "revoked_sessions" || k === "kiosk_devices" || k.startsWith(AUDIT_PREFIX) || k.startsWith("kiosk_manager_pin:") || k.startsWith("email:") || (isSquareToken(k) && !fileHasSquare) || NEVER_BACKED_UP(k);
  let result: Awaited<ReturnType<typeof store.importAll>>;
  try {
    result = await store.importAll({
      settings: body.settings.filter((x) => !NEVER_BACKED_UP(x.key)),
      timesheets: body.timesheets.map(({ updated_at: _u, ...rest }: any) => rest),
      // Backups from before the time clock have no punches: leave today's alone.
      punches: hasPunches ? punches : undefined,
    }, { replace: true, keepSetting });
  } catch (err: any) {
    settings.invalidateSettingsCache();
    invalidatePublishedCache();
    invalidateEmployeeCache();
    invalidateDeviceCache();
    resetTagCache();
    const preName = (pre?.find((f) => f.kind === "export") ?? pre?.[0])?.name;
    // SQLite restores in one transaction, so a failure changes nothing. Supabase
    // writes in several requests: everything in the file is written before
    // anything is deleted, so a failure part-way leaves extra rows, never missing ones.
    const partial = store.kind === "supabase";
    console.error(`[restore] ${partial ? "stopped part-way" : "failed"}:`, err?.message ?? err);
    throw Object.assign(new Error(partial
      ? `The restore stopped part-way (${err?.message ?? "database error"}), so some of your data may be from the backup and some from before. Run the same restore again to finish it.${preName ? ` Your data from just before is saved as ${preName}.` : ""}`
      : `Nothing was restored: the database refused the change (${err?.message ?? "database error"}). Your current data is unchanged.`), { status: partial ? 502 : 500, code: partial ? "partial_restore" : undefined });
  }
  settings.invalidateSettingsCache();
  invalidatePublishedCache();
  invalidateEmployeeCache();
  invalidateDeviceCache();
  resetTagCache();
  // Counts are what the file holds: settings kept as they are (accounts, devices…)
  // are still counted, and punches are null when the file has none, meaning "kept".
  return {
    settings: body.settings.filter((x) => !NEVER_BACKED_UP(x.key)).length,
    timesheets: result.timesheets,
    punches: hasPunches ? result.punches : null,
    punchesKept: !hasPunches,
  };
}

/**
 * Send `{...head, list1: [...], list2: [...]}` as JSON, one item at a time,
 * waiting for the socket to drain, so no full-size JSON string is built. A list may be a page-by-page async iterable; the other rows
 * are still in memory (the store loads them first).
 */
async function streamJson(res: Response, head: Record<string, unknown>, lists: Record<string, unknown[] | AsyncIterable<unknown[]>>) {
  res.status(200).setHeader("Content-Type", "application/json; charset=utf-8");
  const write = (chunk: string) => new Promise<void>((resolve, reject) => {
    if (res.destroyed) return reject(new Error("client went away"));
    if (res.write(chunk)) return resolve();
    const done = () => { res.off("close", gone); resolve(); };
    const gone = () => { res.off("drain", done); reject(new Error("client went away")); };
    res.once("drain", done);
    res.once("close", gone);
  });
  let buf = "";
  const add = async (s: string) => { buf += s; if (buf.length >= 64 * 1024) { const b = buf; buf = ""; await write(b); } };
  try {
    await add(JSON.stringify(head).slice(0, -1));
    for (const [name, items] of Object.entries(lists)) {
      await add(`,${JSON.stringify(name)}:[`);
      let n = 0;
      const pages: AsyncIterable<unknown[]> = Array.isArray(items) ? (async function* () { yield items; })() : items;
      for await (const page of pages) for (const item of page) await add((n++ ? "," : "") + JSON.stringify(item));
      await add("]");
    }
    res.end(buf + "}");
  } catch {
    res.destroy();
  }
}

/** The restore and switch routes themselves, and a read-only connection test, aren't paused. */
const MAINTENANCE_ROUTES = [/^\/backup\/restore\/?$/, /^\/backups\/[^/]+\/restore\/?$/, /^\/database\/(switch|test)\/?$/];

export function registerRoutes(app: Express) {
  // /live checks its own short-lived ticket (EventSource cannot send headers).
  const PUBLIC = new Set(["/health", "/auth/status", "/auth/login", "/auth/setup", "/auth/logout", "/live", "/email/google/callback", ...TWO_FACTOR_PUBLIC]);
  app.use(kioskHostGuard()); // KIOSK_HOST: serve only the kiosk on that hostname
  // While a restore or database switch runs, other changes (punches included) get a short 503 "try again"
  app.use("/api", maintenanceGate((p) => MAINTENANCE_ROUTES.some((r) => r.test(p))));
  registerAndroidRoutes(app); // /.well-known/assetlinks.json for the Android Time Clock app
  // Never cache API responses (payroll data) in browsers or at the Cloudflare edge.
  app.use("/api", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  // /api/kiosk/*: device-token auth (a custom header, so not exposed to CSRF), never the admin session
  registerKioskRoutes(app);
  registerPortalRoutes(app); // /api/portal/*: employee self-service with its own cookie and guard, never the admin session
  app.use("/api", csrfGuard());
  app.use("/api", requireAuth(PUBLIC));
  app.use("/api", authorize(PUBLIC));
  app.use("/api", auditTrail());
  registerPermissionRoutes(app); // role permissions; adds them to bootstrap/me and hides pay when needed
  registerPayRoutes(app, { rowFromDoc }); // pay extras, lock on finalized timesheets (before the timesheet routes)
  registerTwoFactorRoutes(app);
  registerOffsiteRoutes(app);
  registerEmailRoutes(app);
  registerGoogleEmailRoutes(app); // Settings → Email (owner / admin)
  registerPublishRoutes(app); // publish finalized payroll to accountants
  registerShareRoutes(app); // email finalized payroll PDFs to accountants

  // ── Public ──────────────────────────────────────────────────────────────────
  app.get("/api/health", h(async (_req, res) => {
    const st = dbStatus();
    res.json({ ok: true, db: { connected: st.connected, kind: st.kind } });
  }));

  // ── Sign-in, users, activity log ────────────────────────────────────────────
  registerAuthRoutes(app);
  registerUpdateRoutes(app); // "Update now" (admin only: not in the access policy)
  registerAboutRoutes(app); // Settings → About: installed version and history (admin only)

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
    res.json(await settings.savePrefs(parsePatch(prefsSchema, req.body)));
  }));

  // ── Sites ───────────────────────────────────────────────────────────────────
  // A time zone the server can't use would make every time on the location wrong.
  const checkTimezone = (tz: unknown) => {
    if (tz === undefined) return;
    try { new Intl.DateTimeFormat("en-US", { timeZone: String(tz) }); } catch {
      throw Object.assign(new Error(`"${String(tz).slice(0, 60)}" isn't a time zone this app knows. Pick one from the list, like America/New_York.`), { status: 400 });
    }
  };
  app.post("/api/sites", h(async (req, res) => {
    const input = siteInputSchema.parse(req.body);
    checkTimezone(input.rules?.timezone);
    res.json(await settings.createSite(input));
  }));
  app.put("/api/sites/:id", h(async (req, res) => {
    // Only the fields sent: renaming must not reset rules, time clock or archive state.
    const patch: any = parsePatch(siteInputSchema, req.body);
    // Merge only the rule fields actually sent (the parsed patch has every rule filled with its default).
    if (patch.rules) patch.rules = siteRulesSchema.parse({ ...((await settings.getSite(String(req.params.id)))?.rules ?? {}), ...(req.body.rules as object) });
    checkTimezone((req.body?.rules as any)?.timezone);
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
    const published = await getPublishedMap();
    const pub = (t: { id: string; status: string; deletedAt?: string | null }) => publishedRecord(published, t.id, t.status, t.deletedAt);
    const accountant = user.role === "accountant";
    // Accountants only see published payroll (and never the Trash).
    if (accountant && trash) return res.json([]);
    const list = (await store.listTimesheets()).filter((t) => (trash ? !!t.deletedAt : !t.deletedAt) && canAccessSite(user, t.siteId ?? def) && (!accountant || !!pub(t)));
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
    res.json(list.map((t) => ({ ...t, siteId: t.siteId ?? def, publishedAt: pub(t)?.at ?? null, ...(legacyCache.get(`${t.id}|${t.updatedAt}`) ?? {}) })));
  }));

  app.get("/api/timesheets/:id", h(async (req, res) => {
    const store = await db();
    const row = await store.getTimesheet(String(req.params.id));
    if (!row) return res.status(404).json({ error: "This timesheet no longer exists." });
    const sites = await settings.getSites();
    const doc = rowToDoc(row, ctxFor(sites, row.site_id));
    const published = publishedRecord(await getPublishedMap(), row.id, row.meta_json?.status, row.meta_json?.deletedAt);
    res.json({ id: row.id, doc, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.meta_json?.deletedAt ?? null, legacy: !(row.meta_json?.version >= 2), publishedAt: published?.at ?? null });
  }));

  app.post("/api/timesheets", h(async (req, res) => {
    const doc = { ...timesheetDocSchema.parse(req.body.doc), paidResult: undefined };
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
    // Only reachable while the stored timesheet is a draft (finalized ones are locked), so it has no paid totals yet.
    const summary = await store.updateTimesheet(id, await rowFromDoc({ ...body.doc, paidResult: undefined }));
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
    const result = await withMaintenance("switch", () => switchDatabase(config, { copyData }));
    settings.invalidateSettingsCache();
    invalidatePublishedCache();
    invalidateEmployeeCache();
    invalidateDeviceCache();
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
    const secret = (k: string) => k === "password_hash" || k === USERS_KEY || k.startsWith("square_token:") || k.startsWith("kiosk_manager_pin:") || k === "square_access_token" || k.startsWith("email:");
    const all = await store.allSettings();
    const timesheets = await store.allTimesheets();
    // Punches are read a page at a time where the store can (the biggest list).
    const punches = store.punchPages ? store.punchPages() : await store.allPunches();
    // Serialized row by row: one JSON.stringify of the whole database added a
    // full-size string (and its copies) on top of the loaded rows.
    await streamJson(res, { app: "payroll-admin", version: 2, exportedAt: new Date().toISOString() }, {
      settings: all.filter((s) => !NEVER_BACKED_UP(s.key) && (includeSecrets || !secret(s.key))),
      timesheets,
      punches,
    });
  }));
  app.post("/api/backup/restore", express.json({ limit: "100mb" }), h(async (req, res) => {
    res.json(await restoreFrom(req.body, { allowEmpty: req.query.allowEmpty === "1" }));
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
    res.json(await restoreFrom(readBackup(String(req.params.name)), { allowEmpty: req.query.allowEmpty === "1" }));
  }));

  registerTimeClockAdminRoutes(app); // employees, punches, kiosk devices, live updates
  registerScheduleRoutes(app); // schedule, time off, late alerts, labor vs. sales, forecast
  registerTimeclockRoutes(app); // auto clock-out, fix punches, approvals, overtime watch, pre-payroll checklist
  registerKioskFeatureAdminRoutes(app); // kiosk extras: stations, shift notes, fix requests, punch photos
  registerFaceRoutes(app); // face recognition: consent, reference photos, photo gallery
  registerPortalAdminRoutes(app); // employee portal on/off per location

  // ── Errors ──────────────────────────────────────────────────────────────────
  app.use("/api", (_req: Request, res: Response) => res.status(404).json({ error: "Not found." }));
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof z.ZodError) {
      const first = err.issues[0];
      return res.status(400).json({ error: first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input.", details: err.issues.slice(0, 5) });
    }
    if (err?.type === "entity.too.large") {
      const limitMb = Number(err?.limit) > 0 ? Math.round(Number(err.limit) / 1048576) : 0;
      const what = /\/share$/.test(_req.path) ? "Those PDFs are too big to email together. Send fewer at a time" : /\/backup\/restore$/.test(_req.path) ? "That backup file is too large to restore here" : "That's too much to send at once";
      return res.status(413).json({ error: `${what}${limitMb ? ` (the limit is ${limitMb} MB)` : ""}.` });
    }
    if (err?.type === "entity.parse.failed") {
      return res.status(400).json({ error: /\/backup\/restore$/.test(_req.path) ? "This file isn't a valid backup (it may be cut off or edited). Use a file from Download backup. Nothing was restored." : "The request wasn't valid JSON." });
    }
    if (err?.code === "empty_lists") return res.status(409).json({ error: err.message, code: err.code, wouldDelete: err.wouldDelete });
    // SQLite stayed locked past busy_timeout (e.g. a long backup or restore): a short,
    // retryable outage, not a crash. The time clock saves the punch and sends it later.
    if (err?.code === "SQLITE_BUSY" || err?.code === "SQLITE_LOCKED" || /database is locked/i.test(String(err?.message ?? ""))) {
      res.setHeader("Retry-After", "5");
      // No `code`: the kiosk treats a 5xx without one as "no answer" and queues the punch.
      return res.status(503).json({ error: "The database is busy for a moment. Please try again.", busy: true });
    }
    const status = Number(err?.status) || 500;
    if (status >= 500) console.error("[api]", err);
    const code = err?.code === "partial_restore" || err?.code === "maintenance" ? err.code : undefined;
    res.status(status).json({ error: err?.message || "Something went wrong.", ...(code ? { code } : {}) });
  });
}
