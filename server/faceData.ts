// Face data for face recognition at the time clock: per employee, the owner's
// record of the employee's written consent, approved reference photos, and the
// face templates (128-number descriptors) worked out from them.
//
// Stored as files, not in the database, so face data never ends up in JSON
// backups or off-site copies:
//   DATA_DIR/face-data/<siteId>/<employeeId>/profile.enc   consent, settings, descriptors (AES-256-GCM)
//   DATA_DIR/face-data/<siteId>/<employeeId>/refs/<id>.jpg reference photos
// Deleting someone's face data removes the whole folder. Face data is deleted
// when the employee is removed, and by a daily clean-up once they haven't
// punched for the location's face data retention period. The clean-up never
// treats a database switch or an older backup as people leaving (see
// purgeExpiredFaceData).
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  FACE_ALERT_DAYS, FACE_ALERT_MAX, FACE_MATCH_MAX_DISTANCE, FACE_MAX_REFS, FACE_MIN_REFS, FACE_REF_MAX_DISTANCE,
  type FaceAlert, type FaceRefView, type FaceSummary, type GalleryPhoto, closestDistance, faceConsentNotice, roundDistance,
} from "@shared/face";
import type { Punch } from "@shared/punches";
import { DATA_DIR, getPinKey } from "./config";
import { db } from "./db";
import { listPunchesChecked } from "./db/types";
import * as settings from "./settings";
import { actorOf, audit } from "./audit";
import { employeeRemovedHooks, getEmployee, listEmployees } from "./employees";
import { getSiteConfig } from "./kioskConfig";
import { deletePhoto, photoPath, readPhoto, savePhoto } from "./kioskPhotos";
import { broadcast } from "./live";
import { checkFaceJpeg } from "./faceCheck";

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

export interface FaceRef {
  id: string;
  punchId: string | null;
  takenAt: string;
  addedAt: string;
  addedBy: string;
  /** The face template (128 numbers). */
  d: number[];
}
export interface FaceProfile {
  consentAt: string | null;
  consentBy: string | null;
  required: boolean;
  refs: FaceRef[];
}
const emptyProfile = (): FaceProfile => ({ consentAt: null, consentBy: null, required: false, refs: [] });

export class FaceError extends Error {
  constructor(message: string, public status = 400, public code = "face") { super(message); }
}

// ── Files ────────────────────────────────────────────────────────────────────
export const faceRoot = () => path.resolve(process.env.FACE_DATA_DIR || path.join(DATA_DIR, "face-data"));

function personDir(siteId: string, employeeId: string): string {
  if (!SAFE_ID.test(siteId) || !SAFE_ID.test(employeeId)) throw new FaceError("Invalid id.", 400);
  return path.join(faceRoot(), siteId, employeeId);
}
const profileFile = (siteId: string, employeeId: string) => path.join(personDir(siteId, employeeId), "profile.enc");
function refFile(siteId: string, employeeId: string, refId: string): string | null {
  if (!SAFE_ID.test(refId)) return null;
  return path.join(personDir(siteId, employeeId), "refs", `${refId}.jpg`);
}

/** A key for face data only, derived from the server's PIN key. */
let keyCache: { pin: Buffer; key: Buffer } | null = null;
function faceKey(): Buffer {
  const pin = getPinKey();
  if (!keyCache || !keyCache.pin.equals(pin)) keyCache = { pin, key: Buffer.from(hkdfSync("sha256", pin, Buffer.alloc(0), "payroll face data v1", 32)) };
  return keyCache.key;
}

function encrypt(json: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", faceKey(), iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(json, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${body.toString("base64url")}.${c.getAuthTag().toString("base64url")}`;
}
function decrypt(enc: string, aad: string): string | null {
  try {
    const [v, iv, body, tag] = enc.trim().split(".");
    if (v !== "v1" || !iv || !body || !tag) return null;
    const d = createDecipheriv("aes-256-gcm", faceKey(), Buffer.from(iv, "base64url"));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function sanitize(raw: any): FaceProfile {
  const p = emptyProfile();
  if (!raw || typeof raw !== "object") return p;
  p.consentAt = typeof raw.consentAt === "string" ? raw.consentAt : null;
  p.consentBy = typeof raw.consentBy === "string" ? raw.consentBy : null;
  p.required = raw.required === true;
  p.refs = (Array.isArray(raw.refs) ? raw.refs : [])
    .filter((r: any) => r && typeof r.id === "string" && SAFE_ID.test(r.id) && Array.isArray(r.d) && r.d.length === 128 && r.d.every((x: unknown) => typeof x === "number" && Number.isFinite(x)))
    .map((r: any): FaceRef => ({
      id: r.id, punchId: typeof r.punchId === "string" ? r.punchId : null, takenAt: String(r.takenAt ?? r.addedAt ?? ""),
      addedAt: String(r.addedAt ?? ""), addedBy: String(r.addedBy ?? ""), d: r.d,
    }));
  if (!p.consentAt) { p.refs = []; p.required = false; }
  if (p.refs.length < FACE_MIN_REFS) p.required = false;
  return p;
}

/** Someone's face data, or an empty profile when there is none (or it can't be read). */
export function readProfile(siteId: string, employeeId: string): FaceProfile {
  return readProfileState(siteId, employeeId).profile;
}

/**
 * Someone's face data, and whether a profile exists but can't be read
 * (damaged file, or the server's PIN key changed). An unreadable profile might
 * have had face match on, so the time clock fails closed for that person.
 */
export function readProfileState(siteId: string, employeeId: string): { profile: FaceProfile; unreadable: boolean } {
  let enc: string;
  try { enc = fs.readFileSync(profileFile(siteId, employeeId), "utf8"); } catch (err: any) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return { profile: emptyProfile(), unreadable: false };
    console.error(`[face] face data for ${employeeId} at ${siteId} can't be read: ${err?.message ?? err}`);
    return { profile: emptyProfile(), unreadable: true };
  }
  const json = decrypt(enc, `face:${siteId}:${employeeId}`);
  let raw: unknown;
  try { raw = json == null ? undefined : JSON.parse(json); } catch { raw = undefined; }
  if (raw === undefined || !raw || typeof raw !== "object") {
    console.error(`[face] face data for ${employeeId} at ${siteId} can't be read (damaged, or the server's PIN key changed). Their punches are refused until it's deleted and set up again.`);
    return { profile: emptyProfile(), unreadable: true };
  }
  return { profile: sanitize(raw), unreadable: false };
}

function writeProfile(siteId: string, employeeId: string, p: FaceProfile) {
  const file = profileFile(siteId, employeeId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, encrypt(JSON.stringify(p), `face:${siteId}:${employeeId}`), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** One change at a time per person. */
const locks = new Map<string, Promise<unknown>>();
function withPerson<T>(siteId: string, employeeId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${siteId}|${employeeId}`;
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const tail = next.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return next;
}

export function summaryOf(employeeId: string, p: FaceProfile, unreadable = false): FaceSummary {
  return { employeeId, consentAt: p.consentAt, consentBy: p.consentBy, refs: p.refs.length, required: p.required, ...(unreadable ? { unreadable: true } : {}) };
}
const refView = (r: FaceRef): FaceRefView => ({ id: r.id, punchId: r.punchId, takenAt: r.takenAt, addedAt: r.addedAt, addedBy: r.addedBy });

/** Employees at a location that have any face data. */
function peopleWithData(siteId: string): string[] {
  if (!SAFE_ID.test(siteId)) return [];
  try { return fs.readdirSync(path.join(faceRoot(), siteId)).filter((f) => SAFE_ID.test(f)); } catch { return []; }
}

export function faceSummaries(siteId: string): FaceSummary[] {
  return peopleWithData(siteId).map((id) => {
    const st = readProfileState(siteId, id);
    return summaryOf(id, st.profile, st.unreadable);
  }).filter((s) => s.consentAt || s.refs || s.unreadable);
}

/** Writing over a profile we can't read would silently turn Require off and orphan its photos. */
function refuseUnreadable(siteId: string, employeeId: string) {
  if (readProfileState(siteId, employeeId).unreadable) throw new FaceError("This person's face data can't be read. Delete their face data first, then set it up again.", 409, "unreadable");
}

// ── Changes ──────────────────────────────────────────────────────────────────
export function recordConsent(siteId: string, employeeId: string, by: string): Promise<FaceProfile> {
  return withPerson(siteId, employeeId, async () => {
    refuseUnreadable(siteId, employeeId);
    const p = readProfile(siteId, employeeId);
    if (!p.consentAt) { p.consentAt = new Date().toISOString(); p.consentBy = by; }
    writeProfile(siteId, employeeId, p);
    return p;
  });
}

/** Approve a punch photo as one of the person's reference photos. */
export function addReference(siteId: string, employeeId: string, punchId: string, by: string): Promise<{ profile: FaceProfile; ref: FaceRef; dropped: number }> {
  return withPerson(siteId, employeeId, async () => {
    refuseUnreadable(siteId, employeeId);
    const p = readProfile(siteId, employeeId);
    if (!p.consentAt) throw new FaceError("Record their consent before adding reference photos.", 409, "consent");
    const punch = await (await db()).getPunch(punchId);
    if (!punch || punch.siteId !== siteId || punch.employeeId !== employeeId || punch.meta?.photo !== "saved") throw new FaceError("That photo isn't one of theirs.", 404, "missing");
    if (p.refs.some((r) => r.punchId === punchId)) throw new FaceError("That photo is already a reference photo.", 409, "duplicate");
    const bytes = readPhoto(siteId, punchId);
    if (!bytes) throw new FaceError("That photo is no longer kept.", 404, "missing");
    const face = await checkFaceJpeg(bytes, { descriptor: true });
    if (!face.ok) {
      if (face.reason === "busy" || face.reason === "unavailable") throw new FaceError("The face check isn't working on the server right now. Try again in a moment.", 503, "unavailable");
      throw new FaceError("No clear face in this photo. Choose one where their face is easy to see.", 422, "no_face");
    }
    if ((face.faces ?? 1) > 1) throw new FaceError("There's more than one face in this photo. Choose one with only them.", 422, "faces");
    if (!face.descriptor) throw new FaceError("The face check isn't working on the server right now. Try again in a moment.", 503, "unavailable");
    if (p.refs.length) {
      const dist = closestDistance(face.descriptor, p.refs.map((r) => r.d));
      if (dist > FACE_REF_MAX_DISTANCE) throw new FaceError("This doesn't look like the same person as their other reference photos. Check it's really them, or remove the other photos first.", 422, "different");
    }
    const ref: FaceRef = { id: randomUUID().replace(/-/g, "").slice(0, 16), punchId, takenAt: punch.at, addedAt: new Date().toISOString(), addedBy: by, d: face.descriptor };
    const file = refFile(siteId, employeeId, ref.id)!;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    p.refs.push(ref);
    let dropped = 0;
    while (p.refs.length > FACE_MAX_REFS) {
      const old = p.refs.shift()!;
      fs.rmSync(refFile(siteId, employeeId, old.id)!, { force: true });
      dropped++;
    }
    writeProfile(siteId, employeeId, p);
    return { profile: p, ref, dropped };
  });
}

export function removeReference(siteId: string, employeeId: string, refId: string): Promise<FaceProfile> {
  return withPerson(siteId, employeeId, async () => {
    const p = readProfile(siteId, employeeId);
    if (!p.refs.some((r) => r.id === refId)) throw new FaceError("That reference photo no longer exists.", 404, "missing");
    p.refs = p.refs.filter((r) => r.id !== refId);
    if (p.refs.length < FACE_MIN_REFS) p.required = false;
    const file = refFile(siteId, employeeId, refId);
    if (file) fs.rmSync(file, { force: true });
    writeProfile(siteId, employeeId, p);
    return p;
  });
}

/** Turn face match at the time clock on or off for someone. On needs consent and enough reference photos. */
export function setRequired(siteId: string, employeeId: string, required: boolean): Promise<FaceProfile> {
  return withPerson(siteId, employeeId, async () => {
    const p = readProfile(siteId, employeeId);
    if (required && !p.consentAt) throw new FaceError("Record their consent first.", 409, "consent");
    if (required && p.refs.length < FACE_MIN_REFS) throw new FaceError(`Face match needs ${FACE_MIN_REFS} reference photos first.`, 409, "refs");
    if (p.required === required) return p;
    p.required = required;
    writeProfile(siteId, employeeId, p);
    return p;
  });
}

/** Face match at the time clock: the person's face templates when face match is on for them, else null. */
export function requiredTemplates(siteId: string, employeeId: string): number[][] | "unreadable" | null {
  if (!SAFE_ID.test(siteId) || !SAFE_ID.test(employeeId)) return null;
  const { profile: p, unreadable } = readProfileState(siteId, employeeId);
  if (unreadable) return "unreadable"; // fail closed: it may have had face match on
  return p.required ? p.refs.map((r) => r.d) : null;
}

export type MatchResult = { match: boolean; distance: number | null };
/** Does this face match these templates? */
export function matchFace(descriptor: number[] | undefined, templates: number[][]): MatchResult {
  if (!descriptor) return { match: false, distance: null };
  const d = closestDistance(descriptor, templates);
  return { match: d <= FACE_MATCH_MAX_DISTANCE, distance: roundDistance(d) };
}

/**
 * Delete all of someone's face data: consent record, reference photos and face
 * templates. With `punchPhotos`, also their punch photos (the punches stay).
 */
export function deleteFaceData(siteId: string, employeeId: string, opts: { punchPhotos?: boolean } = {}): Promise<{ punchPhotos: number }> {
  return withPerson(siteId, employeeId, async () => {
    fs.rmSync(personDir(siteId, employeeId), { recursive: true, force: true });
    let removed = 0;
    if (opts.punchPhotos) {
      for (const p of await punchesWithPhotos(siteId, employeeId)) {
        const file = photoPath(siteId, p.id);
        if (file && fs.existsSync(file)) { deletePhoto(siteId, p.id); removed++; }
        // The photo is gone, so the punch must stop saying it has one (Live would ask for it and get a 404).
        const { photo: _photo, ...meta } = p.meta ?? {};
        await (await db()).updatePunch(p.id, { edits: p.edits, flags: p.flags, meta });
      }
      await deleteAlertsFor(siteId, employeeId);
    }
    return { punchPhotos: removed };
  });
}

async function punchesWithPhotos(siteId: string, employeeId: string): Promise<Punch[]> {
  const { photoRetentionDays } = await getSiteConfig(siteId);
  const from = new Date(Date.now() - (photoRetentionDays + 2) * 86_400_000).toISOString();
  return (await listPunchesChecked(await db(), { siteId, employeeId, from })).filter((p) => p.meta?.photo === "saved");
}

export function readRefPhoto(siteId: string, employeeId: string, refId: string): Buffer | null {
  const file = refFile(siteId, employeeId, refId);
  if (!file) return null;
  try { return fs.readFileSync(file); } catch { return null; }
}

// ── Photo gallery ────────────────────────────────────────────────────────────
const DAY = 86_400_000;
/**
 * Punch photos at a location, newest first, a page at a time. Punches are read
 * in windows going back from `before` until there are enough photos or the
 * retention period is reached; `nextBefore` continues from there (null: no more).
 */
export async function galleryPage(siteId: string, opts: { employeeId?: string; before?: string; limit?: number; nowMs?: number }) {
  const now = opts.nowMs ?? Date.now();
  const limit = Math.min(96, Math.max(1, opts.limit ?? 36));
  const { photoRetentionDays } = await getSiteConfig(siteId);
  const horizon = now - (photoRetentionDays + 1) * DAY;
  let end = opts.before ? Math.min(Date.parse(opts.before), now + DAY) : now + DAY;
  if (!Number.isFinite(end)) throw new FaceError("Invalid date.", 400);
  const windowDays = opts.employeeId ? 60 : 7;
  const store = await db();
  const refsByPerson = new Map<string, Set<string>>();
  const refPunches = (employeeId: string) => {
    let s = refsByPerson.get(employeeId);
    if (!s) { s = new Set(readProfile(siteId, employeeId).refs.map((r) => r.punchId ?? "")); refsByPerson.set(employeeId, s); }
    return s;
  };
  const current = new Set((await listEmployees(siteId)).map((e) => e.id));
  const photos: GalleryPhoto[] = [];
  while (end > horizon && photos.length < limit) {
    const start = Math.max(horizon, end - windowDays * DAY);
    const list = await listPunchesChecked(store, {
      siteId, ...(opts.employeeId ? { employeeId: opts.employeeId } : {}), from: new Date(start).toISOString(), to: new Date(end).toISOString(),
    });
    const withPhoto = list.filter((p) => p.meta?.photo === "saved").sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
    for (const p of withPhoto) {
      const file = photoPath(siteId, p.id);
      if (!file || !fs.existsSync(file)) continue;
      // Page is full and there is more: continue just before the last photo shown (`to` is exclusive).
      if (photos.length >= limit) return { photos, nextBefore: photos[photos.length - 1].at };
      photos.push({ punchId: p.id, employeeId: p.employeeId, employeeName: p.employeeName, type: p.type, at: p.at, face: p.meta?.face ?? null, reference: refPunches(p.employeeId).has(p.id), ...(current.has(p.employeeId) ? {} : { removed: true }) });
    }
    end = start;
    // A page always ends at a window boundary, so nothing is skipped or shown twice.
  }
  return { photos, nextBefore: end > horizon ? new Date(end).toISOString() : null };
}

// ── Face alerts (refused punches, shown on Live) ─────────────────────────────
export const ALERTS_PREFIX = "face_alerts:";
const alertPhotoId = (alertId: string) => `face-alert-${alertId}`;
const alertLocks = new Map<string, Promise<unknown>>();
function withAlerts<T>(siteId: string, fn: (list: FaceAlert[]) => Promise<{ list: FaceAlert[]; result: T }>): Promise<T> {
  const prev = alertLocks.get(siteId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(async () => {
    const store = await db();
    const out = await fn(await listFaceAlertsRaw(siteId));
    await store.setSetting(ALERTS_PREFIX + siteId, JSON.stringify(out.list));
    return out.result;
  });
  const tail = next.catch(() => undefined);
  alertLocks.set(siteId, tail);
  void tail.then(() => { if (alertLocks.get(siteId) === tail) alertLocks.delete(siteId); });
  return next;
}
async function listFaceAlertsRaw(siteId: string): Promise<FaceAlert[]> {
  try {
    const v = JSON.parse((await (await db()).getSetting(ALERTS_PREFIX + siteId)) ?? "[]");
    return Array.isArray(v) ? v.filter((a) => a && typeof a.id === "string" && SAFE_ID.test(a.id)) : [];
  } catch {
    return [];
  }
}
/** Newest first, with whether each photo is still kept. */
export async function listFaceAlerts(siteId: string): Promise<FaceAlert[]> {
  return (await listFaceAlertsRaw(siteId)).map((a) => {
    const file = photoPath(siteId, alertPhotoId(a.id));
    return { ...a, photo: !!file && fs.existsSync(file) };
  }).reverse();
}

/** Record a punch refused because the face didn't match (with its photo), and tell Live. */
export async function recordFaceAlert(siteId: string, a: Omit<FaceAlert, "id" | "photo" | "dismissedAt" | "dismissedBy">, photo: Buffer | null): Promise<FaceAlert> {
  const alert: FaceAlert = { ...a, id: randomUUID().replace(/-/g, "").slice(0, 16), photo: false, dismissedAt: null, dismissedBy: null };
  if (photo) alert.photo = savePhoto(siteId, alertPhotoId(alert.id), photo);
  const cutoff = Date.now() - FACE_ALERT_DAYS * DAY;
  await withAlerts(siteId, async (list) => {
    const all = [...list, alert];
    const keep = all.filter((x) => Date.parse(x.at) >= cutoff).slice(-FACE_ALERT_MAX);
    const kept = new Set(keep.map((x) => x.id));
    for (const x of all) if (!kept.has(x.id)) deletePhoto(siteId, alertPhotoId(x.id));
    return { list: keep, result: undefined };
  });
  broadcast({ type: "kiosk", kind: "face_alert", siteId });
  return alert;
}

export function dismissFaceAlert(siteId: string, id: string, by: string): Promise<FaceAlert> {
  return withAlerts(siteId, async (list) => {
    const cur = list.find((x) => x.id === id);
    if (!cur) throw new FaceError("That alert no longer exists.", 404, "missing");
    const next = { ...cur, dismissedAt: cur.dismissedAt ?? new Date().toISOString(), dismissedBy: cur.dismissedBy ?? by };
    return { list: list.map((x) => (x.id === id ? next : x)), result: next };
  });
}

/** Remove someone's alerts and their photos (when their punch photos are deleted). */
async function deleteAlertsFor(siteId: string, employeeId: string) {
  await withAlerts(siteId, async (list) => {
    for (const x of list) if (x.employeeId === employeeId) deletePhoto(siteId, alertPhotoId(x.id));
    return { list: list.filter((x) => x.employeeId !== employeeId), result: undefined };
  });
}

// ── Retention ────────────────────────────────────────────────────────────────
/**
 * Someone with face data who isn't in the location's employee list is only
 * deleted after this many days. Removing an employee deletes their face data
 * straight away (see startFaceHousekeeping), so this only covers face data the
 * database doesn't know about: usually a database switch or a restore of an
 * older backup. Face data isn't in backups, so deleting it then would lose it
 * for good when the owner switches back.
 */
export const FACE_MISSING_GRACE_DAYS = 30;
const missingFile = (siteId: string, employeeId: string) => path.join(personDir(siteId, employeeId), "missing-since");

function missingSince(siteId: string, employeeId: string, nowMs: number): number {
  try {
    const t = Date.parse(fs.readFileSync(missingFile(siteId, employeeId), "utf8").trim());
    if (Number.isFinite(t) && t <= nowMs) return t;
  } catch { /* not marked yet */ }
  try { fs.writeFileSync(missingFile(siteId, employeeId), new Date(nowMs).toISOString(), { mode: 0o600 }); } catch { /* folder gone */ }
  return nowMs;
}
function clearMissing(siteId: string, employeeId: string) {
  try { fs.unlinkSync(missingFile(siteId, employeeId)); } catch { /* not marked */ }
}

/**
 * Delete face data for people who were removed, or haven't punched for the
 * retention period. Nothing is deleted when the database in use doesn't look
 * like this location's real records (no location, no employees, or no punches
 * at all within the retention period), because that's what a database switch
 * or an older backup looks like, not people leaving.
 */
export async function purgeExpiredFaceData(nowMs = Date.now()): Promise<number> {
  let sites: string[] = [];
  try { sites = fs.readdirSync(faceRoot()).filter((s) => SAFE_ID.test(s)); } catch { return 0; }
  const store = await db();
  let removed = 0;
  for (const siteId of sites) {
    const people = peopleWithData(siteId);
    if (!people.length) continue;
    if (!(await settings.getSite(siteId))) { console.warn(`[face] clean-up skipped for location ${siteId}: it isn't in the database in use, so its face data is kept`); continue; }
    const employees = await listEmployees(siteId);
    if (!employees.length) { console.warn(`[face] clean-up skipped for location ${siteId}: the database in use has no employees there, so its face data is kept`); continue; }
    const known = new Set(employees.map((e) => e.id));
    const { faceRetentionDays } = await getSiteConfig(siteId);
    const cutoff = nowMs - faceRetentionDays * DAY;
    const from = new Date(cutoff).toISOString();
    const siteActive = (await store.listPunches({ siteId, from, limit: 1 })).length > 0;
    for (const employeeId of people) {
      let expired = false;
      if (!known.has(employeeId)) {
        expired = nowMs - missingSince(siteId, employeeId, nowMs) >= FACE_MISSING_GRACE_DAYS * DAY;
      } else {
        clearMissing(siteId, employeeId);
        // No punches at all here in the retention period means the records are
        // old or missing, not that this person stopped working: keep it.
        if (siteActive) {
          const p = readProfile(siteId, employeeId);
          const lastSet = Math.max(0, ...[p.consentAt, ...p.refs.map((r) => r.addedAt)].map((x) => (x ? Date.parse(x) || 0 : 0)));
          if (lastSet < cutoff) {
            const recent = await store.listPunches({ siteId, employeeId, from, limit: 1 });
            expired = recent.length === 0;
          }
        }
      }
      if (expired) {
        await deleteFaceData(siteId, employeeId);
        audit({ userId: null, userName: "System", ip: "", action: "face.retention-delete", target: `site:${siteId}`, detail: `employee ${employeeId}${known.has(employeeId) ? "" : " (not in the employee list)"}` });
        removed++;
      }
    }
  }
  if (removed) console.log(`[face] deleted face data for ${removed} employee(s) past the retention period`);
  return removed;
}

let started = false;
export function startFaceHousekeeping() {
  if (started) return;
  started = true;
  employeeRemovedHooks.push(async (siteId, employeeId) => {
    if (!peopleWithData(siteId).includes(employeeId)) return;
    await deleteFaceData(siteId, employeeId);
    audit({ userId: null, userName: "System", ip: "", action: "face.delete", target: `site:${siteId}`, detail: `employee ${employeeId} removed` });
  });
  if (process.env.PHOTO_CLEANUP === "off") return;
  const run = () => purgeExpiredFaceData().catch((err) => console.error("[face] clean-up failed:", err?.message ?? err));
  setTimeout(run, 120_000).unref();
  setInterval(run, DAY).unref();
}

// ── Routes ───────────────────────────────────────────────────────────────────
const h = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch((err) => {
    if (err instanceof FaceError) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  });
};

async function personOr404(req: Request, res: Response) {
  const site = await settings.getSite(String(req.params.siteId));
  if (!site) { res.status(404).json({ error: "Location not found." }); return null; }
  const employeeId = String(req.params.employeeId);
  if (!SAFE_ID.test(employeeId)) { res.status(404).json({ error: "Employee not found." }); return null; }
  const employee = await getEmployee(site.id, employeeId);
  if (!employee) { res.status(404).json({ error: "Employee not found." }); return null; }
  return { site, employee };
}

function sendJpeg(res: Response, bytes: Buffer | null) {
  if (!bytes) return res.status(404).json({ error: "No photo." });
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "private, max-age=600");
  res.setHeader("Content-Disposition", "inline");
  res.end(bytes);
}

/** Admin routes. Who can use them is set in access.ts. */
export function registerFaceRoutes(app: Express) {
  startFaceHousekeeping();

  app.get("/api/sites/:siteId/face", h(async (req, res) => {
    const site = await settings.getSite(String(req.params.siteId));
    if (!site) return res.status(404).json({ error: "Location not found." });
    res.json(faceSummaries(site.id));
  }));

  app.get("/api/sites/:siteId/photos", h(async (req, res) => {
    const site = await settings.getSite(String(req.params.siteId));
    if (!site) return res.status(404).json({ error: "Location not found." });
    const q = z.object({
      employeeId: z.string().regex(SAFE_ID).optional(),
      before: z.string().max(40).optional(),
      limit: z.coerce.number().int().min(1).max(96).optional(),
    }).parse(req.query);
    res.json(await galleryPage(site.id, q));
  }));

  app.get("/api/sites/:siteId/employees/:employeeId/face", h(async (req, res) => {
    const ctx = await personOr404(req, res); if (!ctx) return;
    const { profile: p, unreadable } = readProfileState(ctx.site.id, ctx.employee.id);
    const { faceRetentionDays } = await getSiteConfig(ctx.site.id);
    res.json({
      ...summaryOf(ctx.employee.id, p, unreadable), refList: p.refs.map(refView).reverse(),
      notice: faceConsentNotice(ctx.site.name, faceRetentionDays), retentionDays: faceRetentionDays,
    });
  }));

  app.get("/api/sites/:siteId/employees/:employeeId/face/refs/:refId/photo", h(async (req, res) => {
    const ctx = await personOr404(req, res); if (!ctx) return;
    sendJpeg(res, readRefPhoto(ctx.site.id, ctx.employee.id, String(req.params.refId)));
  }));

  app.post("/api/sites/:siteId/employees/:employeeId/face/consent", h(async (req, res) => {
    const ctx = await personOr404(req, res); if (!ctx) return;
    z.object({ confirm: z.literal(true, { message: "Confirm that they signed the consent notice." }) }).parse(req.body ?? {});
    const actor = actorOf(req, res);
    const p = await recordConsent(ctx.site.id, ctx.employee.id, actor.userName);
    audit({ ...actor, action: "face.consent", target: `site:${ctx.site.id}`, detail: ctx.employee.name });
    res.json(summaryOf(ctx.employee.id, p));
  }));

  app.post("/api/sites/:siteId/employees/:employeeId/face/refs", h(async (req, res) => {
    const ctx = await personOr404(req, res); if (!ctx) return;
    const { punchId } = z.object({ punchId: z.string().regex(SAFE_ID) }).parse(req.body ?? {});
    const actor = actorOf(req, res);
    const out = await addReference(ctx.site.id, ctx.employee.id, punchId, actor.userName);
    audit({ ...actor, action: "face.reference.add", target: `site:${ctx.site.id}`, detail: `${ctx.employee.name}: ${out.profile.refs.length} reference photo(s)` });
    res.json({ ...summaryOf(ctx.employee.id, out.profile), ref: refView(out.ref), dropped: out.dropped });
  }));

  app.delete("/api/sites/:siteId/employees/:employeeId/face/refs/:refId", h(async (req, res) => {
    const ctx = await personOr404(req, res); if (!ctx) return;
    const actor = actorOf(req, res);
    const p = await removeReference(ctx.site.id, ctx.employee.id, String(req.params.refId));
    audit({ ...actor, action: "face.reference.remove", target: `site:${ctx.site.id}`, detail: `${ctx.employee.name}: ${p.refs.length} reference photo(s) left` });
    res.json(summaryOf(ctx.employee.id, p));
  }));

  app.put("/api/sites/:siteId/employees/:employeeId/face/required", h(async (req, res) => {
    const ctx = await personOr404(req, res); if (!ctx) return;
    const { required } = z.object({ required: z.boolean() }).parse(req.body ?? {});
    const p = await setRequired(ctx.site.id, ctx.employee.id, required);
    audit({ ...actorOf(req, res), action: required ? "face.require.on" : "face.require.off", target: `site:${ctx.site.id}`, detail: ctx.employee.name });
    res.json(summaryOf(ctx.employee.id, p));
  }));

  app.get("/api/sites/:siteId/face-alerts", h(async (req, res) => {
    const site = await settings.getSite(String(req.params.siteId));
    if (!site) return res.status(404).json({ error: "Location not found." });
    res.json(await listFaceAlerts(site.id));
  }));
  app.get("/api/sites/:siteId/face-alerts/:id/photo", h(async (req, res) => {
    const site = await settings.getSite(String(req.params.siteId));
    if (!site) return res.status(404).json({ error: "Location not found." });
    const id = String(req.params.id);
    sendJpeg(res, SAFE_ID.test(id) ? readPhoto(site.id, alertPhotoId(id)) : null);
  }));
  app.post("/api/sites/:siteId/face-alerts/:id/dismiss", h(async (req, res) => {
    const site = await settings.getSite(String(req.params.siteId));
    if (!site) return res.status(404).json({ error: "Location not found." });
    const out = await dismissFaceAlert(site.id, String(req.params.id), actorOf(req, res).userName);
    broadcast({ type: "kiosk", kind: "face_alert", siteId: site.id });
    res.json(out);
  }));

  app.delete("/api/sites/:siteId/employees/:employeeId/face", h(async (req, res) => {
    const ctx = await personOr404(req, res); if (!ctx) return;
    const punchPhotos = req.query.punchPhotos === "1";
    const out = await deleteFaceData(ctx.site.id, ctx.employee.id, { punchPhotos });
    audit({ ...actorOf(req, res), action: "face.delete", target: `site:${ctx.site.id}`, detail: `${ctx.employee.name}${punchPhotos ? `, and ${out.punchPhotos} punch photo(s)` : ""}` });
    res.json({ ok: true, punchPhotos: out.punchPhotos });
  }));
}
