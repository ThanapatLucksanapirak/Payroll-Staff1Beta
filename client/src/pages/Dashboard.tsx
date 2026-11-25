import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowUpDown, CalendarRange, Tablet, CheckCircle2, Copy, FileSpreadsheet, LayoutGrid, List, Loader2, MoreHorizontal, MoveRight, Pencil, Plus, RotateCcw, Search, Trash2, Users } from "lucide-react";
import type { Site, TimesheetSummary } from "@shared/schema";
import { useApp } from "@/context/AppData";
import { api, errorMessage, queryClient } from "@/lib/api";
import { timeAgo } from "@/lib/doc";
import { safeStorage } from "@/lib/storage";
import { canEdit, isAdmin } from "@/lib/roles";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { useNewTimesheet } from "@/components/NewTimesheet";
import { SiteDot } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { Page, PageHeader } from "@/components/ui/page";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedControl } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ToastAction } from "@/components/ui/toast";

type Sort = "updated" | "period" | "pay" | "name";
type View = "grid" | "list";
const VIEW_KEY = "payroll.timesheets.view";

export function Dashboard() {
  const app = useApp();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const confirm = useConfirm();
  const newTimesheet = useNewTimesheet();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | "draft" | "final">("all");
  const [sort, setSort] = useState<Sort>("updated");
  const [view, setViewState] = useState<View>(() => (safeStorage.get(VIEW_KEY) === "list" ? "list" : "grid"));
  const [renaming, setRenaming] = useState<TimesheetSummary | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const setView = (v: View) => { setViewState(v); safeStorage.set(VIEW_KEY, v); };

  const list = useQuery<TimesheetSummary[]>({ queryKey: ["/api/timesheets"] });
  const site = app.site;
  const editable = canEdit(app.user);
  const timeSource = site.timeSource ?? "square";

  const rows = useMemo(() => {
    let r = (list.data ?? []).filter((t) => t.siteId === site.id);
    if (status !== "all") r = r.filter((t) => (t.status || "draft") === status);
    const q = search.trim().toLowerCase();
    if (q) r = r.filter((t) => `${t.customLabel ?? ""} ${t.filename} ${t.periodStart ?? ""} ${t.periodEnd ?? ""}`.toLowerCase().includes(q));
    const key = (t: TimesheetSummary) => t.updatedAt ?? t.createdAt;
    if (sort === "updated") r = [...r].sort((a, b) => key(b).localeCompare(key(a)));
    if (sort === "period") r = [...r].sort((a, b) => (b.periodEnd ?? "").localeCompare(a.periodEnd ?? ""));
    if (sort === "pay") r = [...r].sort((a, b) => b.totalPay - a.totalPay);
    if (sort === "name") r = [...r].sort((a, b) => (a.customLabel || a.filename).localeCompare(b.customLabel || b.filename));
    return r;
  }, [list.data, site.id, status, search, sort]);

  const siteTotal = (list.data ?? []).filter((t) => t.siteId === site.id);
  const drafts = siteTotal.filter((t) => (t.status || "draft") === "draft").length;

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

  const menu = (t: TimesheetSummary) => (
    <TimesheetMenu
      t={t}
      onRename={() => setRenaming(t)}
      onDuplicate={() => duplicate.mutate(t.id)}
      onToggleFinal={() => patch.mutate({ id: t.id, body: { status: t.status === "final" ? "draft" : "final" } })}
      onMove={(s) => patch.mutate({ id: t.id, body: { siteId: s.id } }, { onSuccess: () => toast({ title: `Moved to ${s.name}` }) })}
      onDelete={() => remove.mutate(t.id)}
    />
  );
  const filtersActive = !!search.trim() || status !== "all";

  return (
    <Page>
      <PageHeader
        title="Timesheets"
        titleTestId="text-page-title"
        subtitle={<span className="inline-flex items-center gap-1.5"><SiteDot color={site.color} />{site.name}{siteTotal.length ? ` · ${siteTotal.length} saved${drafts ? `, ${drafts} draft${drafts === 1 ? "" : "s"}` : ""}` : ""}</span>}
        actions={
          <>
            <Button variant="ghost" onClick={() => setTrashOpen(true)} data-testid="button-open-trash"><Trash2 />Trash</Button>
            {editable && <Button onClick={() => newTimesheet()} data-testid="button-new-timesheet"><Plus /> New timesheet</Button>}
          </>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or date" aria-label="Search timesheets" className="pl-9" data-testid="input-search" />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as any)}>
          <SelectTrigger className="w-[8.5rem]" aria-label="Status" data-testid="select-status-filter"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All</SelectItem><SelectItem value="draft">Drafts</SelectItem><SelectItem value="final">Finalized</SelectItem></SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
          <SelectTrigger className="w-[10.5rem]" aria-label="Sort by" data-testid="select-sort"><ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="updated">Recently edited</SelectItem><SelectItem value="period">Pay period</SelectItem><SelectItem value="pay">Total pay</SelectItem><SelectItem value="name">Name</SelectItem></SelectContent>
        </Select>
        <SegmentedControl
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: "grid", label: <LayoutGrid />, title: "Grid", testid: "button-view-grid" },
            { value: "list", label: <List />, title: "List", testid: "button-view-list" },
          ]}
        />
      </div>

      {list.isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-36 rounded-xl" />)}</div>
      ) : list.error ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load timesheets" description={errorMessage(list.error)} action={<Button variant="outline" size="sm" onClick={() => list.refetch()}>Try again</Button>} />
      ) : rows.length === 0 ? (
        siteTotal.length ? (
          <EmptyState icon={Search} title="No timesheets match" description="Try a different search or show all statuses." action={filtersActive && <Button variant="outline" size="sm" onClick={() => { setSearch(""); setStatus("all"); }}>Clear filters</Button>} />
        ) : (
          <EmptyState
            icon={FileSpreadsheet}
            title={`No timesheets for ${site.name} yet`}
            description={editable ? (timeSource === "kiosk" ? "Import hours from the time clock, a CSV, or a Toast/Sling PDF — or start a blank one." : "Import timecards from Square, a CSV, or a Toast/Sling PDF — or start a blank one.") : "Timesheets created by your team will show up here."}
            action={editable && <>{timeSource === "kiosk" ? <Button onClick={() => newTimesheet("kiosk")} variant="tinted"><Tablet />From the time clock</Button> : <Button onClick={() => newTimesheet("square")} variant="tinted"><CalendarRange />Pull from Square</Button>}<Button onClick={() => newTimesheet()} ><Plus />New timesheet</Button></>}
          />
        )
      ) : view === "grid" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((t) => (
            <div key={t.id} className="group relative min-w-0 rounded-xl border border-card-border bg-card p-4 shadow-card transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:shadow-float focus-within:shadow-float" data-testid={`card-timesheet-${t.id}`}>
              <button className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35" aria-label={`Open ${t.customLabel || t.filename}`} onClick={() => navigate(`/timesheet/${t.id}`)} data-testid={`button-open-${t.id}`} />
              <div className="pointer-events-none relative flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-semibold tracking-tight" title={t.customLabel || t.filename}>{t.customLabel || t.filename || "Untitled"}</p>
                  <p className="mt-0.5 text-[13px] text-muted-foreground">{t.periodStart ? `${app.date(t.periodStart)} – ${app.date(t.periodEnd)}` : "No dates yet"}</p>
                </div>
                {editable && <div className="pointer-events-auto -mr-1.5 -mt-1">{menu(t)}</div>}
              </div>
              <div className="pointer-events-none relative mt-6 flex items-end justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[22px] font-semibold leading-none tracking-tight tabular">{app.money(t.totalPay)}</p>
                  <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground"><Users className="h-3 w-3" />{t.employeeCount} · edited {timeAgo(t.updatedAt ?? t.createdAt)}</p>
                </div>
                <StatusBadge status={t.status} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-card-border bg-card shadow-card" role="table" aria-label="Timesheets">
          <div className="hidden grid-cols-[minmax(0,1fr)_10rem_6rem_8rem_6rem_2.5rem] items-center gap-3 border-b border-border/70 px-4 py-2 text-xs font-medium text-muted-foreground sm:grid" role="row">
            <span role="columnheader">Name</span><span role="columnheader">Pay period</span><span role="columnheader" className="text-right">Employees</span><span role="columnheader" className="text-right">Total</span><span role="columnheader">Status</span><span />
          </div>
          <ul className="divide-y divide-border/70">
            {rows.map((t) => (
              <li key={t.id} className="relative grid grid-cols-[minmax(0,1fr)_auto_2.5rem] items-center gap-3 px-4 py-3 transition-colors hover:bg-foreground/[0.02] sm:grid-cols-[minmax(0,1fr)_10rem_6rem_8rem_6rem_2.5rem]" role="row" data-testid={`card-timesheet-${t.id}`}>
                <button className="absolute inset-0 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/35" aria-label={`Open ${t.customLabel || t.filename}`} onClick={() => navigate(`/timesheet/${t.id}`)} data-testid={`button-open-${t.id}`} />
                <div className="pointer-events-none relative min-w-0" role="cell">
                  <p className="truncate text-[14px] font-medium">{t.customLabel || t.filename || "Untitled"}</p>
                  <p className="truncate text-xs text-muted-foreground">edited {timeAgo(t.updatedAt ?? t.createdAt)}<span className="sm:hidden"> · {t.periodStart ? `${app.date(t.periodStart)} – ${app.date(t.periodEnd)}` : "No dates"}</span></p>
                </div>
                <span className="pointer-events-none relative hidden text-[13px] text-muted-foreground sm:block" role="cell">{t.periodStart ? `${app.date(t.periodStart)} – ${app.date(t.periodEnd)}` : "—"}</span>
                <span className="pointer-events-none relative hidden text-right text-[13px] tabular sm:block" role="cell">{t.employeeCount}</span>
                <span className="pointer-events-none relative text-right text-[14px] font-semibold tabular" role="cell">{app.money(t.totalPay)}</span>
                <span className="pointer-events-none relative hidden sm:block" role="cell"><StatusBadge status={t.status} /></span>
                <span className="relative justify-self-end" role="cell">{editable && menu(t)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <TrashDialog open={trashOpen} onOpenChange={setTrashOpen} onRestore={(id) => restore.mutate(id)} confirm={confirm} />
      <RenameDialog item={renaming} onClose={() => setRenaming(null)} onSave={(label) => renaming ? patch.mutateAsync({ id: renaming.id, body: { label } }) : undefined} />
    </Page>
  );
}

function TimesheetMenu({ t, onRename, onDuplicate, onToggleFinal, onMove, onDelete }: {
  t: TimesheetSummary; onRename: () => void; onDuplicate: () => void; onToggleFinal: () => void; onMove: (s: Site) => void; onDelete: () => void;
}) {
  const app = useApp();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Timesheet actions" data-testid={`button-menu-${t.id}`}><MoreHorizontal /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onRename}><Pencil />Rename</DropdownMenuItem>
        <DropdownMenuItem onClick={onDuplicate}><Copy />Duplicate</DropdownMenuItem>
        <DropdownMenuItem onClick={onToggleFinal}><CheckCircle2 />{t.status === "final" ? "Reopen as draft" : "Mark as final"}</DropdownMenuItem>
        {app.activeSites.length > 1 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger><MoveRight />Move to location</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {app.activeSites.filter((s) => s.id !== t.siteId).map((s) => (
                <DropdownMenuItem key={s.id} onClick={() => onMove(s)}><SiteDot color={s.color} />{s.name}</DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive focus:text-destructive [&_svg]:text-current" onClick={onDelete} data-testid={`button-delete-${t.id}`}><Trash2 />Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
  const editable = canEdit(app.user);
  const admin = isAdmin(app.user);
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
          <EmptyState compact icon={Trash2} title="The Trash is empty" description="Deleted timesheets show up here for 30 days." />
        ) : (
          <ul className="max-h-[50vh] divide-y divide-border/70 overflow-y-auto rounded-xl border border-border/80" data-testid="list-trash">
            {items.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{t.customLabel || t.filename || "Untitled"}</p>
                  <p className="text-xs text-muted-foreground">{app.sites.find((x) => x.id === t.siteId)?.name ?? ""}{t.periodStart ? ` · ${app.date(t.periodStart)} – ${app.date(t.periodEnd)}` : ""} · {daysLeft(t.deletedAt)} days left</p>
                </div>
                {editable && <Button size="sm" variant="outline" onClick={() => { onRestore(t.id); setTimeout(refresh, 300); }} data-testid={`button-restore-${t.id}`}><RotateCcw className="h-3.5 w-3.5" />Restore</Button>}
                {admin && <Button size="icon-sm" variant="ghost" className="text-muted-foreground hover:text-destructive" aria-label="Delete forever" onClick={() => removeForever(t)}><Trash2 /></Button>}
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          {admin && items.length > 0 && <Button variant="ghost" className="text-destructive mr-auto" onClick={empty}>Empty Trash</Button>}
          <Button variant="outline" onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
