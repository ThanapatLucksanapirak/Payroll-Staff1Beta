// Punch photos: small JPEG snapshots from the kiosk's front camera, stored as
// files under DATA_DIR/punch-photos/<siteId>/<punchId>.jpg. They are NOT part of
// the JSON backups (too big); the punch itself only records meta.photo.
import fs from "node:fs";
import path from "node:path";
import { MAX_PHOTO_BYTES, photoExpired } from "@shared/kiosk";
import { DATA_DIR } from "./config";
import { getSiteConfig } from "./kioskConfig";
import { onLiveEvent } from "./live";

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
export const photoRoot = () => path.resolve(process.env.PUNCH_PHOTO_DIR || path.join(DATA_DIR, "punch-photos"));

/** The file for a punch's photo, or null when an id is not safe to use in a path. */
export function photoPath(siteId: string, punchId: string): string | null {
  if (!SAFE_ID.test(siteId) || !SAFE_ID.test(punchId)) return null;
  return path.join(photoRoot(), siteId, `${punchId}.jpg`);
}

/** Decode a data URL / base64 string into JPEG bytes, or null when it isn't a small JPEG. */
export function decodePhoto(input: string): Buffer | null {
  const b64 = input.replace(/^data:image\/jpe?g;base64,/i, "");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64) || b64.length > Math.ceil(MAX_PHOTO_BYTES * 4 / 3) + 8) return null;
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 100 || buf.length > MAX_PHOTO_BYTES) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null; // JPEG magic
  return buf;
}

export function savePhoto(siteId: string, punchId: string, bytes: Buffer): boolean {
  const p = photoPath(siteId, punchId);
  if (!p) return false;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.renameSync(tmp, p);
    return true;
  } catch (err: any) {
    console.warn(`[photos] could not save the photo for punch ${punchId}: ${err?.message ?? err}`);
    return false;
  }
}

export function deletePhoto(siteId: string, punchId: string) {
  const p = photoPath(siteId, punchId);
  if (p) fs.rm(p, { force: true }, () => undefined);
}

export function readPhoto(siteId: string, punchId: string): Buffer | null {
  const p = photoPath(siteId, punchId);
  if (!p) return null;
  try { return fs.readFileSync(p); } catch { return null; }
}

/** Delete photos older than each location's retention setting. Returns how many were removed. */
export async function purgeOldPhotos(nowMs = Date.now()): Promise<number> {
  const root = photoRoot();
  let sites: string[] = [];
  try { sites = fs.readdirSync(root).filter((s) => SAFE_ID.test(s)); } catch { return 0; }
  let removed = 0;
  for (const siteId of sites) {
    const { photoRetentionDays } = await getSiteConfig(siteId);
    const dir = path.join(root, siteId);
    let files: string[] = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && photoExpired(st.mtimeMs, photoRetentionDays, nowMs)) { fs.unlinkSync(p); removed++; }
      } catch { /* gone meanwhile */ }
    }
  }
  if (removed) console.log(`[photos] removed ${removed} punch photo(s) past their retention period`);
  return removed;
}

let started = false;
/** Daily retention clean-up, and remove a photo when its punch is deleted. */
export function startPhotoHousekeeping() {
  if (started) return;
  started = true;
  onLiveEvent((e) => {
    const p = (e as any).punch;
    if (e.type === "punch" && (e as any).action === "deleted" && p?.siteId && p?.id) deletePhoto(p.siteId, p.id);
  });
  if (process.env.PHOTO_CLEANUP === "off") return;
  const run = () => purgeOldPhotos().catch((err) => console.error("[photos] clean-up failed:", err?.message ?? err));
  setTimeout(run, 90_000).unref();
  setInterval(run, 24 * 60 * 60_000).unref();
}
