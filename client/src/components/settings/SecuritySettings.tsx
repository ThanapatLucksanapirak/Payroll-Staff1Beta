import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useApp } from "@/context/AppData";
import { api, errorMessage, session } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, NumberInput, Section } from "@/components/workspace/fields";

export function SecuritySettings() {
  const app = useApp();
  const { toast } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState(app.prefs.sessionDays);
  const mismatch = confirmPw.length > 0 && next !== confirmPw;

  const change = async () => {
    setBusy(true);
    try {
      const r = await api<{ token: string; message: string }>("POST", "/api/auth/change-password", { current, next });
      session.set(r.token);
      setCurrent(""); setNext(""); setConfirmPw("");
      toast({ title: "Password changed", description: r.message });
    } catch (e) {
      toast({ title: "Couldn't change password", description: errorMessage(e), variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <Section title="Change password" description="Changing it signs out every other device.">
        <form className="grid gap-3 sm:grid-cols-3 items-start" onSubmit={(e) => { e.preventDefault(); if (!mismatch && next.length >= 6) void change(); }}>
          <Field label="Current password"><Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} data-testid="input-pw-current" /></Field>
          <Field label="New password" hint="At least 6 characters"><Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} data-testid="input-pw-next" /></Field>
          <Field label="Confirm new password" hint={mismatch ? <span className="text-destructive">Passwords don't match</span> : undefined}><Input type="password" autoComplete="new-password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} data-testid="input-pw-confirm" /></Field>
          <div className="sm:col-span-3"><Button type="submit" disabled={busy || !current || next.length < 6 || next !== confirmPw} data-testid="button-pw-save">{busy && <Loader2 className="animate-spin" />}Change password</Button></div>
        </form>
      </Section>
      <Section title="Sessions">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Stay signed in for (days)" hint="Applies to new sign-ins when “Remember this device” is checked" className="w-56"><NumberInput step="1" min={1} value={days} onChange={(n) => setDays(Math.max(1, Math.min(365, Math.round(n))))} /></Field>
          <Button variant="outline" className="mb-5" disabled={days === app.prefs.sessionDays} onClick={async () => {
            try { await api("PUT", "/api/prefs", { sessionDays: days }); await app.refresh(); toast({ title: "Saved" }); } catch (e) { toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" }); }
          }}>Save</Button>
        </div>
      </Section>
    </div>
  );
}
