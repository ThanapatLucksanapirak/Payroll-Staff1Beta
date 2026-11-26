import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Camera, Dices, Download, Eye, EyeOff, Images, KeyRound, Loader2, Pencil, Plus, Search, Trash2, UserRound } from "lucide-react";
import { useApp } from "@/context/AppData";
import { api, errorMessage, queryClient } from "@/lib/api";
import { can, canEdit, isAdmin } from "@/lib/roles";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { SiteDot } from "@/components/AppShell";
import { Page, PageHeader } from "@/components/ui/page";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/workspace/fields";
import { cn } from "@/lib/utils";
import { YtdPanel } from "@/components/pay/YtdPanel";
import { PortalSettingsCard } from "@/components/settings/PortalSettings";
import { EmployeePhotosDialog, FaceBadge, SitePhotosDialog, useFaceSummaries } from "@/components/face/FacePhotos";

export interface EmployeeRow { id: string; name: string; role: string; active: boolean; hasPin: boolean; pinViewable?: boolean; createdAt: string; updatedAt: string }

/** PINs shown to an owner after they re-enter their password; hidden again after this long. */
const SHOW_PINS_MS = 2 * 60_000;

function randomPin(len = 4) {
  const b = new Uint32Array(len);
  crypto.getRandomValues(b);
  let pin = [...b].map((x) => String(x % 10)).join("");
  if (/^(\d)\1+$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin)) pin = randomPin(len);
  return pin;
}

export function EmployeesPage() {
  const app = useApp();
  const site = app.site;
  const { toast } = useToast();
  const confirm = useConfirm();
  // Only owners and administrators manage the employee list (the server enforces this too).
  const admin = can(app.user, "employees.manage"); // add and edit people and PINs
  const settingsAdmin = isAdmin(app.user);
  // Punch photos and face match: editors see photos (as on Live); face match set-up follows "employees.manage".
  const seesPhotos = canEdit(app.user) && site.timeSource !== "square";
  const faces = useFaceSummaries(site.id, seesPhotos);
  const faceOf = useMemo(() => new Map((faces.data ?? []).map((f) => [f.employeeId, f])), [faces.data]);
  const [photosFor, setPhotosFor] = useState<EmployeeRow | null>(null);
  const [allPhotos, setAllPhotos] = useState(false);
  const key = ["/api/sites", site.id, "employees"];
  const q = useQuery<EmployeeRow[]>({ queryKey: key });
  const [editing, setEditing] = useState<EmployeeRow | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  // Owners can look up PINs (password re-entry; every look-up is logged).
  const owner = app.user?.role === "owner";
  const [pins, setPins] = useState<Record<string, string | null> | null>(null);
  const [askPins, setAskPins] = useState(false);
  useEffect(() => {
    if (!pins) return;
    const t = setTimeout(() => setPins(null), SHOW_PINS_MS);
    return () => clearTimeout(t);
  }, [pins]);
  useEffect(() => { setPins(null); }, [site.id]);

  const rows = useMemo(() => {
    let r = q.data ?? [];
    if (!showInactive) r = r.filter((e) => e.active);
    const s = search.trim().toLowerCase();
    if (s) r = r.filter((e) => `${e.name} ${e.role}`.toLowerCase().includes(s));
    return r;
  }, [q.data, search, showInactive]);
  const inactive = (q.data ?? []).filter((e) => !e.active).length;
  const noPin = (q.data ?? []).filter((e) => e.active && !e.hasPin).length;
  const activeCount = (q.data ?? []).filter((e) => e.active).length;

  const [generating, setGenerating] = useState(false);
  const [newPins, setNewPins] = useState<{ id: string; name: string; pin: string }[] | null>(null);
  const generatePins = async () => {
    if (!(await confirm({ title: `Give ${noPin} ${noPin === 1 ? "person" : "people"} a PIN?`, description: "Each active employee without a PIN gets a random 4-digit one. You'll see them once, to hand out.", confirmLabel: "Make PINs" }))) return;
    setGenerating(true);
    try {
      const r = await api<{ pins: { id: string; name: string; pin: string }[]; skipped: number }>("POST", `/api/sites/${site.id}/employee-pins/generate`, {});
      await queryClient.invalidateQueries({ queryKey: key });
      setNewPins(r.pins);
      if (r.skipped) toast({ title: `${r.skipped} couldn't get a PIN`, description: "Edit them to set one by hand.", variant: "destructive" });
    } catch (err) { toast({ title: "Couldn't make PINs", description: errorMessage(err), variant: "destructive" }); } finally { setGenerating(false); }
  };

  const remove = async (e: EmployeeRow) => {
    // Clocked in right now? Say so: they'd stay on Live as "Removed, still clocked in" until someone clocks them out.
    let clockedIn = false;
    if (site.timeSource !== "square") {
      try {
        const day = await api<{ employees: { id: string; status: string }[] }>("GET", `/api/sites/${site.id}/timeclock`);
        clockedIn = day.employees.some((x) => x.id === e.id && x.status !== "out");
      } catch { /* not knowing doesn't block removing */ }
    }
    if (!(await confirm({ title: `Remove ${e.name}?`, description: (clockedIn ? `${e.name} is clocked in right now. Clock them out on Live first, or they'll show there as "Removed" until someone does. ` : "") + "They can no longer use the time clock. Their face data (if any) is deleted now. Their past punches, timesheets and punch photos are kept, because they're pay records; punch photos are deleted at the end of the photo retention period (Settings → Locations & rules). To pause someone instead, turn off Active.", confirmLabel: "Remove", destructive: true }))) return;
    try {
      await api("DELETE", `/api/sites/${site.id}/employees/${e.id}`);
      await queryClient.invalidateQueries({ queryKey: key });
      toast({ title: `${e.name} removed` });
    } catch (err) { toast({ title: "Couldn't remove", description: errorMessage(err), variant: "destructive" }); }
  };

  return (
    <Page>
      <PageHeader
        title="Employees"
        titleTestId="text-page-title"
        subtitle={<span className="inline-flex flex-wrap items-center gap-x-1.5"><SiteDot color={site.color} />{site.name}<span aria-hidden>·</span>{q.data ? `${activeCount} employee${activeCount === 1 ? "" : "s"}` : "Your staff"}</span>}
        actions={(admin || owner || seesPhotos) && (
          <>
            {seesPhotos && <Button variant="ghost" onClick={() => setAllPhotos(true)} data-testid="button-all-photos"><Images /> Photos</Button>}
            {owner && (pins
              ? <Button variant="ghost" onClick={() => setPins(null)} data-testid="button-hide-pins"><EyeOff /> Hide PINs</Button>
              : <Button variant="ghost" onClick={() => setAskPins(true)} data-testid="button-show-pins"><Eye /> Show PINs</Button>)}
            {admin && <Button variant="ghost" onClick={() => setImporting(true)} data-testid="button-import-employees"><Download /> Import names</Button>}
            {admin && <Button onClick={() => setEditing("new")} data-testid="button-add-employee"><Plus /> Add employee</Button>}
          </>
        )}
      />

      {site.timeSource === "square" && (
        <div className="mb-5 flex flex-col gap-2.5 rounded-xl bg-warning-soft px-4 py-3 text-[13px] sm:flex-row sm:items-center sm:gap-3" role="status">
          <span className="flex min-w-0 flex-1 items-start gap-3">
            <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-warning" />
            <span className="min-w-0 flex-1">The time clock is off at {site.name} (hours come from Square). You can still set up employees now.</span>
          </span>
          {settingsAdmin && <span className="shrink-0 pl-7 sm:pl-0"><Button asChild size="sm" variant="outline"><Link href="/settings/locations">Time clock settings</Link></Button></span>}
        </div>
      )}
      {(faces.data ?? []).some((f) => f.unreadable) && (
        <div className="mb-5 flex items-start gap-3 rounded-xl bg-destructive/10 px-4 py-3 text-[13px] text-destructive" role="alert" data-testid="banner-face-unreadable">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Face data for {(faces.data ?? []).filter((f) => f.unreadable).map((f) => (q.data ?? []).find((e) => e.id === f.employeeId)?.name ?? "a removed employee").join(", ")} can't be read (a damaged file, or the server's key changed). Their time clock punches are refused until you open them here, delete their face data and set face match up again.</span>
        </div>
      )}
      {noPin > 0 && (
        <div className="mb-5 flex flex-col gap-2.5 rounded-xl border border-card-border bg-card px-4 py-3 text-[13px] text-muted-foreground shadow-card sm:flex-row sm:items-center sm:gap-3" data-testid="banner-no-pin">
          <span className="flex min-w-0 flex-1 items-start gap-3"><KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-warning" /><span>{noPin} employee{noPin === 1 ? " has" : "s have"} no PIN yet, so they can't use the time clock or the staff portal.{admin && " Give everyone a PIN at once, or edit someone to choose theirs."}</span></span>
          {admin && <span className="shrink-0 pl-7 sm:pl-0"><Button size="sm" variant="outline" onClick={() => void generatePins()} disabled={generating} data-testid="button-generate-pins">{generating ? <Loader2 className="animate-spin" /> : <Dices />}Give everyone a PIN</Button></span>}
        </div>
      )}
      {settingsAdmin && site.timeSource !== "square" && (
        <div className="mb-5 rounded-xl border border-card-border bg-card px-4 pb-3 shadow-card [&>div]:border-t-0" data-testid="card-employees-portal">
          <PortalSettingsCard site={site} />
        </div>
      )}
      <Dialog open={!!newPins} onOpenChange={(o) => { if (!o) setNewPins(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New PINs</DialogTitle>
            <DialogDescription>Give each person their PIN now. {owner ? "You can look them up again with Show PINs." : "Only an owner can look them up again."}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-80 divide-y divide-border/70 overflow-y-auto rounded-xl border border-border/80 text-[13px]" data-testid="list-new-pins">
            {(newPins ?? []).map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2"><span className="min-w-0 truncate font-medium">{p.name}</span><span className="font-mono text-[15px] font-semibold tabular tracking-widest">{p.pin}</span></li>
            ))}
          </ul>
          <DialogFooter><Button onClick={() => setNewPins(null)}>Done</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search employees" aria-label="Search employees" className="pl-9" data-testid="input-search-employees" />
        </div>
        {inactive > 0 && (
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-[13px] text-muted-foreground">
            <Switch checked={showInactive} onCheckedChange={setShowInactive} /> Show inactive (<span className="tabular">{inactive}</span>)
          </label>
        )}
      </div>

      {q.isLoading ? (
        <div className="divide-y divide-border/70 overflow-hidden rounded-xl border border-card-border bg-card shadow-card" aria-busy="true" aria-label="Loading employees">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
              <div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-40 max-w-[60%]" /><Skeleton className="h-3 w-20" /></div>
            </div>
          ))}
        </div>
      ) : q.error ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load employees" description={errorMessage(q.error)} action={<Button variant="outline" size="sm" onClick={() => q.refetch()}>Try again</Button>} />
      ) : !(q.data ?? []).length ? (
        <EmptyState
          icon={UserRound}
          title="No employees yet"
          description={admin ? "Import the names from your existing timesheets, then give each person a PIN." : "An owner or administrator adds the people who use the time clock."}
          action={admin && <><Button variant="tinted" onClick={() => setImporting(true)}><Download /> Import names</Button><Button onClick={() => setEditing("new")}><Plus /> Add employee</Button></>}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-card-border bg-card shadow-card">
          <ul className="divide-y divide-border/70" data-testid="list-employees">
            {rows.map((e) => (
              <li key={e.id} className={cn("flex items-center gap-3 px-4 py-3", !e.active && "opacity-60")}>
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary" aria-hidden>
                  {e.name.split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("")}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-medium">{e.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{e.role || "—"}</p>
                </div>
                {!e.active && <Badge variant="secondary">Inactive</Badge>}
                {seesPhotos && <span className="hidden sm:contents"><FaceBadge summary={faceOf.get(e.id)} /></span>}
                {pins && e.hasPin ? (
                  pins[e.id]
                    ? <span className="rounded-lg bg-foreground/[0.05] px-2.5 py-1 font-mono text-[15px] font-semibold tracking-[0.2em]" data-testid={`text-pin-${e.id}`}>{pins[e.id]}</span>
                    : <span className="max-w-[11rem] text-right text-xs text-muted-foreground" data-testid={`text-pin-hidden-${e.id}`}>Set before PINs could be shown. Set a new one to see it.</span>
                ) : e.hasPin ? <Badge variant="success" title="PIN set"><KeyRound /><span className="sr-only sm:not-sr-only">PIN set</span></Badge> : <Badge variant="warning">No PIN</Badge>}
                {seesPhotos && <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`Photos and face match: ${e.name}`} title="Photos and face match" onClick={() => setPhotosFor(e)} data-testid={`button-photos-${e.id}`}><Camera /></Button>}
                {admin && (
                  <>
                    <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`Edit ${e.name}`} onClick={() => setEditing(e)} data-testid={`button-edit-employee-${e.id}`}><Pencil /></Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove ${e.name}`} className="text-muted-foreground hover:text-destructive" onClick={() => remove(e)}><Trash2 /></Button>
                  </>
                )}
              </li>
            ))}
            {!rows.length && <li className="px-4 py-8 text-center text-[13px] text-muted-foreground">{search.trim() ? <>No one matches “{search.trim()}”.</> : "Everyone here is inactive. Turn on Show inactive to see them."}</li>}
          </ul>
        </div>
      )}
      <p className="mt-3 px-1 text-xs text-muted-foreground">Names should match how they appear in your timesheets and saved rates, so time-clock hours line up with the right pay.</p>

      <YtdPanel siteId={site.id} siteName={site.name} />

      {editing && <EmployeeDialog siteId={site.id} employee={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {importing && <ImportNamesDialog siteId={site.id} onClose={() => setImporting(false)} />}
      {photosFor && <EmployeePhotosDialog siteId={site.id} employee={photosFor} tz={site.rules.timezone} canManage={admin} onClose={() => setPhotosFor(null)} />}
      {allPhotos && <SitePhotosDialog siteId={site.id} employees={q.data ?? []} tz={site.rules.timezone} onClose={() => setAllPhotos(false)} onOpenEmployee={(e) => { const row = (q.data ?? []).find((x) => x.id === e.id); if (row) { setAllPhotos(false); setPhotosFor(row); } }} />}
      {askPins && <ShowPinsDialog siteId={site.id} onClose={() => setAskPins(false)} onShown={(p) => { setPins(p); setAskPins(false); }} />}
    </Page>
  );
}

function EmployeeDialog({ siteId, employee, onClose }: { siteId: string; employee: EmployeeRow | null; onClose: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState(employee?.name ?? "");
  const [role, setRole] = useState(employee?.role ?? "");
  const [pin, setPin] = useState("");
  const [active, setActive] = useState(employee?.active ?? true);
  const [clearPin, setClearPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shownPin, setShownPin] = useState<string | null>(null);
  const pinOk = pin === "" || /^\d{4,6}$/.test(pin);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const body: any = { name: name.trim(), role: role.trim(), active };
      if (pin) body.pin = pin;
      else if (clearPin) body.pin = null;
      if (employee) await api("PUT", `/api/sites/${siteId}/employees/${employee.id}`, body);
      else await api("POST", `/api/sites/${siteId}/employees`, body);
      await queryClient.invalidateQueries({ queryKey: ["/api/sites", siteId, "employees"] });
      if (pin) { setShownPin(pin); return; }
      toast({ title: employee ? "Employee saved" : `${name.trim()} added` });
      onClose();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        {shownPin ? (
          <>
            <DialogHeader><DialogTitle>PIN saved</DialogTitle><DialogDescription>Give this PIN to {name.trim()}. It is stored encrypted. The owner can look it up later with Show PINs.</DialogDescription></DialogHeader>
            <p className="my-2 rounded-xl bg-foreground/[0.04] py-4 text-center font-mono text-4xl font-semibold tracking-[0.3em]" data-testid="text-new-pin">{shownPin}</p>
            <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{employee ? `Edit ${employee.name}` : "Add employee"}</DialogTitle>
              <DialogDescription>Each person signs in to the time clock with their own PIN.</DialogDescription>
            </DialogHeader>
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (name.trim() && pinOk) void save(); }}>
              <Field label="Name" hint="As it appears in timesheets."><Input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} data-testid="input-employee-name" /></Field>
              <Field label="Role or title (optional)"><Input value={role} maxLength={60} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Cook" /></Field>
              <Field label={employee?.hasPin ? "New PIN (leave blank to keep the current one)" : "PIN (4–6 digits)"} hint={!employee?.hasPin ? "Needed only for the time clock and the staff portal. You can leave it blank." : undefined} error={!pinOk ? "Use 4 to 6 digits." : undefined}>
                <div className="flex gap-2">
                  <Input
                    inputMode="numeric" autoComplete="off" value={pin} maxLength={6}
                    onChange={(e) => { setPin(e.target.value.replace(/\D/g, "").slice(0, 6)); setClearPin(false); }}
                    className={cn("font-mono tracking-widest", !pinOk && "border-destructive")} placeholder={employee?.hasPin ? "••••" : "e.g. 4821"} data-testid="input-employee-pin"
                  />
                  <Button type="button" variant="outline" onClick={() => setPin(randomPin(4))} data-testid="button-generate-pin"><Dices /> Generate</Button>
                </div>
              </Field>
              {employee?.hasPin && !pin && (
                <label className="flex items-center gap-2 text-xs text-muted-foreground"><Checkbox checked={clearPin} onCheckedChange={(v) => setClearPin(!!v)} /> Remove the PIN (they can't clock in until a new one is set)</label>
              )}
              <label className="flex items-center justify-between gap-3 rounded-lg border border-border/80 px-3 py-2 text-[13px]">
                <span>Active<span className="block text-xs text-muted-foreground">Inactive employees can't use the time clock.</span></span>
                <Switch checked={active} onCheckedChange={setActive} />
              </label>
              {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] font-medium text-danger" role="alert">{error}</p>}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
                <Button type="submit" disabled={busy || !name.trim() || !pinOk} data-testid="button-save-employee">{busy && <Loader2 className="animate-spin" />}{employee ? "Save" : "Add employee"}</Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ImportNamesDialog({ siteId, onClose }: { siteId: string; onClose: () => void }) {
  const { toast } = useToast();
  const q = useQuery<{ name: string; from: string }[]>({ queryKey: ["/api/sites", siteId, "employee-suggestions"], staleTime: 0 });
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const picked = (q.data ?? []).filter((s) => !skip.has(s.name));

  const run = async () => {
    setBusy(true);
    try {
      const r = await api<{ created: EmployeeRow[]; skipped: string[] }>("POST", `/api/sites/${siteId}/employees/import`, { names: picked.map((p) => p.name) });
      await queryClient.invalidateQueries({ queryKey: ["/api/sites", siteId, "employees"] });
      toast({ title: `${r.created.length} employee${r.created.length === 1 ? "" : "s"} added`, description: "Give each one a PIN so they can clock in." });
      onClose();
    } catch (e) { toast({ title: "Couldn't import", description: errorMessage(e), variant: "destructive" }); } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Import names</DialogTitle>
          <DialogDescription>From this location's saved rates and recent timesheets. People already in the list are left out.</DialogDescription>
        </DialogHeader>
        {q.isLoading ? <div className="space-y-2 rounded-xl border border-border/80 p-3" aria-busy="true" aria-label="Looking for names">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-5" />)}</div>
          : !(q.data ?? []).length ? <p className="py-4 text-sm text-muted-foreground">No new names found. Everyone from your timesheets is already in the list.</p>
          : (
            <div className="max-h-[50dvh] divide-y divide-border/70 overflow-y-auto rounded-xl border border-border/80">
              {q.data!.map((s) => (
                <label key={s.name} className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-foreground/[0.02]">
                  <Checkbox checked={!skip.has(s.name)} onCheckedChange={(v) => { const n = new Set(skip); v ? n.delete(s.name) : n.add(s.name); setSkip(n); }} />
                  <span className="min-w-0 flex-1 truncate font-medium" title={s.name}>{s.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{s.from}</span>
                </label>
              ))}
            </div>
          )}
        <DialogFooter>
          {(q.data ?? []).length > 0 || q.isLoading ? (
            <>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button disabled={busy || !picked.length} onClick={run} data-testid="button-confirm-import-employees">{busy && <Loader2 className="animate-spin" />}Add {picked.length || ""}</Button>
            </>
          ) : <Button variant="outline" onClick={onClose}>Close</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Owner-only: re-enter your password to see the PINs at this location for a couple of minutes. */
function ShowPinsDialog({ siteId, onClose, onShown }: { siteId: string; onClose: () => void; onShown: (pins: Record<string, string | null>) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ pins: { id: string; pin: string | null }[] }>("POST", `/api/sites/${siteId}/employee-pins/reveal`, { password });
      onShown(Object.fromEntries(r.pins.map((p) => [p.id, p.pin])));
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); setPassword(""); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Show employee PINs</DialogTitle>
          <DialogDescription>Enter your password to see the time clock PINs here. They hide again after 2 minutes, and each look-up is recorded in Settings → Activity.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (password) void run(); }}>
          <Field label="Your password"><Input type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} data-testid="input-pins-password" /></Field>
          {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] font-medium text-danger" role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !password} data-testid="button-confirm-show-pins">{busy && <Loader2 className="animate-spin" />}Show PINs</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
