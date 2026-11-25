import { useState } from "react";
import { Loader2, Lock, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { api, errorMessage, session } from "@/lib/api";
import { Logo } from "@/components/Logo";

export function LoginPage({ appName, setupRequired, dbError, onDone }: { appName: string; setupRequired: boolean; dbError?: string | null; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (setupRequired && password !== confirm) { setError("The passwords don't match."); return; }
    if (setupRequired && password.length < 8) { setError("Use at least 8 characters."); return; }
    if (setupRequired && !username.trim()) { setError("Choose a username."); return; }
    setBusy(true);
    try {
      await api("POST", setupRequired ? "/api/auth/setup" : "/api/auth/login", setupRequired
        ? { username: username.trim(), displayName: displayName.trim() || undefined, password, setupCode }
        : { username: username.trim(), password, remember });
      session.set();
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background p-4">
      {/* Soft ambient backdrop */}
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_40rem_at_50%_-10%,hsl(var(--primary)/0.10),transparent_60%),radial-gradient(40rem_30rem_at_100%_110%,hsl(var(--chart-4)/0.08),transparent_60%)]" />
      <div className="relative w-full max-w-[22rem]">
        <div className="mb-7 flex flex-col items-center gap-4 text-center">
          <Logo className="h-16 w-16 drop-shadow-[0_8px_24px_hsl(var(--primary)/0.35)]" />
          <div>
            <h1 className="text-[26px] font-bold tracking-tight">{appName}</h1>
            <p className="mt-1 text-[14px] text-muted-foreground">
              {setupRequired ? "Create the owner account to get started." : "Sign in to continue."}
            </p>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-card-border bg-card/90 p-6 shadow-float backdrop-blur-xl" data-testid="form-login">
          {dbError && <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning" role="alert">Database issue: {dbError}</p>}
          {setupRequired && (
            <div className="space-y-1.5">
              <Label htmlFor="setup-code">Setup code</Label>
              <Input id="setup-code" autoFocus autoComplete="off" spellCheck={false} placeholder="XXXXX-XXXXX" className="h-10 font-mono uppercase tracking-wider" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} data-testid="input-setup-code" />
              <p className="text-xs leading-snug text-muted-foreground">Shown by the installer. You can also find it on the server in the data folder, in setup-code.txt.</p>
            </div>
          )}
          {setupRequired && (
            <div className="space-y-1.5">
              <Label htmlFor="display-name">Your name</Label>
              <Input id="display-name" className="h-10" autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Alex Morgan" data-testid="input-display-name" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="username">Username</Label>
            <Input id="username" className="h-10" autoFocus={!setupRequired} autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} placeholder={setupRequired ? "e.g. alex" : undefined} data-testid="input-username" />
            {!setupRequired && <p className="text-xs leading-snug text-muted-foreground">Used a single shared password before? Your username is <span className="font-mono">admin</span>, or leave this blank.</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pw">{setupRequired ? "New password" : "Password"}</Label>
            <Input id="pw" type="password" className="h-10" autoComplete={setupRequired ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!error || undefined} aria-describedby={error ? "login-error" : undefined} data-testid="input-password" />
            {setupRequired && <p className="text-xs text-muted-foreground">At least 8 characters.</p>}
          </div>
          {setupRequired && (
            <div className="space-y-1.5">
              <Label htmlFor="pw2">Confirm password</Label>
              <Input id="pw2" type="password" className="h-10" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="input-password-confirm" />
            </div>
          )}
          <label className="flex cursor-pointer select-none items-center gap-2 text-[13px] text-muted-foreground">
            <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} data-testid="checkbox-remember" />
            Keep me signed in on this device
          </label>
          {error && <p id="login-error" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] font-medium text-danger" role="alert" data-testid="text-login-error">{error}</p>}
          <Button type="submit" size="lg" className="w-full" disabled={busy || !password || (setupRequired && (!setupCode.trim() || !username.trim()))} data-testid="button-login">
            {busy ? <Loader2 className="animate-spin" /> : setupRequired ? <ShieldCheck /> : <Lock />}
            {setupRequired ? "Create owner account" : "Sign in"}
          </Button>
        </form>
        <p className="mt-6 text-center text-xs text-muted-foreground">Your data stays on your own server.</p>
      </div>
    </div>
  );
}
