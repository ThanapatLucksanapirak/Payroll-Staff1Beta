// "Get the Android app" button: a direct APK download for Android tablets, so
// the Time Clock app can be installed without the Play Store. Shown only in an
// Android browser, never inside the app itself, and only when the server says
// an APK has been published (GET /api/kiosk/app).
import { useEffect, useState } from "react";
import { Download } from "lucide-react";

const IN_APP_KEY = "kiosk.inAndroidApp";

/**
 * Call once at start-up. The Android app opens /kiosk?app=android (and Chrome
 * sets document.referrer to android-app://<package>), so remember for this
 * session that we're inside the app, and tidy the address.
 */
export function noteAndroidApp() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const fromApp = url.searchParams.get("app") === "android" || document.referrer.startsWith("android-app://");
  if (fromApp) {
    try { sessionStorage.setItem(IN_APP_KEY, "1"); } catch { /* storage blocked: the referrer check still works on launch */ }
  }
  if (url.searchParams.has("app")) {
    url.searchParams.delete("app");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  }
}

function inAndroidApp(): boolean {
  try { if (sessionStorage.getItem(IN_APP_KEY) === "1") return true; } catch { /* ignore */ }
  return document.referrer.startsWith("android-app://") || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

export function shouldOfferAndroidApp(ua = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return /\bAndroid\b/i.test(ua) && !inAndroidApp();
}

/** The APK link, or null when the button shouldn't show. */
export function useAndroidAppDownload(): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!shouldOfferAndroidApp()) return;
    let live = true;
    fetch("/api/kiosk/app", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && typeof j?.url === "string" && /^https?:\/\//.test(j.url)) setUrl(j.url); })
      .catch(() => { /* offline: no button */ });
    return () => { live = false; };
  }, []);
  return url;
}

export function AndroidAppButton({ url, className = "" }: { url: string; className?: string }) {
  return (
    <a
      href={url}
      download
      rel="noopener"
      className={`kiosk-tap flex shrink-0 items-center gap-2 rounded-full px-4 text-base font-semibold text-[var(--kiosk-accent-ink)] ring-2 ring-stone-200 transition active:scale-95 active:bg-[var(--kiosk-accent-soft)] ${className}`}
      aria-label="Get the Android app"
      data-testid="kiosk-get-app"
    >
      <Download className="h-5 w-5" aria-hidden />
      <span><span className="hidden sm:inline">Get the Android app</span><span className="sm:hidden">App</span></span>
    </a>
  );
}
