// Settings → Account & password → Two-factor sign-in.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, Loader2, Mail, ShieldCheck, ShieldAlert, Smartphone } from "lucide-react";
import { useApp } from "@/context/AppData";
import { api, errorMessage, queryClient } from "@/lib/api";
import { isAdmin } from "@/lib/roles";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, Section, ToggleRow } from "@/components/workspace/fields";
import { EnrollStep, RecoveryCodes } from "@/components/TwoFactor";
import { LoadError } from "@/components/LoadError";

export interface TwoFactorStatus {
  enabled: boolean; enabledAt: string | null; recoveryCodesLeft: number; required: boolean; policy: { requireForAdmins: boolean };
  method?: "app" | "email" | null; emailAvailable?: boolean; email?: string | null;
}
export const TWO_FACTOR_KEY = ["/api/auth/2fa"];

type Flow =
  | { step: "password"; action: "enable" | "enable-email" | "disable" | "codes" }
  | { step: "scan"; secret: string; otpauthUrl: string }
  | { step: "email"; sentTo: string }
  | { step: "codes"; codes: string[] };

export function TwoFactorSettings() {
  const app = useApp();
  const { toast } = useToast();
  const q = useQuery<TwoFactorStatus>({ queryKey: TWO_FACTOR_KEY });
  const [flow, setFlow] = useState<Flow | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const st = q.data;
  const admin = isAdmin(app.user);

  const close = () => { setFlow(null); setPassword(""); setError(""); };
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: TWO_FACTOR_KEY }); await queryClient.invalidateQueries({ queryKey: ["/api/users"] }); };

  const withPassword = async () => {
    if (flow?.step !== "password") return;
    setBusy(true); setError("");
    try {
      if (flow.action === "enable") {
        const r = await api<{ secret: string; otpauthUrl: string }>("POST", "/api/auth/2fa/setup", { password });
        setFlow({ step: "scan", ...r });
      } else if (flow.action === "enable-email") {
        const r = await api<{ sentTo: string }>("POST", "/api/auth/2fa/email/setup", { password });
        setFlow({ step: "email", sentTo: r.sentTo });
      } else if (flow.action === "disable") {
        await api("POST", "/api/auth/2fa/disable", { password });
        await refresh();
        close();
        toast({ title: "Two-factor sign-in is off" });
      } else {
        const r = await api<{ recoveryCodes: string[] }>("POST", "/api/auth/2fa/recovery-codes", { password });
        await refresh();
        setFlow({ step: "codes", codes: r.recoveryCodes });
      }
      setPassword("");
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };

  const enable = async (code: string) => {
    setBusy(true); setError("");
    try {
      const r = await api<{ recoveryCodes: string[] }>("POST", "/api/auth/2fa/enable", { code });
      await refresh();
      setFlow({ step: "codes", codes: r.recoveryCodes });
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };

  const enableEmail = async (code: string) => {
    setBusy(true); setError("");
    try {
      const r = await api<{ recoveryCodes: string[] }>("POST", "/api/auth/2fa/email/enable", { code });
      await refresh();
      setFlow({ step: "codes", codes: r.recoveryCodes });
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };

  const forget = async () => {
    try { await api("POST", "/api/auth/2fa/forget-devices", {}); toast({ title: "Remembered devices forgotten", description: "Every device will ask for a code at the next sign-in." }); }
    catch (e) { toast({ title: "Something went wrong", description: errorMessage(e), variant: "destructive" }); }
  };

  const setRequired = async (v: boolean) => {
    try { await api("PUT", "/api/auth/2fa/policy", { requireForAdmins: v }); await refresh(); toast({ title: v ? "Two-factor is now required for owners and administrators" : "Two-factor is optional" }); }
    catch (e) { toast({ title: "Couldn't change it", description: errorMessage(e), variant: "destructive" }); }
  };

  return (
    <Section title="Two-step verification" description="After your password, also enter a 6-digit code from an authenticator app or from an email. Stops anyone who learns your password.">
      {q.isError && !q.data ? <LoadError what="your two-step verification status" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} testid="two-factor-error" /> : q.isLoading || !st ? <Skeleton className="h-16" /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            {st.enabled ? <ShieldCheck className="h-5 w-5 text-success" /> : <ShieldAlert className="h-5 w-5 text-warning" />}
            <div className="min-w-[12rem] flex-1">
              <p className="text-[13px] font-medium" data-testid="text-2fa-status">{st.enabled ? (st.method === "email" ? `On · codes by email${st.email ? ` to ${st.email}` : ""}` : "On · authenticator app") : "Off"}</p>
              <p className="text-xs text-muted-foreground">
                {st.enabled ? `${st.recoveryCodesLeft} recovery code${st.recoveryCodesLeft === 1 ? "" : "s"} left.` : admin ? "Recommended for owners and administrators." : "Optional for your account."}
              </p>
            </div>
            {st.enabled ? (
              <div className="flex flex-wrap gap-2">
                {st.method === "email"
                  ? <Button variant="outline" size="sm" onClick={() => setFlow({ step: "password", action: "enable" })}><Smartphone />Use an app instead</Button>
                  : st.emailAvailable && <Button variant="outline" size="sm" onClick={() => setFlow({ step: "password", action: "enable-email" })}><Mail />Use email instead</Button>}
                <Button variant="outline" size="sm" onClick={() => setFlow({ step: "password", action: "codes" })}><KeyRound />New recovery codes</Button>
                <Button variant="outline" size="sm" onClick={() => void forget()}>Forget remembered devices</Button>
                {!st.required && <Button variant="outline" size="sm" className="text-danger hover:text-danger" onClick={() => setFlow({ step: "password", action: "disable" })} data-testid="button-2fa-disable">Turn off</Button>}
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setFlow({ step: "password", action: "enable-email" })} disabled={!st.emailAvailable} title={st.emailAvailable ? undefined : "Add your email above, and an owner must set up Settings → Email"} data-testid="button-2fa-setup-email"><Mail />Email me codes</Button>
                <Button onClick={() => setFlow({ step: "password", action: "enable" })} data-testid="button-2fa-setup"><Smartphone />Use an app</Button>
              </div>
            )}
          </div>
          {!st.enabled && !st.emailAvailable && <p className="text-xs text-muted-foreground">To get codes by email, add your email address above{admin ? " and set up Settings → Email" : " (an owner also needs to set up email)"}.</p>}
          {st.enabled && st.recoveryCodesLeft <= 2 && <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">You're almost out of recovery codes. Make new ones.</p>}
          {admin && (
            <ToggleRow
              label="Require two-factor for owners and administrators"
              hint={st.enabled || st.policy.requireForAdmins ? "Those without it set it up the next time they sign in." : "Set it up for your own account first, so nobody gets locked out."}
              checked={st.policy.requireForAdmins}
              disabled={!st.enabled && !st.policy.requireForAdmins}
              className="opacity-100 [&_button]:opacity-60"
              onChange={(v) => void setRequired(v)}
              testid="switch-2fa-required"
            />
          )}
        </div>
      )}

      <Dialog open={!!flow} onOpenChange={(o) => { if (!o && !busy) close(); }}>
        <DialogContent className="max-w-sm">
          {flow?.step === "password" && (
            <form onSubmit={(e) => { e.preventDefault(); void withPassword(); }} className="space-y-4">
              <DialogHeader>
                <DialogTitle>{flow.action === "enable" ? "Use an authenticator app" : flow.action === "enable-email" ? "Get codes by email" : flow.action === "disable" ? "Turn off two-step verification?" : "Make new recovery codes?"}</DialogTitle>
                <DialogDescription>{flow.action === "codes" ? "Your old recovery codes will stop working." : flow.action === "enable-email" ? `Enter your password. We'll email a code to ${st?.email ?? "your address"} to make sure it arrives.` : "Enter your password to continue."}</DialogDescription>
              </DialogHeader>
              <Field label="Your password" error={error || undefined}><Input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="input-2fa-password" /></Field>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
                <Button type="submit" variant={flow.action === "disable" ? "destructive" : "default"} disabled={busy || !password}>{busy && <Loader2 className="animate-spin" />}{flow.action === "disable" ? "Turn off" : "Continue"}</Button>
              </DialogFooter>
            </form>
          )}
          {flow?.step === "scan" && (
            <>
              <DialogHeader><DialogTitle>Scan with your phone</DialogTitle></DialogHeader>
              <EnrollStep secret={flow.secret} otpauthUrl={flow.otpauthUrl} busy={busy} error={error} onSubmit={(c) => void enable(c)} />
            </>
          )}
          {flow?.step === "email" && <EmailConfirm sentTo={flow.sentTo} busy={busy} error={error} onSubmit={(c) => void enableEmail(c)} />}
          {flow?.step === "codes" && (
            <>
              <DialogHeader><DialogTitle>Save your recovery codes</DialogTitle></DialogHeader>
              <RecoveryCodes codes={flow.codes} appName={app.prefs.appName} />
              <DialogFooter><Button onClick={close} data-testid="button-2fa-done">Done</Button></DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Section>
  );
}

/** Enter the code from the setup email. */
function EmailConfirm({ sentTo, busy, error, onSubmit }: { sentTo: string; busy: boolean; error: string; onSubmit: (code: string) => void }) {
  const [code, setCode] = useState("");
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (code.length === 6) onSubmit(code); }}>
      <DialogHeader>
        <DialogTitle>Check your email</DialogTitle>
        <DialogDescription>We sent a 6-digit code to {sentTo}. It works for 10 minutes.</DialogDescription>
      </DialogHeader>
      <Field label="Code from the email" error={error || undefined}>
        <Input autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="h-10 text-center font-mono text-lg tracking-[0.3em]" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))} data-testid="input-2fa-email-code" />
      </Field>
      <DialogFooter>
        <Button type="submit" disabled={busy || code.length !== 6} data-testid="button-2fa-email-enable">{busy && <Loader2 className="animate-spin" />}Turn on</Button>
      </DialogFooter>
    </form>
  );
}
