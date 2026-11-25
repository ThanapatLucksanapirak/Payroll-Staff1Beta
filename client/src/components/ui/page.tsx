import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/** Standard page container: generous margins, readable max width. */
export function Page({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return <div className={cn("mx-auto w-full px-4 pb-16 pt-6 sm:px-8 sm:pt-10", wide ? "max-w-[90rem]" : "max-w-6xl", className)}>{children}</div>
}

/** Large bold title, quiet subtitle, actions on the right. */
export function PageHeader({ title, subtitle, actions, eyebrow, className, titleTestId }: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  eyebrow?: ReactNode
  className?: string
  titleTestId?: string
}) {
  return (
    <header className={cn("mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3 sm:mb-8", className)}>
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-[13px] text-muted-foreground">{eyebrow}</div>}
        <h1 className="text-display tracking-tight" data-testid={titleTestId}>{title}</h1>
        {subtitle && <p className="mt-1 text-[15px] text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

/** Small grey uppercase label used above groups of content. */
export function SectionLabel({ children, className, action }: { children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <div className={cn("mb-2 flex items-center justify-between gap-2 px-1", className)}>
      <h2 className="section-label">{children}</h2>
      {action}
    </div>
  )
}
