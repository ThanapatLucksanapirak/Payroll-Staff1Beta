import { useState } from "react";
import { Clock, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { api, errorMessage, session } from "@/lib/api";
import { BrandPanel } from "@/components/BrandPanel";
import { TwoFactorStep } from "@/components/TwoFactorLogin";

export function LoginPage({ appName, setupRequired, dbError, onDone }: { appName: string; setupRequired: boolean; dbError?: string | null; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showPw, setShowPw] = useState(false);
  /** Second sign-in step (two-factor), after a correct password. */
  const [second, setSecond] = useState<{ kind: "verify" | "setup"; ticket: string; method?: "app" | "email"; sentTo?: string; emailError?: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (setupRequired && password !== confirm) { setError("The passwords don't match."); return; }
    if (setupRequired && password.length < 8) { setError("Use at least 8 characters."); return; }
    if (setupRequired && !username.trim()) { setError("Choose a username."); return; }
    setBusy(true);
    try {
      const r = await api<{ twoFactor?: "verify" | "setup"; ticket?: string; method?: "app" | "email"; sentTo?: string; emailError?: string }>("POST", setupRequired ? "/api/auth/setup" : "/api/auth/login", setupRequired
        ? { username: username.trim(), displayName: displayName.trim() || undefined, password, setupCode }
        : { username: username.trim(), password, remember });
      if (r?.twoFactor && r.ticket) { setPassword(""); setSecond({ kind: r.twoFactor, ticket: r.ticket, method: r.method, sentTo: r.sentTo, emailError: r.emailError }); return; }
      session.set();
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const lede = setupRequired ? "Create the owner account to get started."
    : second?.kind === "setup" ? "Set up two-factor sign-in to continue."
    : second ? (second.method === "email" ? (second.sentTo ? `Enter the code we emailed to ${second.sentTo}.` : "Enter the code we emailed you.") : "Enter the code from your authenticator app.")
    : "Sign in to Shijiri Payroll.";
  const heading = setupRequired ? "Welcome" : second ? "One more step" : "Welcome back";
  const fieldCls = "h-12 rounded-[10px] px-[14px] text-[15px] md:text-[15px]";
  const labelCls = "mb-[7px] block text-[13px] font-semibold text-foreground";

  return (
    <div className="grid min-h-dvh grid-cols-1 grid-rows-[auto_1fr] bg-card dark:bg-background min-[861px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] min-[861px]:grid-rows-1">
      {/* Brand panel (header band on phones) */}
      <BrandPanel />

      {/* Form side */}
      <main className="flex flex-col px-5 pb-5 pt-7 min-[861px]:px-12 min-[861px]:py-8">
        <div className="mx-auto w-full max-w-[380px] min-[861px]:my-auto">
          <h1 className="font-display text-[30px] font-normal leading-[1.1] tracking-[-0.012em] min-[861px]:text-[36px]">{heading}</h1>
          <p className="mb-6 mt-2.5 text-[15px] leading-[22px] text-muted-foreground min-[861px]:mb-8">{lede}</p>
          {second ? (
            <TwoFactorStep {...second} appName={appName} onBack={(msg) => { setSecond(null); setError(msg ?? ""); }} onDone={() => { session.set(); onDone(); }} />
          ) : (
          <form onSubmit={submit} className="space-y-[18px]" data-testid="form-login">
            {dbError && <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning" role="alert">Database issue: {dbError}</p>}
            {setupRequired && (
              <div>
                <Label htmlFor="setup-code" className={labelCls}>Setup code</Label>
                <Input id="setup-code" autoFocus autoComplete="off" spellCheck={false} placeholder="XXXXX-XXXXX" className={`${fieldCls} font-mono uppercase tracking-wider`} value={setupCode} onChange={(e) => setSetupCode(e.target.value)} data-testid="input-setup-code" />
                <p className="mt-[7px] text-[12.5px] leading-[18px] text-muted-foreground">Shown by the installer. You can also find it on the server in the data folder, in setup-code.txt.</p>
              </div>
            )}
            {setupRequired && (
              <div>
                <Label htmlFor="display-name" className={labelCls}>Your name</Label>
                <Input id="display-name" className={fieldCls} autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Alex Morgan" data-testid="input-display-name" />
              </div>
            )}
            <div>
              <Label htmlFor="username" className={labelCls}>Username</Label>
              <Input id="username" className={fieldCls} autoFocus={!setupRequired} autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} placeholder={setupRequired ? "e.g. alex" : undefined} data-testid="input-username" />
              {!setupRequired && <p className="mt-[7px] text-[12.5px] leading-[18px] text-muted-foreground">Used one shared password before? Your username is <span className="font-mono text-[12px]">admin</span>.</p>}
            </div>
            <div>
              <Label htmlFor="pw" className={labelCls}>{setupRequired ? "New password" : "Password"}</Label>
              <div className="relative">
                <Input id="pw" type={showPw ? "text" : "password"} className={`${fieldCls} pr-[68px]`} autoComplete={setupRequired ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!error || undefined} aria-describedby={error ? "login-error" : undefined} data-testid="input-password" />
                <button type="button" onClick={() => setShowPw((v) => !v)} aria-pressed={showPw} className="absolute right-1.5 top-1.5 h-9 rounded-lg px-2.5 text-[13px] font-semibold text-primary hover:underline hover:underline-offset-4 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35" data-testid="button-show-password">{showPw ? "Hide" : "Show"}</button>
              </div>
              {setupRequired
                ? <p className="mt-[7px] text-[12.5px] leading-[18px] text-muted-foreground">At least 8 characters.</p>
                : <p className="mt-[7px] text-[12.5px] leading-[18px] text-muted-foreground">Forgot it? Ask an owner to reset your password.</p>}
            </div>
            {setupRequired && (
              <div>
                <Label htmlFor="pw2" className={labelCls}>Confirm password</Label>
                <Input id="pw2" type={showPw ? "text" : "password"} className={fieldCls} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="input-password-confirm" />
              </div>
            )}
            <label className="flex min-h-6 cursor-pointer select-none items-center gap-[9px] text-[13.5px] text-foreground">
              <Checkbox className="h-[18px] w-[18px]" checked={remember} onCheckedChange={(v) => setRemember(v === true)} data-testid="checkbox-remember" />
              Keep me signed in
            </label>
            {error && <p id="login-error" className="rounded-[10px] bg-danger-soft px-3.5 py-2.5 text-[13px] font-medium leading-[18px] text-danger" role="alert" data-testid="text-login-error">{error}</p>}
            <Button type="submit" size="lg" className="mt-1.5 h-12 w-full rounded-[10px] text-[15px] font-semibold" disabled={busy || !password || (setupRequired && (!setupCode.trim() || !username.trim()))} data-testid="button-login">
              {setupRequired ? (busy ? "Creating account…" : "Create owner account") : busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
          )}
          {!second && !setupRequired && (
            <>
              <div className="mb-4 mt-7 flex items-center gap-3 text-[12.5px] text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">Not a manager?</div>
              <div className="grid grid-cols-2 gap-2.5">
                <a href="/kiosk" className="flex h-11 items-center justify-center gap-2 rounded-[10px] border border-input bg-card text-[13.5px] font-semibold text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35" data-testid="link-kiosk"><Clock className="h-4 w-4 text-muted-foreground" />Time clock</a>
                <a href="/me" className="flex h-11 items-center justify-center gap-2 rounded-[10px] border border-input bg-card text-[13.5px] font-semibold text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35" data-testid="link-portal"><Smartphone className="h-4 w-4 text-muted-foreground" />My shifts &amp; pay</a>
              </div>
            </>
          )}
        </div>
        <div className="mt-8 flex flex-col gap-1 text-xs text-muted-foreground min-[861px]:mt-0 min-[861px]:flex-row min-[861px]:justify-between">
          <span>Shijiri Group</span>
          <span>Your data stays on your own server.</span>
        </div>
      </main>
    </div>
  );
}
