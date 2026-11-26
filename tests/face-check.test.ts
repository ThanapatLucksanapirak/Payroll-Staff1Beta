// The server's face check: right answers, a timeout, and a cap on waiting checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkFaceJpeg, faceLimits, loadFaceModel } from "../server/faceCheck";

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
    // Each check takes about 0.3 s: with a 0.2 s limit the first passes and the ones waiting behind it time out
    faceLimits.timeoutMs = 200;
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
