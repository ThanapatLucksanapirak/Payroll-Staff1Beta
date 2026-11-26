// Kiosk extras: shift notes, fix requests from the kiosk, per-location kiosk
// settings (stations, break reminder, photo retention) and punch photos.
//
// Device-token routes (/api/kiosk/...) are registered from kiosk.ts, inside the
// device-token middleware; admin routes are registered from routes.ts after the
// admin session middleware and are covered by POLICY rules in access.ts.
import { randomUUID } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { Site } from "@shared/schema";
import { localToInstant } from "@shared/dates";
import { PUNCH_TYPES } from "@shared/punches";
import {
  type FixRequest, type ShiftNote, FIX_TYPE_LABELS, MAX_STATIONS, acknowledge, fixTimeProblem, noteActive,
} from "@shared/kiosk";
import { FACE_RETENTION_MAX_DAYS, FACE_RETENTION_MIN_DAYS } from "@shared/face";
import { db } from "./db";
import * as settings from "./settings";
import { actorOf, audit } from "./audit";
import { broadcast } from "./live";
import { getEmployee, listEmployees, type StoredEmployee } from "./employees";
import { PunchError, recordPunch } from "./punches";
import { getSiteConfig, listFixRequests, listNotes, setSiteConfig, updateFixRequests, updateNotes } from "./kioskConfig";
import { readPhoto, startPhotoHousekeeping } from "./kioskPhotos";

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch((err) => {
    if (err instanceof PunchError) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  });
};

const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instant = z.string().refine((s) => Number.isFinite(Date.parse(s)), "Enter a valid date and time.");

/** What the kiosk routes need from kiosk.ts (passed in to avoid a circular import). */
export interface KioskDeps {
  ctx: (res: Response) => { device: { id: string }; site: Site };
  kioskEnabled: (site: Site) => boolean;
  authenticateEmployee: (req: Request, res: Response, body: { pin?: string; employeeId?: string; ticket?: string }) => Promise<StoredEmployee | null>;
}

const kioskSignal = (siteId: string, kind: "fix_request" | "note") => broadcast({ type: "kiosk", kind, siteId });

// ── Device-token routes ──────────────────────────────────────────────────────
export function registerKioskDeviceFeatureRoutes(app: Express, deps: KioskDeps) {
  const who = z.object({ ticket: z.string().max(600).optional(), pin: z.string().max(12).optional(), employeeId: z.string().max(64).optional() });

  // "OK" on a shift note: record that this employee saw it.
  app.post("/api/kiosk/notes/:id/ack", h(async (req, res) => {
    const { site } = deps.ctx(res);
    const body = who.parse(req.body ?? {});
    const e = await deps.authenticateEmployee(req, res, body);
    if (!e) return;
    const id = String(req.params.id);
    const ok = await updateNotes(site.id, (list) => {
      const i = list.findIndex((n) => n.id === id);
      if (i < 0) return { list, result: false };
      const next = [...list];
      next[i] = acknowledge(list[i], e.id, e.name, new Date().toISOString());
      return { list: next, result: true };
    });
    if (!ok) return res.status(404).json({ error: "That note was removed." });
    kioskSignal(site.id, "note");
    res.json({ ok: true });
  }));

  // "I forgot to clock in at 9:00": a request a manager approves or declines.
  app.post("/api/kiosk/fix-requests", h(async (req, res) => {
    const { site, device } = deps.ctx(res);
    if (!deps.kioskEnabled(site)) return res.status(403).json({ error: "The time clock is turned off for this location.", code: "disabled" });
    const body = who.extend({
      type: z.enum(PUNCH_TYPES),
      date: isoDate,
      minutes: z.number().int().min(0).max(1439),
      note: z.string().trim().max(300).default(""),
    }).parse(req.body ?? {});
    const e = await deps.authenticateEmployee(req, res, body);
    if (!e) return;
    const at = localToInstant(body.date, body.minutes, site.rules.timezone);
    const problem = fixTimeProblem(Date.parse(at));
    if (problem) return res.status(400).json({ error: problem, code: "time" });
    const created = await updateFixRequests(site.id, (list) => {
      if (list.filter((r) => r.status === "pending" && r.employeeId === e.id).length >= 10) return { list, result: null };
      const r: FixRequest = {
        id: newId("fr"), employeeId: e.id, employeeName: e.name, type: body.type, at, note: body.note, createdAt: new Date().toISOString(),
        deviceId: device.id, status: "pending", decidedAt: null, decidedBy: null, reason: "", punchId: null,
      };
      return { list: [...list, r], result: r };
    });
    if (!created) return res.status(429).json({ error: "You already have several requests waiting. Ask a manager to look at them.", code: "limit" });
    audit({ userId: null, userName: `${e.name} (kiosk)`, ip: req.ip ?? "", action: "kiosk.fix-request", target: `site:${site.id}`, detail: `${FIX_TYPE_LABELS[created.type]} at ${at}` });
    kioskSignal(site.id, "fix_request");
    res.json({ id: created.id, type: created.type, at: created.at, status: created.status });
  }));
}

// ── Admin routes ─────────────────────────────────────────────────────────────
async function siteOr404(req: Request, res: Response) {
  const site = await settings.getSite(String(req.params.siteId));
  if (!site) { res.status(404).json({ error: "Location not found." }); return null; }
  return site;
}

const noteView = (n: ShiftNote, now = Date.now()) => ({ ...n, active: noteActive(n, now) });

export function registerKioskFeatureAdminRoutes(app: Express) {
  startPhotoHousekeeping();

  // Location kiosk settings (admin): stations, break reminder, photo retention.
  app.get("/api/sites/:siteId/kiosk-config", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    res.json(await getSiteConfig(site.id));
  }));
  app.put("/api/sites/:siteId/kiosk-config", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    const patch = z.object({
      stations: z.array(z.string().max(80)).max(MAX_STATIONS).optional(),
      breakReminderHours: z.number().min(0).max(16).nullable().optional(),
      photoRetentionDays: z.number().int().min(1).max(3650).optional(),
      faceRetentionDays: z.number().int().min(FACE_RETENTION_MIN_DAYS).max(FACE_RETENTION_MAX_DAYS).optional(),
    }).strict().parse(req.body ?? {});
    const next = await setSiteConfig(site.id, patch);
    audit({ ...actorOf(req, res), action: "kiosk.settings", target: `site:${site.id}`, detail: Object.keys(patch).join(", ") });
    res.json(next);
  }));

  // Shift notes (managers): post per location, optionally for some employees, with an expiry.
  app.get("/api/sites/:siteId/kiosk-notes", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    const now = Date.now();
    res.json((await listNotes(site.id)).map((n) => noteView(n, now)).reverse());
  }));
  app.post("/api/sites/:siteId/kiosk-notes", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    const body = z.object({
      text: z.string().trim().min(1, "Write the note.").max(500),
      employeeIds: z.array(z.string().max(64)).max(200).default([]),
      expiresAt: instant.nullable().default(null),
    }).parse(req.body ?? {});
    if (body.expiresAt && Date.parse(body.expiresAt) <= Date.now()) return res.status(400).json({ error: "The end time is already past." });
    const known = new Set((await listEmployees(site.id)).map((e) => e.id));
    const actor = actorOf(req, res);
    const note: ShiftNote = {
      id: newId("note"), text: body.text, employeeIds: [...new Set(body.employeeIds.filter((id) => known.has(id)))],
      createdAt: new Date().toISOString(), createdBy: actor.userName, expiresAt: body.expiresAt ? new Date(body.expiresAt).toISOString() : null, acks: [],
    };
    await updateNotes(site.id, (list) => ({ list: [...list, note], result: null }));
    audit({ ...actor, action: "kiosk.note.create", target: `site:${site.id}`, detail: note.text.slice(0, 120) });
    kioskSignal(site.id, "note");
    res.json(noteView(note));
  }));
  app.delete("/api/sites/:siteId/kiosk-notes/:id", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    const id = String(req.params.id);
    const removed = await updateNotes(site.id, (list) => ({ list: list.filter((n) => n.id !== id), result: list.find((n) => n.id === id) ?? null }));
    if (!removed) return res.status(404).json({ error: "That note no longer exists." });
    audit({ ...actorOf(req, res), action: "kiosk.note.delete", target: `site:${site.id}`, detail: removed.text.slice(0, 120) });
    kioskSignal(site.id, "note");
    res.json({ ok: true });
  }));

  // Fix requests from the kiosk.
  app.get("/api/sites/:siteId/fix-requests", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    const list = await listFixRequests(site.id);
    res.json(list.sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1) || b.createdAt.localeCompare(a.createdAt)));
  }));
  app.post("/api/sites/:siteId/fix-requests/:id/approve", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    const body = z.object({ at: instant.optional(), note: z.string().trim().max(300).optional(), force: z.boolean().optional() }).parse(req.body ?? {});
    const id = String(req.params.id);
    const actor = actorOf(req, res);
    const out = await updateFixRequests(site.id, async (list) => {
      const cur = list.find((r) => r.id === id);
      if (!cur) throw new PunchError("That request no longer exists.", 404, "missing");
      if (cur.status !== "pending") throw new PunchError(`This request was already ${cur.status}.`, 409, "decided");
      const employee = await getEmployee(site.id, cur.employeeId);
      if (!employee) throw new PunchError("That employee is no longer in the employee list.", 404, "missing");
      const at = body.at ? new Date(body.at).toISOString() : cur.at;
      if (Date.parse(at) > Date.now() + 5 * 60_000) throw new PunchError("A punch can't be in the future.", 400, "time");
      const note = body.note || `Fix request from the kiosk${cur.note ? `: ${cur.note}` : ""}`;
      // Same path as "Add punch" on Live: validated against the sequence, note kept with the punch.
      const { punch } = await recordPunch({
        id: `adm_${cur.id}`, site, employee, type: cur.type, at, source: "admin", deviceId: null,
        note: note.slice(0, 300), audience: "admin", force: body.force, meta: { fixRequestId: cur.id },
      });
      const next: FixRequest = { ...cur, status: "approved", decidedAt: new Date().toISOString(), decidedBy: actor.userName, reason: note.slice(0, 300), punchId: punch.id, at };
      return { list: list.map((r) => (r.id === id ? next : r)), result: next };
    });
    audit({ ...actor, action: "kiosk.fix-request.approve", target: `site:${site.id}`, detail: `${out.employeeName}: ${FIX_TYPE_LABELS[out.type]} at ${out.at}` });
    kioskSignal(site.id, "fix_request");
    res.json(out);
  }));
  app.post("/api/sites/:siteId/fix-requests/:id/decline", h(async (req, res) => {
    const site = await siteOr404(req, res); if (!site) return;
    const body = z.object({ reason: z.string().trim().max(300).default("") }).parse(req.body ?? {});
    const id = String(req.params.id);
    const actor = actorOf(req, res);
    const out = await updateFixRequests(site.id, (list) => {
      const cur = list.find((r) => r.id === id);
      if (!cur) throw new PunchError("That request no longer exists.", 404, "missing");
      if (cur.status !== "pending") throw new PunchError(`This request was already ${cur.status}.`, 409, "decided");
      const next: FixRequest = { ...cur, status: "declined", decidedAt: new Date().toISOString(), decidedBy: actor.userName, reason: body.reason };
      return { list: list.map((r) => (r.id === id ? next : r)), result: next };
    });
    audit({ ...actor, action: "kiosk.fix-request.decline", target: `site:${site.id}`, detail: `${out.employeeName}: ${FIX_TYPE_LABELS[out.type]}${body.reason ? ` (${body.reason})` : ""}` });
    kioskSignal(site.id, "fix_request");
    res.json(out);
  }));

  // Punch photos: only for signed-in editors of that location (see access.ts).
  app.get("/api/punches/:id/photo", h(async (req, res) => {
    const punch = await (await db()).getPunch(String(req.params.id));
    const bytes = punch && punch.meta?.photo === "saved" ? readPhoto(punch.siteId, punch.id) : null;
    if (!bytes) return res.status(404).json({ error: "No photo for this punch." });
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=600");
    res.setHeader("Content-Disposition", "inline");
    res.end(bytes);
  }));
}


