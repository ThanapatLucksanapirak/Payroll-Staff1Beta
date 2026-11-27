// Updater safety (stability run 3): a new version must stay healthy for a while,
// not answer once and crash, and a build missing files (or with files that don't
// match the build's checksums) is never switched to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const common = path.join(import.meta.dirname, "..", "deploy", "lib", "common.sh");

/** Run bash with common.sh loaded, health checks answering from `answers` (1 = OK), and no real sleeping. */
function waitHealthy(answers: string, args: string): number {
  const script = `
    source "${common}"
    sleep() { :; }
    n=0; answers="${answers}"
    health_ok() { local a="\${answers:n:1}"; n=$((n + 1)); [[ "$a" == 1 ]]; }
    wait_healthy ${args} && echo ok || echo fail
  `;
  return execFileSync("bash", ["-c", script], { encoding: "utf8" }).trim().endsWith("ok") ? 1 : 0;
}

test("wait_healthy without a stable period accepts the first OK (as before)", () => {
  assert.equal(waitHealthy("0001", "10"), 1);
  assert.equal(waitHealthy("0000", "4"), 0);
});

test("wait_healthy with a stable period rejects a version that answers once and then crashes", () => {
  // OK once, then down for good: not healthy.
  assert.equal(waitHealthy("1000000000", "10 3"), 0);
  // OK for 4 checks in a row (first + 3 s): healthy.
  assert.equal(waitHealthy("1111", "10 3"), 1);
  // A blip restarts the count.
  assert.equal(waitHealthy("11011110", "8 3"), 1);
  assert.equal(waitHealthy("110110110", "9 3"), 0);
});

function release(files: Record<string, string>, opts: { sums?: boolean; worker?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-release-"));
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  if (opts.worker) { fs.mkdirSync(path.join(dir, "server"), { recursive: true }); fs.writeFileSync(path.join(dir, "server", "faceWorker.ts"), ""); }
  if (opts.sums) execFileSync("bash", ["-c", "find dist -type f ! -name SHA256SUMS | sort | xargs sha256sum > dist/SHA256SUMS"], { cwd: dir });
  return dir;
}
const problem = (dir: string) => execFileSync("bash", ["-c", `source "${common}"; release_problem "${dir}"`], { encoding: "utf8" }).trim();

test("release_problem: a complete build passes; missing or changed files don't", () => {
  const full = { "dist/index.cjs": "x", "dist/faceWorker.cjs": "w", "dist/public/index.html": "<html>", "dist/public/assets/a.js": "a" };
  const good = release(full, { sums: true, worker: true });
  assert.equal(problem(good), "");

  const noWorker = release({ ...full, "dist/faceWorker.cjs": "" }, { worker: true });
  assert.match(problem(noWorker), /faceWorker\.cjs is missing/);

  const changed = release(full, { sums: true, worker: true });
  fs.writeFileSync(path.join(changed, "dist/public/assets/a.js"), "tampered");
  assert.match(problem(changed), /don't match/);

  const gone = release(full, { sums: true, worker: true });
  fs.rmSync(path.join(gone, "dist/public/assets/a.js"));
  assert.match(problem(gone), /don't match/);

  // An older version (no worker, no checksums) only needs its own files.
  const old = release({ "dist/index.cjs": "x", "dist/public/index.html": "<html>" });
  assert.equal(problem(old), "");
  for (const d of [good, noWorker, changed, gone, old]) fs.rmSync(d, { recursive: true, force: true });
});
