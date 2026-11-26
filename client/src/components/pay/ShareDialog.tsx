// Email a finalized payroll's PDFs to anyone: pick the reports and who gets
// them (accountants in the app, or any address), see exactly what will be
// sent, then confirm.
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, FileText, Loader2, MailWarning, Send, X } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { useApp } from "@/context/AppData";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type ReportKind = "report" | "summary" | "statements" | "payout";
const REPORTS: { kind: ReportKind; label: string; hint: string }[] = [
  { kind: "report", label: "Full report", hint: "Overview and every employee's details" },
  { kind: "summary", label: "Manager summary", hint: "One page" },
  { kind: "statements", label: "Pay statements", hint: "One page per employee" },
  { kind: "payout", label: "Pay-out sheet", hint: "Cash, bank transfers and checks" },
];

interface PublishInfo { emailReady: boolean; accountants: { id: string; name: string; email: string }[] }
interface Preview {
  from: string; to: { name: string; email: string }[]; cc: string[]; replyTo: string | null; subject: string; html: string;
  attachments: { filename: string; size: number }[];
}
type Files = { kind: ReportKind; data: string }[];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 10;
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The preview's links can't be followed (they would navigate the frame). */
export function inertLinks(html: string): string {
  const css = "<style>a{pointer-events:none!important;cursor:default!important}</style>";
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${css}`) : `${css}${html}`;
}

export function ShareDialog({ id, open, onOpenChange, makePdf, onDownload }: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Builds one PDF in the browser (the same files as Export). */
  makePdf: (kind: ReportKind) => Promise<ArrayBuffer>;
  /** Download one PDF, the same as Export (offered when email isn't set up). */
  onDownload?: (kind: ReportKind) => void | Promise<void>;
}) {
  const app = useApp();
  const { toast } = useToast();
  const info = useQuery<PublishInfo>({ queryKey: ["/api/timesheets", id, "publish"], queryFn: () => api("GET", `/api/timesheets/${id}/publish`), enabled: open, staleTime: 0 });
  const withEmail = (info.data?.accountants ?? []).filter((a) => a.email);
  const [kinds, setKinds] = useState<ReportKind[]>(["report", "statements"]);
  const [to, setTo] = useState<string[]>([]);
  const [emails, setEmails] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const [message, setMessage] = useState("");
  const [copyMe, setCopyMe] = useState(false);
  const [busy, setBusy] = useState<null | "preview" | "send">(null);
  const [preview, setPreview] = useState<{ data: Preview; files: Files } | null>(null);

  // Fresh start each time it opens: every accountant ticked.
  useEffect(() => { if (open) { setPreview(null); setMessage(""); setCopyMe(false); setBusy(null); setEmails([]); setTyped(""); } }, [open]);
  useEffect(() => { if (open && info.data) setTo(withEmail.map((a) => a.id)); }, [open, info.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));
  // Typed addresses: added on Enter, comma or space, and whatever is left in the box when previewing.
  const parse = (text: string) => text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  const pending = parse(typed);
  const badTyped = pending.filter((x) => !EMAIL_RE.test(x));
  const addTyped = () => {
    const good = pending.filter((x) => EMAIL_RE.test(x));
    if (good.length) setEmails((cur) => [...new Set([...cur, ...good])]);
    setTyped(badTyped.join(", "));
  };
  const allEmails = [...new Set([...emails, ...pending.filter((x) => EMAIL_RE.test(x))])];
  const count = to.length + allEmails.length;
  const body = (files: Files, send: boolean) => ({ recipientIds: to, emails: allEmails, files, message: message.trim(), copyMe, send });

  const makePreview = async () => {
    addTyped();
    setBusy("preview");
    try {
      const files: Files = [];
      for (const r of REPORTS) if (kinds.includes(r.kind)) files.push({ kind: r.kind, data: toBase64(await makePdf(r.kind)) });
      const data = await api<Preview>("POST", `/api/timesheets/${id}/share`, body(files, false), { timeoutMs: 60_000 });
      setPreview({ data, files });
    } catch (e) {
      toast({ title: "Couldn't make the preview", description: errorMessage(e), variant: "destructive" });
    } finally { setBusy(null); }
  };

  const send = async () => {
    if (!preview) return;
    setBusy("send");
    try {
      const r = await api<{ message: string }>("POST", `/api/timesheets/${id}/share`, body(preview.files, true), { timeoutMs: 90_000 });
      toast({ title: "Email sent", description: r.message });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "Couldn't send", description: errorMessage(e), variant: "destructive" });
    } finally { setBusy(null); }
  };

  const downloadAll = async () => {
    if (!onDownload) return;
    setBusy("preview");
    try {
      for (const r of REPORTS) if (kinds.includes(r.kind)) await onDownload(r.kind);
      toast({ title: kinds.length === 1 ? "PDF downloaded" : `${kinds.length} PDFs downloaded`, description: "Check your Downloads folder, then attach them to an email." });
      onOpenChange(false);
    } finally { setBusy(null); }
  };

  const ready = !!info.data?.emailReady;
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className={preview ? "max-w-2xl" : "max-w-md"}>
        <DialogHeader>
          <DialogTitle>{preview ? "Check and send" : "Email payroll PDFs"}</DialogTitle>
          <DialogDescription>{preview ? "This is exactly what will be sent. Nothing has been sent yet." : info.data && !info.data.emailReady ? "Send the payroll PDFs to your accountant or anyone else." : "Pick the reports to attach. You'll see a preview before anything is sent."}</DialogDescription>
        </DialogHeader>

        {!info.data ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : !info.data.emailReady ? (
          // Not a dead end: say what's missing and who it would go to, and offer the files to download instead.
          <div className="space-y-3 text-[13px]" data-testid="share-no-email">
            <p className="flex items-start gap-2 rounded-xl bg-warning-soft px-3 py-2.5 text-foreground"><MailWarning className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <span><span className="font-medium">Email isn't set up yet, so nothing can be sent.</span> Setting it up needs your Google account, or your email provider's SMTP details (server, user name and password).</span>
            </p>
            <p className="text-muted-foreground" data-testid="share-no-email-recipients">
              {info.data.accountants.length
                ? <>Once it's set up, you can send to {info.data.accountants.map((a) => a.name).join(", ")}{withEmail.length < info.data.accountants.length ? " (accountants need an email address on their user)" : ""}, or to any address you type.</>
                : <>Once it's set up, you can send to any address you type. No accountant has access yet: add one in <Link href="/settings/users" className="text-primary hover:underline">Settings → Users</Link>.</>}
            </p>
            {onDownload && (
              <fieldset className="space-y-2">
                <legend className="mb-1.5 font-medium">Or download the PDFs and send them yourself</legend>
                {REPORTS.map((r) => (
                  <label key={r.kind} className="flex items-start gap-2.5">
                    <Checkbox className="mt-0.5" checked={kinds.includes(r.kind)} onCheckedChange={(v) => setKinds(toggle(kinds, r.kind, v === true))} data-testid={`checkbox-download-${r.kind}`} />
                    <span>{r.label} <span className="block text-xs text-muted-foreground">{r.hint}</span></span>
                  </label>
                ))}
              </fieldset>
            )}
          </div>
        ) : preview ? (
          <div className="min-w-0 space-y-3 text-[13px]" data-testid="share-preview">
            <dl className="grid min-w-0 grid-cols-[4.75rem_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-xl border border-border/80 px-3 py-2.5 sm:grid-cols-[5.5rem_minmax(0,1fr)]">
              <dt className="text-muted-foreground">From</dt><dd className="[overflow-wrap:anywhere]">{preview.data.from}</dd>
              <dt className="text-muted-foreground">To</dt><dd className="[overflow-wrap:anywhere]">{preview.data.to.map((t) => (t.name ? `${t.name} <${t.email}>` : t.email)).join(", ")}</dd>
              {preview.data.cc.length > 0 && <><dt className="text-muted-foreground">Copy to</dt><dd className="[overflow-wrap:anywhere]">{preview.data.cc.join(", ")}</dd></>}
              {preview.data.replyTo && <><dt className="text-muted-foreground">Replies to</dt><dd className="[overflow-wrap:anywhere]">{preview.data.replyTo}</dd></>}
              <dt className="text-muted-foreground">Subject</dt><dd className="font-medium [overflow-wrap:anywhere]">{preview.data.subject}</dd>
              <dt className="text-muted-foreground">Attached</dt>
              <dd className="min-w-0 space-y-0.5">{preview.data.attachments.map((a) => <span key={a.filename} className="flex min-w-0 items-center gap-1.5"><FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{a.filename}</span><span className="shrink-0 text-muted-foreground">{kb(a.size)}</span></span>)}</dd>
            </dl>
            {/* The email itself, in a sandbox with no scripts. Its links are switched off: following one would load
                the app inside the frame, which the app refuses (no framing), and the preview went blank. */}
            <iframe title="Email preview" sandbox="" srcDoc={inertLinks(preview.data.html)} className="h-[380px] w-full rounded-xl border border-border/80 bg-white" data-testid="share-preview-frame" />
            <p className="text-xs text-muted-foreground">Links in the email work once it's sent. They're switched off in this preview.</p>
          </div>
        ) : (
          <div className="space-y-4 text-[13px]">
            <fieldset className="space-y-2">
              <legend className="mb-1.5 font-medium">Attach</legend>
              {REPORTS.map((r) => (
                <label key={r.kind} className="flex items-start gap-2.5">
                  <Checkbox className="mt-0.5" checked={kinds.includes(r.kind)} onCheckedChange={(v) => setKinds(toggle(kinds, r.kind, v === true))} data-testid={`checkbox-share-${r.kind}`} />
                  <span>{r.label} <span className="block text-xs text-muted-foreground">{r.hint}</span></span>
                </label>
              ))}
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="mb-1.5 font-medium">Send to</legend>
              {withEmail.length > 0 && <span className="block text-xs text-muted-foreground">Accountants</span>}
              {withEmail.map((a) => (
                <label key={a.id} className="flex items-center gap-2.5">
                  <Checkbox checked={to.includes(a.id)} onCheckedChange={(v) => setTo(toggle(to, a.id, v === true))} />
                  <span className="min-w-0 truncate"><span className="font-medium">{a.name}</span> <span className="text-muted-foreground">{a.email}</span></span>
                </label>
              ))}
              <div className="space-y-1.5 pt-1">
                <span className="block text-xs text-muted-foreground">{withEmail.length ? "Other email addresses" : "Email addresses"}</span>
                {emails.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {emails.map((e) => (
                      <span key={e} className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs">
                        <span className="truncate">{e}</span>
                        <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setEmails(emails.filter((x) => x !== e))} aria-label={`Remove ${e}`}><X className="h-3 w-3" /></button>
                      </span>
                    ))}
                  </div>
                )}
                <Input
                  type="email" inputMode="email" autoCapitalize="none" spellCheck={false} multiple value={typed} placeholder="name@example.com"
                  onChange={(e) => setTyped(e.target.value)} onBlur={addTyped}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTyped(); } }}
                  data-testid="input-share-emails"
                />
                {badTyped.length > 0 && <span className="block text-xs text-destructive">Not an email address: {badTyped.join(", ")}</span>}
                {count > MAX_RECIPIENTS && <span className="block text-xs text-destructive">Up to {MAX_RECIPIENTS} addresses per email.</span>}
              </div>
              <label className="flex items-center gap-2.5">
                <Checkbox checked={copyMe} disabled={!app.user.notificationEmail} onCheckedChange={(v) => setCopyMe(v === true)} />
                <span className={app.user.notificationEmail ? "" : "text-muted-foreground"}>Send me a copy{app.user.notificationEmail ? ` (${app.user.notificationEmail})` : " (add your email in Settings → Account first)"}</span>
              </label>
            </fieldset>
            <label className="block space-y-1.5">
              <span className="font-medium">Message <span className="font-normal text-muted-foreground">(optional)</span></span>
              <Textarea value={message} maxLength={1000} rows={3} placeholder="Anything your accountant should know" onChange={(e) => setMessage(e.target.value)} data-testid="input-share-message" />
            </label>
          </div>
        )}

        <DialogFooter>
          {preview ? (
            <>
              <Button type="button" variant="outline" onClick={() => setPreview(null)} disabled={!!busy}><ArrowLeft />Back</Button>
              <Button onClick={() => void send()} disabled={!!busy} data-testid="button-share-send">{busy === "send" ? <Loader2 className="animate-spin" /> : <Send />}Send email</Button>
            </>
          ) : info.data && !ready ? (
            <>
              <Button type="button" variant="outline" asChild><Link href="/settings/email" data-testid="button-share-setup-email">Set up email</Link></Button>
              {onDownload && (
                <Button onClick={() => void downloadAll()} disabled={!!busy || !kinds.length} data-testid="button-share-download">{busy ? <Loader2 className="animate-spin" /> : <Download />}Download instead</Button>
              )}
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={!!busy}>Cancel</Button>
              <Button onClick={() => void makePreview()} disabled={!!busy || !ready || !kinds.length || !count || count > MAX_RECIPIENTS || badTyped.length > 0} data-testid="button-share-preview">{busy === "preview" && <Loader2 className="animate-spin" />}Preview…</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
