// The face detector itself: loads face-api's SSD MobileNet v1 on TensorFlow.js's
// WebAssembly backend and looks for a face in a JPEG. It blocks the thread it
// runs on for about 0.3 s per photo, so the server runs it in a worker thread
// (server/faceWorker.ts, started from server/faceCheck.ts). This file is also
// the in-process fallback when the worker can't start.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/** How sure the detector must be. Real faces from kiosk photos score 0.9 to 1.0 (a small face in a wide frame about 0.55); objects and hands about 0.2 to 0.4. */
export const FACE_MIN_SCORE = 0.5;

/** Photos are shrunk so their longest side is at most this many pixels before detection (the detector looks at 512 px anyway), which keeps a big upload from costing more. */
export const FACE_MAX_SIDE = 640;
export type FaceVerdict =
  | { ok: true; score: number; /** Faces found above the threshold. */ faces?: number; /** 128 numbers describing the clearest face (face recognition), when asked for. */ descriptor?: number[] }
  | { ok: false; reason: "no_face" | "bad_image" | "unavailable" | "busy"; score?: number };

export interface FaceCheckOptions {
  /** Also work out the face's descriptor for face recognition (about 0.1 s more). */
  descriptor?: boolean;
}

type FaceApi = typeof import("@vladmandic/face-api");
type Tf = typeof import("@tensorflow/tfjs");
let tf: Tf;
let loading: Promise<FaceApi> | null = null;
let failedAt = 0;

const req = createRequire(typeof __filename !== "undefined" ? __filename : path.join(process.cwd(), "index.js"));

/** Load the detector once. Rejects when it can't run (tried again after a minute). */
export function loadDetector(): Promise<FaceApi> {
  if (loading) return loading;
  if (failedAt && Date.now() - failedAt < 60_000) return Promise.reject(new Error("face model failed to load recently"));
  loading = (async () => {
    tf = req("@tensorflow/tfjs");
    req("@tensorflow/tfjs-backend-wasm");
    const faceapi: FaceApi = req("@vladmandic/face-api/dist/face-api.node-wasm.js");
    await tf.setBackend("wasm");
    await tf.ready();
    const dir = path.join(path.dirname(req.resolve("@vladmandic/face-api/package.json")), "model");
    if (!fs.existsSync(path.join(dir, "ssd_mobilenetv1_model.bin"))) throw new Error(`face model not found in ${dir}`);
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(dir);
    // Face recognition: 68-point landmarks to line the face up, then the
    // recognition network's 128-number descriptor (about 6.5 MB more).
    await faceapi.nets.faceLandmark68Net.loadFromDisk(dir);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(dir);
    return faceapi;
  })().catch((err) => {
    loading = null;
    failedAt = Date.now();
    console.error("[face] face detector failed to load:", err);
    throw err;
  });
  return loading;
}

/** The size to detect at: longest side at most FACE_MAX_SIDE, the same shape. Smaller photos stay as they are: the detector scales everything to 512 px itself, so enlarging a 320 px frame measured no difference. */
export function detectionSize(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= FACE_MAX_SIDE) return { width, height };
  const scale = FACE_MAX_SIDE / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Is there a face in this JPEG? */
export async function detectFace(bytes: Uint8Array, opts: FaceCheckOptions): Promise<FaceVerdict> {
  let faceapi: FaceApi;
  try { faceapi = await loadDetector(); } catch { return { ok: false, reason: "unavailable" }; }
  const jpeg: typeof import("jpeg-js") = req("jpeg-js");
  let img: { width: number; height: number; data: Uint8Array };
  try {
    img = jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 4, maxMemoryUsageInMB: 64 });
  } catch {
    return { ok: false, reason: "bad_image" };
  }
  if (!img.width || !img.height) return { ok: false, reason: "bad_image" };
  const rgba = tf.tensor3d(img.data, [img.height, img.width, 4], "int32");
  const rgb3 = tf.slice(rgba, [0, 0, 0], [-1, -1, 3]);
  const size = detectionSize(img.width, img.height);
  const resized = size.width === img.width && size.height === img.height ? null : tf.image.resizeBilinear(rgb3 as import("@tensorflow/tfjs").Tensor3D, [size.height, size.width]);
  const rgb = (resized ?? rgb3) as unknown as Parameters<typeof faceapi.detectAllFaces>[0];
  try {
    const options = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3, maxResults: 3 });
    if (!opts.descriptor) {
      const found = await faceapi.detectAllFaces(rgb, options);
      const score = Math.max(0, ...found.map((d) => d.score));
      const faces = found.filter((d) => d.score >= FACE_MIN_SCORE).length;
      return score >= FACE_MIN_SCORE ? { ok: true, score, faces } : { ok: false, reason: "no_face", score };
    }
    const found = await faceapi.detectAllFaces(rgb, options).withFaceLandmarks().withFaceDescriptors();
    const best = found.reduce<(typeof found)[number] | null>((b, f) => (!b || f.detection.score > b.detection.score ? f : b), null);
    const score = best?.detection.score ?? 0;
    if (!best || score < FACE_MIN_SCORE) return { ok: false, reason: "no_face", score };
    const faces = found.filter((f) => f.detection.score >= FACE_MIN_SCORE).length;
    return { ok: true, score, faces, descriptor: Array.from(best.descriptor, (x) => Math.round(x * 1e6) / 1e6) };
  } finally {
    tf.dispose([rgba, rgb3, ...(resized ? [resized] : [])]);
  }
}
