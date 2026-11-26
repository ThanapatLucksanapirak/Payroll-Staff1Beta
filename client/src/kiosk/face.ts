// Face check for "photo on punch": before a punch is sent, the kiosk makes sure
// the camera actually sees a face, so a covered or blocked camera can't be used
// to punch unnoticed.
//
// Detection runs on the tablet with MediaPipe's BlazeFace model (about 230 KB)
// and its WebAssembly runtime, both served by this app from /face/ (nothing is
// sent anywhere). They load only on kiosks with photos turned on. If MediaPipe
// can't start (an old or low-memory tablet), the browser's own face detector is
// used where there is one (Chrome on Android has it). If neither runs, the
// check says so ("unchecked") instead of passing, and the punch isn't sent.
// Loading is retried, so one failed download doesn't switch the check off for
// the rest of the day.
import type { FaceDetector as MpFaceDetector } from "@mediapipe/tasks-vision";

export type FaceReason = "no_face" | "covered" | "no_frame" | "unchecked";
export type FaceResult = { ok: true } | { ok: false; reason: FaceReason };

/** Anything that can say whether a canvas holds a face. */
interface Detector { kind: "mediapipe" | "native"; faces(canvas: HTMLCanvasElement): Promise<boolean> }

/**
 * How sure the model must be that it sees a face. Real faces score about 0.95;
 * patterns and objects that only look a bit like one (e.g. Chrome's fake
 * test camera) score 0.3 to 0.6, so 0.5 let them through. 0.7 leaves room for real faces in poor light.
 */
const MIN_SCORE = 0.7;
/** After a failed load, wait this long before trying again. */
const RETRY_MS = 20_000;

let detector: Promise<Detector | null> | null = null;
let failedAt = 0;

async function mediapipe(): Promise<Detector | null> {
  if (typeof WebAssembly === "undefined") return null;
  const vision = await import("@mediapipe/tasks-vision");
  const simd = await vision.FilesetResolver.isSimdSupported().catch(() => false);
  // Some tablets report SIMD but fail to start it: fall back to the plain build.
  for (const name of simd ? ["vision_wasm_internal", "vision_wasm_nosimd_internal"] : ["vision_wasm_nosimd_internal"]) {
    try {
      const d: MpFaceDetector = await vision.FaceDetector.createFromOptions(
        { wasmLoaderPath: `/face/${name}.js`, wasmBinaryPath: `/face/${name}.wasm` },
        { baseOptions: { modelAssetPath: "/face/blaze_face_short_range.tflite", delegate: "CPU" }, runningMode: "IMAGE", minDetectionConfidence: MIN_SCORE },
      );
      return {
        kind: "mediapipe",
        faces: async (canvas) => d.detect(canvas).detections.some((x) => (x.categories?.[0]?.score ?? 0) >= MIN_SCORE),
      };
    } catch (err) {
      console.warn(`[kiosk] face detector (${name}) failed to start`, err);
    }
  }
  return null;
}

/** The browser's built-in detector (Shape Detection API), where it exists. */
async function native(): Promise<Detector | null> {
  const Native = (globalThis as { FaceDetector?: new (o?: { fastMode?: boolean; maxDetectedFaces?: number }) => { detect(src: CanvasImageSource): Promise<unknown[]> } }).FaceDetector;
  if (typeof Native !== "function") return null;
  try {
    const d = new Native({ fastMode: true, maxDetectedFaces: 1 });
    // A probe on a blank canvas: throws when the API exists but isn't backed by anything.
    const probe = document.createElement("canvas");
    probe.width = probe.height = 32;
    await d.detect(probe);
    return { kind: "native", faces: async (canvas) => (await d.detect(canvas)).length > 0 };
  } catch {
    return null;
  }
}

/** Load the detector once (shared by every check). Resolves to null when nothing can run here right now. */
export function loadFaceDetector(): Promise<Detector | null> {
  if (detector) return detector;
  if (failedAt && Date.now() - failedAt < RETRY_MS) return Promise.resolve(null);
  detector = (async () => {
    let d: Detector | null = null;
    try { d = await mediapipe(); } catch (err) { console.warn("[kiosk] face detector unavailable", err); }
    if (!d) d = await native();
    if (!d) { failedAt = Date.now(); detector = null; } // try again later
    return d;
  })();
  return detector;
}

/**
 * Is the picture usable at all? A covered lens or a camera that only sends
 * black frames gives an almost flat image: very dark, or almost no contrast.
 */
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

/** Check a frame (a canvas holding the snapshot) for a face. */
export async function checkFace(canvas: HTMLCanvasElement): Promise<FaceResult> {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || !canvas.width || !canvas.height) return { ok: false, reason: "no_frame" };
  if (frameLooksCovered(ctx, canvas.width, canvas.height)) return { ok: false, reason: "covered" };
  const d = await loadFaceDetector();
  // Nothing can look for a face on this tablet: never treat that as "face found".
  if (!d) return { ok: false, reason: "unchecked" };
  try {
    return (await d.faces(canvas)) ? { ok: true } : { ok: false, reason: "no_face" };
  } catch (err) {
    // The detector runs here but failed on this frame: don't let the punch through.
    console.warn("[kiosk] face check failed", err);
    return { ok: false, reason: "no_frame" };
  }
}

export const FACE_MESSAGES: Record<FaceReason, string> = {
  no_face: "Face not detected. Look at the camera and try again.",
  covered: "Face not detected: the camera looks covered or too dark. Uncover it and try again.",
  no_frame: "The camera isn't ready yet. Wait a moment and try again.",
  unchecked: "This tablet couldn't check for a face. Try again in a moment, or ask a manager.",
};
