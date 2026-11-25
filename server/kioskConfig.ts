// Storage for the kiosk extras, all as JSON in the settings table (so they are
// part of backups and work on SQLite and Supabase alike):
//   kiosk_config:<siteId>        stations, break reminder, photo retention
//   kiosk_notes:<siteId>         shift notes / announcements and who saw them
//   kiosk_fix_requests:<siteId>  "I forgot to clock in" requests from the kiosk
// Per-device options live on the device record in `kiosk_devices`.
import {
  type FixRequest, type KioskSiteConfig, type ShiftNote, normalizeSiteConfig, pruneFixRequests, pruneNotes,
} from "@shared/kiosk";
import { db } from "./db";

export const CONFIG_PREFIX = "kiosk_config:";
export const NOTES_PREFIX = "kiosk_notes:";
export const FIX_PREFIX = "kiosk_fix_requests:";

function parse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

const locks = new Map<string, Promise<unknown>>();
/** Read-modify-write of one settings key, one at a time in this process. */
function withKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const tail = next.catch(() => undefined);
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return next;
}

// ── Location config ──────────────────────────────────────────────────────────
export async function getSiteConfig(siteId: string): Promise<KioskSiteConfig> {
  try {
    return normalizeSiteConfig(parse((await (await db()).getSetting(CONFIG_PREFIX + siteId)), {}));
  } catch {
    return normalizeSiteConfig({});
  }
}

export async function setSiteConfig(siteId: string, patch: Partial<KioskSiteConfig>): Promise<KioskSiteConfig> {
  return withKey(CONFIG_PREFIX + siteId, async () => {
    const next = normalizeSiteConfig({ ...(await getSiteConfig(siteId)), ...patch });
    await (await db()).setSetting(CONFIG_PREFIX + siteId, JSON.stringify(next));
    return next;
  });
}

// ── Lists (notes, fix requests) ──────────────────────────────────────────────
async function readList<T>(key: string): Promise<T[]> {
  const v = parse<unknown>(await (await db()).getSetting(key), []);
  return Array.isArray(v) ? (v as T[]) : [];
}

function sanitizeNote(n: any): ShiftNote | null {
  if (!n || typeof n !== "object" || typeof n.id !== "string" || typeof n.text !== "string") return null;
  return {
    id: n.id, text: n.text, employeeIds: Array.isArray(n.employeeIds) ? n.employeeIds.map(String) : [],
    createdAt: String(n.createdAt ?? new Date(0).toISOString()), createdBy: String(n.createdBy ?? ""),
    expiresAt: typeof n.expiresAt === "string" ? n.expiresAt : null,
    acks: Array.isArray(n.acks) ? n.acks.filter((a: any) => a && typeof a.employeeId === "string") : [],
  };
}

export async function listNotes(siteId: string): Promise<ShiftNote[]> {
  return (await readList<any>(NOTES_PREFIX + siteId)).map(sanitizeNote).filter((n): n is ShiftNote => !!n);
}

export function updateNotes<T>(siteId: string, fn: (list: ShiftNote[]) => { list: ShiftNote[]; result: T }): Promise<T> {
  return withKey(NOTES_PREFIX + siteId, async () => {
    const { list, result } = fn(await listNotes(siteId));
    await (await db()).setSetting(NOTES_PREFIX + siteId, JSON.stringify(pruneNotes(list)));
    return result;
  });
}

function sanitizeFix(r: any): FixRequest | null {
  if (!r || typeof r !== "object" || typeof r.id !== "string" || typeof r.employeeId !== "string") return null;
  return {
    id: r.id, employeeId: r.employeeId, employeeName: String(r.employeeName ?? ""), type: r.type, at: String(r.at), note: String(r.note ?? ""),
    createdAt: String(r.createdAt ?? new Date(0).toISOString()), deviceId: r.deviceId ?? null,
    status: r.status === "approved" || r.status === "declined" ? r.status : "pending",
    decidedAt: r.decidedAt ?? null, decidedBy: r.decidedBy ?? null, reason: String(r.reason ?? ""), punchId: r.punchId ?? null,
  };
}

export async function listFixRequests(siteId: string): Promise<FixRequest[]> {
  return (await readList<any>(FIX_PREFIX + siteId)).map(sanitizeFix).filter((r): r is FixRequest => !!r);
}

export function updateFixRequests<T>(siteId: string, fn: (list: FixRequest[]) => Promise<{ list: FixRequest[]; result: T }> | { list: FixRequest[]; result: T }): Promise<T> {
  return withKey(FIX_PREFIX + siteId, async () => {
    const { list, result } = await fn(await listFixRequests(siteId));
    await (await db()).setSetting(FIX_PREFIX + siteId, JSON.stringify(pruneFixRequests(list)));
    return result;
  });
}
