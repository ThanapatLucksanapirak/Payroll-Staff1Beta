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

  const saveProfile = async () => {
    try {
      await api("PUT", "/api/auth/profile", { displayName: displayName.trim() });
      await app.refresh();
      toast({ title: "Saved" });
    } catch (e) { toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" }); }
  };

  const everywhere = async () => {
    const ok = await confirm({ title: "Sign out everywhere?", description: "You'll be signed out on every device and browser, including this one.", confirmLabel: "Sign out everywhere" });
    if (ok) await signOut(true);
  };

  return (
    <div className="space-y-5">
      <Section title="Your account" description={`Signed in as ${app.user.username} · ${ROLE_LABELS[app.user.role]}`}>
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void saveProfile(); }}>
          <Field label="Display name" className="w-full sm:w-72"><Input value={displayName} maxLength={100} onChange={(e) => setDisplayName(e.target.value)} data-testid="input-profile-name" /></Field>
          <Button type="submit" variant="outline" disabled={displayName.trim() === app.user.displayName || !displayName.trim()} data-testid="button-profile-save">Save</Button>
        </form>
      </Section>
      <Section title="Change password" description="Changing it signs out every other device.">
        <form className="grid gap-3 sm:grid-cols-3 items-start" onSubmit={(e) => { e.preventDefault(); if (!mismatch && next.length >= MIN) void change(); }}>
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
