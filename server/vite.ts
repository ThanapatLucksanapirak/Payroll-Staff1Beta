import type { Express } from 'express';
import { createServer as createViteServer, createLogger } from "vite";
import type { Server } from 'node:http';
import viteConfig from "../vite.config";
import fs from "node:fs";
import path from "node:path";


const viteLogger = createLogger();

export async function setupVite(server: Server, app: Express) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server, path: "/vite-hmr" },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      },
    },
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);

  app.use("/{*path}", async (req, res, next) => {
    const url = req.originalUrl;
    // The time-clock kiosk is its own page (client/kiosk.html).
    const pathname = url.split("?")[0].split("#")[0];
    if (pathname.startsWith("/kiosk/")) return res.redirect(302, "/kiosk");
    if (pathname.startsWith("/me/")) return res.redirect(302, "/me");
    const kiosk = pathname === "/kiosk";
    const portal = pathname === "/me"; // employee portal (client/me.html)

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "..",
        "client",
        kiosk ? "kiosk.html" : portal ? "me.html" : "index.html",
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      const entry = kiosk ? "/src/kiosk/main.tsx" : portal ? "/src/portal/main.tsx" : "/src/main.tsx";
      template = template.replace(
        `src="${entry}"`,
        `src="${entry}?v=${Date.now().toString(36)}"`,
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}
