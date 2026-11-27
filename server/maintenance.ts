// A pause on changes while a backup restore or a database switch runs.
//
// Both read the whole database, then write it somewhere (back over itself, or
// into the new database). Anything saved in between, such as a punch from the
// time clock, would be missing afterwards even though it was confirmed. So for
// the length of a restore or switch, every other change is refused with a
// short 503 "try again" (no `code`, so the time clock keeps the punch and sends
// it again a moment later), and the restore or switch first waits for changes
// already under way to finish.
import type { NextFunction, Request, Response } from "express";

let active: string | null = null;
let inFlight = 0;
const waiters = new Set<() => void>();

/**
 * drainMs: how long a restore or switch waits for changes already under way before giving up.
 * requestMs: a change still running after this long stops counting as under way (a hung
 * request would otherwise block every restore and switch until a restart).
 */
export const maintenanceLimits = { drainMs: 15_000, requestMs: 60_000 };

export class MaintenanceError extends Error {
  status = 409;
  code = "maintenance";
}

/** What's running ("restore", "switch"), or null. */
export function maintenanceActive(): string | null {
  return active;
}

function notify() {
  for (const w of [...waiters]) w();
}

/**
 * Run `fn` with all other changes paused. Throws a 409 when another restore or
 * switch is already running, and a 503 when changes already under way don't
 * finish in time (nothing was changed then).
 */
export async function withMaintenance<T>(what: string, fn: () => Promise<T>): Promise<T> {
  if (active) throw Object.assign(new MaintenanceError(`A ${active === "switch" ? "database switch" : "restore"} is already running. Wait for it to finish, then try again.`));
  active = what;
  try {
    if (inFlight > 0) {
      const drained = await new Promise<boolean>((resolve) => {
        const check = () => { if (inFlight === 0) { cleanup(); resolve(true); } };
        const timer = setTimeout(() => { cleanup(); resolve(false); }, maintenanceLimits.drainMs);
        const cleanup = () => { clearTimeout(timer); waiters.delete(check); };
        waiters.add(check);
        check();
      });
      if (!drained) throw Object.assign(new Error("The app is busy saving other changes, so nothing was changed. Try again in a moment."), { status: 503 });
    }
    return await fn();
  } finally {
    active = null;
  }
}

const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Express middleware for /api: counts changes under way, and refuses new ones
 * while a restore or switch runs. `exempt` paths (the restore and switch routes
 * themselves, sign-in and sign-out) pass through uncounted.
 */
export function maintenanceGate(exempt: (path: string) => boolean) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!WRITE.has(req.method) || exempt(req.path)) return next();
    if (active) {
      res.setHeader("Retry-After", "5");
      // No `code`: the time clock treats a 5xx without one as "no answer" and keeps the punch to send again.
      return res.status(503).json({ error: `A ${active === "switch" ? "database switch" : "backup restore"} is running. Please try again in a moment.`, busy: true });
    }
    const finish = hold(`${req.method} ${req.originalUrl ?? req.path}`);
    res.once("finish", finish);
    res.once("close", finish);
    next();
  };
}

/** Count one change as under way. Returns the function that ends it (safe to call twice). */
function hold(label: string): () => void {
  inFlight++;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    inFlight--;
    if (inFlight === 0) notify();
  };
  const timer = setTimeout(() => {
    if (done) return;
    console.warn(`[maintenance] ${label} is still running after ${Math.round(maintenanceLimits.requestMs / 1000)} s; no longer waiting for it before a restore or database switch`);
    finish();
  }, maintenanceLimits.requestMs);
  timer.unref?.();
  return finish;
}

/**
 * Run background work that changes data (e.g. automatic clock-out) as a change
 * under way: a restore or switch waits for it. Skipped (returns null) while one
 * is running.
 */
export async function asChange<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  if (active) return null;
  const finish = hold(label);
  try { return await fn(); } finally { finish(); }
}

/** For tests. */
export function maintenanceState() {
  return { active, inFlight };
}
