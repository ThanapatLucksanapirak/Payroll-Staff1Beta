import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { initDatabase } from "./db";

const app = express();
const httpServer = createServer(app);
app.set("trust proxy", 1);
app.disable("x-powered-by");

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

(async () => {
  void initDatabase();
  registerRoutes(app);
  if (process.env.NODE_ENV === "production") serveStatic(app);
  else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen({ port, host: "0.0.0.0", reusePort: true }, () => console.log(`serving on port ${port}`));
})();
