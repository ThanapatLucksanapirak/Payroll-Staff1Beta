// Settings → About: installed version, history parsing and CHANGELOG.md notes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payroll-about-"));
process.env.DATA_DIR = dir;
process.env.PAYROLL_ROOT = path.join(dir, "opt"); // never read the real /opt/payroll
process.env.BACKUPS = "off";
process.env.SETUP_CODE = "ABCDE-FGHJK";
delete process.env.SUPABASE_URL;
delete process.env.PAYROLL_MANAGED;

const F = "\x1f", R = "\x1e";

test("history: PR merges use the PR title, branch merges are skipped, trailers dropped", async () => {
  const { parseHistory } = await import("../server/about");
  const raw = [
    `${"a".repeat(40)}${F}2026-11-25T20:27:45-05:00${F}Merge pull request #10 from me/installer-polish${F}Update now button\n\nCo-Authored-By: X <x@y>\n${R}`,
    `\n${"b".repeat(40)}${F}2026-11-25T19:00:00-05:00${F}Merge branch 'main' into x${F}${R}`,
    `\n${"c".repeat(40)}${F}2026-11-25T12:09:22+00:00${F}Import source${F}Co-Authored-By: X <x@y>\n${R}\n`,
  ].join("");
  const h = parseHistory(raw);
  assert.equal(h.length, 2);
  assert.deepEqual(h[0], { sha: "a".repeat(40), date: "2026-11-25T20:27:45-05:00", title: "Update now button", pr: 10, notes: [] });
  assert.equal(h[1].title, "Import source");
  assert.equal(h[1].pr, null);
  assert.deepEqual(parseHistory(""), []);
  assert.deepEqual(parseHistory("garbage"), []);
});

test("changelog: date, title, PR number and bullets", async () => {
  const { parseChangelog } = await import("../server/about");
  const c = parseChangelog("# What's new\n\nIntro text.\n\n## 2026-11-25 · Accountant role (#13)\n- One\n* Two\n\n## Unreleased tweaks\n- Three\n");
  assert.deepEqual(c, [
    { pr: 13, date: "2026-11-25", title: "Accountant role", notes: ["One", "Two"] },
    { pr: null, date: null, title: "Unreleased tweaks", notes: ["Three"] },
  ]);
  // The shipped CHANGELOG.md parses and every entry has notes
  const real = parseChangelog(fs.readFileSync(path.join(process.cwd(), "CHANGELOG.md"), "utf8"));
  assert.ok(real.length > 5);
  for (const e of real) { assert.ok(e.pr && e.date, e.title); assert.ok(e.notes.length, e.title); }
});

test("repo links only for GitHub, never with credentials", async () => {
  const { repoWebUrl } = await import("../server/about");
  assert.equal(repoWebUrl("https://github.com/Owner/Repo.git"), "https://github.com/Owner/Repo");
  assert.equal(repoWebUrl("https://x-access-token:secret@github.com/Owner/Repo"), "https://github.com/Owner/Repo");
  assert.equal(repoWebUrl("git@github.com:Owner/Repo.git"), "https://github.com/Owner/Repo");
  assert.equal(repoWebUrl("https://gitlab.com/Owner/Repo"), null);
  assert.equal(repoWebUrl(""), null);
});

let base = "";
let server: Server;
let cookie = "";
async function call(url: string, auth = true) {
  const res = await fetch(base + url, { headers: auth && cookie ? { Cookie: cookie, "X-Requested-With": "payroll" } : { "X-Requested-With": "payroll" } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  const express = (await import("express")).default;
  const { createServer } = await import("node:http");
  const routes = await import("../server/routes");
  const { initDatabase } = await import("../server/db");
  await initDatabase();
  const app = express();
  app.use(express.json());
  routes.registerRoutes(app);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const res = await fetch(base + "/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "payroll" }, body: JSON.stringify({ username: "owner", password: "correct horse", setupCode: "ABCDE-FGHJK" }) });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
});
after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  (await import("../server/db")).closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("GET /api/system/about: signed-in admins only, with version, status and notes", async () => {
  assert.equal((await call("/api/system/about", false)).status, 401);
  fs.writeFileSync(path.join(dir, "update-status.json"), JSON.stringify({ state: "ok", from: "a".repeat(40), to: "a".repeat(40), at: new Date().toISOString(), message: "Already up to date" }));
  const r = await call("/api/system/about");
  assert.equal(r.status, 200);
  assert.equal(r.body.appVersion, JSON.parse(fs.readFileSync("package.json", "utf8")).version);
  assert.equal(r.body.status.message, "Already up to date");
  assert.equal(r.body.managed, true, "a status file means the installer manages this server");
  assert.ok(Array.isArray(r.body.history) && Array.isArray(r.body.changelog));
  if (fs.existsSync(".git") && r.body.history.length) {
    // In a git checkout the history comes from git, and CHANGELOG notes land on the matching PR.
    const withNotes = r.body.history.filter((e: { notes: string[] }) => e.notes.length);
    const prs = r.body.history.filter((e: { pr: number | null }) => e.pr != null);
    if (prs.length) assert.ok(withNotes.length, "changelog notes matched to merged PRs");
  } else {
    assert.ok(r.body.changelog.length, "without history, the changelog is shown on its own");
  }
});
