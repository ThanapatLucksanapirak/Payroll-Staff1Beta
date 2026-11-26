// The second sign-in step: a code from the authenticator app (or a recovery
// code), or — when two-factor is required but not set up yet — enrollment.
import { useEffect, useState } from "react";
import { ChevronLeft, Loader2, Mail, ShieldCheck } from "lucide-react";
import { ApiError, api, errorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { EnrollStep, RecoveryCodes } from "@/components/TwoFactor";

const isExpired = (e: unknown) => e instanceof ApiError && e.body?.expired === true;

export function TwoFactorStep({ kind, ticket, appName, method, sentTo, emailError, onBack, onDone }: {
  kind: "verify" | "setup"; ticket: string; appName: string; method?: "app" | "email"; sentTo?: string; emailError?: string; onBack: (message?: string) => void; onDone: () => void;
}) {
  return kind === "verify"
    ? <VerifyStep ticket={ticket} email={method === "email" ? { sentTo, error: emailError } : null} onBack={onBack} onDone={onDone} />
    : <SetupStep ticket={ticket} appName={appName} onBack={onBack} onDone={onDone} />;
}

function BackLink({ onBack }: { onBack: () => void }) {
  return <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"><ChevronLeft className="h-4 w-4" />Back</button>;
}

function VerifyStep({ ticket, email, onBack, onDone }: { ticket: string; email: { sentTo?: string; error?: string } | null; onBack: (message?: string) => void; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState(email?.sentTo);
  const [notice, setNotice] = useState(email?.error ? `${email.error} You can use a recovery code instead.` : "");
  const [resending, setResending] = useState(false);
  const resend = async () => {
    setResending(true); setError(""); setNotice("");
    try {
      const r = await api<{ sentTo: string }>("POST", "/api/auth/2fa/login/resend", { ticket });
      setSentTo(r.sentTo); setNotice(`Sent a new code to ${r.sentTo}.`); setCode("");
    } catch (err) {
      if (isExpired(err)) onBack(errorMessage(err)); else setError(errorMessage(err));
    } finally { setResending(false); }
  };
  const [rememberDevice, setRememberDevice] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [left, setLeft] = useState<number | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const r = await api<{ recoveryCodesLeft?: number }>("POST", "/api/auth/2fa/login/verify", { ticket, code: code.trim(), rememberDevice });
      if (typeof r?.recoveryCodesLeft === "number") { setLeft(r.recoveryCodesLeft); return; }
      onDone();
    } catch (err) {
      if (isExpired(err)) onBack(errorMessage(err));
      else { setError(errorMessage(err)); setCode(""); }
    } finally { setBusy(false); }
  };

  if (left !== null) {
    return (
      <div className="space-y-4">
        <p className="text-[14px] font-medium">You used a recovery code.</p>
        <p className="text-[13px] text-muted-foreground">{left === 0 ? "That was your last one." : `You have ${left} left.`} Make new ones under Settings → Account &amp; password.</p>
        <Button className="w-full" onClick={onDone}>Continue</Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="form-2fa-verify">
      <BackLink onBack={() => onBack()} />
      {email && !recovery && (
        <div className="flex items-start gap-2.5 rounded-xl bg-info-soft px-3 py-2.5 text-[13px] text-info" data-testid="text-2fa-email-sent">
          <Mail className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{sentTo ? <>We emailed a 6-digit code to <b className="font-semibold">{sentTo}</b>. It works for 10 minutes.</> : "Enter the 6-digit code from your email."}</span>
        </div>
      )}
      {notice && <p className="text-[13px] text-muted-foreground" role="status">{notice}</p>}
      <div className="space-y-1.5">
        <Label htmlFor="otp">{recovery ? "Recovery code" : email ? "Code from the email" : "6-digit code"}</Label>
        {recovery ? (
          <Input id="otp" autoFocus autoComplete="off" spellCheck={false} className="h-10 text-center font-mono uppercase tracking-wider" placeholder="XXXXX-XXXXX" value={code} onChange={(e) => setCode(e.target.value)} data-testid="input-2fa-code" />
        ) : (
          <Input id="otp" autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={7} className="h-10 text-center font-mono text-lg tracking-[0.3em]" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))} data-testid="input-2fa-code" />
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => { setRecovery(!recovery); setCode(""); setError(""); }}>
            {recovery ? (email ? "Use the emailed code instead" : "Use a code from the app instead") : email ? "Can't get the email? Use a recovery code" : "Lost your phone? Use a recovery code"}
          </button>
          {email && !recovery && (
            <button type="button" className="text-xs font-medium text-primary hover:underline disabled:opacity-50" onClick={() => void resend()} disabled={resending} data-testid="button-2fa-resend">
              {resending ? "Sending…" : "Send a new code"}
            </button>
          )}
        </div>
      </div>
      <label className="flex cursor-pointer select-none items-center gap-2 text-[13px] text-muted-foreground">
        <Checkbox checked={rememberDevice} onCheckedChange={(v) => setRememberDevice(v === true)} data-testid="checkbox-remember-device" />
        Don't ask again on this device for 30 days
      </label>
      {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] font-medium text-danger" role="alert">{error}</p>}
      <Button type="submit" size="lg" className="w-full" disabled={busy || (recovery ? code.trim().length < 10 : code.length < 6)} data-testid="button-2fa-verify">
        {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}Verify
      </Button>
    </form>
  );
}

function SetupStep({ ticket, appName, onBack, onDone }: { ticket: string; appName: string; onBack: (message?: string) => void; onDone: () => void }) {
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ secret: string; otpauthUrl: string }>("POST", "/api/auth/2fa/login/setup", { ticket })
      .then(setEnroll)
      .catch((err) => onBack(errorMessage(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket]);

  const enable = async (code: string) => {
    setBusy(true); setError("");
    try {
      const r = await api<{ recoveryCodes: string[] }>("POST", "/api/auth/2fa/login/enable", { ticket, code });
      setCodes(r.recoveryCodes);
    } catch (err) {
      if (isExpired(err)) onBack(errorMessage(err));
      else setError(errorMessage(err));
    } finally { setBusy(false); }
  };

  if (codes) {
    return (
      <div className="space-y-4">
        <p className="text-[14px] font-medium">Two-factor sign-in is on.</p>
        <RecoveryCodes codes={codes} appName={appName} />
        <Button className="w-full" onClick={onDone} data-testid="button-2fa-continue">Continue</Button>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <BackLink onBack={() => onBack()} />
      <p className="text-[13px] text-muted-foreground">Your account needs two-factor sign-in. It takes a minute.</p>
      {enroll ? <EnrollStep {...enroll} busy={busy} error={error} onSubmit={(c) => void enable(c)} submitLabel="Turn on and sign in" /> : <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}
    </div>
  );
}
