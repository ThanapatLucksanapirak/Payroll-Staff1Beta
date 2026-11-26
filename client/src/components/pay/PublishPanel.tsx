import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Mail, MailWarning, Send, Undo2 } from "lucide-react";
import type { TimesheetSummary } from "@shared/schema";
import { api, errorMessage, queryClient } from "@/lib/api";
import { useApp } from "@/context/AppData";
import { isAdmin } from "@/lib/roles";
import { timeAgo } from "@/lib/doc";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface PublishRecord {
  at: string;
  byId: string | null;
  byName: string;
  email?: { at: string; ok: boolean; sent: number; message: string } | null;
}
interface PublishInfo {
  published: PublishRecord | null;
  final: boolean;
  emailReady: boolean;
  accountants: { id: string; name: string; email: string }[];
}

const key = (id: string) => ["/api/timesheets", id, "publish"];

/**
 * On a finalized timesheet: owners and administrators publish it to the
 * accountant (who then sees it and gets an email). Accountants see when it was
 * published.
 */
export function PublishPanel({ id, title }: { id: string; title: string }) {
  const app = useApp();
  const admin = isAdmin(app.user);
  const { toast } = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const info = useQuery<PublishInfo>({ queryKey: key(id), queryFn: () => api("GET", `/api/timesheets/${id}/publish`), enabled: admin, staleTime: 0 });
  const list = useQuery<TimesheetSummary[]>({ queryKey: ["/api/timesheets"], enabled: !admin });
  const publishedAt = list.data?.find((t) => t.id === id)?.publishedAt;

  if (!admin) {
    if (!publishedAt) return null;
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/80 bg-card px-4 py-2.5 text-[13px] shadow-card" data-testid="banner-published">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
        <span className="flex-1">Published {timeAgo(publishedAt)}. You can look through it and download the PDFs and CSV from Export.</span>
      </div>
    );
  }

  const data = info.data;
  const pub = data?.published ?? null;
  const withEmail = (data?.accountants ?? []).filter((a) => a.email);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: key(id) });
    void queryClient.invalidateQueries({ queryKey: ["/api/timesheets"], exact: true });
  };

  const publish = async () => {
    setBusy(true);
    try {
      const r = await api<{ published: PublishRecord }>("POST", `/api/timesheets/${id}/publish`, { notify });
      refresh();
      setOpen(false);
      const e = r.published.email;
      toast({
        title: pub ? "Emailed again" : data && data.accountants.length === 1 ? `Published to ${data.accountants[0].name}` : "Published to your accountants",
        description: e ? e.message : "No email was sent.",
        variant: e && !e.ok && !/not set up|No accountant/i.test(e.message) ? "destructive" : undefined,
      });
    } catch (err) {
      toast({ title: "Couldn't publish", description: errorMessage(err), variant: "destructive" });
    } finally { setBusy(false); }
  };

  const unpublish = async () => {
    const ok = await confirm({ title: `Unpublish “${title}”?`, description: "Your accountant will no longer see it. No email is sent.", confirmLabel: "Unpublish" });
    if (!ok) return;
    try {
      await api("DELETE", `/api/timesheets/${id}/publish`);
      refresh();
      toast({ title: "Unpublished" });
    } catch (err) {
      toast({ title: "Couldn't unpublish", description: errorMessage(err), variant: "destructive" });
    }
  };

  if (!data) return null;
  const noAccountant = data.accountants.length === 0;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/80 bg-card px-4 py-2.5 text-[13px] shadow-card" data-testid="banner-publish">
        {pub ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" /> : <Send className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1">
          {pub ? (
            <>
              {noAccountant
                ? <>Published {timeAgo(pub.at)} by {pub.byName}, but no accountant has access yet. Add one in <Link href="/settings/users" className="text-primary hover:underline">Settings → Users</Link>.</>
                : <>Published to {data.accountants.length === 1 ? data.accountants[0].name : "your accountants"} {timeAgo(pub.at)} by {pub.byName}.</>}
              {pub.email && !noAccountant && (
                <span className={pub.email.ok ? "text-muted-foreground" : "text-warning"}> {pub.email.message}</span>
              )}
            </>
          ) : noAccountant ? (
            <>Publishing shares this payroll with your accountant. Nobody has the Accountant role yet: add one in <Link href="/settings/users" className="text-primary hover:underline">Settings → Users</Link>, then publish.</>
          ) : (
            <>Not published yet. Publish it so your accountant can see it{data.emailReady && withEmail.length ? " and gets an email" : ""}.</>
          )}
        </span>
        {pub ? (
          <span className="flex gap-1.5">
            {data.emailReady && withEmail.length > 0
              ? <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="button-republish"><Mail />Email again</Button>
              : !data.emailReady && !noAccountant && <Button size="sm" variant="outline" asChild><Link href="/settings/email" data-testid="button-publish-setup-email"><Mail />Set up email</Link></Button>}
            <Button size="sm" variant="ghost" onClick={unpublish} data-testid="button-unpublish"><Undo2 />Unpublish</Button>
          </span>
        ) : (
          // Publishing with nobody to see it did nothing but say "Published to your accountant".
          <Button size="sm" onClick={() => setOpen(true)} disabled={noAccountant} title={noAccountant ? "Add an accountant first" : undefined} data-testid="button-publish"><Send />Publish…</Button>
        )}
      </div>

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{pub ? "Email your accountant again?" : `Publish “${title}”?`}</DialogTitle>
            <DialogDescription>
              {pub ? "It stays published. This sends the notification again." : "Accountants with access to this location will be able to see this payroll, its reports and PDFs. You can unpublish it later, and reopening it also unpublishes it."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-[13px]">
            {data.accountants.length > 0 && (
              <ul className="divide-y divide-border/70 rounded-xl border border-border/80">
                {data.accountants.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="font-medium">{a.name}</span>
                    <span className="truncate text-muted-foreground">{a.email || "no email address"}</span>
                  </li>
                ))}
              </ul>
            )}
            {!data.emailReady ? (
              <p className="flex items-start gap-2 text-muted-foreground"><MailWarning className="mt-0.5 h-4 w-4 shrink-0" /><span>Email isn't set up, so nobody will be emailed. <Link href="/settings/email" className="text-primary hover:underline">Set up email</Link></span></p>
            ) : withEmail.length === 0 ? (
              <p className="flex items-start gap-2 text-muted-foreground"><MailWarning className="mt-0.5 h-4 w-4 shrink-0" /><span>No accountant has a notification email yet. Add one in <Link href="/settings/users" className="text-primary hover:underline">Settings → Users</Link>.</span></p>
            ) : (
              <label className="flex items-center gap-2.5">
                <Checkbox checked={notify} onCheckedChange={(v) => setNotify(v === true)} data-testid="checkbox-notify" />
                <span>Email {withEmail.length === 1 ? withEmail[0].name : `${withEmail.length} accountants`}</span>
              </label>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={publish} disabled={busy || (!!pub && (!notify || !withEmail.length || !data.emailReady))} data-testid="button-publish-confirm">
              {busy ? <Loader2 className="animate-spin" /> : pub ? <Mail /> : <Send />}{pub ? "Send email" : "Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
