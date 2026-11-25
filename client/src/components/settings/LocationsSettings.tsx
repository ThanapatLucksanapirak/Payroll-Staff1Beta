import { useEffect, useState } from "react";
import { Archive, Check, Link2, Loader2, Plus, Trash2, Unlink } from "lucide-react";
import type { Site } from "@shared/schema";
import { DEFAULT_RULES } from "@shared/schema";
import { useApp } from "@/context/AppData";
import { api, errorMessage } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, Section } from "@/components/workspace/fields";
import { SiteDot } from "@/components/AppShell";
import { RulesEditor } from "./RulesEditor";
import { cn } from "@/lib/utils";

const COLORS = ["#0f766e", "#2563eb", "#7c3aed", "#db2777", "#ea580c", "#ca8a04", "#16a34a", "#475569"];

export function LocationsSettings() {
  const app = useApp();
  const [selected, setSelected] = useState(app.site.id);
  const [creating, setCreating] = useState(false);
  const site = app.sites.find((s) => s.id === selected) ?? app.sites[0];

  return (
    <div className="grid gap-5 xl:grid-cols-[13rem_1fr]">
      <div className="h-fit rounded-xl border border-card-border bg-card p-1.5 shadow-card" role="list" aria-label="Locations">
        {app.sites.map((s) => (
          <button key={s.id} role="listitem" aria-current={s.id === site.id ? "true" : undefined} onClick={() => setSelected(s.id)} className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35", s.id === site.id && "bg-primary/10 font-semibold text-primary hover:bg-primary/10")} data-testid={`button-location-${s.id}`}>
            <SiteDot color={s.color} /><span className="truncate flex-1">{s.name}</span>
            {s.archived && <Archive className="h-3.5 w-3.5 text-muted-foreground" />}
          </button>
        ))}
        <Button variant="ghost" size="sm" className="mt-1 w-full justify-start text-primary" onClick={() => setCreating(true)} data-testid="button-new-location"><Plus /> Add location</Button>
      </div>
      <SiteEditor key={site.id} site={site} onDeleted={() => setSelected(app.sites.find((s) => s.id !== site.id)?.id ?? "")} />
      <NewSiteDialog open={creating} onOpenChange={setCreating} onCreated={(s) => setSelected(s.id)} />
    </div>
  );
}

function SiteEditor({ site, onDeleted }: { site: Site; onDeleted: () => void }) {
  const app = useApp();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Site>(site);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(site), [site]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(site);

  const save = async () => {
    if (!draft.name.trim()) { toast({ title: "Give the location a name", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const { id, createdAt, ...patch } = draft;
      await api("PUT", `/api/sites/${site.id}`, { ...patch, name: patch.name.trim() });
      await app.refresh();
      toast({ title: "Location saved", description: "New timesheets use these rules. Existing ones keep theirs until you reapply." });
    } catch (e) {
      toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" });
    } finally { setSaving(false); }
  };

  const remove = async () => {
    if (!(await confirm({ title: `Delete ${site.name}?`, description: "Its saved rates, Square connection and location-only categories are removed. Timesheets must be moved or deleted first.", confirmLabel: "Delete location", destructive: true, typeToConfirm: "DELETE" }))) return;
    try {
      await api("DELETE", `/api/sites/${site.id}`);
      onDeleted();
      await app.refresh();
      toast({ title: "Location deleted" });
    } catch (e) {
      toast({ title: "Couldn't delete", description: errorMessage(e), variant: "destructive" });
    }
  };

  return (
    <div className="min-w-0 space-y-5">
      <Section
        title="Location"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setDraft({ ...draft, archived: !draft.archived })} data-testid="button-archive-location"><Archive /> {draft.archived ? "Unarchive" : "Archive"}</Button>
            <Button variant="ghost" size="sm" className="text-destructive" onClick={remove} disabled={app.sites.length <= 1} data-testid="button-delete-location"><Trash2 /> Delete</Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name"><Input value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="input-location-name" /></Field>
          <Field label="Address (optional)"><Input value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} /></Field>
          <Field label="Color">
            <div className="flex flex-wrap gap-2">
              {COLORS.map((c) => (
                <button key={c} onClick={() => setDraft({ ...draft, color: c })} className={cn("h-7 w-7 rounded-full ring-offset-2 ring-offset-card transition-transform duration-150 hover:scale-110 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50", draft.color === c && "scale-110 ring-2 ring-foreground/30")} style={{ background: c }} aria-label={`Color ${c}`} aria-pressed={draft.color === c}>
                  {draft.color === c && <Check className="mx-auto h-3.5 w-3.5 text-white" />}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Notes"><Textarea rows={2} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></Field>
        </div>
        {draft.archived && <p className="mt-3 text-xs text-muted-foreground">Archived locations are hidden from the switcher but their timesheets are kept.</p>}
      </Section>

      <Section title="Pay rules" description="How shifts at this location become full days, half days and pay.">
        <RulesEditor rules={draft.rules} siteLevel onChange={(rules) => setDraft({ ...draft, rules })} />
      </Section>

      <SquareSection site={site} />

      <div className={cn("z-10 -mx-1 flex items-center justify-end gap-2 rounded-xl border px-3 py-2.5 transition-shadow duration-200", dirty ? "glass sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] border-border/70 shadow-float md:bottom-4" : "border-transparent")} data-testid="bar-save">
        <span className="mr-auto text-xs text-muted-foreground">{dirty ? "Unsaved changes" : "All changes saved"}</span>
        <Button variant="outline" disabled={!dirty || saving} onClick={() => setDraft(site)}>Discard</Button>
        <Button disabled={!dirty || saving} onClick={save} data-testid="button-save-location">{saving && <Loader2 className="animate-spin" />}Save location</Button>
      </div>
    </div>
  );
}

function SquareSection({ site }: { site: Site }) {
  const app = useApp();
  const { toast } = useToast();
  const confirm = useConfirm();
  const connected = !!app.squareConnected[site.id];
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [locations, setLocations] = useState<{ id: string; name: string; timezone: string | null }[] | null>(null);

  useEffect(() => {
    if (!connected) { setLocations(null); return; }
    api<typeof locations>("GET", `/api/sites/${site.id}/square/locations`).then(setLocations).catch(() => setLocations([]));
  }, [connected, site.id]);

  const connect = async () => {
    setBusy(true);
    try {
      const r = await api<{ locations: NonNullable<typeof locations> }>("PUT", `/api/sites/${site.id}/square`, { token: token.trim() });
      setToken("");
      setLocations(r.locations);
      await app.refresh();
      toast({ title: "Square connected", description: `${r.locations.length} Square location${r.locations.length === 1 ? "" : "s"} found.` });
    } catch (e) {
      toast({ title: "Couldn't connect Square", description: errorMessage(e), variant: "destructive" });
    } finally { setBusy(false); }
  };
  const disconnect = async () => {
    if (!(await confirm({ title: "Disconnect Square?", description: `The access token for ${site.name} is removed from the database.`, confirmLabel: "Disconnect", destructive: true }))) return;
    await api("DELETE", `/api/sites/${site.id}/square`).catch(() => undefined);
    await app.refresh();
  };
  const pick = async (id: string) => {
    const l = locations?.find((x) => x.id === id);
    try {
      await api("PUT", `/api/sites/${site.id}`, { squareLocationId: id, squareLocationName: l?.name ?? "" });
      await app.refresh();
      toast({ title: `Pulling timecards from ${l?.name ?? id}` });
    } catch (e) { toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" }); }
  };

  return (
    <Section title="Square" description="Pull closed timecards straight from Square for this location." actions={connected ? <Badge variant="success"><Link2 />Connected</Badge> : <Badge variant="secondary">Not connected</Badge>}>
      {connected ? (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Square location" className="min-w-[16rem] flex-1">
            {locations === null ? <div className="flex h-9 items-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading…</div> : (
              <Select value={site.squareLocationId || undefined} onValueChange={pick}>
                <SelectTrigger data-testid="select-square-location"><SelectValue placeholder={locations.length ? "Choose a location" : "No locations found"} /></SelectTrigger>
                <SelectContent>{locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}{l.timezone ? ` · ${l.timezone}` : ""}</SelectItem>)}</SelectContent>
              </Select>
            )}
          </Field>
          <Button variant="outline" onClick={disconnect} data-testid="button-square-disconnect"><Unlink /> Disconnect</Button>
        </div>
      ) : (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void connect(); }}>
          <Field label="Access token" hint="From developer.squareup.com → your app → Credentials → Production access token. Needs Timecards and Merchant profile read access." className="min-w-[16rem] flex-1">
            <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="EAAA…" data-testid="input-square-token" />
          </Field>
          <Button type="submit" disabled={token.trim().length < 10 || busy} className="mb-5" data-testid="button-square-connect">{busy && <Loader2 className="animate-spin" />}Connect</Button>
        </form>
      )}
    </Section>
  );
}

function NewSiteDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (s: Site) => void }) {
  const app = useApp();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [copyFrom, setCopyFrom] = useState("default");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const src = app.sites.find((s) => s.id === copyFrom);
      const s = await api<Site>("POST", "/api/sites", { name: name.trim(), color: COLORS[app.sites.length % COLORS.length], rules: src ? src.rules : DEFAULT_RULES });
      await app.refresh();
      onCreated(s);
      onOpenChange(false);
      setName("");
      toast({ title: `${s.name} added` });
    } catch (e) {
      toast({ title: "Couldn't add location", description: errorMessage(e), variant: "destructive" });
    } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Add a location</DialogTitle><DialogDescription>Each location has its own rules, saved rates and Square connection.</DialogDescription></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void create(); }}>
          <Field label="Name"><Input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Downtown" data-testid="input-new-location-name" /></Field>
          <Field label="Start with rules from">
            <Select value={copyFrom} onValueChange={setCopyFrom}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default rules</SelectItem>
                {app.sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={!name.trim() || busy} data-testid="button-create-location">{busy && <Loader2 className="animate-spin" />}Add location</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
