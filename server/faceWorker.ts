// Worker thread for the face check (see server/faceCheck.ts): detection takes
// about 0.3 s of CPU per photo, which would stall every other request if it ran
// on the server's main thread. Built as its own file next to dist/index.cjs.
import { parentPort } from "node:worker_threads";
import { detectFace, loadDetector, type FaceCheckOptions, type FaceVerdict } from "./faceDetect";

export type WorkerMessage = { type: "load" } | { type: "detect"; bytes: Uint8Array; opts: FaceCheckOptions };
export type WorkerRequest = WorkerMessage & { id: number };
export type WorkerReply = { type: "ready" } | { id: number; verdict: FaceVerdict };

const port = parentPort;
if (port) {
  port.postMessage({ type: "ready" } satisfies WorkerReply);
  port.on("message", async (m: WorkerRequest) => {
    let verdict: FaceVerdict;
    try {
      verdict = m.type === "load"
        ? await loadDetector().then((): FaceVerdict => ({ ok: true, score: 1 }), (): FaceVerdict => ({ ok: false, reason: "unavailable" }))
        : await detectFace(m.bytes, m.opts);
    } catch (err) {
      console.error("[face] detection failed:", err);
      verdict = { ok: false, reason: "unavailable" };
    }
    port.postMessage({ id: m.id, verdict } satisfies WorkerReply);
  });
}
