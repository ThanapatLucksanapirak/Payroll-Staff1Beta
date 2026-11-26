// Settings → About: the installed version, when it was installed, and the
// version history (merged changes, with plain-language notes from CHANGELOG.md).
//
// Where the history comes from, first that works:
//  1. .release-history next to .release-sha (written by deploy/lib/common.sh build_release)
//  2. the installer's mirror clone (/opt/payroll/repo), read with git
//  3. a .git folder in the app directory (development checkouts)
// CHANGELOG.md ships inside every release, so its notes show even when none of these do.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { Express, Request, Response } from "express";
import { updatesManaged, readUpdateStatus, currentVersion } from "./updates";

export interface HistoryEntry {
  sha: string;
  date: string | null;
  title: string;
  pr: number | null;
  notes: string[];
}

export interface ChangelogEntry {
  pr: number | null;
  date: string | null;
  title: string;
  notes: string[];
}

const SHA = /^[0-9a-f]{7,40}$/i;
const FIELD = "\x1f";
const RECORD = "\x1e";
/** git log --format for .release-history and the git fallbacks. */
export const HISTORY_FORMAT = "%H%x1f%cI%x1f%s%x1f%b%x1e";
const MAX_ENTRIES = 200;

const payrollRoot = () => process.env.PAYROLL_ROOT || "/opt/payroll";

/** Folders that may hold the running release (its .release-sha, CHANGELOG.md, …). */
function appDirs(): string[] {
  const here = typeof __dirname === "string" ? [path.resolve(__dirname, "..")] : [];
  return [...new Set([process.cwd(), ...here])];
}

function readFirst(name: string): { dir: string; text: string } | null {
  for (const dir of appDirs()) {
    try { return { dir, text: fs.readFileSync(path.join(dir, name), "utf8") }; } catch { /* next */ }
  }
  return null;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

const MERGE_PR = /^Merge pull request #(\d+)\b/;
const NOISE = /^Merge (branch|remote-tracking branch) /;
const TRAILER = /^(Co-Authored-By|Claude-Session|Signed-off-by):/i;

/** Parses `git log --format=HISTORY_FORMAT` output into one entry per change on the branch. */
export function parseHistory(raw: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const rec of raw.split(RECORD)) {
    const [sha, date, subject = "", body = ""] = rec.replace(/^\s+/, "").split(FIELD);
    if (!sha || !SHA.test(sha.trim())) continue;
    if (NOISE.test(subject)) continue;
    const lines = body.split("\n").map((l) => l.trim()).filter((l) => l && !TRAILER.test(l));
    const m = MERGE_PR.exec(subject);
    out.push({
      sha: sha.trim(),
      date: date?.trim() || null,
      title: (m ? lines[0] : subject.trim()) || subject.trim(),
      pr: m ? Number(m[1]) : null,
      notes: [],
    });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

/**
 * CHANGELOG.md: one `## ` heading per update, bullets under it.
 *   ## 2026-11-25 · Accountant role and email notifications (#13)
 *   - Accountants only see payroll you publish.
 */
export function parseChangelog(md: string): ChangelogEntry[] {
  const out: ChangelogEntry[] = [];
  let cur: ChangelogEntry | null = null;
  for (const line of md.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      let title = h[1];
      let date: string | null = null;
      let pr: number | null = null;
      const d = /^(\d{4}-\d{2}-\d{2})\s*[·•\-–—:|]\s*/.exec(title);
      if (d) { date = d[1]; title = title.slice(d[0].length); }
      const p = /\s*\(#(\d+)\)\s*$/.exec(title);
      if (p) { pr = Number(p[1]); title = title.slice(0, p.index); }
      cur = { pr, date, title: title.trim(), notes: [] };
      out.push(cur);
      continue;
    }
    const b = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (b && cur) cur.notes.push(b[1]);
  }
  return out.filter((e) => e.title);
}

// ── Sources ───────────────────────────────────────────────────────────────────

function git(args: string[], cwd?: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) => resolve(err ? null : stdout));
  });
}

let cached: { key: string; at: number; value: HistoryEntry[] | null } | null = null;

async function loadHistory(sha: string | null): Promise<{ entries: HistoryEntry[]; source: string } | null> {
  const file = readFirst(".release-history");
  if (file) return { entries: parseHistory(file.text), source: "release" };

  const key = sha ?? "HEAD";
  // A missing history is looked up again after a minute; a found one is kept until the version changes.
  if (cached && cached.key === key && (cached.value || Date.now() - cached.at < 60_000)) {
    return cached.value ? { entries: cached.value, source: "git" } : null;
  }
  const ref = sha && SHA.test(sha) ? sha : "HEAD";
  const log = ["log", "--first-parent", `-n${MAX_ENTRIES}`, `--format=${HISTORY_FORMAT}`, ref, "--"];
  let raw: string | null = null;
  const mirror = path.join(payrollRoot(), "repo");
  if (sha && fs.existsSync(mirror)) raw = await git(["-c", "safe.directory=*", "-C", mirror, ...log]);
  if (raw === null) {
    for (const dir of appDirs()) {
      if (!fs.existsSync(path.join(dir, ".git"))) continue;
      raw = await git(["-c", "safe.directory=*", "-C", dir, ...log]);
      if (raw !== null) break;
    }
  }
  const value = raw ? parseHistory(raw) : null;
  cached = { key, at: Date.now(), value: value?.length ? value : null };
  return cached.value ? { entries: cached.value, source: "git" } : null;
}

/** When the running release was switched on (the installer's `current` link), else when it was built. */
function installedAt(): string | null {
  try {
    const link = path.join(payrollRoot(), "current");
    const target = fs.realpathSync(link);
    if (appDirs().some((d) => { try { return fs.realpathSync(d) === target; } catch { return false; } })) {
      return fs.lstatSync(link).mtime.toISOString();
    }
  } catch { /* not installed with deploy/ */ }
  for (const dir of appDirs()) {
    try { return fs.statSync(path.join(dir, ".release-sha")).mtime.toISOString(); } catch { /* next */ }
  }
  return null;
}

function previousVersion(): string | null {
  try {
    const v = fs.readFileSync(path.join(payrollRoot(), "previous", ".release-sha"), "utf8").trim();
    return SHA.test(v) ? v : null;
  } catch { return null; }
}

/** https://github.com/owner/repo for links, only when REPO_URL points at GitHub (credentials stripped). */
export function repoWebUrl(raw = process.env.REPO_URL ?? ""): string | null {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(raw.trim());
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

function appVersion(): string | null {
  const pkg = readFirst("package.json");
  try { const v = pkg ? JSON.parse(pkg.text).version : null; return typeof v === "string" ? v : null; } catch { return null; }
}

const h = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: (e?: unknown) => void) => {
  Promise.resolve(fn(req, res)).catch(next);
};

export function registerAboutRoutes(app: Express) {
  app.get("/api/system/about", h(async (_req, res) => {
    const version = currentVersion();
    const history = await loadHistory(version);
    const changelogFile = readFirst("CHANGELOG.md");
    const changelog = changelogFile ? parseChangelog(changelogFile.text) : [];

    // Attach the changelog's plain-language notes to the matching merged change.
    const entries = history?.entries.map((e) => ({ ...e })) ?? [];
    const byPr = new Map(entries.filter((e) => e.pr != null).map((e) => [e.pr!, e]));
    const unmatched: ChangelogEntry[] = [];
    for (const c of changelog) {
      const hit = c.pr != null ? byPr.get(c.pr) : undefined;
      if (hit) { hit.notes = c.notes; if (c.title) hit.title = c.title; }
      else unmatched.push(c);
    }
    const current = version ?? entries[0]?.sha ?? null;
    const head = entries.find((e) => current && e.sha.startsWith(current.slice(0, 7)));

    res.json({
      appVersion: appVersion(),
      version: current,
      committedAt: head?.date ?? null,
      installedAt: installedAt(),
      runningSince: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      previousVersion: previousVersion(),
      managed: updatesManaged(),
      autoUpdate: process.env.AUTO_UPDATE === "1",
      status: readUpdateStatus(),
      repoUrl: repoWebUrl(),
      historySource: history?.source ?? null,
      history: entries,
      // Changelog notes with no matching merged change (or all of them when there is no history).
      changelog: history ? unmatched.filter((c) => c.pr == null) : changelog,
    });
  }));
}
