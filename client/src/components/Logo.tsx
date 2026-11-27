import type { SVGProps } from "react";
import { DOT, GOLD_SQUARE, INK_TEXT, ORANGE_SQUARE, PAY, RED_TEXT, ROLL } from "@/components/logo-art";

/** Brand colours from the logo artwork (brand/BRAND.md). Fixed: the logo never recolours. */
export const BRAND = { gold: "#e6b422", orange: "#fe5721", red: "#e33a3a", ink: "#1b1714" } as const;

/** The small mark: the logo's gold and orange blocks with the red dot. Used for the favicon,
 *  the app icon and small headers. Always full colour. Size it with className. */
export function MarkShapes() {
  return (
    <>
      <rect x="0" y="5" width="9" height="10" fill={BRAND.gold} />
      <rect x="10.5" y="5" width="5.5" height="10" fill={BRAND.orange} />
      <circle cx="13.4" cy="3.3" r="2.6" fill={BRAND.red} />
    </>
  );
}

export function Mark({ className = "h-6 w-auto", ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0.7 16 14.3" className={className} role="img" aria-label="Payroll by Shijiri Group" {...rest}>
      <MarkShapes />
    </svg>
  );
}

/** The full lockup, "Payroll by SHIJIRI Group". "By SHIJIRI GROUP" takes currentColor
 *  (ink on light, white on dark); the gold, orange and red stay fixed. Size it with a height class. */
export function Wordmark({ className = "h-16 w-auto", ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 288 128" className={className} role="img" aria-label="Payroll by Shijiri Group" {...rest}>
      <path fill={BRAND.gold} d={PAY + GOLD_SQUARE} />
      <path fill={BRAND.orange} d={ROLL + ORANGE_SQUARE} />
      <path fill="currentColor" d={INK_TEXT} />
      <path fill={BRAND.red} d={RED_TEXT + DOT} />
    </svg>
  );
}

/** Compact lockup for app chrome: just "Payroll" and the red dot from the logo. */
export function ProductWordmark({ className = "h-6 w-auto", ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="4 0 280 91" className={className} role="img" aria-label="Payroll" {...rest}>
      <path fill={BRAND.gold} d={PAY} />
      <path fill={BRAND.orange} d={ROLL} />
      <path fill={BRAND.red} d={DOT} />
    </svg>
  );
}

/** App icon: the mark on the warm ink rounded square. Existing call sites size it with className. */
export function Logo({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} role="img" aria-label="Payroll by Shijiri Group">
      <rect width="100" height="100" rx="22.5" fill={BRAND.ink} />
      <g transform="translate(19 19.98) scale(3.875)"><MarkShapes /></g>
    </svg>
  );
}
