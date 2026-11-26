import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"

import { cn } from "@/lib/utils"

const Tabs = TabsPrimitive.Root

/** Tabs render as a macOS segmented control. */
const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn("inline-flex h-9 items-center gap-0.5 rounded-[10px] bg-foreground/[0.06] p-[3px] text-muted-foreground dark:bg-foreground/[0.09]", className)}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex h-full min-w-[4.5rem] flex-auto items-center justify-center gap-1.5 whitespace-nowrap rounded-[8px] px-3 text-[13px] font-medium transition-[color,background-color,box-shadow] duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-segment data-[state=active]:text-foreground data-[state=active]:shadow-segment [&_svg]:size-4",
      className,
    )}
    {...props}
  />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn("mt-4 focus-visible:outline-none data-[state=active]:animate-in data-[state=active]:fade-in-0 data-[state=active]:duration-200", className)}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

/** Standalone segmented control (radio semantics) for view toggles. */
function SegmentedControl<T extends string>({ value, onChange, options, className, label }: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: React.ReactNode; title?: string; testid?: string }[]
  className?: string
  label: string
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([])
  const idx = options.findIndex((o) => o.value === value)
  const move = (d: number) => {
    const n = (idx + d + options.length) % options.length
    onChange(options[n].value)
    refs.current[n]?.focus()
  }
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex h-9 items-center gap-0.5 rounded-[10px] bg-foreground/[0.06] p-[3px] dark:bg-foreground/[0.09]", className)}
      onKeyDown={(e) => { if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); move(1) } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); move(-1) } }}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => { refs.current[i] = el }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          title={o.title}
          onClick={() => onChange(o.value)}
          data-testid={o.testid}
          className={cn(
            "inline-flex h-full items-center justify-center gap-1.5 rounded-[8px] px-2.5 text-[13px] font-medium text-muted-foreground transition-[color,background-color,box-shadow] duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 [&_svg]:size-4",
            o.value === value && "bg-segment text-foreground shadow-segment",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, SegmentedControl }
