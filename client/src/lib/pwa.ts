// Installable app: register the service worker (static shell only; see client/public/sw.js).
export function registerServiceWorker() {
  if (!import.meta.env.PROD || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (!window.isSecureContext) return; // service workers need https (or localhost)
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => { /* the app works without it */ });
  });
}
