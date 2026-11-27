import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { errorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";

/**
 * Shown in place of a list or a settings form whose data couldn't be loaded.
 * Never show defaults or "nothing yet" instead: someone could save the defaults
 * over their real settings, or think their backups are gone.
 */
export function LoadError({ what, error, onRetry, retrying, testid }: { what: string; error: unknown; onRetry: () => void; retrying?: boolean; testid?: string }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] sm:flex-row sm:items-center" data-testid={testid ?? "load-error"}>
      <p className="flex min-w-0 flex-1 items-start gap-2 text-destructive">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span className="min-w-0 [overflow-wrap:anywhere]">Couldn't load {what}. Nothing has been changed. {errorMessage(error)}</span>
      </p>
      <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>{retrying ? <Loader2 className="animate-spin" /> : <RotateCcw />}Try again</Button>
    </div>
  );
}
