import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
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
