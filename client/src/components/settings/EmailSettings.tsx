// Settings → Email: the SMTP server the app sends notifications through
// (optional). The password is saved on the server and never shown again.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Copy, Loader2, LogIn, Send, Unplug } from "lucide-react";
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
type Provider = "smtp" | "google";
interface EmailCfg {
  enabled: boolean; provider: Provider; host: string; port: number; security: Security; username: string;
  fromAddress: string; fromName: string; appUrl: string; hasPassword: boolean;
  googleClientId: string; googleAccount: string; hasGoogleSecret: boolean; googleConnected: boolean;
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

const presetFor = (c: Pick<EmailCfg, "host" | "provider">) => c.provider === "google" ? "gmail" : PRESETS.find((p) => p.host && p.host === c.host.trim().toLowerCase())?.id ?? "other";

/** What came back from "Connect with Google" (the server adds ?google=… when it sends the person back here). */
const GOOGLE_OUTCOMES: Record<string, { ok: boolean; title: string; description: string }> = {
  connected: { ok: true, title: "Google account connected", description: "Emails will be sent through Gmail. Send a test email to check." },
  denied: { ok: false, title: "Not connected", description: "Google sign-in was cancelled. Try again and press Allow." },
  expired: { ok: false, title: "Not connected", description: "That sign-in took too long or was already used. Press Connect with Google again." },
  changed: { ok: false, title: "Not connected", description: "The Google client ID changed while you were signing in. Press Connect with Google again." },
  client: { ok: false, title: "Google didn't accept the client", description: "Check the client ID and client secret from Google Cloud, save, and try again." },
  scope: { ok: false, title: "Gmail access wasn't allowed", description: "On Google's screen, tick the box that lets the app send email, then press Allow." },
  refresh: { ok: false, title: "Not connected", description: "Google didn't give lasting access. Remove the app at myaccount.google.com → Security → Third-party connections, then connect again." },
  failed: { ok: false, title: "Couldn't connect to Google", description: "Check that the redirect URI in Google Cloud matches the one shown here exactly, then try again." },
};

export function EmailSettings() {
  const app = useApp();
  const { toast } = useToast();
  const q = useQuery<EmailInfo>({ queryKey: KEY });
  const [cfg, setCfg] = useState<EmailCfg | null>(null);
  const [password, setPassword] = useState("");
  const [googleSecret, setGoogleSecret] = useState("");
  const [preset, setPreset] = useState("other");
  const [testTo, setTestTo] = useState(app.user.notificationEmail ?? "");
  const [busy, setBusy] = useState<string | null>(null);

  const load = (c: EmailCfg) => {
    setCfg({ ...c, appUrl: c.appUrl || window.location.origin });
    setPreset(presetFor(c));
    setPassword("");
    setGoogleSecret("");
  };
  // Fill the form once; later refreshes (e.g. the status after a test) must not wipe unsaved edits.
  useEffect(() => { if (q.data && !cfg) load(q.data.config); }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // Back from Google: say how it went once, then tidy the address bar.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("google");
    if (!outcome) return;
    const o = GOOGLE_OUTCOMES[outcome] ?? GOOGLE_OUTCOMES.failed;
    toast({ title: o.title, description: o.description, variant: o.ok ? undefined : "destructive" });
    params.delete("google");
    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.error) return <Section title="Email"><p className="text-sm text-destructive">{errorMessage(q.error)}</p></Section>;
  if (!cfg || !q.data) return <Section title="Email"><Skeleton className="h-48" /></Section>;

  const saved = q.data.config;
  const plain = (c: EmailCfg) => [c.enabled, c.provider, c.host, c.port, c.security, c.username, c.fromAddress, c.fromName, c.appUrl, c.googleClientId].join("|");
  const google = cfg.provider === "google";
  // The saved password only goes to the server it was entered for (the server enforces this too).
  const dest = (c: EmailCfg) => [c.host.trim().toLowerCase(), c.port, c.security, c.username.trim().toLowerCase()].join("|");
  const needPassword = !google && saved.hasPassword && !password && dest(cfg) !== dest(saved);
  const dirty = plain(cfg) !== plain({ ...saved, appUrl: saved.appUrl || window.location.origin }) || !!password || !!googleSecret || !saved.appUrl;
  const body = () => ({
    enabled: cfg.enabled, provider: cfg.provider, host: cfg.host.trim(), port: cfg.port, security: cfg.security, username: cfg.username.trim(),
    fromAddress: cfg.fromAddress.trim(), fromName: cfg.fromName.trim(), appUrl: cfg.appUrl.trim(), googleClientId: cfg.googleClientId.trim(),
    ...(password ? { password } : {}), ...(googleSecret ? { googleClientSecret: googleSecret.trim() } : {}),
  });
  // The connection belongs to the saved client ID: changing it means connecting again.
  const sameClient = cfg.googleClientId.trim() === saved.googleClientId;
  const connected = saved.googleConnected && sameClient;
  const redirectUri = `${(cfg.appUrl.trim() || window.location.origin).replace(/\/+$/, "")}/api/email/google/callback`;
  const canConnect = !!cfg.googleClientId.trim() && (!!googleSecret || (saved.hasGoogleSecret && sameClient)) && /^https?:\/\//i.test(cfg.appUrl.trim());
  const set = (patch: Partial<EmailCfg>) => setCfg({ ...cfg, ...patch });
  const help = google ? "Sign in with your Google account and press Allow. No App password needed." : PRESETS.find((p) => p.id === preset)?.help;

  const choosePreset = (id: string) => {
    setPreset(id);
    const p = PRESETS.find((x) => x.id === id);
    const provider: Provider = id === "gmail" ? cfg.provider : "smtp";
    if (p && p.host) set({ provider, host: p.host, port: p.port, security: p.security, ...(id === "resend" && !cfg.username ? { username: "resend" } : {}) });
    else set({ provider });
  };

  const connectGoogle = async () => {
    setBusy("google");
    try {
      if (dirty) {
        const r = await api<EmailInfo>("PUT", "/api/email", { config: body() });
        queryClient.setQueryData(KEY, r);
        load(r.config);
      }
      const r = await api<{ url: string }>("POST", "/api/email/google/start", {});
      window.location.assign(r.url);
    } catch (e) {
      toast({ title: "Couldn't start Google sign-in", description: errorMessage(e), variant: "destructive" });
      setBusy(null);
    }
  };

  const disconnectGoogle = async () => {
    setBusy("google");
    try {
      await api("POST", "/api/email/google/disconnect", {});
      const r = await queryClient.fetchQuery<EmailInfo>({ queryKey: KEY, staleTime: 0 });
      load(r.config);
      toast({ title: "Google account disconnected" });
    } catch (e) { toast({ title: "Couldn't disconnect", description: errorMessage(e), variant: "destructive" }); }
    finally { setBusy(null); }
  };

  const copyRedirect = async () => {
    try { await navigator.clipboard.writeText(redirectUri); toast({ title: "Copied" }); }
    catch { toast({ title: "Couldn't copy", description: "Select the address and copy it by hand." }); }
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
        description="Optional. When it's on, the app emails your accountant when you publish payroll, and people can get sign-in codes by email. Everything else works the same without it."
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
              {preset === "gmail" && (
                <Field label="How to sign in to Gmail">
                  <Select value={cfg.provider} onValueChange={(v) => set({ provider: v as Provider })}>
                    <SelectTrigger data-testid="select-email-provider"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="google">Connect with Google (no password)</SelectItem>
                      <SelectItem value="smtp">App password</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              )}
              {google ? (
                <div className="space-y-3 rounded-xl border border-border/80 p-3">
                  <p className="text-xs text-muted-foreground">One-time setup in Google Cloud: create an OAuth client (type "Web application"), add the redirect URI below, then paste its client ID and secret here.</p>
                  <Field label="Redirect URI (add this in Google Cloud)">
                    <div className="flex gap-2">
                      <Input readOnly value={redirectUri} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} data-testid="input-google-redirect" />
                      <Button type="button" variant="outline" size="icon" onClick={() => void copyRedirect()} aria-label="Copy redirect URI"><Copy /></Button>
                    </div>
                  </Field>
                  <div className="grid items-start gap-3 sm:grid-cols-2">
                    <Field label="Client ID"><Input value={cfg.googleClientId} spellCheck={false} autoCapitalize="none" autoComplete="off" placeholder="…apps.googleusercontent.com" onChange={(e) => set({ googleClientId: e.target.value })} data-testid="input-google-client-id" /></Field>
                    <Field label="Client secret" hint={saved.hasGoogleSecret && sameClient ? "Saved. Leave blank to keep it." : "Stored on your server only. Never shown again."}>
                      <Input type="password" autoComplete="new-password" value={googleSecret} placeholder={saved.hasGoogleSecret && sameClient ? "••••••••" : ""} onChange={(e) => setGoogleSecret(e.target.value)} data-testid="input-google-client-secret" />
                    </Field>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {connected ? (
                      <>
                        <span className="flex flex-1 items-center gap-2 text-sm" data-testid="text-google-connected"><CheckCircle2 className="h-4 w-4 text-success" />Connected as <span className="font-medium">{saved.googleAccount}</span></span>
                        <Button type="button" variant="outline" size="sm" disabled={!!busy || !canConnect} onClick={() => void connectGoogle()}>{busy === "google" ? <Loader2 className="animate-spin" /> : <LogIn />}Reconnect</Button>
                        <Button type="button" variant="ghost" size="sm" disabled={!!busy} onClick={() => void disconnectGoogle()} data-testid="button-google-disconnect"><Unplug />Disconnect</Button>
                      </>
                    ) : (
                      <Button type="button" disabled={!!busy || !canConnect} onClick={() => void connectGoogle()} data-testid="button-google-connect">{busy === "google" ? <Loader2 className="animate-spin" /> : <LogIn />}Connect with Google</Button>
                    )}
                  </div>
                </div>
              ) : (
              <>
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
              </div>
              </>
              )}
              <div className="grid items-start gap-3 sm:grid-cols-2">
                <Field label="From address" hint={google ? "Your Google account's address, or one added in Gmail under Settings → Accounts → Send mail as. Otherwise Gmail sends from the account's own address." : "Your email service must allow sending from this address (e.g. verify the domain, or add it as a send-as address)."}><Input type="email" value={cfg.fromAddress} spellCheck={false} autoCapitalize="none" placeholder="payroll@yourcompany.com" onChange={(e) => set({ fromAddress: e.target.value })} data-testid="input-email-from" /></Field>
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
              <Button type="submit" variant="outline" disabled={!!busy || needPassword || !testTo.trim() || (google ? !connected : !cfg.host.trim()) || !cfg.fromAddress.trim()} data-testid="button-email-test">{busy === "test" ? <Loader2 className="animate-spin" /> : <Send />}Send test email</Button>
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
