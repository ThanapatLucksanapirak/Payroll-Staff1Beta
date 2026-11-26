import { Mark, Wordmark } from "@/components/Logo";

/** Sign-in brand panel: left column on desktop (>= 861px), header band on phones.
 *  Runs to the screen edge in the home-screen app; its content clears the status bar and notch. */
export function BrandPanel() {
  return (
    <aside className="relative flex flex-col overflow-hidden bg-brand-ink pb-[22px] pl-[max(1.25rem,env(safe-area-inset-left))] pr-[max(1.25rem,env(safe-area-inset-right))] pt-[calc(1.25rem+env(safe-area-inset-top))] text-brand-rice dark:shadow-[inset_-1px_0_0_hsl(var(--border))] min-[861px]:pb-[calc(2.5rem+env(safe-area-inset-bottom))] min-[861px]:pl-[calc(3rem+env(safe-area-inset-left))] min-[861px]:pr-12 min-[861px]:pt-[calc(2.5rem+env(safe-area-inset-top))]">
      <Mark aria-hidden aria-label={undefined} role="presentation" className="pointer-events-none absolute -right-9 -top-2.5 h-auto w-[150px] text-brand-tonal min-[861px]:-right-[22%] min-[861px]:top-[12%] min-[861px]:w-full" />
      <Wordmark className="relative h-6 w-auto self-start text-brand-rice min-[861px]:h-8" />
      <p className="relative mt-7 font-display text-[26px] font-normal leading-[1.08] tracking-[-0.012em] min-[861px]:mt-auto min-[861px]:text-[44px]">Every shift counted.<br />Every hour paid.</p>
      <p className="relative mt-[18px] hidden max-w-[34ch] text-[15px] leading-[22px] text-brand-muted min-[861px]:block">Shijiri Payroll keeps the hours, tips and pay for every Shijiri kitchen and floor.</p>
    </aside>
  );
}
