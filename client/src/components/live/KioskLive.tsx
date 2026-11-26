// Live page additions for the kiosk extras: punch photo thumbnails, station
// tags, "break due" badges, fix requests from the kiosk, and shift notes.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Camera, CameraOff, Check, Coffee, Loader2, MapPin, Megaphone, Plus, Trash2, Wrench, X } from "lucide-react";
import type { Punch } from "@shared/punches";
import { type FixRequest, type ShiftNote, FIX_TYPE_LABELS } from "@shared/kiosk";
import { instantToLocal, localToInstant, minutesToInput, inputToMinutes, todayISO, addDays } from "@shared/dates";
import { api, errorMessage, queryClient } from "@/lib/api";
import { useLiveEvents } from "@/lib/live";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { SectionLabel } from "@/components/ui/page";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/workspace/fields";
import { cn } from "@/lib/utils";

// ── Small inline bits ────────────────────────────────────────────────────────
/** Thumbnail of a punch's kiosk photo; click to enlarge. Photos are served to editors only. */
export function PunchPhoto({ punch, canView, label }: { punch: Punch; canView: boolean; label: string }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const photo = punch.meta?.photo;
  if (!photo || !canView) return null;
  if (photo === "none" || failed) {
    return <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-foreground/[0.05] text-muted-foreground" title={failed ? "Photo no longer kept" : "No photo (camera unavailable)"}><CameraOff className="h-3.5 w-3.5" /></span>;
  }
  const src = `/api/punches/${encodeURIComponent(punch.id)}/photo`;
  const noFace = punch.meta?.face === "missing";
  const unchecked = punch.meta?.face === "unchecked";
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={cn("h-8 w-8 shrink-0 overflow-hidden rounded-md bg-foreground/[0.05] transition hover:ring-primary/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35", noFace || unchecked ? "ring-2 ring-amber-500" : "ring-1 ring-border/70")} title={noFace ? "No face found in this photo" : unchecked ? "This photo wasn't checked for a face" : undefined} aria-label={`Photo: ${label}${noFace ? " (no face found)" : unchecked ? " (not checked for a face)" : ""}`} data-testid={`button-photo-${punch.id}`}>
        <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" onError={() => setFailed(true)} />
      </button>
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><Camera className="h-4 w-4 text-muted-foreground" />Punch photo</DialogTitle>
              <DialogDescription className="break-words">{label}</DialogDescription>
            </DialogHeader>
            <img src={src} alt={`Kiosk photo: ${label}`} className="w-full rounded-lg bg-foreground/[0.04]" />
            {noFace && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950 ring-1 ring-amber-200 dark:bg-amber-950/30 dark:text-amber-100 dark:ring-amber-800">No face was found in this photo. The punch was saved on the tablet while it was offline, so it couldn't be refused. Check it's really them.</p>}
            {unchecked && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950 ring-1 ring-amber-200 dark:bg-amber-950/30 dark:text-amber-100 dark:ring-amber-800">This photo wasn't checked for a face: the punch was saved on the tablet while it was offline, and the face check wasn't working when it arrived. Check it's really them.</p>}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

/** "No photo", "No face" or "Not checked" badge for a kiosk punch saved offline that a manager should check. */
export function NoFaceBadge({ punch }: { punch: Punch }) {
  if (punch.meta?.face === "unchecked") {
    return <Badge variant="warning" className="shrink-0" title="Saved offline; the face check wasn't working when it arrived" data-testid={`badge-not-checked-${punch.id}`}>Not checked</Badge>;
  }
  if (punch.meta?.face !== "missing") return null;
  if (punch.meta.photo !== "saved") {
    return <Badge variant="warning" className="shrink-0" title="Saved offline without a photo, so it couldn't be checked for a face" data-testid={`badge-no-photo-${punch.id}`}>No photo</Badge>;
  }
  return <Badge variant="warning" className="shrink-0" title="Saved offline; no face was found in the photo" data-testid={`badge-no-face-${punch.id}`}>No face</Badge>;
}

export function StationTag({ station, className }: { station?: string | null; className?: string }) {
  if (!station) return null;
  return <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-foreground/[0.05] px-2 py-0.5 text-[11px] font-medium text-muted-foreground", className)}><MapPin className="h-3 w-3 shrink-0" /><span className="truncate">{station}</span></span>;
}

export function BreakDueBadge({ due }: { due?: boolean }) {
  if (!due) return null;
  return <Badge variant="warning" className="shrink-0" data-testid="badge-break-due"><Coffee />Break due</Badge>;
}

/** Refresh the kiosk extras when the kiosk or another admin changes them. */
function useKioskEvents(siteId: string, kind: "fix_request" | "note", key: unknown[]) {
  useLiveEvents((e) => {
    if (e.type === "hello" || (e.type === "kiosk" && e.siteId === siteId && (e as any).kind === kind)) void queryClient.invalidateQueries({ queryKey: key });
  });
}

function useLocalDateTime(iso: string, tz: string) {
  const l = instantToLocal(iso, tz);
  const [date, setDate] = useState(l.date);
  const [time, setTime] = useState(minutesToInput(l.minutes));
  const toIso = () => { const m = inputToMinutes(time); return m == null || !date ? null : localToInstant(date, m, tz); };
  return { date, setDate, time, setTime, toIso };
}

const when = (iso: string, tz: string) => {
  try { return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso)); } catch { return new Date(iso).toLocaleString(); }
};

// ── Fix requests ─────────────────────────────────────────────────────────────
export function FixRequests({ siteId, tz, editable }: { siteId: string; tz: string; editable: boolean }) {
  const key = ["/api/sites", siteId, "fix-requests"];
  const q = useQuery<FixRequest[]>({ queryKey: key, staleTime: 0 });
  useKioskEvents(siteId, "fix_request", key);
  const { toast } = useToast();
  const [approve, setApprove] = useState<FixRequest | null>(null);
  const [decline, setDecline] = useState<FixRequest | null>(null);
  const [showDone, setShowDone] = useState(false);
  const list = q.data ?? [];
  const pending = list.filter((r) => r.status === "pending");
  const decided = list.filter((r) => r.status !== "pending").slice(0, 10);
  if (q.isLoading || (!pending.length && !decided.length)) return null;

  return (
    <section data-testid="section-fix-requests">
      <SectionLabel action={decided.length > 0 ? <button type="button" className="rounded-sm text-[13px] font-medium text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/35" onClick={() => setShowDone((v) => !v)}>{showDone ? "Hide recent" : "Show recent"}</button> : undefined}>
        Fix requests{pending.length > 0 && <Badge variant="warning" className="ml-2 align-middle">{pending.length} new</Badge>}
      </SectionLabel>
      <div className="overflow-hidden rounded-xl border border-card-border bg-card shadow-card">
        {pending.length === 0 && !showDone ? (
          <p className="px-4 py-3 text-[13px] text-muted-foreground">No requests waiting.</p>
        ) : (
          <ul className="divide-y divide-border/70" data-testid="list-fix-requests">
            {[...pending, ...(showDone ? decided : [])].map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-[13px]">
                <Wrench className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1 basis-48">
                  <p className="break-words"><b className="font-semibold">{r.employeeName}</b> · {FIX_TYPE_LABELS[r.type]} at <b className="font-medium">{when(r.at, tz)}</b></p>
                  {r.note && <p className="break-words text-xs text-muted-foreground">“{r.note}”</p>}
                  {r.status !== "pending" && <p className="text-xs text-muted-foreground">{r.status === "approved" ? "Approved" : "Declined"}{r.decidedBy ? ` by ${r.decidedBy}` : ""}{r.status === "declined" && r.reason ? `: ${r.reason}` : ""}</p>}
                </div>
                {r.status === "pending" ? (
                  editable ? (
                    <div className="flex shrink-0 gap-1.5">
                      <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setDecline(r)} data-testid={`button-decline-${r.id}`}><X /> Decline</Button>
                      <Button size="sm" onClick={() => setApprove(r)} data-testid={`button-approve-${r.id}`}><Check /> Approve</Button>
                    </div>
                  ) : <Badge variant="warning">Waiting</Badge>
                ) : <Badge variant={r.status === "approved" ? "success" : "secondary"}>{r.status === "approved" ? "Approved" : "Declined"}</Badge>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {approve && <ApproveDialog r={approve} siteId={siteId} tz={tz} onClose={() => setApprove(null)} onDone={() => { setApprove(null); toast({ title: "Approved, punch added" }); void queryClient.invalidateQueries({ queryKey: key }); }} />}
      {decline && <DeclineDialog r={decline} siteId={siteId} onClose={() => setDecline(null)} onDone={() => { setDecline(null); toast({ title: "Request declined" }); void queryClient.invalidateQueries({ queryKey: key }); }} />}
    </section>
  );
}

function ApproveDialog({ r, siteId, tz, onClose, onDone }: { r: FixRequest; siteId: string; tz: string; onClose: () => void; onDone: () => void }) {
  const dt = useLocalDateTime(r.at, tz);
  const [note, setNote] = useState(`Fix request from the kiosk${r.note ? `: ${r.note}` : ""}`);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const conflict = !!problem && /doesn't fit/.test(problem);
  const save = async () => {
    const at = dt.toIso();
    if (!at) { setProblem("Enter a date and time."); return; }
    setBusy(true); setProblem(null);
    try {
      await api("POST", `/api/sites/${siteId}/fix-requests/${r.id}/approve`, { at, note: note.trim() || undefined, force: conflict });
      onDone();
    } catch (e) { setProblem(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Approve fix request</DialogTitle>
          <DialogDescription className="break-words">{r.employeeName} · {FIX_TYPE_LABELS[r.type]}. This adds the punch, with the note kept on it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date"><Input type="date" value={dt.date} onChange={(e) => dt.setDate(e.target.value)} /></Field>
            <Field label={`Time (${tz})`}><Input type="time" value={dt.time} onChange={(e) => dt.setTime(e.target.value)} data-testid="input-approve-time" /></Field>
          </div>
          <Field label="Note"><Textarea rows={2} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></Field>
          {problem && (
            <div className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] font-medium text-danger" role="alert">
              {problem}
              {conflict && <p className="mt-1 text-xs font-normal text-muted-foreground">You can approve anyway; the payroll import will warn about any shift that doesn't pair up.</p>}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={save} data-testid="button-confirm-approve">{busy && <Loader2 className="animate-spin" />}{conflict ? "Approve anyway" : "Approve"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeclineDialog({ r, siteId, onClose, onDone }: { r: FixRequest; siteId: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setProblem(null);
    try { await api("POST", `/api/sites/${siteId}/fix-requests/${r.id}/decline`, { reason: reason.trim() }); onDone(); } catch (e) { setProblem(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Decline fix request</DialogTitle>
          <DialogDescription className="break-words">{r.employeeName} · {FIX_TYPE_LABELS[r.type]}. No punch is added.</DialogDescription>
        </DialogHeader>
        <Field label="Reason (optional)"><Textarea rows={2} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. You were off that day" /></Field>
        {problem && <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] font-medium text-danger" role="alert">{problem}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={save} data-testid="button-confirm-decline">{busy && <Loader2 className="animate-spin" />}Decline</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Shift notes ──────────────────────────────────────────────────────────────
type NoteView = ShiftNote & { active: boolean };

export function ShiftNotes({ siteId, tz, editable, employees }: { siteId: string; tz: string; editable: boolean; employees: { id: string; name: string }[] }) {
  const key = ["/api/sites", siteId, "kiosk-notes"];
  const q = useQuery<NoteView[]>({ queryKey: key, staleTime: 0 });
  useKioskEvents(siteId, "note", key);
  const { toast } = useToast();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const active = (q.data ?? []).filter((n) => n.active);
  const names = useMemo(() => Object.fromEntries(employees.map((e) => [e.id, e.name])), [employees]);
  if (q.isLoading || (!active.length && !editable)) return null;

  const remove = async (n: NoteView) => {
    if (!(await confirm({ title: "Remove this note?", description: "It stops showing on the kiosk.", confirmLabel: "Remove", destructive: true }))) return;
    try { await api("DELETE", `/api/sites/${siteId}/kiosk-notes/${n.id}`); await queryClient.invalidateQueries({ queryKey: key }); } catch (e) { toast({ title: "Couldn't remove", description: errorMessage(e), variant: "destructive" }); }
  };

  return (
    <section data-testid="section-shift-notes">
      <SectionLabel action={editable ? <Button size="sm" variant="ghost" onClick={() => setAdding(true)} data-testid="button-add-note"><Plus /> Post a note</Button> : undefined}>Shift notes</SectionLabel>
      <div className="overflow-hidden rounded-xl border border-card-border bg-card shadow-card">
        {active.length === 0 ? (
          <p className="flex items-start gap-3 px-4 py-3 text-[13px] text-muted-foreground"><Megaphone className="mt-0.5 h-4 w-4 shrink-0" />No notes up. Post one and each person sees it once when they clock in, and taps OK.</p>
        ) : (
          <ul className="divide-y divide-border/70" data-testid="list-notes">
            {active.map((n) => {
              const audience = n.employeeIds.length ? n.employeeIds.map((id) => names[id] ?? "Removed employee") : null;
              const target = audience ? audience.length : employees.length;
              return (
                <li key={n.id} className="flex items-start gap-3 px-4 py-3 text-[13px]">
                  <Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap break-words font-medium">{n.text}</p>
                    <p className="mt-0.5 break-words text-xs text-muted-foreground">
                      {audience ? `For ${audience.join(", ")}` : "For everyone"}
                      {n.expiresAt ? ` · until ${when(n.expiresAt, tz)}` : ""}
                      {n.createdBy ? ` · ${n.createdBy}` : ""}
                    </p>
                    <p className="mt-0.5 break-words text-xs text-muted-foreground" title={n.acks.map((a) => `${a.name} ${when(a.at, tz)}`).join("\n")}>
                      Seen by {n.acks.length}{target ? ` of ${target}` : ""}{n.acks.length ? `: ${n.acks.map((a) => a.name).join(", ")}` : ""}
                    </p>
                  </div>
                  {editable && <Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground hover:text-destructive" aria-label="Remove note" onClick={() => remove(n)}><Trash2 /></Button>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {adding && <NoteDialog siteId={siteId} tz={tz} employees={employees} onClose={() => setAdding(false)} onDone={() => { setAdding(false); toast({ title: "Note posted" }); void queryClient.invalidateQueries({ queryKey: key }); }} />}
    </section>
  );
}

const EXPIRY = [
  { id: "today", label: "End of today" },
  { id: "tomorrow", label: "End of tomorrow" },
  { id: "week", label: "One week" },
  { id: "never", label: "Until I remove it" },
] as const;

function NoteDialog({ siteId, tz, employees, onClose, onDone }: { siteId: string; tz: string; employees: { id: string; name: string }[]; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [everyone, setEveryone] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number]["id"]>("today");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const expiresAt = () => {
    const today = todayISO(tz);
    if (expiry === "today") return localToInstant(addDays(today, 1), 0, tz);
    if (expiry === "tomorrow") return localToInstant(addDays(today, 2), 0, tz);
    if (expiry === "week") return localToInstant(addDays(today, 8), 0, tz);
    return null;
  };
  const save = async () => {
    setBusy(true); setProblem(null);
    try {
      await api("POST", `/api/sites/${siteId}/kiosk-notes`, { text: text.trim(), employeeIds: everyone ? [] : [...picked], expiresAt: expiresAt() });
      onDone();
    } catch (e) { setProblem(errorMessage(e)); } finally { setBusy(false); }
  };
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Post a shift note</DialogTitle>
          <DialogDescription>Shown once on the kiosk when each person clocks in. They tap OK, and you see who has seen it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Note"><Textarea rows={3} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder="e.g. Fish delivery at 10. Please check the walk-in." data-testid="input-note-text" /></Field>
          <Field label="Who sees it">
            <div className="flex gap-2">
              <Button type="button" size="sm" variant={everyone ? "tinted" : "outline"} onClick={() => setEveryone(true)}>{everyone && <Check />}Everyone</Button>
              <Button type="button" size="sm" variant={!everyone ? "tinted" : "outline"} onClick={() => setEveryone(false)} data-testid="button-note-some">{!everyone && <Check />}Some people</Button>
            </div>
          </Field>
          {!everyone && (
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border/80 p-2">
              {employees.length === 0 ? <p className="text-xs text-muted-foreground">No employees yet.</p> : employees.map((e) => (
                <label key={e.id} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-foreground/[0.03]">
                  <Checkbox checked={picked.has(e.id)} onCheckedChange={() => toggle(e.id)} />
                  <span className="min-w-0 break-words">{e.name}</span>
                </label>
              ))}
            </div>
          )}
          <Field label="Show until">
            <Select value={expiry} onValueChange={(v) => setExpiry(v as typeof expiry)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{EXPIRY.map((x) => <SelectItem key={x.id} value={x.id}>{x.label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {problem && <p className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] font-medium text-danger" role="alert">{problem}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !text.trim() || (!everyone && picked.size === 0)} onClick={save} data-testid="button-post-note">{busy && <Loader2 className="animate-spin" />}Post note</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
