import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { purgeTrash, registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { closeDatabase, initDatabase } from "./db";
import { announceSetupCode } from "./auth";
import { hardenBackupFiles, scheduleBackups, stopBackups } from "./backup";
import { hardenAuditFiles } from "./audit";
import { securityHeaders } from "./security";
import { runAdminCliAndExit } from "./cli";
import { endLiveStreams } from "./live";
import { startAutoCloseJob, stopAutoCloseJob } from "./timeclock";
import { SHARE_PATH } from "./share";
import { getPinKey } from "./config";

// Say at start-up (not on the first PIN change) when PIN_KEY is unusable.
if (process.env.PIN_KEY) {
  try { getPinKey(); } catch (err) { console.error(`[config] ${(err as Error).message} Setting or changing employee PINs fails until this is fixed.`); }
}

const app = express();
const httpServer = createServer(app);
// Trust X-Forwarded-For only from a proxy on this machine (cloudflared, nginx).
// Set TRUST_PROXY to change it (e.g. "1" behind one remote proxy).
app.set("trust proxy", process.env.TRUST_PROXY ?? "loopback");
app.disable("x-powered-by");
app.use(securityHeaders(process.env.NODE_ENV === "production"));

app.use((req, res, next) => {
  // These routes read bigger bodies with their own parser.
  if (req.path.startsWith("/api/backup/restore") || req.path.startsWith("/api/import/pdf") || SHARE_PATH.test(req.path)) return next();
  return express.json({ limit: "8mb" })(req, res, next);
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    if (req.path.startsWith("/api")) console.log(`[api] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
process.on("uncaughtException", (err) => {
  // State may be corrupt: log, close the database cleanly, and let the
  // service manager (systemd) start a fresh process.
  console.error("[uncaughtException]", err);
  shutdown("uncaughtException", 1);
});

let stopping = false;
function shutdown(reason: string, code = 0) {
  if (stopping) return;
  stopping = true;
  console.log(`[server] shutting down (${reason})`);
  stopBackups();
  stopAutoCloseJob();
  endLiveStreams();
  const force = setTimeout(() => {
    closeDatabase();
    process.exit(code);
  }, 10_000);
  force.unref();
  httpServer.close(() => {
    closeDatabase();
    process.exit(code);
  });
  httpServer.closeIdleConnections?.();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

(async () => {
  // `node dist/index.cjs admin ...`: operator commands, no web server.
  if (process.argv[2] === "admin") return runAdminCliAndExit(process.argv.slice(3));
  await initDatabase();
  hardenBackupFiles();
  hardenAuditFiles();
  registerRoutes(app);
  if (process.env.NODE_ENV === "production") serveStatic(app);
  else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }
  const port = parseInt(process.env.PORT || "5000", 10);
  const host = process.env.HOST || "0.0.0.0";
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") console.error(`[server] port ${port} is already in use. Set PORT to another value.`);
    else console.error("[server]", err);
    process.exit(1);
  });
  httpServer.listen({ port, host }, () => console.log(`serving on http://${host}:${port}`));

  await announceSetupCode().catch(() => undefined);
  scheduleBackups();
  startAutoCloseJob(); // closes shifts left open past each location's auto clock-out time
  const daily = () => purgeTrash().catch((err) => console.error("[trash] purge failed:", err.message));
  setTimeout(daily, 60_000).unref();
  setInterval(daily, 24 * 60 * 60_000).unref();
})();
