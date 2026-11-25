export function Logo({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-label="Payroll Admin logo" role="img">
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <path d="M9 10.5h14M9 16h14M9 21.5h8" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-primary-foreground" />
      <circle cx="23" cy="21.5" r="2.5" className="fill-primary-foreground/70" />
    </svg>
  );
}
