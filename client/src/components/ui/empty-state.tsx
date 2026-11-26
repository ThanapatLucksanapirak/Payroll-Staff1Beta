import type { ComponentType, ReactNode } from "react"
import { cn } from "@/lib/utils"

export function EmptyState({ icon: Icon, title, description, action, className, compact, children }: {
  icon?: ComponentType<{ className?: string }>
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
  compact?: boolean
  /** Extra content under the actions (for example a list of first steps). */
  children?: ReactNode
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center", compact ? "gap-2 px-4 py-8" : "gap-3 rounded-2xl border border-dashed border-border px-6 py-14", className)}>
      {Icon && (
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-foreground/[0.05]">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>
      )}
      <div className="max-w-sm space-y-1">
        <p className="text-[15px] font-semibold">{title}</p>
        {description && <p className="text-[13px] leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div>}
      {children}
    </div>
  )
}
