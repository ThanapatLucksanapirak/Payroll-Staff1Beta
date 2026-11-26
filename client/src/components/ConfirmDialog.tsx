import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Require typing this word to enable the confirm button. */
  typeToConfirm?: string;
}

type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;
const Ctx = createContext<ConfirmFn>(async () => false);

export function useConfirm() {
  return useContext(Ctx);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const [typed, setTyped] = useState("");
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((o) => {
    setOpts(o);
    setTyped("");
    return new Promise<boolean>((resolve) => { resolver.current = resolve; });
  }, []);

  const close = (v: boolean) => {
    resolver.current?.(v);
    resolver.current = null;
    setOpts(null);
  };

  const blocked = !!opts?.typeToConfirm && typed.trim().toLowerCase() !== opts.typeToConfirm.toLowerCase();
  return (
    <Ctx.Provider value={confirm}>
      {children}
      <AlertDialog open={!!opts} onOpenChange={(o) => { if (!o) close(false); }}>
        <AlertDialogContent data-testid="dialog-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{opts?.title}</AlertDialogTitle>
            {opts?.description && <AlertDialogDescription asChild><div className="text-sm text-muted-foreground">{opts.description}</div></AlertDialogDescription>}
          </AlertDialogHeader>
          {opts?.typeToConfirm && (
            <div className="space-y-1.5">
              <p className="text-sm">Type <span className="font-mono font-semibold">{opts.typeToConfirm}</span> to confirm.</p>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" spellCheck={false} aria-label={`Type ${opts.typeToConfirm} to confirm`} data-testid="input-type-confirm" />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-confirm-cancel">{opts?.cancelLabel ?? "Cancel"}</AlertDialogCancel>
            <AlertDialogAction
              disabled={blocked}
              onClick={(e) => { if (blocked) { e.preventDefault(); return; } close(true); }}
              className={cn(opts?.destructive && buttonVariants({ variant: "destructive" }))}
              data-testid="button-confirm-ok"
            >
              {opts?.confirmLabel ?? "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Ctx.Provider>
  );
}
