// "Update now" from the app. The Linux installer (deploy/) watches
// DATA_DIR/update-request with a systemd path unit and runs `payroll update`
// as root; progress lands in DATA_DIR/update-status.json (see deploy/CONTRACT.md).
import fs from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { DATA_DIR } from "./config";
import { actorOf, audit } from "./audit";

const REQUEST = () => path.join(DATA_DIR, "update-request");
const STATUS = () => path.join(DATA_DIR, "update-status.json");
const PATH_UNIT = "/etc/systemd/system/payroll-update.path";

/** Installed with deploy/install.sh, so updates can be requested from here. */
export function updatesManaged(): boolean {
  return process.env.PAYROLL_MANAGED === "1" || fs.existsSync(PATH_UNIT) || fs.existsSync(STATUS());
}

export function readUpdateStatus(): { state: string; from?: string; to?: string; at?: string; message?: string } | null {
  try {
    const s = JSON.parse(fs.readFileSync(STATUS(), "utf8"));
    return s && typeof s.state === "string" ? s : null;
  } catch { return null; }
}

/** The running release's git commit (written by the installer as .release-sha). */
export function currentVersion(): string | null {
  const here = typeof __dirname === "string" ? [path.resolve(__dirname, "..")] : [];
  for (const dir of [process.cwd(), ...here]) {
    try { const v = fs.readFileSync(path.join(dir, ".release-sha"), "utf8").trim(); if (v) return v; } catch { /* next */ }
  }
  return null;
}

/**
 * Is an update request waiting? Only a regular file counts. Anything else at that
 * path (a directory, a symlink, a socket) is removed, so "Update now" can never be
 * wedged and never writes through a link.
 */
export function requestPending(): boolean {
  let st: fs.Stats;
  try { st = fs.lstatSync(REQUEST()); } catch { return false; }
  if (st.isFile()) {
    // A request nobody picked up (path unit stopped) would show "Updating…" forever.
    if (Date.now() - st.mtimeMs <= 50 * 60_000) return true;
  }
  try {
    if (st.isDirectory()) fs.rmSync(REQUEST(), { recursive: true, force: true });
    else fs.unlinkSync(REQUEST());
  } catch { /* leave it; reported as pending below */ return fs.existsSync(REQUEST()); }
  return false;
}

const h = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: (e?: unknown) => void) => {
  Promise.resolve(fn(req, res)).catch(next);
};

export function registerUpdateRoutes(app: Express) {
  app.get("/api/system/update", h((_req, res) => {
    const requested = requestPending();
    res.json({
      managed: updatesManaged(),
      version: currentVersion(),
      autoUpdate: process.env.AUTO_UPDATE === "1",
      requested,
      status: readUpdateStatus(),
    });
  }));
  app.post("/api/system/update", h((req, res) => {
    if (!updatesManaged()) {
      return res.status(409).json({ error: "Updates from the app need the Linux installer. On this server, update with git pull and a rebuild.", code: "not_managed" });
    }
    const st = readUpdateStatus();
    if (requestPending() || st?.state === "checking" || st?.state === "updating") {
      return res.json({ ok: true, alreadyRunning: true });
    }
    try {
      // "wx": create only; never follows a (dangling) symlink or reuses something planted there.
      fs.writeFileSync(REQUEST(), `${new Date().toISOString()}\n`, { mode: 0o640, flag: "wx" });
    } catch (err: any) {
      if (err?.code === "EEXIST") return res.json({ ok: true, alreadyRunning: true });
      throw err;
    }
    audit({ ...actorOf(req, res), action: "system.update", detail: "Update now" });
    res.json({ ok: true });
  }));
}
