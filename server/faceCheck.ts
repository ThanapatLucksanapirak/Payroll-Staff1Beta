// Face check for "photo on punch", on the server. The kiosk only takes the
// photo; this decides whether a face is in it, so the result is the same on
// every phone and tablet and can't be skipped by a modified kiosk.
//
// It runs face-api's SSD MobileNet v1 face detector (about 5.6 MB of weights,
// shipped in the npm package) on TensorFlow.js's WebAssembly backend: CPU only,
// no native build, nothing sent anywhere. A 320 px kiosk photo takes about
// 0.3 s. The model loads once, in the background at start-up and on first use.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/** How sure the detector must be. Real faces from kiosk photos score 0.9 to 1.0; objects and hands about 0.2 to 0.4. */
export const FACE_MIN_SCORE = 0.6;

export type FaceVerdict =
  | { ok: true; score: number }
  | { ok: false; reason: "no_face" | "bad_image" | "unavailable" | "busy"; score?: number };

/** A check that takes longer than this (waiting included) answers "unavailable"; more than this many waiting answer "busy". */
export const faceLimits = { timeoutMs: 10_000, maxWaiting: 10 };

type FaceApi = typeof import("@vladmandic/face-api");
type Tf = typeof import("@tensorflow/tfjs");
let tf: Tf;
let loading: Promise<FaceApi> | null = null;
let failedAt = 0;

const req = createRequire(typeof __filename !== "undefined" ? __filename : path.join(process.cwd(), "index.js"));

/** Load the detector once. Rejects when it can't run (tried again after a minute). */
export function loadFaceModel(): Promise<FaceApi> {
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
    return faceapi;
  })().catch((err) => {
    loading = null;
    failedAt = Date.now();
    console.error("[face] face detector failed to load:", err);
    throw err;
  });
  return loading;
}

/** One check at a time: the WebAssembly backend is single-threaded anyway. */
let queue: Promise<unknown> = Promise.resolve();

let waiting = 0;

/** Is there a face in this JPEG? */
export function checkFaceJpeg(bytes: Buffer): Promise<FaceVerdict> {
  if (waiting >= faceLimits.maxWaiting) return Promise.resolve({ ok: false, reason: "busy" });
  waiting++;
  const deadline = Date.now() + faceLimits.timeoutMs;
  // Detection blocks the event loop (about 0.3 s each), so let the server breathe
  // between checks, and skip a check whose request has already timed out.
  const next = async (): Promise<FaceVerdict> => {
    await new Promise((r) => setImmediate(r));
    if (Date.now() > deadline) return { ok: false, reason: "unavailable" };
    return detect(bytes);
  };
  const run = queue.then(next, next).finally(() => { waiting--; });
  queue = run.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<FaceVerdict>((resolve) => {
    timer = setTimeout(() => {
      console.error(`[face] face check took over ${faceLimits.timeoutMs} ms`);
      resolve({ ok: false, reason: "unavailable" });
    }, faceLimits.timeoutMs);
  });
  return Promise.race([run.catch((): FaceVerdict => ({ ok: false, reason: "unavailable" })), timeout]).finally(() => clearTimeout(timer));
}

async function detect(bytes: Buffer): Promise<FaceVerdict> {
  let faceapi: FaceApi;
  try { faceapi = await loadFaceModel(); } catch { return { ok: false, reason: "unavailable" }; }
  const jpeg: typeof import("jpeg-js") = req("jpeg-js");
  let img: { width: number; height: number; data: Uint8Array };
  try {
    img = jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 4, maxMemoryUsageInMB: 64 });
  } catch {
    return { ok: false, reason: "bad_image" };
  }
  if (!img.width || !img.height) return { ok: false, reason: "bad_image" };
  const rgba = tf.tensor3d(img.data, [img.height, img.width, 4], "int32");
  const rgb = tf.slice(rgba, [0, 0, 0], [-1, -1, 3]) as unknown as Parameters<typeof faceapi.detectAllFaces>[0];
  try {
    const found = await faceapi.detectAllFaces(rgb, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3, maxResults: 3 }));
    const score = Math.max(0, ...found.map((d) => d.score));
    return score >= FACE_MIN_SCORE ? { ok: true, score } : { ok: false, reason: "no_face", score };
  } finally {
    tf.dispose([rgba, rgb as unknown as import("@tensorflow/tfjs").Tensor]);
  }
}
