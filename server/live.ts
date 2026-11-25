// Live updates for the admin app over Server-Sent Events.
//
// EventSource cannot send an Authorization header, so the admin app first asks
// for a short-lived signed ticket (POST /api/live/ticket, admin session) and
// passes it as ?ticket=… when opening GET /api/live.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { getAuthSecret } from "./config";
import { currentUser, requestToken, verifyToken } from "./auth";
import { isAdmin } from "./users";

export const HEARTBEAT_MS = 25_000;
/**
 * A client whose unsent data grows past this is stalled (asleep laptop, dead
 * tunnel): it is disconnected instead of buffering events in memory forever.
 * EventSource reconnects by itself and reloads the current state.
 */
export const MAX_BUFFERED_BYTES = Math.max(16 * 1024, Number.parseInt(process.env.LIVE_MAX_BUFFER_BYTES || "", 10) || 512 * 1024);
const TICKET_MS = 60_000;

export interface LiveEvent { type: string; siteId?: string; [k: string]: unknown }

/** sites: location ids this client may see (null = all). */
interface Client { res: Response; timer: NodeJS.Timeout; sites: string[] | null }
const clients = new Set<Client>();
const listeners = new Set<(e: LiveEvent) => void>();

function drop(c: Client) {
  clearInterval(c.timer);
  clients.delete(c);
  try { c.res.destroy(); } catch { /* already gone */ }
}

/** Write to one client, dropping it when its backlog is too large (backpressure). */
function send(c: Client, msg: string) {
  if (c.res.destroyed || c.res.writableLength > MAX_BUFFERED_BYTES) return drop(c);
  try { c.res.write(msg); } catch { return drop(c); }
  if (c.res.writableLength > MAX_BUFFERED_BYTES) drop(c);
}

/** Send an event to every connected admin app (and in-process listeners). */
export function broadcast(event: LiveEvent) {
  const msg = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const c of [...clients]) {
    if (c.sites && event.siteId && !c.sites.includes(event.siteId)) continue;
    send(c, msg);
  }
  for (const l of listeners) {
    try { l(event); } catch { /* ignore */ }
  }
}

export function onLiveEvent(fn: (e: LiveEvent) => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function liveClientCount() { return clients.size; }

/** Close every stream (server shutdown), so the HTTP server can stop promptly. */
export function endLiveStreams() {
  for (const c of clients) {
    clearInterval(c.timer);
    try { c.res.end(); } catch { /* ignore */ }
  }
  clients.clear();
}

const sign = (payload: string) => createHmac("sha256", getAuthSecret()).update(`live:${payload}`).digest("base64url");

export function issueLiveTicket(sites: string[] | null = null): { ticket: string; expiresAt: number } {
  const expiresAt = Date.now() + TICKET_MS;
  const payload = Buffer.from(JSON.stringify({ p: "live", exp: expiresAt, s: sites })).toString("base64url");
  return { ticket: `${payload}.${sign(payload)}`, expiresAt };
}

/** Returns the ticket's allowed locations (null = all), or false when invalid. */
export function verifyLiveTicket(ticket: string | undefined): string[] | null | false {
  if (!ticket) return false;
  const [payload, sig] = ticket.split(".");
  if (!payload || !sig) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data.p !== "live" || typeof data.exp !== "number" || data.exp <= Date.now()) return false;
    return Array.isArray(data.s) ? data.s.map(String) : null;
  } catch {
    return false;
  }
}

const userSites = (u: { role: string; siteIds: string[] }) => (isAdmin(u as any) || !u.siteIds.length ? null : u.siteIds);

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

/**
 * Registers POST /api/live/ticket (admin session) and GET /api/live.
 * GET /api/live must be listed as public in the global auth middleware: it
 * checks the ticket (or an admin bearer token) itself.
 */
export function registerLiveRoutes(app: Express) {
  app.post("/api/live/ticket", h(async (_req, res) => {
    const user = currentUser(res);
    res.json(issueLiveTicket(user ? userSites(user) : null));
  }));

  app.get("/api/live", h(async (req, res) => {
    const ticket = typeof req.query.ticket === "string" ? req.query.ticket : undefined;
    // A ticket, or the signed-in session (cookie or bearer token).
    let sites: string[] | null | false = verifyLiveTicket(ticket);
    if (sites === false) {
      const session = await verifyToken(requestToken(req));
      sites = session ? userSites(session.user) : false;
    }
    if (sites === false) return res.status(401).json({ error: "This live connection has expired. Reconnecting…" });

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // nginx / some proxies: do not buffer
    res.flushHeaders?.();
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);

    res.write(`retry: 3000\n\n`);
    res.write(`event: hello\ndata: ${JSON.stringify({ type: "hello", at: new Date().toISOString() })}\n\n`);
    const client: Client = {
      res,
      sites,
      timer: setInterval(() => send(client, `: ping ${Date.now()}\n\n`), HEARTBEAT_MS),
    };
    client.timer.unref?.();
    clients.add(client);
    const done = () => { clearInterval(client.timer); clients.delete(client); };
    req.on("close", done);
    res.on("error", done);
  }));
}
