import { Wordmark } from "@/components/Logo";

/** Sign-in brand panel: left column on desktop (>= 861px), header band on phones.
 *  Warm ink with the reversed logo and nothing else behind it.
 *  Runs to the screen edge in the home-screen app; its content clears the status bar and notch. */
export function BrandPanel() {
  return (
    <aside className="relative flex flex-col overflow-hidden bg-brand-ink pb-[22px] pl-[max(1.25rem,env(safe-area-inset-left))] pr-[max(1.25rem,env(safe-area-inset-right))] pt-[calc(1.25rem+env(safe-area-inset-top))] text-brand-rice dark:shadow-[inset_-1px_0_0_hsl(var(--border))] min-[861px]:pb-[calc(2.5rem+env(safe-area-inset-bottom))] min-[861px]:pl-[calc(3rem+env(safe-area-inset-left))] min-[861px]:pr-12 min-[861px]:pt-[calc(2.5rem+env(safe-area-inset-top))]">
      <Wordmark className="relative h-14 w-auto self-start text-white min-[861px]:h-[88px]" />
      <p className="relative mt-6 font-display text-[24px] font-semibold leading-[1.15] tracking-[-0.02em] min-[861px]:mt-auto min-[861px]:text-[40px]">Every shift counted.<br /><span className="text-[#e6b422]">Every hour paid.</span></p>
      <p className="relative mt-[18px] hidden max-w-[34ch] text-[15px] leading-[22px] text-brand-muted min-[861px]:block">Payroll keeps the hours, tips and pay for every Shijiri Group kitchen and floor.</p>
    </aside>
  );
}
