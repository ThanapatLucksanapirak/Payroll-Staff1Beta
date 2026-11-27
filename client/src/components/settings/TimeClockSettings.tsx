import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, KeyRound, Loader2, Plus, SlidersHorizontal, Tablet, Trash2 } from "lucide-react";
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
import { AutoClockOutSettings } from "@/components/timeclock/AutoClockOutSettings";
import { cn } from "@/lib/utils";
import { type KioskDeviceOptions, type KioskSiteConfig, weakPinReason } from "@shared/kiosk";
import { DeviceOptionsPanel, KioskLocationExtras } from "./KioskExtrasSettings";
import { PortalSettingsCard } from "./PortalSettings";
import { LoadError } from "@/components/LoadError";

interface Device { id: string; name: string; createdAt: string; lastSeenAt: string | null; pairCodeExpiresAt: string | null; options?: KioskDeviceOptions }
interface Created { device: Device; token: string; pairCode: string; pairPath: string }

const SOURCES: { id: TimeSource; title: string; desc: string }[] = [
  { id: "square", title: "Square", desc: "Pull timecards from Square" },
  { id: "kiosk", title: "Time clock", desc: "Employees clock in on a tablet" },
  { id: "both", title: "Both", desc: "Use either, per timesheet" },
];

/** Settings → Locations → Time clock. Everything here is saved with the page's Save changes button, except adding/removing devices and the manager PIN. */
export function TimeClockSection({ site, draft, onChange }: { site: Site; draft: Site; onChange: (s: Site) => void }) {
  const kioskOn = draft.timeSource !== "square";
  return (
    <Section title="Time clock" description="Where this location's hours come from, and the tablets employees clock in on.">
      <div className="space-y-5">
        <Field label="Hours come from">
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Hours come from">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={draft.timeSource === s.id}
                onClick={() => onChange({ ...draft, timeSource: s.id })}
                className={cn("min-h-14 rounded-xl border border-border/80 bg-card px-3.5 py-2.5 text-left shadow-card transition-[border-color,box-shadow] duration-150 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35", draft.timeSource === s.id && "border-primary ring-1 ring-primary")}
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
        <ManagerPin site={site} />
        {site.timeSource !== "square" && <AutoClockOutSettings site={site} />}
        <KioskLocationExtras site={site} />
        <PortalSettingsCard site={site} />
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
  const [openOptions, setOpenOptions] = useState<string | null>(null);
  const cfg = useQuery<KioskSiteConfig>({ queryKey: ["/api/sites", site.id, "kiosk-config"] });

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
      {q.isLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : q.isError && !q.data ? <LoadError what="the time clock devices" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} testid="devices-error" /> : (q.data ?? []).length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-[13px] text-muted-foreground">No devices yet. Add one, then open its pairing link on the tablet or PC at the door.</p>
      ) : (
        <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/80">
          {q.data!.map((d) => (
            <li key={d.id} className="text-[13px]">
              <div className="flex items-center gap-2 px-3 py-2 sm:gap-3">
                <Tablet className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{d.name}</span>
                  {d.options && <span className="block truncate text-xs text-muted-foreground">{[d.options.photo ? "Photo on" : "No photo", d.options.loginMode === "site" ? null : d.options.loginMode === "pin" ? "PIN only" : "Name list", `${d.options.idleSeconds}s idle`].filter(Boolean).join(" · ")}</span>}
                </span>
                {d.pairCodeExpiresAt ? <Badge variant="warning">Waiting to pair</Badge> : <span className="hidden text-xs text-muted-foreground sm:inline">{d.lastSeenAt ? `Seen ${timeAgo(d.lastSeenAt)}` : "Not used yet"}</span>}
                <Button variant="ghost" size="sm" className="text-muted-foreground max-sm:h-10 max-sm:w-10 max-sm:px-0" aria-label={`Options for ${d.name}`} aria-expanded={openOptions === d.id} onClick={() => setOpenOptions(openOptions === d.id ? null : d.id)} data-testid={`button-device-options-${d.id}`}><SlidersHorizontal /><span className="max-sm:hidden">Options</span></Button>
                <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-danger max-sm:h-10 max-sm:w-10" aria-label={`Remove ${d.name}`} onClick={() => revoke(d)} data-testid={`button-revoke-${d.id}`}><Trash2 /></Button>
              </div>
              {/* Kept mounted while closed so unsaved changes survive collapsing the panel. */}
              <div hidden={openOptions !== d.id}><DeviceOptionsPanel siteId={site.id} deviceId={d.id} deviceName={d.name} options={d.options} hasStations={(cfg.data?.stations.length ?? 0) > 0} /></div>
            </li>
          ))}
        </ul>
      )}
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <Field label="New device name" className="min-w-[12rem] flex-1"><Input value={name} maxLength={60} disabled={!enabled} onChange={(e) => setName(e.target.value)} placeholder="e.g. Front door tablet" data-testid="input-device-name" /></Field>
        <Button type="submit" variant="outline" disabled={busy || !enabled} data-testid="button-add-device">{busy ? <Loader2 className="animate-spin" /> : <Plus />} Add device</Button>
      </form>
      {!enabled && <p className="text-xs text-muted-foreground" data-testid="text-add-device-off">Switch to Time clock or Both and save first. A tablet can't clock anyone in while hours come from Square.</p>}
      {created && <PairDialog created={created} onClose={() => setCreated(null)} />}
    </div>
  );
}

const LOCK_GUIDE: { title: string; steps: string[] }[] = [
  { title: "iPad (Guided Access)", steps: [
    "Settings → Accessibility → Guided Access: turn it on, then set a passcode under Passcode Settings (use a different code from the manager PIN).",
    "Open https://YOUR-ADDRESS/kiosk in Safari and tap Share → Add to Home Screen. Open it from the Home Screen so it runs without the address bar.",
    "Pair it from inside the Home Screen app (type the pairing code there). Home Screen apps don't share Safari's storage, so pairing in Safari doesn't carry over.",
    "Triple-click the side (or Home) button and tap Start. The iPad now stays on the time clock.",
    "To leave, triple-click again and enter the Guided Access passcode.",
  ] },
  { title: "Android (screen pinning)", steps: [
    "Turn on App pinning with “Ask for PIN before unpinning” (Pixel: Settings → Security & privacy → More security settings → App pinning; Samsung: Settings → Security and privacy → More security settings → Pin app).",
    "Open the kiosk in Chrome, tap ⋮ → Add to Home screen / Install app, and open it from the Home screen.",
    "Open Recent apps, tap the app's icon at the top of its card, and choose Pin.",
    "To leave, hold Back and Overview (or swipe up and hold), then enter the device PIN.",
  ] },
  { title: "Windows or Linux PC (Chrome kiosk mode)", steps: [
    "Make a shortcut that runs: chrome --kiosk --app=https://YOUR-ADDRESS/kiosk",
    "Windows: put the shortcut in the Startup folder (Win+R, shell:startup). Linux: add it to your desktop's autostart apps.",
    "To leave, press Alt+F4 (Windows) or Ctrl+Shift+Q (Linux).",
  ] },
  { title: "Fully locked Windows PC (Assigned Access with Microsoft Edge)", steps: [
    "Windows Pro or Enterprise: Settings → Accounts → Other users → Set up a kiosk. It makes a separate account that runs one app; choose Microsoft Edge (Chrome isn't offered here).",
    "Choose to run Edge as a digital sign or interactive display, enter https://YOUR-ADDRESS/kiosk, then pair the kiosk while signed in to that account.",
    "To leave, press Ctrl+Alt+Del and switch to another account. Not available on Windows Home: use the Chrome shortcut above instead.",
  ] },
];

function LockGuide({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Lock the tablet to the time clock</DialogTitle>
          <DialogDescription>The manager PIN protects the kiosk's own settings. These steps stop people leaving the app or opening other apps on the device.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {LOCK_GUIDE.map((g) => (
            <div key={g.title}>
              <p className="text-[13px] font-semibold">{g.title}</p>
              <ol className="mt-1 list-decimal space-y-1 pl-5 text-[13px] text-muted-foreground">
                {g.steps.map((s) => <li key={s}>{s}</li>)}
              </ol>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">Also turn off auto-lock or sleep while plugged in, and keep the device on its charger.</p>
        </div>
        <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Manager PIN: needed on the kiosk to open its settings, unpair it, or leave full screen. */
function ManagerPin({ site }: { site: Site }) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const key = ["/api/sites", site.id, "kiosk-manager-pin"];
  const q = useQuery<{ set: boolean }>({ queryKey: key });
  const [editing, setEditing] = useState(false);
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [guide, setGuide] = useState(false);
  const weak = /^\d{4,8}$/.test(pin) ? weakPinReason(pin) : null;
  const valid = /^\d{4,8}$/.test(pin) && !weak;
  const match = pin === again;

  const save = async (value: string | null) => {
    setBusy(true);
    try {
      await api("PUT", `/api/sites/${site.id}/kiosk-manager-pin`, { pin: value });
      await queryClient.invalidateQueries({ queryKey: key });
      setEditing(false); setPin(""); setAgain("");
      toast({ title: value ? "Manager PIN saved" : "Manager PIN removed" });
    } catch (e) { toast({ title: "Couldn't save the PIN", description: errorMessage(e), variant: "destructive" }); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await confirm({ title: "Remove the manager PIN?", description: "Without a manager PIN, anyone at a tablet can open its settings and leave full screen. Unpairing from the tablet is off until you set a new PIN (you can still remove devices here).", confirmLabel: "Remove PIN", destructive: true }))) return;
    await save(null);
  };
  const isSet = q.data?.set;

  return (
    <div className="space-y-3 border-t border-border/70 pt-4">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 h-4 w-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[13px] font-semibold">Manager PIN {q.isLoading || (q.isError && !q.data) ? null : isSet ? <Badge variant="success">On</Badge> : <Badge variant="warning">Not set</Badge>}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Asked for on the kiosk before anyone can open its settings, unpair it, or leave full screen. It must differ from every employee PIN, and easy ones (1234, 0000, 1212) aren't allowed.{" "}
            <button type="button" onClick={() => setGuide(true)} className="font-medium text-primary hover:underline" data-testid="button-lock-guide">How to lock the tablet itself</button>
          </p>
          {q.isError && !q.data && <div className="mt-2"><LoadError what="whether a manager PIN is set" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} testid="manager-pin-error" /></div>}
          {!q.isLoading && q.data && !isSet && (
            <p className="mt-2 rounded-lg bg-warning-soft px-2.5 py-1.5 text-xs font-medium text-warning" role="status" data-testid="text-no-manager-pin">
              No manager PIN set: anyone at a tablet can open its settings and leave full screen. Unpairing from the tablet is off until you set one.
            </p>
          )}
        </div>
        {!editing && (
          <div className="flex gap-1">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)} data-testid="button-manager-pin-edit">{isSet ? "Change" : "Set PIN"}</Button>
            {isSet && <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={remove} disabled={busy} data-testid="button-manager-pin-remove">Remove</Button>}
          </div>
        )}
      </div>
      {editing && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (valid && match) void save(pin); }}>
          <Field label="New PIN (4 to 8 digits)" className="w-40"><Input type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} data-testid="input-manager-pin" /></Field>
          <Field label="Type it again" className="w-40"><Input type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={again} onChange={(e) => setAgain(e.target.value.replace(/\D/g, ""))} data-testid="input-manager-pin-again" /></Field>
          <Button type="submit" disabled={busy || !valid || !match} data-testid="button-manager-pin-save">{busy && <Loader2 className="animate-spin" />} Save PIN</Button>
          <Button type="button" variant="ghost" onClick={() => { setEditing(false); setPin(""); setAgain(""); }}>Cancel</Button>
          {again.length > 0 && !match && <p className="w-full text-xs text-destructive">The two PINs don't match.</p>}
          {weak && <p className="w-full text-xs text-destructive" data-testid="text-weak-pin">{weak}</p>}
        </form>
      )}
      {guide && <LockGuide onClose={() => setGuide(false)} />}
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
