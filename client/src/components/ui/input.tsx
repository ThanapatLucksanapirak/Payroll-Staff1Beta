import * as React from "react"

import { cn } from "@/lib/utils"

/** Shared look for text-like controls (inputs, textareas, select triggers). */
export const fieldClass =
  "w-full rounded-md border border-input/90 bg-card px-3 text-[14px] text-foreground shadow-card transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground/80 hover:border-input focus-visible:outline-none focus-visible:border-primary/70 focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-muted/60 disabled:opacity-60 aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/20 md:text-[13px]"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          fieldClass,
          "flex h-9 py-1.5 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
          className,
        )}
        ref={ref}
        {...props}
      />
    )
  },
)
Input.displayName = "Input"

export { Input }
