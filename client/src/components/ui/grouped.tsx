import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * macOS System Settings style grouped inset list.
 * <InsetGroup title="General"><InsetRow label="Autosave" control={<Switch/>} /></InsetGroup>
 */
export function InsetGroup({ title, description, footer, actions, children, className }: {
  title?: ReactNode
  description?: ReactNode
  footer?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn("space-y-2", className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-end justify-between gap-2 px-1">
          <div>
            {title && <h3 className="text-[13px] font-semibold">{title}</h3>}
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
      <div className="divide-y divide-border/70 overflow-hidden rounded-xl border border-card-border bg-card shadow-card">{children}</div>
      {footer && <p className="px-1 text-xs text-muted-foreground">{footer}</p>}
    </section>
  )
}

export function InsetRow({ label, hint, control, children, className, htmlFor }: {
  label?: ReactNode
  hint?: ReactNode
  control?: ReactNode
  children?: ReactNode
  className?: string
  htmlFor?: string
}) {
  const Tag = htmlFor ? "label" : "div"
  return (
    <div className={cn("px-4 py-3", className)}>
      {(label || control) && (
        <div className="flex min-h-[28px] flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {label && (
            <Tag htmlFor={htmlFor} className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">{label}</span>
              {hint && <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>}
            </Tag>
          )}
          {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
        </div>
      )}
      {children && <div className={cn(label && "mt-3")}>{children}</div>}
    </div>
  )
}
