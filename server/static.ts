import express from 'express';
import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath));

  // The time-clock kiosk is a separate page. Its asset URLs are relative, so
  // it must be served at exactly /kiosk.
  app.get("/kiosk", (_req, res) => res.sendFile(path.resolve(distPath, "kiosk.html")));
  app.get("/kiosk/{*path}", (_req, res) => res.redirect(302, "/kiosk"));

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
