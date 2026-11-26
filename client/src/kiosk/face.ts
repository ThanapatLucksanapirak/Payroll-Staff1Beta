// Photo check on the tablet for "photo on punch". Whether a face is in the
// photo is decided by the server (server/faceCheck.ts), the same way for every
// device. The tablet only catches the obvious case right away: a covered lens
// or a camera sending black frames gives an almost flat picture.

export type FaceReason = "covered" | "no_frame";
export type FaceResult = { ok: true } | { ok: false; reason: FaceReason };

/** A covered lens or black frames: very dark, or almost no contrast. */
export function frameLooksCovered(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const { data } = ctx.getImageData(0, 0, w, h);
  let sum = 0, sumSq = 0, n = 0;
  // Every 4th pixel is plenty.
  for (let i = 0; i < data.length; i += 16) {
    const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += y; sumSq += y * y; n++;
  }
  if (!n) return true;
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  return mean < 18 || sd < 6;
}

/** Is this frame usable as a punch photo (not blank, not covered)? */
export function checkFrame(canvas: HTMLCanvasElement): FaceResult {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || !canvas.width || !canvas.height) return { ok: false, reason: "no_frame" };
  return frameLooksCovered(ctx, canvas.width, canvas.height) ? { ok: false, reason: "covered" } : { ok: true };
}

export const FACE_MESSAGES: Record<FaceReason, string> = {
  covered: "Face not detected: the camera looks covered or too dark. Uncover it and try again.",
  no_frame: "The camera isn't ready yet. Wait a moment and try again.",
};
