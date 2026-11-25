import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { purgeTrash, registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { closeDatabase, initDatabase } from "./db";
import { announceSetupCode } from "./auth";
import { scheduleBackups, stopBackups } from "./backup";
import { securityHeaders } from "./security";
import { runAdminCliAndExit } from "./cli";

const app = express();
const httpServer = createServer(app);
// Trust X-Forwarded-For only from a proxy on this machine (cloudflared, nginx).
// Set TRUST_PROXY to change it (e.g. "1" behind one remote proxy).
app.set("trust proxy", process.env.TRUST_PROXY ?? "loopback");
app.disable("x-powered-by");
app.use(securityHeaders(process.env.NODE_ENV === "production"));

app.use((req, res, next) => {
  if (req.path.startsWith("/api/backup/restore") || req.path.startsWith("/api/import/pdf")) return next();
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
  const daily = () => purgeTrash().catch((err) => console.error("[trash] purge failed:", err.message));
  setTimeout(daily, 60_000).unref();
  setInterval(daily, 24 * 60 * 60_000).unref();
})();
