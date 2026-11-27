// The server's face check: right answers, a timeout, and a cap on waiting checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import jpeg from "jpeg-js";
import { checkFaceJpeg, faceLimits, loadFaceModel, FACE_MIN_SCORE } from "../server/faceCheck";
import { detectionSize } from "../server/faceDetect";

const fixture = (f: string) => fs.readFileSync(path.join(import.meta.dirname, "fixtures", f));

test("face check: face, no face, bad image", async () => {
  await loadFaceModel();
  assert.equal((await checkFaceJpeg(fixture("face.jpg"))).ok, true);
  assert.deepEqual({ ...(await checkFaceJpeg(fixture("no-face.jpg"))), score: undefined }, { ok: false, reason: "no_face", score: undefined });
  assert.deepEqual(await checkFaceJpeg(Buffer.from("not a jpeg")), { ok: false, reason: "bad_image" });
});

test("face check: too many waiting answers busy, a slow check answers unavailable", async () => {
  await loadFaceModel();
  const saved = { ...faceLimits };
  try {
    faceLimits.maxWaiting = 3;
    const all = await Promise.all(Array.from({ length: 6 }, () => checkFaceJpeg(fixture("face.jpg"))));
    assert.equal(all.filter((v) => v.ok).length, 3);
    assert.equal(all.filter((v) => !v.ok && v.reason === "busy").length, 3);
    Object.assign(faceLimits, saved);
    // Each check takes about 0.3 s: with a limit of 1.5 checks the first passes and the ones waiting behind it time out
    const t0 = Date.now();
    await checkFaceJpeg(fixture("face.jpg"));
    faceLimits.timeoutMs = Math.round((Date.now() - t0) * 1.5);
    const slow = await Promise.all(Array.from({ length: 4 }, () => checkFaceJpeg(fixture("face.jpg"))));
    assert.equal(slow[0].ok, true);
    assert.deepEqual(slow.slice(2), [{ ok: false, reason: "unavailable" }, { ok: false, reason: "unavailable" }]);
    Object.assign(faceLimits, saved);
    // The queue recovers: the next check works normally
    assert.equal((await checkFaceJpeg(fixture("face.jpg"))).ok, true);
  } finally {
    Object.assign(faceLimits, saved);
  }
});

test("face check: 20 photo punches at the same moment all get checked", async () => {
  await loadFaceModel();
  assert.ok(faceLimits.maxWaiting >= 30, "room for a crowd at the start of a shift");
  const all = await Promise.all(Array.from({ length: 20 }, () => checkFaceJpeg(fixture("face.jpg"))));
  assert.equal(all.filter((v) => !v.ok && v.reason === "busy").length, 0);
  assert.equal(all.filter((v) => v.ok).length, 20);
});

/** A fixture face of `face` px square, centred in a blank `w` x `h` frame (like a kiosk photo of someone far from the camera). */
function framed(file: string, face: number, w = 320, h = 240): Buffer {
  const src = jpeg.decode(fixture(file), { useTArray: true });
  const data = new Uint8Array(w * h * 4).fill(120);
  const ox = Math.round((w - face) / 2), oy = Math.round((h - face) / 2);
  for (let y = 0; y < face; y++) for (let x = 0; x < face; x++) {
    const si = (Math.min(src.height - 1, Math.floor((y * src.height) / face)) * src.width + Math.min(src.width - 1, Math.floor((x * src.width) / face))) * 4;
    const di = ((oy + y) * w + ox + x) * 4;
    data.set(src.data.subarray(si, si + 3), di);
  }
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data);
}

test("face check: a small face in a wide frame is found, a non-face still isn't", async () => {
  await loadFaceModel();
  assert.equal(FACE_MIN_SCORE, 0.5);
  for (const size of [80, 60, 50, 40]) {
    const v = await checkFaceJpeg(framed("face-4.jpg", size));
    assert.equal(v.ok, true, `${size} px face: ${JSON.stringify(v)}`);
  }
  assert.equal((await checkFaceJpeg(framed("face-2.jpg", 40))).ok, true);
  // Not faces: a blank frame, a scene, a palm
  const blank = jpeg.encode({ data: new Uint8Array(320 * 240 * 4).fill(128), width: 320, height: 240 }, 90).data;
  assert.equal((await checkFaceJpeg(Buffer.from(blank))).ok, false);
  for (const f of ["no-face.jpg", "palm.jpg"]) {
    const v = await checkFaceJpeg(fixture(f));
    assert.deepEqual({ ok: v.ok, reason: !v.ok && v.reason }, { ok: false, reason: "no_face" }, f);
  }
});

test("face check: big photos are shrunk before detection", () => {
  assert.deepEqual(detectionSize(320, 240), { width: 320, height: 240 });
  assert.deepEqual(detectionSize(2000, 2000), { width: 640, height: 640 });
  assert.deepEqual(detectionSize(1600, 800), { width: 640, height: 320 });
  assert.deepEqual(detectionSize(300, 1200), { width: 160, height: 640 });
});

test("face check: detection doesn't block the server's event loop", async () => {
  await loadFaceModel();
  // A 2000x2000 photo used to block the loop for over a second; checks used to block it for 0.3 s each
  const big = Buffer.from(jpeg.encode({ data: new Uint8Array(2000 * 2000 * 4).fill(128), width: 2000, height: 2000 }, 50).data);
  let worst = 0, last = Date.now();
  const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 10);
  try {
    const all = await Promise.all([checkFaceJpeg(big), checkFaceJpeg(fixture("face.jpg")), checkFaceJpeg(fixture("face-2.jpg"), { descriptor: true })]);
    assert.equal(all[0].ok, false);
    assert.equal(all[1].ok, true);
    assert.equal(all[2].ok, true);
  } finally {
    clearInterval(timer);
  }
  assert.ok(worst < 150, `the event loop stalled for ${worst} ms`);
});
