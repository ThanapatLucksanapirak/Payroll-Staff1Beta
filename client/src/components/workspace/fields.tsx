import { useEffect, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { inputToMinutes, minutesToInput } from "@shared/dates";

/** Numeric input that keeps a local text buffer so typing "1." or "" never jumps. */
export function NumberInput({ value, onChange, min = 0, step = "0.01", className, prefix, ...rest }: {
  value: number; onChange: (n: number) => void; min?: number; step?: string; className?: string; prefix?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "prefix">) {
  const [text, setText] = useState(fmt(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(fmt(value)); }, [value, focused]);
  const commit = (t: string) => {
    const n = t.trim() === "" ? 0 : Number(t);
    if (Number.isFinite(n)) onChange(Math.max(min, n));
  };
  return (
    <div className={cn("relative", className)}>
      {prefix && <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{prefix}</span>}
      <Input
        {...rest}
        inputMode="decimal"
        type="text"
        value={text}
        className={cn("tabular", prefix && "pl-6")}
        onFocus={(e) => { setFocused(true); e.currentTarget.select(); }}
        onBlur={() => { setFocused(false); commit(text); }}
        onChange={(e) => {
          const t = e.target.value.replace(/[^0-9.\-]/g, "");
          setText(t);
          if (/^-?\d*\.?\d*$/.test(t)) commit(t);
        }}
      />
    </div>
  );
}
const fmt = (n: number) => (n ? String(Math.round(n * 100) / 100) : "");

/** HH:MM time input in minutes. Values >1440 (overnight) render as next-day time. */
export function TimeInput({ value, onChange, className, ...rest }: { value: number; onChange: (m: number) => void; className?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <Input
      {...rest}
      type="time"
      className={cn("tabular", className)}
      value={minutesToInput(value % 1440)}
      onChange={(e) => {
        const m = inputToMinutes(e.target.value);
        if (m != null) onChange(m);
      }}
    />
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function Section({ title, description, actions, children, className }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl border bg-card", className)}>
      <header className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}
