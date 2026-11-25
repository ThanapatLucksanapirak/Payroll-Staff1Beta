import { useId } from "react";

/** App icon: an iOS-style squircle with a soft blue gradient. */
export function Logo({ className = "h-8 w-8" }: { className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 32 32" className={className} aria-label="Payroll Admin logo" role="img">
      <defs>
        <linearGradient id={`lg-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3b9bff" />
          <stop offset="1" stopColor="#0060d6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8.5" fill={`url(#lg-${id})`} />
      <path d="M9.5 11h13M9.5 16h13M9.5 21h7.5" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="22.5" cy="21" r="2.4" fill="#fff" fillOpacity="0.75" />
    </svg>
  );
}
