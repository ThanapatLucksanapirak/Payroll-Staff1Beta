import { useState } from "react";
import { Loader2, Lock, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { api, errorMessage, session } from "@/lib/api";
import { Logo } from "@/components/Logo";

export function LoginPage({ appName, setupRequired, dbError, onDone }: { appName: string; setupRequired: boolean; dbError?: string | null; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (setupRequired && password !== confirm) { setError("The passwords don't match."); return; }
    setBusy(true);
    try {
      const r = await api<{ token: string }>("POST", setupRequired ? "/api/auth/setup" : "/api/auth/login", { password, remember });
      session.set(r.token, remember);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm space-y-5" data-testid="form-login">
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo className="h-11 w-11" />
          <div>
            <h1 className="text-lg font-semibold">{appName}</h1>
            <p className="text-sm text-muted-foreground">
              {setupRequired ? "Create the administrator password to get started." : "Enter the administrator password."}
            </p>
          </div>
        </div>
        {dbError && <p className="rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">Database issue: {dbError}</p>}
        <div className="space-y-2">
          <Label htmlFor="pw">{setupRequired ? "New password" : "Password"}</Label>
          <Input id="pw" type="password" autoFocus autoComplete={setupRequired ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} data-testid="input-password" />
        </div>
        {setupRequired && (
          <div className="space-y-2">
            <Label htmlFor="pw2">Confirm password</Label>
            <Input id="pw2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="input-password-confirm" />
          </div>
        )}
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
          <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} data-testid="checkbox-remember" />
          Keep me signed in on this device
        </label>
        {error && <p className="text-sm text-destructive" role="alert" data-testid="text-login-error">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy || !password} data-testid="button-login">
          {busy ? <Loader2 className="animate-spin" /> : setupRequired ? <ShieldCheck /> : <Lock />}
          {setupRequired ? "Create password" : "Unlock"}
        </Button>
      </form>
    </div>
  );
}
