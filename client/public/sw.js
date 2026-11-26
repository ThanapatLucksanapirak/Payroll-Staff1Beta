// Service worker for the installable app. It keeps only the static shell
// (the HTML pages, hashed scripts/styles, icons and manifests) so the app
// opens quickly and shows "can't reach the server" when offline. It never
// touches /api/ (so payroll data and sign-in are never cached) or other sites.
const VERSION = "2";
const SHELL = `payroll-shell-v${VERSION}`;
const ASSETS = `payroll-assets-v${VERSION}`;
const MAX_ASSETS = 80;
const STATIC = /^\/(icons\/[\w.-]+|manifest\.webmanifest|kiosk\.webmanifest|me\.webmanifest|favicon\.svg)$/;
const PAGES = new Set(["/", "/kiosk", "/me"]);

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/manifest.webmanifest", "/icons/icon-192.png"])).catch(() => undefined));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== SHELL && key !== ASSETS) await caches.delete(key);
    await self.clients.claim();
  })());
});

const cacheable = (res) => res && res.ok && res.type === "basic" && !res.redirected && !/no-store/i.test(res.headers.get("Cache-Control") || "");

async function trim(cache) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(k);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return; // never cache data

  // Pages: always from the network; the cached copy only when offline.
  if (req.mode === "navigate") {
    const page = url.pathname === "/kiosk" || url.pathname.startsWith("/kiosk/") ? "/kiosk" : url.pathname === "/me" || url.pathname.startsWith("/me/") ? "/me" : "/";
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (cacheable(res) && PAGES.has(url.pathname)) (await caches.open(SHELL)).put(page, res.clone());
        return res;
      } catch (err) {
        const hit = await caches.match(page, { cacheName: SHELL });
        if (hit) return hit;
        throw err;
      }
    })());
    return;
  }

  // Hashed build files never change: cache first.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith((async () => {
      const cache = await caches.open(ASSETS);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (cacheable(res)) { await cache.put(req, res.clone()); event.waitUntil(trim(cache)); }
      return res;
    })());
    return;
  }

  // The kiosk's face-check model and runtime (large, unversioned names): cache
  // first, so a kiosk downloads them once. Bump VERSION when they change.
  if (/^\/face\/[\w.-]+$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (cacheable(res)) await cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // Icons and manifests: from the cache, refreshed in the background.
  if (STATIC.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req);
      const refresh = fetch(req).then((res) => { if (cacheable(res)) cache.put(req, res.clone()); return res; });
      if (hit) { event.waitUntil(refresh.catch(() => undefined)); return hit; }
      return refresh;
    })());
  }
});
