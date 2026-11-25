import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Dices, Download, KeyRound, Loader2, Pencil, Plus, Search, Trash2, UserRound } from "lucide-react";
import { useApp } from "@/context/AppData";
import { api, errorMessage, queryClient } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/workspace/fields";
import { cn } from "@/lib/utils";

export interface EmployeeRow { id: string; name: string; role: string; active: boolean; hasPin: boolean; createdAt: string; updatedAt: string }

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
  const key = ["/api/sites", site.id, "employees"];
  const q = useQuery<EmployeeRow[]>({ queryKey: key });
  const [editing, setEditing] = useState<EmployeeRow | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  const rows = useMemo(() => {
    let r = q.data ?? [];
    if (!showInactive) r = r.filter((e) => e.active);
    const s = search.trim().toLowerCase();
    if (s) r = r.filter((e) => `${e.name} ${e.role}`.toLowerCase().includes(s));
    return r;
  }, [q.data, search, showInactive]);
  const inactive = (q.data ?? []).filter((e) => !e.active).length;
  const noPin = (q.data ?? []).filter((e) => e.active && !e.hasPin).length;

  const remove = async (e: EmployeeRow) => {
    if (!(await confirm({ title: `Remove ${e.name}?`, description: "They can no longer use the time clock. Their past punches and timesheets are kept. To pause someone instead, turn off Active.", confirmLabel: "Remove", destructive: true }))) return;
    try {
      await api("DELETE", `/api/sites/${site.id}/employees/${e.id}`);
      await queryClient.invalidateQueries({ queryKey: key });
      toast({ title: `${e.name} removed` });
    } catch (err) { toast({ title: "Couldn't remove", description: errorMessage(err), variant: "destructive" }); }
  };

  return (
    <div className="mx-auto max-w-5xl px-3 sm:px-5 py-6 space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" data-testid="text-page-title">Employees</h1>
          <p className="text-sm text-muted-foreground">{site.name} · who can use the time clock</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setImporting(true)} data-testid="button-import-employees"><Download /> Import names</Button>
          <Button onClick={() => setEditing("new")} data-testid="button-add-employee"><Plus /> Add employee</Button>
        </div>
      </div>

      {site.timeSource === "square" && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/40 px-4 py-3 text-sm">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <span className="flex-1">The time clock is off at {site.name} (hours come from Square). You can still set up employees now.</span>
          <Link href="/settings/locations"><Button size="sm" variant="outline">Time clock settings</Button></Link>
        </div>
      )}
      {noPin > 0 && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><KeyRound className="h-4 w-4" />{noPin} employee{noPin === 1 ? " has" : "s have"} no PIN yet and can't clock in. Edit them to set one.</p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[12rem]">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search employees" className="pl-8" data-testid="input-search-employees" />
        </div>
        {inactive > 0 && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={showInactive} onCheckedChange={setShowInactive} /> Show inactive ({inactive})
          </label>
        )}
      </div>

      <div className="rounded-xl border bg-card">
        {q.isLoading ? (
          <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : q.error ? (
          <p className="p-4 text-sm text-destructive">{errorMessage(q.error)}</p>
        ) : !(q.data ?? []).length ? (
          <div className="p-10 text-center">
            <UserRound className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-3 font-medium">No employees yet</p>
            <p className="mt-1 text-sm text-muted-foreground">Import the names from your existing timesheets, then give each person a PIN.</p>
            <div className="mt-4 flex justify-center gap-2">
              <Button variant="outline" onClick={() => setImporting(true)}><Download /> Import names</Button>
              <Button onClick={() => setEditing("new")}><Plus /> Add employee</Button>
            </div>
          </div>
        ) : (
          <ul className="divide-y" data-testid="list-employees">
            {rows.map((e) => (
              <li key={e.id} className={cn("flex items-center gap-3 px-4 py-3", !e.active && "opacity-60")}>
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                  {e.name.split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("")}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{e.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{e.role || "—"}</p>
                </div>
                {!e.active && <Badge variant="secondary">Inactive</Badge>}
                {e.hasPin ? <Badge variant="outline" className="gap-1"><KeyRound className="h-3 w-3" />PIN set</Badge> : <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-400">No PIN</Badge>}
                <Button variant="ghost" size="icon" aria-label={`Edit ${e.name}`} onClick={() => setEditing(e)} data-testid={`button-edit-employee-${e.id}`}><Pencil /></Button>
                <Button variant="ghost" size="icon" aria-label={`Remove ${e.name}`} className="text-muted-foreground hover:text-destructive" onClick={() => remove(e)}><Trash2 /></Button>
              </li>
            ))}
            {!rows.length && <li className="px-4 py-6 text-center text-sm text-muted-foreground">No matches.</li>}
          </ul>
        )}
      </div>
      <p className="text-xs text-muted-foreground">Names should match how they appear in your timesheets and saved rates, so time-clock hours line up with the right pay.</p>

      {editing && <EmployeeDialog siteId={site.id} employee={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {importing && <ImportNamesDialog siteId={site.id} onClose={() => setImporting(false)} />}
    </div>
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
            <DialogHeader><DialogTitle>PIN saved</DialogTitle><DialogDescription>Give this PIN to {name.trim()}. It is stored securely and can't be shown again.</DialogDescription></DialogHeader>
            <p className="my-2 text-center font-mono text-4xl tracking-[0.3em]" data-testid="text-new-pin">{shownPin}</p>
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
              <Field label={employee?.hasPin ? "New PIN (leave blank to keep the current one)" : "PIN (4–6 digits)"}>
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
              <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
                <span>Active<span className="block text-xs text-muted-foreground">Inactive employees can't use the time clock.</span></span>
                <Switch checked={active} onCheckedChange={setActive} />
              </label>
              {error && <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">{error}</p>}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
                <Button type="submit" disabled={busy || !name.trim() || !pinOk} data-testid="button-save-employee">{busy && <Loader2 className="animate-spin" />}{employee ? "Save" : "Add"}</Button>
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
        {q.isLoading ? <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          : !(q.data ?? []).length ? <p className="py-4 text-sm text-muted-foreground">No new names found. Everyone from your timesheets is already in the list.</p>
          : (
            <div className="max-h-[50dvh] overflow-y-auto rounded-lg border divide-y">
              {q.data!.map((s) => (
                <label key={s.name} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                  <Checkbox checked={!skip.has(s.name)} onCheckedChange={(v) => { const n = new Set(skip); v ? n.delete(s.name) : n.add(s.name); setSkip(n); }} />
                  <span className="flex-1 truncate font-medium">{s.name}</span>
                  <span className="text-xs text-muted-foreground">{s.from}</span>
                </label>
              ))}
            </div>
          )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !picked.length} onClick={run} data-testid="button-confirm-import-employees">{busy && <Loader2 className="animate-spin" />}Add {picked.length || ""}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
