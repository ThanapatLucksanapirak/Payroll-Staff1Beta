import { useState } from "react";
import { Loader2, MonitorSmartphone } from "lucide-react";
import { useApp } from "@/context/AppData";
import { api, errorMessage, signOut } from "@/lib/api";
import { ROLE_LABELS, isAdmin } from "@/lib/roles";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, NumberInput, Section } from "@/components/workspace/fields";
import { TwoFactorSettings } from "@/components/settings/TwoFactorSettings";

const MIN = 8;

export function SecuritySettings() {
  const app = useApp();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [displayName, setDisplayName] = useState(app.user.displayName);
  const [username, setUsername] = useState(app.user.username);
  const [email, setEmail] = useState(app.user.notificationEmail ?? "");
  const emailOk = !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState(app.prefs.sessionDays);
  const mismatch = confirmPw.length > 0 && next !== confirmPw;

  const change = async () => {
    setBusy(true);
    try {
      const r = await api<{ message: string }>("POST", "/api/auth/change-password", { current, next });
      setCurrent(""); setNext(""); setConfirmPw("");
      toast({ title: "Password changed", description: r.message });
    } catch (e) {
      toast({ title: "Couldn't change password", description: errorMessage(e), variant: "destructive" });
    } finally { setBusy(false); }
  };

  const profileChanged = username.trim() !== app.user.username || displayName.trim() !== app.user.displayName || email.trim() !== (app.user.notificationEmail ?? "");
  const saveProfile = async () => {
    const u = username.trim();
    try {
      await api("PUT", "/api/auth/profile", { username: u, displayName: displayName.trim(), notificationEmail: email.trim() });
      await app.refresh();
      toast({ title: "Saved", description: u !== app.user.username ? `From now on, sign in as "${u}".` : undefined });
    } catch (e) { toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" }); }
  };

  const everywhere = async () => {
    const ok = await confirm({ title: "Sign out everywhere?", description: "You'll be signed out on every device and browser, including this one.", confirmLabel: "Sign out everywhere" });
    if (ok) await signOut(true);
  };

  return (
    <div className="space-y-5">
      <Section title="Your account" description={`You sign in as "${app.user.username}" · ${ROLE_LABELS[app.user.role]}`}>
        <form className="grid gap-3 sm:grid-cols-2 items-start" onSubmit={(e) => { e.preventDefault(); if (profileChanged && username.trim().length >= 2 && emailOk) void saveProfile(); }}>
          <Field label="Sign-in username" hint="What you type on the sign-in screen."><Input value={username} maxLength={64} autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="username" onChange={(e) => setUsername(e.target.value)} data-testid="input-profile-username" /></Field>
          <Field label="Display name" hint="Shown in the app and on reports. Not used to sign in."><Input value={displayName} maxLength={100} autoComplete="off" onChange={(e) => setDisplayName(e.target.value)} data-testid="input-profile-name" /></Field>
          <Field label="Notification email" className="sm:col-span-2" hint={!emailOk ? <span className="text-destructive">Enter a valid email address</span> : app.user.role === "accountant" ? "You get an email here when payroll is published." : "Optional. Where the app sends you emails."}>
            <Input type="email" inputMode="email" autoCapitalize="none" spellCheck={false} maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" data-testid="input-profile-email" />
          </Field>
          <div className="sm:col-span-2"><Button type="submit" variant="outline" disabled={!profileChanged || username.trim().length < 2 || !displayName.trim() || !emailOk} data-testid="button-profile-save">Save</Button></div>
        </form>
      </Section>
      <Section title="Change password" description={`For signing in as "${app.user.username}". Changing it signs out every other device.`}>
        <form className="grid gap-3 sm:grid-cols-3 items-start" onSubmit={(e) => { e.preventDefault(); if (!mismatch && next.length >= MIN) void change(); }}>
          {/* Tells password managers which account this is, so they save the real sign-in username. */}
          <input type="text" name="username" autoComplete="username" value={app.user.username} readOnly hidden />
          <Field label="Current password"><Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} data-testid="input-pw-current" /></Field>
          <Field label="New password" hint={`At least ${MIN} characters`}><Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} data-testid="input-pw-next" /></Field>
          <Field label="Confirm new password" hint={mismatch ? <span className="text-destructive">Passwords don't match</span> : undefined}><Input type="password" autoComplete="new-password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} data-testid="input-pw-confirm" /></Field>
          <div className="sm:col-span-3"><Button type="submit" disabled={busy || !current || next.length < MIN || next !== confirmPw} data-testid="button-pw-save">{busy && <Loader2 className="animate-spin" />}Change password</Button></div>
        </form>
      </Section>
      <TwoFactorSettings />
      <Section title="Sessions">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground flex-1 min-w-[14rem]">Lost a phone or signed in on a shared computer? Sign out on every device at once.</p>
            <Button variant="outline" onClick={() => void everywhere()} data-testid="button-sessions-signout-all"><MonitorSmartphone /> Sign out everywhere</Button>
          </div>
          {isAdmin(app.user) && (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Stay signed in for (days)" hint="Applies to new sign-ins when “Keep me signed in” is checked" className="w-56"><NumberInput step="1" min={1} value={days} onChange={(n) => setDays(Math.max(1, Math.min(365, Math.round(n))))} /></Field>
              <Button variant="outline" className="mb-5" disabled={days === app.prefs.sessionDays} onClick={async () => {
                try { await api("PUT", "/api/prefs", { sessionDays: days }); await app.refresh(); toast({ title: "Saved" }); } catch (e) { toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" }); }
              }}>Save</Button>
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}
