// Face check for "photo on punch", on the server. The kiosk only takes the
// photo; this decides whether a face is in it, so the result is the same on
// every phone and tablet and can't be skipped by a modified kiosk.
//
// It runs face-api's SSD MobileNet v1 face detector (about 5.6 MB of weights,
// shipped in the npm package) on TensorFlow.js's WebAssembly backend: CPU only,
// no native build, nothing sent anywhere. A kiosk photo takes about 0.3 s, so
// the detector runs in a worker thread (server/faceWorker.ts, built next to
// dist/index.cjs as dist/faceWorker.cjs) and the rest of the server keeps
// answering meanwhile. If the worker can't start, the check runs in-process
// as before. The model loads once, in the background at start-up and on first use.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { detectFace, loadDetector, type FaceCheckOptions, type FaceVerdict } from "./faceDetect";
import type { WorkerMessage, WorkerReply } from "./faceWorker";

export { FACE_MIN_SCORE, type FaceCheckOptions, type FaceVerdict } from "./faceDetect";

/** A check that takes longer than this (waiting included) answers "unavailable"; more than this many waiting answer "busy". */
// About 0.3 s per photo, so 40 waiting clears in well under the 10 s limit;
// with 10, a crowd of 20 at the start of a shift had half told "busy".
export const faceLimits = { timeoutMs: 10_000, maxWaiting: 40 };

const req = createRequire(typeof __filename !== "undefined" ? __filename : path.join(process.cwd(), "index.js"));
const UNAVAILABLE: FaceVerdict = { ok: false, reason: "unavailable" };

// ── The worker ───────────────────────────────────────────────────────────────
let worker: Promise<Worker | null> | null = null;
/** Set when the worker can't start: checks then run in this thread. */
let inProcess = process.env.FACE_WORKER === "off";
let crashes = 0;
let nextId = 1;
const pending = new Map<number, (v: FaceVerdict) => void>();

/** How to start the worker: the built file next to dist/index.cjs, or the TypeScript source in development. */
function workerSource(): { code: string } | null {
  const dirs = [typeof __dirname !== "undefined" ? __dirname : "", path.join(process.cwd(), "dist"), path.join(process.cwd(), "server")].filter(Boolean);
  for (const d of dirs) {
    const built = path.join(d, "faceWorker.cjs");
    if (fs.existsSync(built)) return { code: `require(${JSON.stringify(built)});` };
  }
  for (const d of dirs) {
    const src = path.join(d, "faceWorker.ts");
    if (fs.existsSync(src)) return { code: `require(${JSON.stringify(req.resolve("tsx/cjs"))}); require(${JSON.stringify(src)});` };
  }
  return null;
}

function failPending() {
  for (const [id, resolve] of pending) { pending.delete(id); resolve(UNAVAILABLE); }
}

function getWorker(): Promise<Worker | null> {
  if (inProcess) return Promise.resolve(null);
  if (worker) return worker;
  const p: Promise<Worker | null> = new Promise((resolve) => {
    let w: Worker;
    let started = false;
    const giveUp = (why: string) => {
      if (worker === p) worker = null;
      if (!started) {
        started = true;
        if (++crashes >= 3) inProcess = true;
        console.error(`[face] face worker could not start (${why}); ${inProcess ? "checking in the main thread instead" : "will try again"}`);
        resolve(null);
      } else {
        console.error(`[face] face worker stopped (${why})`);
      }
      failPending();
    };
    try {
      const src = workerSource();
      if (!src) { inProcess = true; started = true; console.error("[face] face worker file not found; checking in the main thread"); return resolve(null); }
      w = new Worker(src.code, { eval: true, execArgv: [] });
    } catch (err) { return giveUp(String(err)); }
    const timer = setTimeout(() => { if (!started) { void w.terminate(); giveUp("timed out"); } }, 15_000);
    w.on("message", (m: WorkerReply) => {
      if ("type" in m) {
        if (!started) { started = true; clearTimeout(timer); crashes = 0; resolve(w); }
        return;
      }
      const done = pending.get(m.id);
      if (done) { pending.delete(m.id); done(m.verdict); }
    });
    w.on("error", (err) => { clearTimeout(timer); giveUp(err instanceof Error ? err.message : String(err)); });
    w.on("exit", (code) => { clearTimeout(timer); giveUp(`exit ${code}`); });
    w.unref();
  });
  worker = p;
  return p;
}

function callWorker(w: Worker, msg: WorkerMessage, transfer: ArrayBuffer[] = []): Promise<FaceVerdict> {
  return new Promise((resolve) => {
    const id = nextId++;
    // A check stuck past its limit: stop the worker at once (a new one starts on the
    // next check), so a hang costs one check, not 20 s of failed punches.
    const stuck = setTimeout(() => { if (pending.delete(id)) { resolve(UNAVAILABLE); void w.terminate(); } }, faceLimits.timeoutMs);
    pending.set(id, (v) => { clearTimeout(stuck); resolve(v); });
    w.postMessage({ ...msg, id }, transfer);
  });
}

/** Start loading the detector (in the worker, or here when there is none). Rejects when it can't run. */
export async function loadFaceModel(): Promise<void> {
  const w = await getWorker();
  if (!w) { await loadDetector(); return; }
  const v = await callWorker(w, { type: "load" });
  if (!v.ok) throw new Error("face detector failed to load");
}

/** One check at a time: the WebAssembly backend is single-threaded anyway. */
let queue: Promise<unknown> = Promise.resolve();

let waiting = 0;

async function detect(bytes: Buffer, opts: FaceCheckOptions): Promise<FaceVerdict> {
  const w = await getWorker();
  if (w) {
    // Copy the photo for the worker (a Buffer may share a pooled ArrayBuffer).
    const copy = new Uint8Array(bytes);
    return callWorker(w, { type: "detect", bytes: copy, opts }, [copy.buffer]);
  }
  // No worker: detection blocks the event loop (about 0.3 s each), so let the server breathe first.
  await new Promise((r) => setImmediate(r));
  return detectFace(bytes, opts);
}

/**
 * Is there a face in this JPEG? With `descriptor`, also describe it for face recognition.
 * The time limit counts from `startedAt` (when the punch arrived; default now), so
 * waiting behind other photos, and anything the request did first, is included.
 * A check that never got its turn in time answers "busy"; one that started but
 * didn't finish answers "unavailable".
 */
export function checkFaceJpeg(bytes: Buffer, opts: FaceCheckOptions = {}, startedAt = Date.now()): Promise<FaceVerdict> {
  if (waiting >= faceLimits.maxWaiting) return Promise.resolve({ ok: false, reason: "busy" });
  const deadline = startedAt + faceLimits.timeoutMs;
  const left = deadline - Date.now();
  if (left <= 0) return Promise.resolve({ ok: false, reason: "busy" });
  waiting++;
  let started = false;
  // Skip a check whose request has already timed out.
  const next = async (): Promise<FaceVerdict> => {
    if (Date.now() > deadline) return { ok: false, reason: "busy" };
    started = true;
    return detect(bytes, opts);
  };
  const run = queue.then(next, next).finally(() => { waiting--; });
  queue = run.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<FaceVerdict>((resolve) => {
    timer = setTimeout(() => {
      console.error(`[face] face check ${started ? "took" : "waited"} over ${faceLimits.timeoutMs} ms`);
      resolve(started ? UNAVAILABLE : { ok: false, reason: "busy" });
    }, left);
  });
  return Promise.race([run.catch((): FaceVerdict => UNAVAILABLE), timeout]).finally(() => clearTimeout(timer));
}
