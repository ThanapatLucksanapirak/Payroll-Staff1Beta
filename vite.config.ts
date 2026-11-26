import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";
import type { Plugin } from "vite";

// The kiosk's face check (photo on punch) runs MediaPipe's WebAssembly runtime,
// served from /face/ next to the model in client/public/face. The runtime files
// come from node_modules: served from there in development, copied into the
// build otherwise, so they never have to be committed.
const FACE_WASM_DIR = path.resolve(import.meta.dirname, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const FACE_FILES = ["vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"];
function faceRuntime(): Plugin {
  return {
    name: "kiosk-face-runtime",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = (req.url ?? "").split("?")[0].replace(/^\/face\//, "");
        if (!req.url?.startsWith("/face/") || !FACE_FILES.includes(name)) return next();
        res.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        fs.createReadStream(path.join(FACE_WASM_DIR, name)).pipe(res);
      });
    },
    generateBundle() {
      for (const name of FACE_FILES) {
        this.emitFile({ type: "asset", fileName: `face/${name}`, source: fs.readFileSync(path.join(FACE_WASM_DIR, name)) });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), faceRuntime()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  base: "./",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    // The manifest lets the server list exactly which files the kiosk page needs (KIOSK_HOST).
    manifest: true,
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, "client", "index.html"),
        kiosk: path.resolve(import.meta.dirname, "client", "kiosk.html"),
        me: path.resolve(import.meta.dirname, "client", "me.html"),
      },
      output: {
        // Stable vendor chunks that cache well across releases. PDF/CSV libraries
        // are left alone: they're only reached through dynamic import().
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
          if (id.includes("@radix-ui") || id.includes("@floating-ui") || id.includes("react-remove-scroll") || id.includes("aria-hidden") || id.includes("react-style-singleton") || id.includes("use-sidecar") || id.includes("use-callback-ref")) return "radix";
          if (id.includes("@tanstack")) return "query";
          if (id.includes("lucide-react")) return "icons";
          if (id.includes("/zod/")) return "zod";
          return undefined;
        },
      },
    },
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
