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
  // Face-check files: a missing one is a 404, never the app's index.html.
  app.use("/face", (_req, res) => { res.status(404).type("text/plain").send("Not found"); });

  // The time-clock kiosk is a separate page. Its asset URLs are relative, so
  // it must be served at exactly /kiosk.
  app.get("/kiosk", (req, res) => {
    if (req.originalUrl.split("?")[0] !== "/kiosk") return res.redirect(302, "/kiosk");
    res.sendFile(path.resolve(distPath, "kiosk.html"));
  });
  app.get("/kiosk/{*path}", (_req, res) => res.redirect(302, "/kiosk"));

  // The employee portal is its own page too, served at exactly /me.
  app.get("/me", (req, res) => {
    if (req.originalUrl.split("?")[0] !== "/me") return res.redirect(302, "/me");
    res.sendFile(path.resolve(distPath, "me.html"));
  });
  app.get("/me/{*path}", (_req, res) => res.redirect(302, "/me"));

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
