import { useId, useState, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

/** "Advanced" style disclosure group: a quiet toggle row that reveals deeper settings. */
export function Disclosure({ title, description, children, defaultOpen = false, className, testid }: {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  className?: string
  testid?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <div className={cn("rounded-xl border border-border/80", className)}>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-xl px-4 py-3 text-left transition-colors hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        data-testid={testid}
      >
        <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-90")} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold">{title}</span>
          {description && <span className="block text-xs text-muted-foreground">{description}</span>}
        </span>
      </button>
      {open && <div id={id} className="border-t border-border/80 px-4 pb-4 pt-4 animate-in fade-in-0 duration-200">{children}</div>}
    </div>
  )
}
