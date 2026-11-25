import { useEffect, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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

export function Field({ label, hint, children, className, error }: { label: string; hint?: ReactNode; children: ReactNode; className?: string; error?: ReactNode }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      {children}
      {error ? <p className="text-xs font-medium text-destructive" role="alert">{error}</p> : hint && <p className="text-xs leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** White card with a quiet header. Used across the workspace and settings. */
export function Section({ title, description, actions, children, className, bodyClassName }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cn("rounded-xl border border-card-border bg-card text-card-foreground shadow-card", className)}>
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pb-1 pt-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          {description && <p className="mt-0.5 max-w-2xl text-[13px] leading-snug text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </header>
      <div className={cn("px-5 pb-5 pt-3", bodyClassName)}>{children}</div>
    </section>
  );
}

/** A label + switch row with an optional hint; the whole row is clickable. */
export function ToggleRow({ label, hint, checked, onChange, disabled, className, testid }: { label: ReactNode; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; className?: string; testid?: string }) {
  return (
    <label className={cn("flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border/80 px-3.5 py-2.5 transition-colors hover:bg-foreground/[0.02]", disabled && "cursor-not-allowed opacity-60", className)}>
      <span className="min-w-0"><span className="block text-[13px] font-medium">{label}</span>{hint && <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>}</span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} data-testid={testid} />
    </label>
  );
}
