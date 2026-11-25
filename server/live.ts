// Live updates for the admin app over Server-Sent Events.
//
// EventSource cannot send an Authorization header, so the admin app first asks
// for a short-lived signed ticket (POST /api/live/ticket, admin session) and
// passes it as ?ticket=… when opening GET /api/live.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { getAuthSecret } from "./config";
import { verifyToken } from "./auth";

export const HEARTBEAT_MS = 25_000;
const TICKET_MS = 60_000;

export interface LiveEvent { type: string; siteId?: string; [k: string]: unknown }

interface Client { res: Response; timer: NodeJS.Timeout }
const clients = new Set<Client>();
const listeners = new Set<(e: LiveEvent) => void>();

/** Send an event to every connected admin app (and in-process listeners). */
export function broadcast(event: LiveEvent) {
  const msg = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) {
    try { c.res.write(msg); } catch { /* closed */ }
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

export function issueLiveTicket(): { ticket: string; expiresAt: number } {
  const expiresAt = Date.now() + TICKET_MS;
  const payload = Buffer.from(JSON.stringify({ p: "live", exp: expiresAt })).toString("base64url");
  return { ticket: `${payload}.${sign(payload)}`, expiresAt };
}

export function verifyLiveTicket(ticket: string | undefined): boolean {
  if (!ticket) return false;
  const [payload, sig] = ticket.split(".");
  if (!payload || !sig) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.p === "live" && typeof data.exp === "number" && data.exp > Date.now();
  } catch {
    return false;
  }
}

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

/**
 * Registers POST /api/live/ticket (admin session) and GET /api/live.
 * GET /api/live must be listed as public in the global auth middleware: it
 * checks the ticket (or an admin bearer token) itself.
 */
export function registerLiveRoutes(app: Express) {
  app.post("/api/live/ticket", h(async (_req, res) => {
    res.json(issueLiveTicket());
  }));

  app.get("/api/live", h(async (req, res) => {
    const ticket = typeof req.query.ticket === "string" ? req.query.ticket : undefined;
    const bearer = req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const ok = verifyLiveTicket(ticket) || (await verifyToken(bearer));
    if (!ok) return res.status(401).json({ error: "This live connection has expired. Reconnecting…" });

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
      timer: setInterval(() => { try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* closed */ } }, HEARTBEAT_MS),
    };
    client.timer.unref?.();
    clients.add(client);
    const done = () => { clearInterval(client.timer); clients.delete(client); };
    req.on("close", done);
    res.on("error", done);
  }));
}
