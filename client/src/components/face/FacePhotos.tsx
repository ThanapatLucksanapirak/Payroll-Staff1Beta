// Punch photo gallery and face match set-up (consent, reference photos,
// deleting face data). Used from the Employees page.
import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Camera, Check, Copy, FileText, Loader2, Printer, ScanFace, ShieldCheck, Trash2, X } from "lucide-react";
import { FACE_MIN_REFS, type FaceRefView, type FaceSummary, type GalleryPhoto } from "@shared/face";
import { PUNCH_LABELS, type PunchType } from "@shared/punches";
import { api, errorMessage, queryClient } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface FaceEmployee { id: string; name: string; active: boolean }
interface FaceDetail extends FaceSummary { refList: FaceRefView[]; notice: string; retentionDays: number }
interface GalleryPage { photos: GalleryPhoto[]; nextBefore: string | null }

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const when = (iso: string, tz: string) => {
  try {
    return new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz });
  } catch {
    return new Date(iso).toLocaleString();
  }
};
const dateOnly = (iso: string, tz: string) => {
  try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: tz }); } catch { return iso.slice(0, 10); }
};
const photoUrl = (punchId: string) => `/api/punches/${encodeURIComponent(punchId)}/photo`;
const refUrl = (siteId: string, employeeId: string, refId: string) => `/api/sites/${siteId}/employees/${employeeId}/face/refs/${refId}/photo`;

/** Who at this location has face data (consent, reference photos, face match on). */
export function useFaceSummaries(siteId: string, enabled: boolean) {
  return useQuery<FaceSummary[]>({ queryKey: ["/api/sites", siteId, "face"], enabled });
}

function invalidateFace(siteId: string, employeeId?: string) {
  void queryClient.invalidateQueries({ queryKey: ["/api/sites", siteId, "face"] });
  void queryClient.invalidateQueries({ queryKey: ["face-gallery", siteId] });
  if (employeeId) void queryClient.invalidateQueries({ queryKey: ["/api/sites", siteId, "employees", employeeId, "face"] });
}

// ── Gallery ──────────────────────────────────────────────────────────────────
function PhotoGrid({ siteId, employeeId, tz, showNames, onOpen }: { siteId: string; employeeId?: string; tz: string; showNames: boolean; onOpen: (p: GalleryPhoto) => void }) {
  const q = useInfiniteQuery<GalleryPage>({
    queryKey: ["face-gallery", siteId, employeeId ?? "all"],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (employeeId) qs.set("employeeId", employeeId);
      if (pageParam) qs.set("before", String(pageParam));
      return api<GalleryPage>("GET", `/api/sites/${siteId}/photos${qs.size ? `?${qs}` : ""}`);
    },
    getNextPageParam: (last) => last.nextBefore,
  });
  const photos = q.data?.pages.flatMap((p) => p.photos) ?? [];

  if (q.isLoading) {
    return <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-busy="true" aria-label="Loading photos">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="aspect-square rounded-lg" />)}</div>;
  }
  if (q.error) {
    return <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive">{errorMessage(q.error)} <button type="button" className="underline" onClick={() => q.refetch()}>Try again</button></p>;
  }
  return (
    <div className="space-y-3">
      {photos.length ? (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4" data-testid="grid-photos">
          {photos.map((p) => {
            const flagged = p.face === "missing" || p.face === "unchecked" || p.face === "mismatch";
            const label = `${showNames ? `${p.employeeName}${p.removed ? " (removed)" : ""} · ` : ""}${PUNCH_LABELS[p.type as PunchType] ?? p.type} · ${when(p.at, tz)}`;
            return (
              <li key={p.punchId} className="min-w-0">
                <button
                  type="button"
                  onClick={() => onOpen(p)}
                  className={cn("relative block aspect-square w-full overflow-hidden rounded-lg bg-foreground/[0.05] transition focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35", flagged ? "ring-2 ring-amber-500" : p.reference ? "ring-2 ring-primary" : "ring-1 ring-border/70 hover:ring-primary/50")}
                  aria-label={`Photo: ${label}${p.reference ? " (reference photo)" : ""}${flagged ? " (flagged)" : ""}`}
                  data-testid={`photo-${p.punchId}`}
                >
                  <img src={photoUrl(p.punchId)} alt="" loading="lazy" className="h-full w-full object-cover" />
                  {p.reference && <span className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow" title="Reference photo"><Check className="h-3 w-3" /></span>}
                </button>
                <p className="mt-1 truncate text-[11px] leading-tight text-muted-foreground">
                  {showNames && <span className="font-medium text-foreground">{p.employeeName}{p.removed ? " (removed)" : ""} · </span>}
                  {PUNCH_LABELS[p.type as PunchType] ?? p.type}
                </p>
                <p className="truncate text-[11px] leading-tight text-muted-foreground tabular">{when(p.at, tz)}</p>
              </li>
            );
          })}
        </ul>
      ) : !q.hasNextPage ? (
        <p className="rounded-lg bg-foreground/[0.03] px-3 py-6 text-center text-[13px] text-muted-foreground" data-testid="text-no-photos">No punch photos yet. They appear here when a time clock with photos on is used.</p>
      ) : null}
      {q.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage} data-testid="button-older-photos">
            {q.isFetchingNextPage && <Loader2 className="animate-spin" />}{photos.length ? "Show older photos" : "Look further back"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** A photo enlarged, with "Use as reference photo" for people who can set up face match. */
function PhotoViewer({ siteId, photo, tz, canAddRef, onClose }: { siteId: string; photo: GalleryPhoto; tz: string; canAddRef: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = `${photo.employeeName} · ${PUNCH_LABELS[photo.type as PunchType] ?? photo.type} · ${when(photo.at, tz)}`;
  const add = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<FaceSummary & { dropped: number }>("POST", `/api/sites/${siteId}/employees/${photo.employeeId}/face/refs`, { punchId: photo.punchId });
      invalidateFace(siteId, photo.employeeId);
      toast({ title: "Reference photo added", description: r.dropped ? "The oldest reference photo was replaced." : `${r.refs} reference photo${r.refs === 1 ? "" : "s"} for ${firstName(photo.employeeName)}.` });
      onClose();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Camera className="h-4 w-4 text-muted-foreground" />Punch photo</DialogTitle>
          <DialogDescription className="break-words">{label}</DialogDescription>
        </DialogHeader>
        <img src={photoUrl(photo.punchId)} alt={`Kiosk photo: ${label}`} className="w-full rounded-lg bg-foreground/[0.04]" />
        {photo.face === "missing" && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950 ring-1 ring-amber-200 dark:bg-amber-950/30 dark:text-amber-100 dark:ring-amber-800">No face was found in this photo when it arrived.</p>}
        {photo.face === "unchecked" && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950 ring-1 ring-amber-200 dark:bg-amber-950/30 dark:text-amber-100 dark:ring-amber-800">This photo wasn't checked for a face when it arrived.</p>}
        {photo.face === "mismatch" && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950 ring-1 ring-amber-200 dark:bg-amber-950/30 dark:text-amber-100 dark:ring-amber-800">This face didn't match their reference photos (the punch was saved offline, so it was kept).</p>}
        {photo.reference && <p className="flex items-center gap-2 text-[13px] text-muted-foreground"><Check className="h-4 w-4 text-primary" />One of {firstName(photo.employeeName)}'s reference photos.</p>}
        {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive" role="alert" data-testid="text-ref-error">{error}</p>}
        {canAddRef && !photo.reference && (
          <DialogFooter>
            <Button onClick={add} disabled={busy} data-testid="button-use-as-reference">{busy ? <Loader2 className="animate-spin" /> : <ScanFace />}Use as reference photo</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Consent notice ───────────────────────────────────────────────────────────
function NoticeDialog({ name, notice, onClose }: { name: string; notice: string; onClose: () => void }) {
  const { toast } = useToast();
  const copy = async () => {
    try { await navigator.clipboard.writeText(notice); toast({ title: "Notice copied" }); } catch { toast({ title: "Couldn't copy", description: "Select the text and copy it instead.", variant: "destructive" }); }
  };
  const print = () => {
    const w = window.open("", "_blank", "width=720,height=900");
    if (!w) return toast({ title: "Couldn't open the print window", description: "Copy the notice instead.", variant: "destructive" });
    const doc = w.document;
    doc.title = `Face recognition consent: ${name}`;
    const pre = doc.createElement("pre");
    pre.textContent = notice.replace("Name: ______________________", `Name: ${name}`);
    pre.style.cssText = "font: 14px/1.5 system-ui, sans-serif; white-space: pre-wrap; max-width: 640px; margin: 40px auto;";
    doc.body.appendChild(pre);
    w.focus();
    w.print();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Consent notice</DialogTitle>
          <DialogDescription>Give this to {firstName(name)} to read and sign, and keep the signed copy. It's a plain-language starting point, not legal advice.</DialogDescription>
        </DialogHeader>
        <pre className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-lg bg-foreground/[0.04] p-3 font-sans text-[13px] leading-relaxed" data-testid="text-consent-notice">{notice}</pre>
        <DialogFooter>
          <Button variant="outline" onClick={copy}><Copy />Copy</Button>
          <Button variant="outline" onClick={print}><Printer />Print</Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteFaceDialog({ siteId, employee, onClose }: { siteId: string; employee: FaceEmployee; onClose: () => void }) {
  const { toast } = useToast();
  const [alsoPhotos, setAlsoPhotos] = useState(false);
  const [busy, setBusy] = useState(false);
  const del = async () => {
    setBusy(true);
    try {
      const r = await api<{ punchPhotos: number }>("DELETE", `/api/sites/${siteId}/employees/${employee.id}/face${alsoPhotos ? "?punchPhotos=1" : ""}`);
      invalidateFace(siteId, employee.id);
      toast({ title: "Face data deleted", description: alsoPhotos ? `${r.punchPhotos} punch photo${r.punchPhotos === 1 ? "" : "s"} deleted too.` : undefined });
      onClose();
    } catch (e) { toast({ title: "Couldn't delete", description: errorMessage(e), variant: "destructive" }); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete {firstName(employee.name)}'s face data?</DialogTitle>
          <DialogDescription>Their consent record, reference photos and face templates are deleted for good. They'll clock in with their PIN only. To use face match again, record consent and pick new reference photos.</DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
          <Checkbox checked={alsoPhotos} onCheckedChange={(v) => setAlsoPhotos(v === true)} className="mt-0.5" data-testid="checkbox-delete-punch-photos" />
          <span>Also delete all their punch photos (their punches and hours are kept)</span>
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={del} disabled={busy} data-testid="button-confirm-delete-face">{busy && <Loader2 className="animate-spin" />}Delete face data</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Face match set-up for one person ─────────────────────────────────────────
function FaceMatchCard({ siteId, employee, tz, canManage }: { siteId: string; employee: FaceEmployee; tz: string; canManage: boolean }) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const q = useQuery<FaceDetail>({ queryKey: ["/api/sites", siteId, "employees", employee.id, "face"] });
  const [notice, setNotice] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const first = firstName(employee.name);
  const d = q.data;

  const recordConsent = async () => {
    if (!(await confirm({ title: `Did ${first} sign the consent notice?`, description: "Only record consent once they've read and signed it. Keep the signed copy. The date and your name are saved, and it's written to Settings → Activity.", confirmLabel: `${first} signed it` }))) return;
    setBusy(true);
    try {
      await api("POST", `/api/sites/${siteId}/employees/${employee.id}/face/consent`, { confirm: true });
      invalidateFace(siteId, employee.id);
      toast({ title: "Consent recorded", description: `Now pick ${FACE_MIN_REFS} clear photos of ${first} below as reference photos.` });
    } catch (e) { toast({ title: "Couldn't record consent", description: errorMessage(e), variant: "destructive" }); } finally { setBusy(false); }
  };
  const setRequired = async (required: boolean) => {
    if (required && !(await confirm({ title: `Turn on face match for ${first}?`, description: `At the time clock, ${first}'s face must match their reference photos to punch. If it doesn't, the punch is refused, ${first} is told to ask a manager, and it shows on Live. Punches saved while the tablet was offline are kept but flagged. Every time clock takes a photo of ${first}, even one with photos turned off.`, confirmLabel: "Turn on" }))) return;
    setBusy(true);
    try {
      await api("PUT", `/api/sites/${siteId}/employees/${employee.id}/face/required`, { required });
      invalidateFace(siteId, employee.id);
      toast({ title: required ? `Face match is on for ${first}` : `Face match is off for ${first}` });
    } catch (e) { toast({ title: "Couldn't change face match", description: errorMessage(e), variant: "destructive" }); } finally { setBusy(false); }
  };
  const removeRef = async (r: FaceRefView) => {
    if (d?.required && d.refs <= FACE_MIN_REFS && !(await confirm({ title: "Turn off face match?", description: `Face match needs ${FACE_MIN_REFS} reference photos, so removing this one turns it off for ${first} until you add another.`, confirmLabel: "Remove and turn off", destructive: true }))) return;
    try {
      await api("DELETE", `/api/sites/${siteId}/employees/${employee.id}/face/refs/${r.id}`);
      invalidateFace(siteId, employee.id);
    } catch (e) { toast({ title: "Couldn't remove", description: errorMessage(e), variant: "destructive" }); }
  };

  if (q.isLoading || !d) {
    return q.error
      ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive">{errorMessage(q.error)}</p>
      : <Skeleton className="h-24 rounded-xl" />;
  }

  return (
    <section className="space-y-3 rounded-xl border border-card-border bg-card p-4 shadow-card" aria-labelledby="face-match-title" data-testid="card-face-match">
      <div className="flex items-start gap-3">
        <ScanFace className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p id="face-match-title" className="text-[14px] font-semibold">Face match</p>
          <p className="text-[13px] text-muted-foreground">The time clock can check it's really {first} punching, by comparing each punch photo with reference photos you approve.</p>
        </div>
      </div>

      {d.unreadable && (
        <p className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-[13px] text-destructive" role="alert" data-testid="text-face-unreadable">
          <ScanFace className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{first}'s face data can't be read (the file is damaged, or the server's key changed). To be safe, their time clock punches are refused until you delete it below and set face match up again.</span>
        </p>
      )}
      {!d.consentAt ? (
        <div className="space-y-2.5 rounded-lg bg-foreground/[0.03] p-3 text-[13px]">
          <p className="flex items-start gap-2"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><span>First, {first} reads and signs the consent notice. Face data is biometric data, which some US states (for example Illinois, Texas and Washington) only allow with written consent.</span></p>
          <div className="flex flex-wrap gap-2 pl-6">
            <Button size="sm" variant="outline" onClick={() => setNotice(true)} data-testid="button-consent-notice"><FileText />Consent notice</Button>
            {canManage
              ? <Button size="sm" onClick={recordConsent} disabled={busy} data-testid="button-record-consent">{busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}{first} signed it</Button>
              : <span className="self-center text-xs text-muted-foreground">An owner or administrator records consent.</span>}
          </div>
        </div>
      ) : (
        <>
          <p className="flex items-start gap-2 text-[13px] text-muted-foreground" data-testid="text-consent">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <span>Consent recorded {dateOnly(d.consentAt, tz)}{d.consentBy ? ` by ${d.consentBy}` : ""}. <button type="button" className="text-xs underline underline-offset-2 hover:text-foreground" onClick={() => setNotice(true)}>View notice</button></span>
          </p>
          <div>
            <p className="mb-1.5 text-[13px] font-medium">Reference photos <span className="font-normal tabular text-muted-foreground">({d.refs})</span></p>
            {d.refList.length ? (
              <ul className="flex flex-wrap gap-2" data-testid="list-reference-photos">
                {d.refList.map((r) => (
                  <li key={r.id} className="relative">
                    <img src={refUrl(siteId, employee.id, r.id)} alt={`Reference photo from ${when(r.takenAt, tz)}`} title={`From ${when(r.takenAt, tz)} · added by ${r.addedBy}`} className="h-16 w-16 rounded-lg object-cover ring-2 ring-primary" />
                    {canManage && (
                      <button type="button" onClick={() => void removeRef(r)} className="absolute -right-1.5 -top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-card text-muted-foreground shadow ring-1 ring-border hover:text-destructive" aria-label={`Remove reference photo from ${when(r.takenAt, tz)}`} data-testid={`button-remove-ref-${r.id}`}><X className="h-3.5 w-3.5" /></button>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            {d.refs < FACE_MIN_REFS ? (
              <p className="mt-1.5 text-xs text-muted-foreground" data-testid="text-refs-needed">
                {canManage ? `Open clear photos of ${first} below and tap Use as reference photo.` : "An owner or administrator picks reference photos."} {FACE_MIN_REFS - d.refs} more needed (face only, looking at the camera, good light).
              </p>
            ) : null}
          </div>
          <div className={cn("flex items-start justify-between gap-3 rounded-lg p-3", d.required ? "bg-success-soft" : "bg-foreground/[0.03]")}>
            <div className="min-w-0">
              <p className="text-[13px] font-medium">Require face match at the time clock</p>
              <p className="mt-0.5 text-xs text-muted-foreground" data-testid="text-face-required">
                {d.refs < FACE_MIN_REFS
                  ? `Available once ${first} has ${FACE_MIN_REFS} reference photos.`
                  : d.required
                    ? `On. A punch is refused if the face isn't ${first}'s, and shows on Live. Every time clock takes a photo of ${first}, even one with photos turned off.`
                    : `Off. ${first} clocks in with their PIN; photos are only checked for a face.`}
              </p>
            </div>
            <Switch checked={d.required} disabled={!canManage || busy || (!d.required && d.refs < FACE_MIN_REFS)} onCheckedChange={(v) => void setRequired(v)} aria-label={`Require face match for ${employee.name}`} data-testid="switch-face-required" />
          </div>
        </>
      )}
      {canManage && (d.consentAt || d.refs > 0 || d.unreadable) && (
        <div className="border-t border-border/70 pt-3">
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => setDeleting(true)} data-testid="button-delete-face"><Trash2 />Delete face data</Button>
        </div>
      )}
      {notice && <NoticeDialog name={employee.name} notice={d.notice} onClose={() => setNotice(false)} />}
      {deleting && <DeleteFaceDialog siteId={siteId} employee={employee} onClose={() => setDeleting(false)} />}
    </section>
  );
}

/** One person's punch photos, and face match set-up. */
export function EmployeePhotosDialog({ siteId, employee, tz, canManage, onClose }: { siteId: string; employee: FaceEmployee; tz: string; canManage: boolean; onClose: () => void }) {
  const [open, setOpen] = useState<GalleryPhoto | null>(null);
  const detail = useQuery<FaceDetail>({ queryKey: ["/api/sites", siteId, "employees", employee.id, "face"] });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{employee.name}</DialogTitle>
          <DialogDescription>Punch photos from the time clock, and face match.</DialogDescription>
        </DialogHeader>
        <FaceMatchCard siteId={siteId} employee={employee} tz={tz} canManage={canManage} />
        <div className="space-y-2">
          <p className="text-[13px] font-semibold">Punch photos</p>
          <PhotoGrid siteId={siteId} employeeId={employee.id} tz={tz} showNames={false} onOpen={setOpen} />
        </div>
        {open && <PhotoViewer siteId={siteId} photo={open} tz={tz} canAddRef={canManage && !!detail.data?.consentAt} onClose={() => setOpen(null)} />}
      </DialogContent>
    </Dialog>
  );
}

/** Every punch photo at the location, newest first, optionally for one person. */
export function SitePhotosDialog({ siteId, employees, tz, onClose, onOpenEmployee }: { siteId: string; employees: FaceEmployee[]; tz: string; onClose: () => void; onOpenEmployee: (e: FaceEmployee) => void }) {
  const [who, setWho] = useState("all");
  const [open, setOpen] = useState<GalleryPhoto | null>(null);
  const person = employees.find((e) => e.id === who);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Photos</DialogTitle>
          <DialogDescription>Every punch photo kept at this location, newest first.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={who} onValueChange={setWho}>
            <SelectTrigger className="w-56 max-w-full" aria-label="Whose photos" data-testid="select-photo-employee"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Everyone</SelectItem>
              {employees.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}{e.active ? "" : " (inactive)"}</SelectItem>)}
            </SelectContent>
          </Select>
          {person && <Button variant="outline" size="sm" onClick={() => onOpenEmployee(person)} data-testid="button-open-face-match"><ScanFace />Face match for {firstName(person.name)}</Button>}
        </div>
        <PhotoGrid key={who} siteId={siteId} employeeId={person?.id} tz={tz} showNames={!person} onOpen={setOpen} />
        {open && <PhotoViewer siteId={siteId} photo={open} tz={tz} canAddRef={false} onClose={() => setOpen(null)} />}
      </DialogContent>
    </Dialog>
  );
}

/** Small "Face match" status badge for the employee list. */
export function FaceBadge({ summary }: { summary?: FaceSummary }) {
  if (!summary) return null;
  if (summary.unreadable) return <Badge variant="destructive" title="Face data can't be read: punches are refused until it's set up again"><ScanFace /><span className="sr-only sm:not-sr-only">Face data unreadable</span></Badge>;
  if (summary.required) return <Badge variant="success" title="Face match is on at the time clock"><ScanFace /><span className="sr-only sm:not-sr-only">Face match</span></Badge>;
  if (summary.consentAt && summary.refs < FACE_MIN_REFS) return <Badge variant="secondary" title={`${summary.refs} of ${FACE_MIN_REFS} reference photos`}><ScanFace /><span className="tabular">{summary.refs}/{FACE_MIN_REFS}</span></Badge>;
  if (summary.consentAt) return <Badge variant="secondary" title="Ready for face match"><ScanFace /><span className="sr-only sm:not-sr-only">Ready</span></Badge>;
  return null;
}

