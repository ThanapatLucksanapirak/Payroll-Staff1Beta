// Settings → Email: the SMTP server the app sends notifications through
// (optional). The password is saved on the server and never shown again.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, Send } from "lucide-react";
import { api, errorMessage, queryClient } from "@/lib/api";
import { useApp } from "@/context/AppData";
import { timeAgo } from "@/lib/doc";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, Section, ToggleRow } from "@/components/workspace/fields";

type Security = "starttls" | "ssl" | "none";
interface EmailCfg {
  enabled: boolean; host: string; port: number; security: Security; username: string;
  fromAddress: string; fromName: string; appUrl: string; hasPassword: boolean;
}
interface EmailInfo {
  config: EmailCfg;
  status: { lastSentAt: string | null; lastFailureAt: string | null; lastError: string | null };
  ready: boolean;
}
const KEY = ["/api/email"];

/** Common providers: fills in the server details (never the password). */
const PRESETS: { id: string; label: string; host: string; port: number; security: Security; help: string }[] = [
  { id: "gmail", label: "Gmail / Google Workspace", host: "smtp.gmail.com", port: 587, security: "starttls", help: "Username is your Gmail address. Password is a 16-letter App password (Google Account → Security → 2-Step Verification → App passwords), not your normal password." },
  { id: "m365", label: "Microsoft 365 / Outlook", host: "smtp.office365.com", port: 587, security: "starttls", help: "Username is your email address. Your admin may need to turn on \"Authenticated SMTP\" for the mailbox." },
  { id: "resend", label: "Resend", host: "smtp.resend.com", port: 587, security: "starttls", help: "Username is resend. Password is an API key from Resend. The from address must be on a domain you verified there." },
  { id: "postmark", label: "Postmark", host: "smtp.postmarkapp.com", port: 587, security: "starttls", help: "Username and password are both your Server API token. The from address must be a verified sender." },
  { id: "other", label: "Other", host: "", port: 587, security: "starttls", help: "Your provider's SMTP details. Most use port 587 with STARTTLS." },
];

const presetFor = (host: string) => PRESETS.find((p) => p.host && p.host === host.trim().toLowerCase())?.id ?? "other";

export function EmailSettings() {
  const app = useApp();
  const { toast } = useToast();
  const q = useQuery<EmailInfo>({ queryKey: KEY });
  const [cfg, setCfg] = useState<EmailCfg | null>(null);
  const [password, setPassword] = useState("");
  const [preset, setPreset] = useState("other");
  const [testTo, setTestTo] = useState(app.user.notificationEmail ?? "");
  const [busy, setBusy] = useState<string | null>(null);

  const load = (c: EmailCfg) => {
    setCfg({ ...c, appUrl: c.appUrl || window.location.origin });
    setPreset(presetFor(c.host));
    setPassword("");
  };
  // Fill the form once; later refreshes (e.g. the status after a test) must not wipe unsaved edits.
  useEffect(() => { if (q.data && !cfg) load(q.data.config); }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.error) return <Section title="Email"><p className="text-sm text-destructive">{errorMessage(q.error)}</p></Section>;
  if (!cfg || !q.data) return <Section title="Email"><Skeleton className="h-48" /></Section>;

  const saved = q.data.config;
  const plain = (c: EmailCfg) => [c.enabled, c.host, c.port, c.security, c.username, c.fromAddress, c.fromName, c.appUrl].join("|");
  // The saved password only goes to the server it was entered for (the server enforces this too).
  const dest = (c: EmailCfg) => [c.host.trim().toLowerCase(), c.port, c.security, c.username.trim().toLowerCase()].join("|");
  const needPassword = saved.hasPassword && !password && dest(cfg) !== dest(saved);
  const dirty = plain(cfg) !== plain({ ...saved, appUrl: saved.appUrl || window.location.origin }) || !!password || !saved.appUrl;
  const body = () => ({
    enabled: cfg.enabled, host: cfg.host.trim(), port: cfg.port, security: cfg.security, username: cfg.username.trim(),
    fromAddress: cfg.fromAddress.trim(), fromName: cfg.fromName.trim(), appUrl: cfg.appUrl.trim(), ...(password ? { password } : {}),
  });
  const set = (patch: Partial<EmailCfg>) => setCfg({ ...cfg, ...patch });
  const help = PRESETS.find((p) => p.id === preset)?.help;

  const choosePreset = (id: string) => {
    setPreset(id);
    const p = PRESETS.find((x) => x.id === id);
    if (p && p.host) set({ host: p.host, port: p.port, security: p.security, ...(id === "resend" && !cfg.username ? { username: "resend" } : {}) });
  };

  const save = async () => {
    setBusy("save");
    try {
      const r = await api<EmailInfo>("PUT", "/api/email", { config: body() });
      queryClient.setQueryData(KEY, r);
      load(r.config);
      toast({ title: "Saved", description: r.ready ? "Email notifications are on." : "Email notifications are off." });
    } catch (e) { toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" }); }
    finally { setBusy(null); }
  };

  const test = async () => {
    setBusy("test");
    try {
      const r = await api<{ ok: boolean; message: string }>("POST", "/api/email/test", { to: testTo.trim(), config: body() }, { timeoutMs: 60_000 });
      void queryClient.invalidateQueries({ queryKey: KEY });
      toast({ title: r.ok ? "Test email sent" : "Test failed", description: r.message, variant: r.ok ? undefined : "destructive" });
    } catch (e) { toast({ title: "Test failed", description: errorMessage(e), variant: "destructive" }); }
    finally { setBusy(null); }
  };

  const st = q.data.status;
  const failing = st.lastFailureAt && (!st.lastSentAt || Date.parse(st.lastFailureAt) > Date.parse(st.lastSentAt));

  return (
    <div className="space-y-5">
      <Section
        title="Email"
        description="Optional. When it's on, the app emails your accountant when you publish payroll. Everything else works the same without it."
      >
        <div className="space-y-4">
          <ToggleRow label="Send email notifications" hint="Uses your own email account or sending service." checked={cfg.enabled} onChange={(v) => set({ enabled: v })} testid="switch-email-enabled" />
          {cfg.enabled && (
            <>
              <Field label="Email service" hint={help}>
                <Select value={preset} onValueChange={choosePreset}>
                  <SelectTrigger data-testid="select-email-preset"><SelectValue /></SelectTrigger>
                  <SelectContent>{PRESETS.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <div className="grid items-start gap-3 sm:grid-cols-[1fr_7rem_9rem]">
                <Field label="Server (SMTP host)"><Input value={cfg.host} spellCheck={false} autoCapitalize="none" placeholder="smtp.example.com" onChange={(e) => set({ host: e.target.value })} data-testid="input-email-host" /></Field>
                <Field label="Port"><Input inputMode="numeric" value={String(cfg.port)} onChange={(e) => set({ port: Math.max(1, Math.min(65535, Number(e.target.value.replace(/\D/g, "")) || 0)) })} data-testid="input-email-port" /></Field>
                <Field label="Security">
                  <Select value={cfg.security} onValueChange={(v) => set({ security: v as Security, ...(v === "ssl" && cfg.port === 587 ? { port: 465 } : v === "starttls" && cfg.port === 465 ? { port: 587 } : {}) })}>
                    <SelectTrigger data-testid="select-email-security"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="starttls">STARTTLS</SelectItem>
                      <SelectItem value="ssl">SSL / TLS</SelectItem>
                      <SelectItem value="none">None</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <div className="grid items-start gap-3 sm:grid-cols-2">
                <Field label="Username"><Input value={cfg.username} spellCheck={false} autoCapitalize="none" autoComplete="off" onChange={(e) => set({ username: e.target.value })} data-testid="input-email-username" /></Field>
                <Field label="Password or API key" error={needPassword ? "Enter it again: the server details changed." : undefined} hint={saved.hasPassword ? "Saved. Leave blank to keep it." : "Stored on your server only. Never shown again."}>
                  <Input type="password" autoComplete="new-password" value={password} placeholder={saved.hasPassword ? "••••••••" : ""} onChange={(e) => setPassword(e.target.value)} data-testid="input-email-password" />
                </Field>
                <Field label="From address" hint="The address emails come from."><Input type="email" value={cfg.fromAddress} spellCheck={false} autoCapitalize="none" placeholder="payroll@yourcompany.com" onChange={(e) => set({ fromAddress: e.target.value })} data-testid="input-email-from" /></Field>
                <Field label="From name"><Input value={cfg.fromName} maxLength={100} placeholder={app.prefs.appName} onChange={(e) => set({ fromName: e.target.value })} /></Field>
                <Field label="App address" hint="Used for the link in emails." className="sm:col-span-2"><Input value={cfg.appUrl} spellCheck={false} autoCapitalize="none" placeholder="https://payroll.yourcompany.com" onChange={(e) => set({ appUrl: e.target.value })} data-testid="input-email-appurl" /></Field>
              </div>
            </>
          )}
          {(cfg.enabled || saved.enabled) && (
            <Button onClick={() => void save()} disabled={!!busy || !dirty || needPassword} data-testid="button-email-save">{busy === "save" && <Loader2 className="animate-spin" />}Save</Button>
          )}
        </div>
      </Section>

      {cfg.enabled && (
        <Section title="Send a test email" description="Uses the settings above, even before you save them.">
          <div className="space-y-3">
            <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void test(); }}>
              <Field label="Send to" className="w-full sm:w-80"><Input type="email" value={testTo} spellCheck={false} autoCapitalize="none" placeholder="you@example.com" onChange={(e) => setTestTo(e.target.value)} data-testid="input-email-test-to" /></Field>
              <Button type="submit" variant="outline" disabled={!!busy || needPassword || !testTo.trim() || !cfg.host.trim() || !cfg.fromAddress.trim()} data-testid="button-email-test">{busy === "test" ? <Loader2 className="animate-spin" /> : <Send />}Send test email</Button>
            </form>
            {failing ? (
              <p className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger" role="alert" data-testid="text-email-failed"><AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" /><span>Last email failed {timeAgo(st.lastFailureAt!)}: {st.lastError}</span></p>
            ) : st.lastSentAt ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground"><CheckCircle2 className="h-3.5 w-3.5 text-success" />Last email sent {timeAgo(st.lastSentAt)}</p>
            ) : null}
          </div>
        </Section>
      )}
    </div>
  );
}
