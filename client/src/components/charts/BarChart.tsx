import { useState } from "react";
import { cn } from "@/lib/utils";

export interface Bar {
  key: string;
  label: string;
  /** Longer text for the tooltip / screen readers. */
  detail?: string;
  value: number;
  onClick?: () => void;
}

/**
 * Minimal single-series column chart in plain HTML/CSS (no chart library).
 * Thin rounded columns anchored to the baseline, recessive gridlines,
 * a hover/focus tooltip, and an accessible label for every bar.
 */
export function BarChart({ bars, format, height = 180, className, highlightLast, ariaLabel }: {
  bars: Bar[];
  format: (n: number) => string;
  height?: number;
  className?: string;
  highlightLast?: boolean;
  ariaLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...bars.map((b) => b.value));
  const top = niceMax(max);
  const ticks = [top, top / 2, 0];
  const showLabelEvery = Math.max(1, Math.ceil(bars.length / 8));

  return (
    <div className={cn("relative select-none", className)} role="group" aria-label={ariaLabel}>
      <div className="flex">
        {/* Y axis */}
        <div className="relative mr-2 shrink-0 text-right text-[11px] text-muted-foreground tabular" style={{ height }} aria-hidden>
          {ticks.map((t, i) => (
            <span key={i} className="absolute right-0 -translate-y-1/2 whitespace-nowrap" style={{ top: `${(i / (ticks.length - 1)) * 100}%` }}>{format(t).replace(/\.00$/, "")}</span>
          ))}
          <span className="invisible block whitespace-nowrap">{format(top).replace(/\.00$/, "")}</span>
        </div>
        {/* Plot */}
        <div className="relative min-w-0 flex-1" style={{ height }}>
          {ticks.map((_, i) => (
            <div key={i} className={cn("absolute inset-x-0 border-t", i === ticks.length - 1 ? "border-border" : "border-dashed border-border/60")} style={{ top: `${(i / (ticks.length - 1)) * 100}%` }} aria-hidden />
          ))}
          <div className="absolute inset-0 flex items-end gap-[2px] sm:gap-1">
            {bars.map((b, i) => {
              const h = top > 0 ? (b.value / top) * 100 : 0;
              const strong = hover === i || (hover === null && highlightLast && i === bars.length - 1);
              return (
                <button
                  key={b.key}
                  type="button"
                  className="group relative flex h-full min-w-0 flex-1 items-end justify-center rounded-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  onClick={b.onClick}
                  tabIndex={b.onClick ? 0 : -1}
                  aria-label={`${b.detail ?? b.label}: ${format(b.value)}`}
                >
                  <span
                    className={cn("block w-full max-w-[2.75rem] rounded-t-[4px] transition-[height,background-color] duration-300", strong ? "bg-primary" : "bg-primary/35 dark:bg-primary/45")}
                    style={{ height: `${Math.max(h, b.value > 0 ? 1.5 : 0)}%` }}
                  />
                </button>
              );
            })}
          </div>
          {hover !== null && bars[hover] && (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-popover-border/80 bg-popover/95 px-2.5 py-1.5 text-xs shadow-float backdrop-blur"
              style={{ left: `${((hover + 0.5) / bars.length) * 100}%`, top: `${Math.max(0, 100 - (top > 0 ? (bars[hover].value / top) * 100 : 0))}%`, marginTop: -6 }}
              role="status"
            >
              <p className="whitespace-nowrap text-muted-foreground">{bars[hover].detail ?? bars[hover].label}</p>
              <p className="whitespace-nowrap text-[13px] font-semibold tabular">{format(bars[hover].value)}</p>
            </div>
          )}
        </div>
      </div>
      {/* X labels */}
      <div className="mt-1.5 flex gap-[2px] sm:gap-1" style={{ marginLeft: 0 }} aria-hidden>
        <div className="invisible mr-2 shrink-0 text-[11px]">{format(top).replace(/\.00$/, "")}</div>
        {bars.map((b, i) => (
          <span key={b.key} className="min-w-0 flex-1 truncate text-center text-[11px] text-muted-foreground">{i % showLabelEvery === 0 || i === bars.length - 1 ? b.label : ""}</span>
        ))}
      </div>
    </div>
  );
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * exp;
}

/** Horizontal bar list (e.g. totals by location). Name and value are always shown as text. */
export function BarList({ items, format }: { items: { key: string; label: string; value: number; color?: string; sub?: string }[]; format: (n: number) => string }) {
  const max = Math.max(0, ...items.map((i) => i.value));
  return (
    <ul className="space-y-3">
      {items.map((i) => (
        <li key={i.key}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
            <span className="flex min-w-0 items-center gap-2 font-medium">
              {i.color && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: i.color }} aria-hidden />}
              <span className="truncate">{i.label}</span>
              {i.sub && <span className="truncate text-xs font-normal text-muted-foreground">{i.sub}</span>}
            </span>
            <span className="shrink-0 font-semibold tabular">{format(i.value)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-foreground/[0.06]" aria-hidden>
            <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${max > 0 ? (i.value / max) * 100 : 0}%`, background: i.color ?? "hsl(var(--primary))" }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
