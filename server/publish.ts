// Publishing a finalized payroll to the accountant.
//
// A timesheet is "published" when an owner or administrator presses Publish on
// a finalized (locked) timesheet. Accountants only ever see published payroll
// (see ACCOUNTANT_RULES in access.ts), and each accountant with a notification
// email and access to that location gets an email when it is published (if
// email is set up in Settings → Email; publishing never depends on it).
//
// Published state is kept in app settings under "payroll:published" (id → who
// and when), so it travels with backups and database copies. It only counts
// while the timesheet is still finalized: reopening a timesheet unpublishes it
// (clearPublished, called from the reopen route), and re-finalizing it does not
// publish it again by itself.
import type { Express, NextFunction, Request, Response } from "express";
import { db } from "./db";
import type { TimesheetRow } from "./db/types";
import * as settings from "./settings";
import { actorOf, audit } from "./audit";
import { currentUser } from "./auth";
import { type UserRecord, canAccessSite, isAccountant, listUsers } from "./users";
import { type SendResult, brandName, brandedHtml, emailReady, getEmailConfig, sendEmail } from "./email";

export const PUBLISHED_KEY = "payroll:published";

export interface PublishRecord {
  at: string;
  byId: string | null;
  byName: string;
  /** The result of the notification email, when one was attempted. */
  email?: { at: string; ok: boolean; sent: number; message: string; /** Still being sent in the background. */ pending?: boolean } | null;
  /** The timesheet's updated_at when it was published (a repeat publish of the same version sends no second email). */
  version?: string;
}
export type PublishedMap = Record<string, PublishRecord>;

let cache: { store: unknown; map: PublishedMap; at: number } | null = null;
const CACHE_MS = 3_000;
/** Forget the cached map (after a restore or database switch). */
export function invalidatePublishedCache() { cache = null; }

export async function getPublishedMap(): Promise<PublishedMap> {
  const store = await db();
  if (cache && cache.store === store && Date.now() - cache.at < CACHE_MS) return cache.map;
  let map: PublishedMap = {};
  try {
    const raw = await store.getSetting(PUBLISHED_KEY);
    const v = raw ? JSON.parse(raw) : {};
    if (v && typeof v === "object" && !Array.isArray(v)) map = v;
  } catch { map = {}; }
  cache = { store, map, at: Date.now() };
  return map;
}

let chain: Promise<unknown> = Promise.resolve();
/** Change the map under an in-process lock (no lost updates). */
function mutate<T>(fn: (map: PublishedMap) => T): Promise<T> {
  const p = chain.then(async () => {
    cache = null;
    const map = { ...(await getPublishedMap()) };
    const out = fn(map);
    const store = await db();
    await store.setSetting(PUBLISHED_KEY, JSON.stringify(map));
    cache = { store, map, at: Date.now() };
    return out;
  });
  chain = p.catch(() => undefined);
  return p;
}

const isFinalRow = (row: Pick<TimesheetRow, "meta_json"> | null | undefined) => row?.meta_json?.status === "final" && !row?.meta_json?.deletedAt;

/** Published and still finalized (and not in the Trash). */
export function publishedRecord(map: PublishedMap, id: string, status: string | null | undefined, deletedAt?: string | null): PublishRecord | null {
  const rec = map[id];
  return rec && status === "final" && !deletedAt ? rec : null;
}

export async function isPublished(id: string): Promise<boolean> {
  const map = await getPublishedMap();
  if (!map[id]) return false;
  const row = await (await db()).getTimesheet(id);
  return isFinalRow(row);
}

/** Unpublish (used when a timesheet is reopened). Never throws. */
export async function clearPublished(id: string): Promise<boolean> {
  try {
    if (!(await getPublishedMap())[id]) return false;
    return await mutate((map) => { const had = !!map[id]; delete map[id]; return had; });
  } catch (err) {
    console.error("[publish] could not clear published state:", err);
    return false;
  }
}

/** Accountants who should hear about a published payroll at this location. */
export async function recipientsFor(siteId: string): Promise<UserRecord[]> {
  const users = await listUsers({ fresh: true });
  return users.filter((u) => u.active && isAccountant(u) && canAccessSite(u, siteId));
}

export const periodText = (start: string | null | undefined, end: string | null | undefined) => {
  const f = (d: string) => {
    const [y, m, day] = d.split("-").map(Number);
    if (!y || !m || !day) return d;
    return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  };
  if (start && end) return start === end ? f(start) : `${f(start)} – ${f(end)}`;
  return start || end ? f((start || end)!) : "";
};

/** Build and send the "payroll published" email. Never throws. */
async function notify(row: TimesheetRow, siteId: string, by: string): Promise<SendResult & { recipients: number }> {
  try {
    const recipients = (await recipientsFor(siteId)).filter((u) => !!u.notificationEmail);
    if (!recipients.length) return { ok: false, skipped: true, reason: "No accountant has a notification email.", recipients: 0 };
    const [cfg, site] = await Promise.all([getEmailConfig(), settings.getSite(siteId)]);
    if (!emailReady(cfg)) return { ok: false, skipped: true, reason: "Email is not set up.", recipients: recipients.length };
    const brand = await brandName(cfg);
    const label = row.custom_label || row.filename || "Payroll";
    const period = periodText(row.period_start, row.period_end);
    const where = site?.name ? ` for ${site.name}` : "";
    const subject = `Payroll ready${where}${period ? `: ${period}` : ""}`;
    const base = cfg.appUrl.replace(/\/+$/, "");
    const link = base ? `${base}/#/timesheet/${encodeURIComponent(row.id)}` : "";
    const details: [string, string][] = [
      ["Payroll", label],
      ...(site?.name ? [["Location", site.name] as [string, string]] : []),
      ...(period ? [["Pay period", period] as [string, string]] : []),
      ["Employees", String(row.employee_count)],
      ["Published by", by],
    ];
    const intro = `${by} has published a payroll for you to review.`;
    const after = "Sign in to see each person's pay and download the full report, pay statements and CSV files.";
    const text = [intro, "", ...details.map(([k, v]) => `${k}: ${v}`), "", after, ...(link ? ["", `Open it: ${link}`] : [])].join("\n");
    const result = await sendEmail({
      to: recipients.map((u) => u.notificationEmail!),
      subject,
      text,
      html: brandedHtml({
        brand, preheader: `${label}${period ? ` · ${period}` : ""} is ready to review.`, heading: "A payroll is ready for you",
        paragraphs: [intro, after], details, button: link ? { label: "Open payroll", url: link } : undefined,
        footer: `You get these emails because you're set up as an accountant in ${brand}.`,
      }),
    });
    return { ...result, recipients: recipients.length };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err).slice(0, 300), recipients: 0 };
  }
}

const describeResult = (r: SendResult) => (r.ok ? `Emailed ${r.sent} accountant${r.sent === 1 ? "" : "s"}.` : "skipped" in r && r.skipped ? r.reason : `Email failed: ${(r as any).error}`);

/** How long a publish waits for the email before answering (the send carries on in the background). */
const EMAIL_WAIT_MS = 1500;
const locks = new Map<string, Promise<unknown>>();
function withPublishLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const p = (locks.get(id) ?? Promise.resolve()).then(fn);
  const tail = p.catch(() => undefined);
  locks.set(id, tail);
  void tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
  return p;
}

// ── Routes ───────────────────────────────────────────────────────────────────
type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

export function registerPublishRoutes(app: Express) {
  /** Published state, and who would be emailed (owners and administrators, for the Publish button). */
  app.get("/api/timesheets/:id/publish", h(async (req, res) => {
    const id = String(req.params.id);
    const row = await (await db()).getTimesheet(id);
    if (!row) return res.status(404).json({ error: "This timesheet no longer exists." });
    const siteId = row.site_id ?? (await settings.defaultSiteId());
    const rec = publishedRecord(await getPublishedMap(), id, row.meta_json?.status, row.meta_json?.deletedAt);
    const [accountants, cfg] = await Promise.all([recipientsFor(siteId), getEmailConfig()]);
    res.json({
      published: rec,
      final: isFinalRow(row),
      emailReady: emailReady(cfg),
      accountants: accountants.map((u) => ({ id: u.id, name: u.displayName || u.username, email: u.notificationEmail || "" })),
    });
  }));

  app.post("/api/timesheets/:id/publish", h(async (req, res) => {
    const id = String(req.params.id);
    const user = currentUser(res)!;
    const row = await (await db()).getTimesheet(id);
    if (!row) return res.status(404).json({ error: "This timesheet no longer exists." });
    if (row.meta_json?.deletedAt) return res.status(410).json({ error: "This timesheet is in the Trash." });
    if (!isFinalRow(row)) return res.status(409).json({ error: "Finalize the timesheet before publishing it." });
    const siteId = row.site_id ?? (await settings.defaultSiteId());
    // Publishing only makes the payroll visible to accountants: with none for this location it would
    // do nothing but report "Published to your accountant".
    if (!(await recipientsFor(siteId)).length) return res.status(409).json({ error: "No accountant has access to this location yet. Add one in Settings → Users, then publish.", code: "no-accountant" });
    const byName = user.displayName || user.username;
    const label = row.custom_label || row.filename || "Timesheet";
    const notifyParam = req.body?.notify !== false;
    const version = row.updated_at ?? "";
    // One publish of a timesheet at a time, so parallel presses can't each send an email.
    const decision = await withPublishLock(id, async () => {
      const prev = (await getPublishedMap())[id];
      // Same version already published and emailed (or being emailed): nothing more to do.
      if (prev && prev.version === version && (prev.email?.ok || prev.email?.pending)) return { skip: prev } as const;
      const rec: PublishRecord = { at: new Date().toISOString(), byId: user.id, byName, email: null, version };
      if (notifyParam) rec.email = { at: rec.at, ok: false, sent: 0, message: "Sending the email…", pending: true };
      await mutate((map) => { map[id] = rec; });
      return { rec, already: !!prev } as const;
    });
    if ("skip" in decision) return res.json({ published: decision.skip });
    const { rec, already } = decision;
    // Publishing is saved first: the email can only add to it, never undo it. It is sent in the
    // background (a hung mail server must not hold up the page); the result lands in the record and the log.
    const finish = async (email: (SendResult & { recipients: number }) | null) => {
      const entry = email ? { at: new Date().toISOString(), ok: email.ok, sent: email.ok ? email.sent : 0, message: describeResult(email) } : null;
      if (entry) await mutate((map) => { if (map[id]?.at === rec.at) map[id] = { ...map[id], email: entry }; }).catch(() => undefined);
      audit({ ...actorOf(req, res), action: already ? "timesheet.republish" : "timesheet.publish", target: `timesheet:${id}`, detail: `${label}${email ? ` · ${describeResult(email)}` : " · no email"}` });
      return entry;
    };
    if (!notifyParam) {
      await finish(null);
      return res.json({ published: rec });
    }
    const sending = notify(row, siteId, byName).then(finish);
    const quick = await Promise.race([sending, new Promise<null>((r) => setTimeout(() => r(null), EMAIL_WAIT_MS))]);
    if (quick) rec.email = quick;
    res.json({ published: rec });
  }));

  app.delete("/api/timesheets/:id/publish", h(async (req, res) => {
    const id = String(req.params.id);
    const row = await (await db()).getTimesheet(id);
    if (!row) return res.status(404).json({ error: "This timesheet no longer exists." });
    const had = await clearPublished(id);
    if (had) audit({ ...actorOf(req, res), action: "timesheet.unpublish", target: `timesheet:${id}`, detail: row.custom_label || row.filename || "Timesheet" });
    res.json({ published: null });
  }));
}
