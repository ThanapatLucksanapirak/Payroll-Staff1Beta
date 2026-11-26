// Small helpers shared by the kiosk screens: time formatting in the location's
// time zone, action colours, and the big touch targets.
import { useEffect, useRef } from "react";
import { Coffee, LogIn, LogOut, Play } from "lucide-react";
import type { PunchType } from "@shared/punches";
import { serverNow } from "./api";

export function fmt(tz: string, opts: Intl.DateTimeFormatOptions) {
  try { return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: tz }); } catch { return new Intl.DateTimeFormat(undefined, opts); }
}
export const timeOf = (at: string | number, tz: string) => fmt(tz, { hour: "numeric", minute: "2-digit" }).format(new Date(at));
export const hourIn = (tz: string) => Number(fmt(tz, { hour: "numeric", hourCycle: "h23" }).format(new Date(serverNow()))) % 24;
export const duration = (min: number) => { const h = Math.floor(min / 60), m = min % 60; return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`; };
export const firstName = (n: string) => n.split(" ")[0] || n;
export const initials = (n: string) => n.split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");

/** High-contrast colours for each action (WCAG AA for the label on the fill). */
export const ACTION_STYLE: Record<PunchType, { cls: string; panel: string; icon: typeof LogIn }> = {
  in: { cls: "bg-emerald-700 text-white active:bg-emerald-800", panel: "bg-emerald-700 text-white", icon: LogIn },
  break_start: { cls: "bg-amber-400 text-stone-950 active:bg-amber-500", panel: "bg-amber-400 text-stone-950", icon: Coffee },
  break_end: { cls: "bg-sky-700 text-white active:bg-sky-800", panel: "bg-sky-700 text-white", icon: Play },
  out: { cls: "bg-stone-900 text-white active:bg-stone-700", panel: "bg-stone-900 text-white", icon: LogOut },
};

/** Go back home after `ms` without a touch or key press. */
export function useIdle(ms: number, onIdle: () => void, deps: unknown[] = []) {
  const ref = useRef(onIdle);
  ref.current = onIdle;
  useEffect(() => {
    let t = setTimeout(() => ref.current(), ms);
    const bump = () => { clearTimeout(t); t = setTimeout(() => ref.current(), ms); };
    window.addEventListener("pointerdown", bump);
    window.addEventListener("keydown", bump);
    window.addEventListener("input", bump);
    return () => { clearTimeout(t); window.removeEventListener("pointerdown", bump); window.removeEventListener("keydown", bump); window.removeEventListener("input", bump); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
}

/** A large, glove-friendly secondary button. */
export function BigSecondary({ children, onClick, testid, className = "" }: { children: React.ReactNode; onClick: () => void; testid?: string; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={`kiosk-tap min-h-16 rounded-2xl px-8 text-xl font-medium text-stone-800 ring-2 ring-stone-300 transition active:scale-[0.98] active:bg-stone-100 active:ring-stone-400 disabled:opacity-50 ${className}`} data-testid={testid}>
      {children}
    </button>
  );
}
