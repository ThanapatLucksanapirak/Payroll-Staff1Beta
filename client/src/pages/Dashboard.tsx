import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarRange, CheckCircle2, Copy, FileSpreadsheet, FileText, Loader2, MoreHorizontal, MoveRight, Pencil, Plus, RotateCcw, Search, Trash2, Users } from "lucide-react";
import type { EmployeeConfig, TimesheetSummary } from "@shared/schema";
import { useApp } from "@/context/AppData";
import { api, errorMessage, queryClient } from "@/lib/api";
import { newDoc, timeAgo } from "@/lib/doc";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { ImportDialog, type ImportResult, type ImportSource } from "@/components/import/ImportDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ToastAction } from "@/components/ui/toast";

type Sort = "updated" | "period" | "pay";

export function Dashboard() {
  const app = useApp();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [importOpen, setImportOpen] = useState(false);
  const [importSource, setImportSource] = useState<ImportSource | undefined>();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | "draft" | "final">("all");
  const [sort, setSort] = useState<Sort>("updated");
  const [renaming, setRenaming] = useState<TimesheetSummary | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);

  const list = useQuery<TimesheetSummary[]>({ queryKey: ["/api/timesheets"] });
  const site = app.site;

  const rows = useMemo(() => {
    let r = (list.data ?? []).filter((t) => t.siteId === site.id);
    if (status !== "all") r = r.filter((t) => (t.status || "draft") === status);
    const q = search.trim().toLowerCase();
    if (q) r = r.filter((t) => `${t.customLabel ?? ""} ${t.filename} ${t.periodStart ?? ""} ${t.periodEnd ?? ""}`.toLowerCase().includes(q));
    const key = (t: TimesheetSummary) => t.updatedAt ?? t.createdAt;
    if (sort === "updated") r = [...r].sort((a, b) => key(b).localeCompare(key(a)));
    if (sort === "period") r = [...r].sort((a, b) => (b.periodEnd ?? "").localeCompare(a.periodEnd ?? ""));
    if (sort === "pay") r = [...r].sort((a, b) => b.totalPay - a.totalPay);
    return r;
  }, [list.data, site.id, status, search, sort]);

  const siteTotal = (list.data ?? []).filter((t) => t.siteId === site.id);
  const latest = [...siteTotal].sort((a, b) => (b.periodEnd ?? "").localeCompare(a.periodEnd ?? ""))[0];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/timesheets"] });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) => api("PATCH", `/api/timesheets/${id}`, body),
    onSuccess: invalidate,
    onError: (e) => toast({ title: "Couldn't update", description: errorMessage(e), variant: "destructive" }),
  });
  const restore = useMutation({
    mutationFn: (id: string) => api("POST", `/api/timesheets/${id}/restore`),
    onSuccess: () => { invalidate(); toast({ title: "Timesheet restored" }); },
    onError: (e) => toast({ title: "Couldn't restore", description: errorMessage(e), variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api("DELETE", `/api/timesheets/${id}`),
    onSuccess: (_r, id) => {
      invalidate();
      toast({
        title: "Moved to Trash",
        description: "It stays in the Trash for 30 days.",
        action: <ToastAction altText="Undo" onClick={() => restore.mutate(id)}>Undo</ToastAction>,
      });
    },
    onError: (e) => toast({ title: "Couldn't delete", description: errorMessage(e), variant: "destructive" }),
  });
  const duplicate = useMutation({
    mutationFn: (id: string) => api<TimesheetSummary>("POST", `/api/timesheets/${id}/duplicate`),
    onSuccess: () => { invalidate(); toast({ title: "Copy created" }); },
    onError: (e) => toast({ title: "Couldn't duplicate", description: errorMessage(e), variant: "destructive" }),
  });

  const create = async (r: ImportResult) => {
    let profile: EmployeeConfig[] = [];
    if (app.prefs.autoApplySavedRates) profile = await api<EmployeeConfig[]>("GET", `/api/sites/${site.id}/wages`).catch(() => []);
    const doc = newDoc(site, r.shifts, { source: r.source, filename: r.filename, label: r.label, profile });
    const created = await api<TimesheetSummary & { removedByRetention?: number }>("POST", "/api/timesheets", { doc });
    invalidate();
    const matched = profile.length ? doc.employees.filter((e) => e.fullDayRate || e.hourlyRate || e.categoryId !== "custom").length : 0;
    toast({ title: "Timesheet created", description: matched ? `Saved rates applied to ${matched} of ${doc.employees.length} employees.` : undefined });
    navigate(`/timesheet/${created.id}`);
  };

  const openImport = (s?: ImportSource) => { setImportSource(s); setImportOpen(true); };

  return (
    <div className="mx-auto max-w-7xl px-3 sm:px-5 py-6 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" data-testid="text-page-title">Timesheets</h1>
          <p className="text-sm text-muted-foreground">{site.name}{site.address ? ` · ${site.address}` : ""}</p>
        </div>
        <Button onClick={() => openImport()} data-testid="button-new-timesheet"><Plus /> New timesheet</Button>
      </div>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <Stat label="Saved timesheets" value={String(siteTotal.length)} />
        <Stat label="Latest period" value={latest ? `${app.date(latest.periodStart)} – ${app.date(latest.periodEnd)}` : "—"} small />
        <Stat label="Latest total" value={latest ? app.money(latest.totalPay) : "—"} />
        <Stat label="Square" value={app.squareConnected[site.id] ? "Connected" : "Not connected"} small tone={app.squareConnected[site.id] ? "ok" : "muted"} />
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <QuickAction icon={CalendarRange} title="Pull from Square" onClick={() => openImport("square")} testid="square" />
        <QuickAction icon={FileSpreadsheet} title="Upload CSV" onClick={() => openImport("csv")} testid="csv" />
        <QuickAction icon={FileText} title="Toast / Sling PDF" onClick={() => openImport("pdf")} testid="pdf" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[12rem]">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search timesheets" className="pl-8" data-testid="input-search" />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as any)}>
          <SelectTrigger className="w-[8.5rem]" data-testid="select-status-filter"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All</SelectItem><SelectItem value="draft">Drafts</SelectItem><SelectItem value="final">Finalized</SelectItem></SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
          <SelectTrigger className="w-[10.5rem]" data-testid="select-sort"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="updated">Recently edited</SelectItem><SelectItem value="period">Pay period</SelectItem><SelectItem value="pay">Total pay</SelectItem></SelectContent>
        </Select>
        <Button variant="ghost" size="sm" onClick={() => setTrashOpen(true)} data-testid="button-open-trash"><Trash2 className="h-4 w-4" />Trash</Button>
      </div>

      {list.isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-32 rounded-xl" />)}</div>
      ) : list.error ? (
        <div className="rounded-xl border p-6 text-center text-sm space-y-2">
          <p className="text-destructive">{errorMessage(list.error)}</p>
          <Button variant="outline" size="sm" onClick={() => list.refetch()}>Retry</Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center space-y-2">
          <p className="font-medium">{siteTotal.length ? "No timesheets match your filters" : "No timesheets yet"}</p>
          <p className="text-sm text-muted-foreground">{siteTotal.length ? "Try clearing the search." : "Import timecards from Square, a CSV, or a Toast/Sling PDF to get started."}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((t) => (
            <div key={t.id} className="group relative min-w-0 rounded-xl border bg-card p-4 shadow-sm transition-colors hover:border-primary/40" data-testid={`card-timesheet-${t.id}`}>
              <button className="absolute inset-0 rounded-xl" aria-label={`Open ${t.customLabel || t.filename}`} onClick={() => navigate(`/timesheet/${t.id}`)} data-testid={`button-open-${t.id}`} />
              <div className="relative pointer-events-none flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium truncate" title={t.customLabel || t.filename}>{t.customLabel || t.filename || "Untitled"}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t.periodStart ? `${app.date(t.periodStart)} – ${app.date(t.periodEnd)}` : "No dates yet"}</p>
                </div>
                <div className="pointer-events-auto">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8 -mr-2 -mt-1" aria-label="Timesheet actions" data-testid={`button-menu-${t.id}`}><MoreHorizontal className="h-4 w-4" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setRenaming(t)}><Pencil className="h-4 w-4 mr-2" />Rename</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => duplicate.mutate(t.id)}><Copy className="h-4 w-4 mr-2" />Duplicate</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => patch.mutate({ id: t.id, body: { status: t.status === "final" ? "draft" : "final" } })}>
                        <CheckCircle2 className="h-4 w-4 mr-2" />{t.status === "final" ? "Reopen as draft" : "Mark as final"}
                      </DropdownMenuItem>
                      {app.activeSites.length > 1 && (
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger><MoveRight className="h-4 w-4 mr-2" />Move to location</DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            {app.activeSites.filter((s) => s.id !== t.siteId).map((s) => (
                              <DropdownMenuItem key={s.id} onClick={() => patch.mutate({ id: t.id, body: { siteId: s.id } }, { onSuccess: () => toast({ title: `Moved to ${s.name}` }) })}>{s.name}</DropdownMenuItem>
                            ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => remove.mutate(t.id)}
                        data-testid={`button-delete-${t.id}`}
                      ><Trash2 className="h-4 w-4 mr-2" />Delete</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
              <div className="relative pointer-events-none mt-4 flex items-end justify-between gap-2">
                <div>
                  <p className="text-lg font-semibold tabular">{app.money(t.totalPay)}</p>
                  <p className="text-xs text-muted-foreground flex items-center gap-1"><Users className="h-3 w-3" />{t.employeeCount} · edited {timeAgo(t.updatedAt ?? t.createdAt)}</p>
                </div>
                <Badge variant={t.status === "final" ? "default" : "secondary"}>{t.status === "final" ? "Final" : "Draft"}</Badge>
              </div>
            </div>
          ))}
        </div>
      )}

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} site={site} mode="create" initialSource={importSource} onComplete={create} />
      <TrashDialog open={trashOpen} onOpenChange={setTrashOpen} onRestore={(id) => restore.mutate(id)} confirm={confirm} />
      <RenameDialog item={renaming} onClose={() => setRenaming(null)} onSave={(label) => renaming ? patch.mutateAsync({ id: renaming.id, body: { label } }) : undefined} />
    </div>
  );
}

function Stat({ label, value, small, tone }: { label: string; value: string; small?: boolean; tone?: "ok" | "muted" }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`${small ? "text-sm mt-1" : "text-lg"} font-semibold tabular truncate ${tone === "ok" ? "text-primary" : tone === "muted" ? "text-muted-foreground" : ""}`}>{value}</p>
    </div>
  );
}

function QuickAction({ icon: Icon, title, onClick, testid }: { icon: any; title: string; onClick: () => void; testid: string }) {
  return (
    <button onClick={onClick} className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 text-left text-sm font-medium transition-colors hover:border-primary/40 hover:bg-accent/40" data-testid={`button-quick-${testid}`}>
      <Icon className="h-4 w-4 text-primary" />{title}
    </button>
  );
}

function RenameDialog({ item, onClose, onSave }: { item: TimesheetSummary | null; onClose: () => void; onSave: (label: string) => Promise<unknown> | undefined }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={!!item} onOpenChange={(o) => { if (!o) onClose(); else setValue(item?.customLabel ?? ""); }}>
      <DialogContent className="max-w-sm" onOpenAutoFocus={() => setValue(item?.customLabel ?? item?.filename ?? "")}>
        <DialogHeader><DialogTitle>Rename timesheet</DialogTitle></DialogHeader>
        <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await onSave(value); onClose(); } finally { setBusy(false); } }} className="space-y-4">
          <Input value={value} onChange={(e) => setValue(e.target.value)} autoFocus maxLength={120} data-testid="input-rename" />
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy} data-testid="button-rename-save">{busy && <Loader2 className="animate-spin" />}Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TrashDialog({ open, onOpenChange, onRestore, confirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; onRestore: (id: string) => void; confirm: ReturnType<typeof useConfirm>;
}) {
  const app = useApp();
  const { toast } = useToast();
  const trash = useQuery<TimesheetSummary[]>({ queryKey: ["/api/timesheets?trash=1"], queryFn: () => api("GET", "/api/timesheets?trash=1"), enabled: open });
  const refresh = () => { void trash.refetch(); void queryClient.invalidateQueries({ queryKey: ["/api/timesheets"] }); };
  const removeForever = async (t: TimesheetSummary) => {
    const ok = await confirm({ title: "Delete forever?", description: `"${t.customLabel || t.filename}" will be permanently removed. This can't be undone.`, confirmLabel: "Delete forever", destructive: true });
    if (!ok) return;
    try { await api("DELETE", `/api/timesheets/${t.id}?permanent=1`); refresh(); } catch (e) { toast({ title: "Couldn't delete", description: errorMessage(e), variant: "destructive" }); }
  };
  const empty = async () => {
    const ok = await confirm({ title: "Empty the Trash?", description: "Every timesheet in the Trash will be permanently removed. This can't be undone.", confirmLabel: "Empty Trash", destructive: true });
    if (!ok) return;
    try { await api("DELETE", "/api/trash"); refresh(); } catch (e) { toast({ title: "Couldn't empty the Trash", description: errorMessage(e), variant: "destructive" }); }
  };
  const items = trash.data ?? [];
  const daysLeft = (d?: string | null) => (d ? Math.max(0, 30 - Math.floor((Date.now() - Date.parse(d)) / 86_400_000)) : 30);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Trash</DialogTitle>
          <DialogDescription>Deleted timesheets stay here for 30 days, then they are removed for good.</DialogDescription>
        </DialogHeader>
        {trash.isLoading ? <Skeleton className="h-24" /> : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">The Trash is empty.</p>
        ) : (
          <ul className="max-h-[50vh] overflow-y-auto divide-y rounded-lg border" data-testid="list-trash">
            {items.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{t.customLabel || t.filename || "Untitled"}</p>
                  <p className="text-xs text-muted-foreground">{app.sites.find((x) => x.id === t.siteId)?.name ?? ""}{t.periodStart ? ` · ${app.date(t.periodStart)} – ${app.date(t.periodEnd)}` : ""} · {daysLeft(t.deletedAt)} days left</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => { onRestore(t.id); setTimeout(refresh, 300); }} data-testid={`button-restore-${t.id}`}><RotateCcw className="h-3.5 w-3.5" />Restore</Button>
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Delete forever" onClick={() => removeForever(t)}><Trash2 className="h-4 w-4" /></Button>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          {items.length > 0 && <Button variant="ghost" className="text-destructive mr-auto" onClick={empty}>Empty Trash</Button>}
          <Button variant="outline" onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
