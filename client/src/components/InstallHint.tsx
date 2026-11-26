// On an iPhone or iPad in Safari (not yet added to the Home Screen), a one-time
// tip: Share → Add to Home Screen opens the app full screen, like an app.
import { useState } from "react";
import { Share, X } from "lucide-react";
import { safeStorage } from "@/lib/storage";

const KEY = "payroll.install-hint-dismissed";

function isIosSafariTab(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia?.("(display-mode: standalone)").matches;
  return ios && !standalone;
}

export function InstallHint() {
  const [hidden, setHidden] = useState(() => safeStorage.get(KEY) === "1" || !isIosSafariTab());
  if (hidden) return null;
  const close = () => { safeStorage.set(KEY, "1"); setHidden(true); };
  return (
    <div className="mb-6 flex items-start gap-3 rounded-xl border border-card-border bg-card px-4 py-3 text-[13px] shadow-card" role="status" data-testid="notice-install">
      <Share className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <span className="flex-1">Use it like an app: tap <b className="font-semibold">Share</b>, then <b className="font-semibold">Add to Home Screen</b>. It then opens full screen from your Home Screen.</span>
      <button type="button" onClick={close} className="rounded-full p-1 text-muted-foreground hover:bg-foreground/[0.05]" aria-label="Dismiss"><X className="h-4 w-4" /></button>
    </div>
  );
}
