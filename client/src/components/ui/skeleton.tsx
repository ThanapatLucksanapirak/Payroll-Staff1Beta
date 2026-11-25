import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-lg bg-foreground/[0.06]", className)} aria-hidden {...props} />
}

export { Skeleton }
