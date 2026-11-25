import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Loader2, Plus, Tablet, Trash2 } from "lucide-react";
import type { Site, TimeSource } from "@shared/schema";
import { api, errorMessage, queryClient } from "@/lib/api";
import { timeAgo } from "@/lib/doc";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, Section } from "@/components/workspace/fields";
import { cn } from "@/lib/utils";

interface Device { id: string; name: string; createdAt: string; lastSeenAt: string | null; pairCodeExpiresAt: string | null }
interface Created { device: Device; token: string; pairCode: string; pairPath: string }

const SOURCES: { id: TimeSource; title: string; desc: string }[] = [
  { id: "square", title: "Square", desc: "Pull timecards from Square" },
  { id: "kiosk", title: "Time clock", desc: "Employees clock in on a tablet" },
  { id: "both", title: "Both", desc: "Use either, per timesheet" },
];

/** Settings → Locations → Time clock. `draft` fields are saved with the location; devices change immediately. */
export function TimeClockSection({ site, draft, onChange }: { site: Site; draft: Site; onChange: (s: Site) => void }) {
  const kioskOn = draft.timeSource !== "square";
  return (
    <Section title="Time clock" description="Where this location's hours come from, and the tablets employees clock in on.">
      <div className="space-y-5">
        <Field label="Hours come from">
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={draft.timeSource === s.id}
                onClick={() => onChange({ ...draft, timeSource: s.id })}
                className={cn("rounded-xl border border-border/80 bg-card p-3 text-left shadow-card transition-[border-color,box-shadow] duration-150 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35", draft.timeSource === s.id && "border-primary ring-1 ring-primary")}
                data-testid={`radio-time-source-${s.id}`}
              >
                <span className="flex items-center justify-between text-[13px] font-semibold">{s.title}{draft.timeSource === s.id && <Check className="h-4 w-4 text-primary" />}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{s.desc}</span>
              </button>
            ))}
          </div>
        </Field>
        {kioskOn && (
          <>
            <Field label="Kiosk sign-in">
              <div className="flex flex-wrap gap-2">
                {([["pin", "PIN only"], ["name_pin", "Tap name, then PIN"]] as const).map(([id, label]) => (
                  <Button key={id} type="button" size="sm" variant={draft.kioskLoginMode === id ? "tinted" : "outline"} aria-pressed={draft.kioskLoginMode === id} onClick={() => onChange({ ...draft, kioskLoginMode: id })} data-testid={`button-login-mode-${id}`}>
                    {draft.kioskLoginMode === id && <Check />}{label}
                  </Button>
                ))}
              </div>
            </Field>
            <p className="text-xs text-muted-foreground">
              Set up who can clock in on the <Link href="/employees" className="font-medium text-primary hover:underline">Employees</Link> page, and watch punches arrive on the <Link href="/live" className="font-medium text-primary hover:underline">Live</Link> page.
            </p>
          </>
        )}
        <Devices site={site} enabled={site.timeSource !== "square"} />
      </div>
    </Section>
  );
}

function Devices({ site, enabled }: { site: Site; enabled: boolean }) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const key = ["/api/sites", site.id, "kiosk-devices"];
  const q = useQuery<Device[]>({ queryKey: key });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);

  const add = async () => {
    setBusy(true);
    try {
      const r = await api<Created>("POST", `/api/sites/${site.id}/kiosk-devices`, { name: name.trim() || "Time clock" });
      setCreated(r);
      setName("");
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (e) { toast({ title: "Couldn't add device", description: errorMessage(e), variant: "destructive" }); } finally { setBusy(false); }
  };
  const revoke = async (d: Device) => {
    if (!(await confirm({ title: `Remove ${d.name}?`, description: "It stops working right away. Punches it already sent are kept; punches still waiting on it (offline) are lost.", confirmLabel: "Remove device", destructive: true }))) return;
    try {
      await api("DELETE", `/api/sites/${site.id}/kiosk-devices/${d.id}`);
      await queryClient.invalidateQueries({ queryKey: key });
      toast({ title: "Device removed" });
    } catch (e) { toast({ title: "Couldn't remove", description: errorMessage(e), variant: "destructive" }); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">Kiosk devices</p>
        {!enabled && <span className="text-xs text-muted-foreground">Save with “Time clock” or “Both” selected to start using them.</span>}
      </div>
      {q.isLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : (q.data ?? []).length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-[13px] text-muted-foreground">No devices yet. Add one, then open its pairing link on the tablet or PC at the door.</p>
      ) : (
        <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/80">
          {q.data!.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
              <Tablet className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 min-w-0 truncate font-medium">{d.name}</span>
              {d.pairCodeExpiresAt ? <Badge variant="warning">Waiting to pair</Badge> : <span className="text-xs text-muted-foreground">{d.lastSeenAt ? `Seen ${timeAgo(d.lastSeenAt)}` : "Not used yet"}</span>}
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label={`Remove ${d.name}`} onClick={() => revoke(d)} data-testid={`button-revoke-${d.id}`}><Trash2 /></Button>
            </li>
          ))}
        </ul>
      )}
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <Field label="New device name" className="min-w-[12rem] flex-1"><Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Front door tablet" data-testid="input-device-name" /></Field>
        <Button type="submit" variant="outline" disabled={busy} data-testid="button-add-device">{busy ? <Loader2 className="animate-spin" /> : <Plus />} Add device</Button>
      </form>
      {created && <PairDialog created={created} onClose={() => setCreated(null)} />}
    </div>
  );
}

function PairDialog({ created, onClose }: { created: Created; onClose: () => void }) {
  const link = `${window.location.origin}${created.pairPath}`;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* not allowed */ }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Pair “{created.device.name}”</DialogTitle>
          <DialogDescription>This is shown only once. Use either the link or the code on the device.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Option 1: open this link on the device</p>
            <div className="flex gap-2">
              <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" data-testid="input-pair-link" />
              <Button variant="outline" size="icon" onClick={copy} aria-label="Copy link">{copied ? <Check /> : <Copy />}</Button>
            </div>
            <p className="text-xs text-muted-foreground">Anyone with this link can use the time clock as this device: send it only to the device itself.</p>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Option 2: open <span className="font-mono">{window.location.origin}/kiosk</span> and enter</p>
            <p className="rounded-xl bg-foreground/[0.04] py-3 text-center font-mono text-3xl font-semibold tracking-[0.25em]" data-testid="text-pair-code">{created.pairCode}</p>
            <p className="text-xs text-muted-foreground">The code works once and expires in 15 minutes.</p>
          </div>
        </div>
        <DialogFooter>
          <Button asChild variant="ghost" className="mr-auto"><a href={link} target="_blank" rel="noreferrer"><ExternalLink /> Use this browser as the kiosk</a></Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
