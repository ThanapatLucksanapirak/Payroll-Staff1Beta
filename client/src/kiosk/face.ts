// Face check for "photo on punch": before a punch is sent, the kiosk makes sure
// the camera actually sees a face, so a covered or blocked camera can't be used
// to punch without a photo.
//
// Detection runs on the tablet with MediaPipe's BlazeFace model (about 230 KB)
// and its WebAssembly runtime, both served by this app from /face/ (nothing is
// sent anywhere). They load only on kiosks with photos turned on. If the
// detector can't run on an old device, a simpler check still stops punches when
// the picture is black, blank or covered.
import type { FaceDetector } from "@mediapipe/tasks-vision";

export type FaceResult =
  | { ok: true }
  | { ok: false; reason: "no_face" | "covered" | "no_frame" };

let detector: Promise<FaceDetector | null> | null = null;

/** Load the detector once (shared by every check). Resolves to null when it can't run here. */
export function loadFaceDetector(): Promise<FaceDetector | null> {
  if (detector) return detector;
  detector = (async () => {
    try {
      if (typeof WebAssembly === "undefined") return null;
      const vision = await import("@mediapipe/tasks-vision");
      const simd = await vision.FilesetResolver.isSimdSupported();
      const name = simd ? "vision_wasm_internal" : "vision_wasm_nosimd_internal";
      return await vision.FaceDetector.createFromOptions(
        { wasmLoaderPath: `/face/${name}.js`, wasmBinaryPath: `/face/${name}.wasm` },
        { baseOptions: { modelAssetPath: "/face/blaze_face_short_range.tflite", delegate: "CPU" }, runningMode: "IMAGE", minDetectionConfidence: 0.5 },
      );
    } catch (err) {
      console.warn("[kiosk] face detector unavailable; using the covered-camera check only", err);
      return null;
    }
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
  if (!d) return { ok: true }; // detector can't run on this device: the covered check above still applies
  try {
    const r = d.detect(canvas);
    return r.detections.length > 0 ? { ok: true } : { ok: false, reason: "no_face" };
  } catch (err) {
    console.warn("[kiosk] face check failed", err);
    return { ok: true };
  }
}

export const FACE_MESSAGES: Record<"no_face" | "covered" | "no_frame", string> = {
  no_face: "Face not detected. Look at the camera and try again.",
  covered: "Face not detected: the camera looks covered or too dark. Uncover it and try again.",
  no_frame: "The camera isn't ready yet. Wait a moment and try again.",
};
