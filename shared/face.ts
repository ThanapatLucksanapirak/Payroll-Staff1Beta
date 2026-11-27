// Face recognition at the time clock: the rules shared by the server and the
// admin app. A face is turned into 128 numbers (a "descriptor") on the server
// with face-api's recognition model; two photos of the same person are close
// together (Euclidean distance), photos of different people are far apart.

/** Approved reference photos needed before face match can be turned on for someone. */
export const FACE_MIN_REFS = 3;
/** Most reference photos kept per person (the oldest goes when a new one is added past this). */
export const FACE_MAX_REFS = 10;
/**
 * A punch photo matches when its face is at most this far from the person's
 * closest reference photo. face-api's own default is 0.6; 0.5 is stricter, so
 * a lookalike coworker is less likely to pass, while the same person under
 * different light usually scores 0.25 to 0.45.
 */
export const FACE_MATCH_MAX_DISTANCE = 0.5;
/**
 * A new reference photo must be at most this far from the person's existing
 * reference photos (the closest of them), so a photo of someone else isn't
 * approved by mistake.
 */
export const FACE_REF_MAX_DISTANCE = 0.55;

/** Face data retention: delete someone's face data this many days after their last punch. */
export const FACE_RETENTION_DEFAULT_DAYS = 365;
export const FACE_RETENTION_MIN_DAYS = 30;
/** Three years: the longest Illinois's biometric privacy law allows after someone's last interaction. */
export const FACE_RETENTION_MAX_DAYS = 1095;

export function normalizeFaceRetention(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return FACE_RETENTION_DEFAULT_DAYS;
  return Math.min(FACE_RETENTION_MAX_DAYS, Math.max(FACE_RETENTION_MIN_DAYS, Math.round(n)));
}

export function faceDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || !a.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i]! - b[i]!; s += d * d; }
  return Math.sqrt(s);
}

/** Distance from `d` to the closest of `refs` (Infinity when there are none). */
export function closestDistance(d: ArrayLike<number>, refs: ArrayLike<number>[]): number {
  let best = Infinity;
  for (const r of refs) best = Math.min(best, faceDistance(d, r));
  return best;
}

/** Round a distance for storing and showing (two decimals). */
export const roundDistance = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

/** What the admin app sees about one person's face data. Never the descriptors. */
export interface FaceSummary {
  employeeId: string;
  /** When the owner recorded the employee's written consent, or null. */
  consentAt: string | null;
  consentBy: string | null;
  refs: number;
  /** Face match required at the time clock. */
  required: boolean;
  /** Their face data exists but can't be read (damaged, or the server's key changed). Their punches are refused until it's deleted. */
  unreadable?: boolean;
}

/** One approved reference photo, as the admin app sees it. */
export interface FaceRefView {
  id: string;
  /** The punch the photo came from, if it came from one. */
  punchId: string | null;
  /** When the photo was taken (the punch time), or when it was added. */
  takenAt: string;
  addedAt: string;
  addedBy: string;
}

/** A photo in the photo gallery (a kiosk punch that has a photo). */
export interface GalleryPhoto {
  punchId: string;
  employeeId: string;
  employeeName: string;
  type: string;
  at: string;
  /** "missing" (no face found), "unchecked" (the face check couldn't run) or "mismatch" (not their face), as on Live. */
  face: string | null;
  /** True when this photo is one of the person's reference photos. */
  reference: boolean;
  /** True when the employee has since been removed from the list. */
  removed?: boolean;
}

/**
 * A punch refused because the face didn't match the person's reference photos,
 * shown on Live until a manager dismisses it.
 */
export interface FaceAlert {
  id: string;
  employeeId: string;
  employeeName: string;
  /** The punch that was refused. */
  type: string;
  at: string;
  /** How far the face was from their closest reference photo (null when unknown). */
  distance: number | null;
  /** "mismatch" (not their face) or "unreadable" (their face data couldn't be read). Missing on older alerts = mismatch. */
  reason?: "mismatch" | "unreadable";
  deviceName: string;
  /** False once the photo has been deleted (retention or face data deletion). */
  photo: boolean;
  dismissedAt: string | null;
  dismissedBy: string | null;
}
/** Face alerts kept per location: the newest this many, and none older than FACE_ALERT_DAYS. */
export const FACE_ALERT_MAX = 200;
export const FACE_ALERT_DAYS = 14;

/**
 * The notice to give each employee before collecting face data. Plain words,
 * covering what the Illinois, Texas and Washington biometric laws ask for:
 * what is collected, why, how long it is kept, and that it is never sold.
 * It's a starting point, not legal advice.
 */
export function faceConsentNotice(business: string, retentionDays: number): string {
  const who = business.trim() || "Your employer";
  const years = retentionDays % 365 === 0 ? `${retentionDays / 365} year${retentionDays === 365 ? "" : "s"}` : `${retentionDays} days`;
  return [
    `Face recognition at the time clock: notice and consent`,
    ``,
    `${who} would like to use face recognition at the time clock, to make sure each punch is made by the right person.`,
    ``,
    `What is collected: the time clock takes a photo when you punch. With your consent, a few of these photos are kept as reference photos, and the server turns your face into a set of numbers (a face template) to compare with the photo at each punch.`,
    ``,
    `Why: only to confirm it's you clocking in and out. It is not used for anything else, and it is never sold, leased, traded or shared with anyone outside ${who}, except where the law requires it.`,
    ``,
    `Where it is kept: on ${who}'s own payroll server. Face templates are encrypted, and photos are stored with restricted file access. None of it is included in backups. No outside face recognition service is used.`,
    ``,
    `How long: your face data is deleted when you no longer need it for the time clock, and at the latest ${years} after your last punch. You can ask for it to be deleted at any time; you'll then clock in with your PIN only.`,
    ``,
    `I have read this notice and agree to the collection and use of my face data as described.`,
    ``,
    `Name: ______________________    Signature: ______________________    Date: __________`,
  ].join("\n");
}
