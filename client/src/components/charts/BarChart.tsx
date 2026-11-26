import { useEffect, useRef, useState } from "react";
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
  // Fit the x labels to the real width: every label gets at least ~48px, so none is cut off.
  const plotRef = useRef<HTMLDivElement>(null);
  const [plotWidth, setPlotWidth] = useState(0);
  useEffect(() => {
    const el = plotRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setPlotWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const max = Math.max(0, ...bars.map((b) => b.value));
  const top = niceMax(max);
  const ticks = [top, top / 2, 0];
  const fitLabels = plotWidth > 0 ? Math.max(1, Math.floor(plotWidth / 48)) : 8;
  const showLabelEvery = Math.max(1, Math.ceil(bars.length / Math.min(8, fitLabels)));
  // Show a label on the last bar and every Nth bar counting back from it, so the latest period is always named.
  const labelled = (i: number) => (bars.length - 1 - i) % showLabelEvery === 0;
  const yLabel = (n: number) => format(n).replace(/\.00$/, "");

  return (
    <div className={cn("relative select-none", className)} role="group" aria-label={ariaLabel}>
      <div className="flex">
        {/* Y axis */}
        <div className="relative mr-3 shrink-0 text-right text-[11px] text-muted-foreground tabular" style={{ height }} aria-hidden>
          {ticks.map((t, i) => (
            <span key={i} className="absolute right-0 -translate-y-1/2 whitespace-nowrap" style={{ top: `${(i / (ticks.length - 1)) * 100}%` }}>{yLabel(t)}</span>
          ))}
          <span className="invisible block whitespace-nowrap">{yLabel(top)}</span>
        </div>
        {/* Plot */}
        <div ref={plotRef} className="relative min-w-0 flex-1" style={{ height }}>
          {ticks.map((_, i) => (
            <div key={i} className={cn("absolute inset-x-0 border-t", i === ticks.length - 1 ? "border-border" : "border-border/50")} style={{ top: `${(i / (ticks.length - 1)) * 100}%` }} aria-hidden />
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
                    className={cn("block w-full max-w-[2.75rem] rounded-t-[4px] transition-[height,background-color] duration-200", strong ? "bg-chart-1" : "bg-chart-1/35 dark:bg-chart-1/40")}
                    style={{ height: `${Math.max(h, b.value > 0 ? 1.5 : 0)}%` }}
                  />
                </button>
              );
            })}
          </div>
          {hover !== null && bars[hover] && (
            <div
              className={cn(
                "pointer-events-none absolute z-10 -translate-y-full rounded-lg border border-popover-border bg-popover px-2.5 py-1.5 text-xs shadow-float",
                // Keep the tooltip inside the card at both ends of the axis.
                bars.length > 2 && hover === 0 ? "-translate-x-2" : bars.length > 2 && hover === bars.length - 1 ? "-translate-x-[calc(100%-0.5rem)]" : "-translate-x-1/2",
              )}
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
      <div className="mt-2 flex" aria-hidden>
        <div className="invisible mr-3 shrink-0 text-[11px] tabular">{yLabel(top)}</div>
        <div className="flex min-w-0 flex-1 gap-[2px] sm:gap-1">
          {bars.map((b, i) => (
            <span key={b.key} className={cn("min-w-0 flex-1 overflow-visible whitespace-nowrap text-center text-[11px] tabular", hover === i ? "font-medium text-foreground" : "text-muted-foreground")}>
              {labelled(i) ? b.label : ""}
            </span>
          ))}
        </div>
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
            <div className="h-full rounded-full transition-[width] duration-200" style={{ width: `${max > 0 ? (i.value / max) * 100 : 0}%`, background: i.color ?? "hsl(var(--chart-1))" }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
