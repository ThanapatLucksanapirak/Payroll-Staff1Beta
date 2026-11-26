import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, ChevronLeft, CalendarRange, FileSpreadsheet, FileText, Loader2, PlusSquare, RefreshCw, Tablet, Upload } from "lucide-react";
import type { Shift, Site } from "@shared/schema";
import { CSV_FIELD_LABELS, type CsvField, type CsvMapping, type CsvParseResult, parseCsvText } from "@shared/importers/csv";
import type { ScheduleParseResult } from "@shared/importers/schedule";
import { shiftEmployeeNames, employeeKey } from "@shared/engine";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, errorMessage } from "@/lib/api";
import { payPeriod } from "@/lib/periods";
import { useApp } from "@/context/AppData";
import { cn } from "@/lib/utils";

export type ImportSource = "square" | "kiosk" | "csv" | "pdf" | "blank";
export interface ImportResult {
  shifts: Shift[]; source: string; filename: string; label: string; warnings: string[];
  /** The day range that was pulled (Square, time clock): it becomes the pay period. */
  period?: { start: string; end: string };
}

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  site: Site;
  mode: "create" | "append";
  initialSource?: ImportSource;
  onComplete: (r: ImportResult) => Promise<void> | void;
}

const NONE = "__none__";

export function ImportDialog({ open, onOpenChange, site, mode, initialSource, onComplete }: Props) {
  const [source, setSource] = useState<ImportSource | null>(initialSource ?? null);
  const [review, setReview] = useState<ImportResult | null>(null);
  const reset = () => { setSource(initialSource ?? null); setReview(null); };
  useEffect(() => { if (open) { setSource(initialSource ?? null); setReview(null); } }, [open, initialSource]);

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setTimeout(reset, 200); }}>
      <DialogContent className="max-w-2xl max-h-[92dvh] overflow-y-auto" data-testid="dialog-import">
        <DialogHeader>
          <DialogTitle>{review ? "Review import" : mode === "append" ? "Add shifts" : "New timesheet"}</DialogTitle>
          <DialogDescription>
            {review ? "Check the employees and shifts before continuing." : `Location: ${site.name}`}
          </DialogDescription>
        </DialogHeader>
        {review ? (
          <ReviewStep result={review} onBack={() => setReview(null)} onConfirm={async (r) => { await onComplete(r); onOpenChange(false); setTimeout(reset, 200); }} mode={mode} />
        ) : !source ? (
          <SourcePicker onPick={setSource} showBlank={mode === "create"} site={site} />
        ) : (
          <div className="space-y-4">
            {!initialSource && (
              <button type="button" className="-ml-1 inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-[13px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35" onClick={() => setSource(null)} data-testid="button-import-back">
                <ChevronLeft className="h-4 w-4" /> All sources
              </button>
            )}
            {source === "square" && <SquareStep site={site} onResult={setReview} />}
            {source === "kiosk" && <KioskStep site={site} onResult={setReview} />}
            {source === "csv" && <CsvStep onResult={setReview} />}
            {source === "pdf" && <PdfStep site={site} onResult={setReview} />}
            {source === "blank" && <BlankStep site={site} onResult={(r) => onComplete(r)} />}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SourcePicker({ onPick, showBlank, site }: { onPick: (s: ImportSource) => void; showBlank: boolean; site: Site }) {
  const timeSource = site.timeSource ?? "square";
  // Same source colours as the Home quick actions (categories use chart-*; the blank option stays neutral).
  const tint: Record<ImportSource, string> = { square: "bg-foreground/[0.06] text-foreground/70 dark:bg-foreground/10", kiosk: "bg-foreground/[0.06] text-foreground/70 dark:bg-foreground/10", csv: "bg-foreground/[0.06] text-foreground/70 dark:bg-foreground/10", pdf: "bg-foreground/[0.06] text-foreground/70 dark:bg-foreground/10", blank: "bg-foreground/[0.06] text-foreground/70 dark:bg-foreground/10" };
  const opts: { id: ImportSource; title: string; desc: string; icon: any }[] = [
    ...(timeSource !== "square" ? [{ id: "kiosk" as const, title: "From the time clock", desc: "Clock-ins and outs from the kiosk for a date range", icon: Tablet }] : []),
    ...(timeSource !== "kiosk" ? [{ id: "square" as const, title: "Pull from Square", desc: "Fetch closed timecards for a date range", icon: CalendarRange }] : []),
    { id: "csv", title: "Upload CSV", desc: "Square, Toast TimeEntries, Sling, 7shifts or any time-card CSV", icon: FileSpreadsheet },
    { id: "pdf", title: "Toast / Sling PDF", desc: "Printed schedule or time-entry report (PDF)", icon: FileText },
    ...(showBlank ? [{ id: "blank" as const, title: "Start blank", desc: "Enter shifts or manual pay by hand", icon: PlusSquare }] : []),
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {opts.map((o) => (
        <button key={o.id} type="button" onClick={() => onPick(o.id)} className="flex items-start gap-3 rounded-xl border border-card-border bg-card p-4 text-left shadow-card transition-[background-color,box-shadow,transform] duration-150 hover:bg-foreground/[0.015] hover:shadow-float focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 active:scale-[0.99]" data-testid={`button-source-${o.id}`}>
          <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]", tint[o.id])}><o.icon className="h-[18px] w-[18px]" /></span>
          <span className="min-w-0">
            <span className="block text-[14px] font-semibold">{o.title}</span>
            <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{o.desc}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return <p className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-[13px] font-medium text-danger" role="alert"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{children}</p>;
}

function SquareStep({ site, onResult }: { site: Site; onResult: (r: ImportResult) => void }) {
  const app = useApp();
  const connected = app.squareConnected[site.id];
  const cur = payPeriod(site.rules, 0);
  const prev = payPeriod(site.rules, -1);
  const [start, setStart] = useState(prev.start);
  const [end, setEnd] = useState(prev.end);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!connected) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-card-border bg-foreground/[0.02] px-6 py-8 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-foreground/[0.05]"><CalendarRange className="h-5 w-5 text-muted-foreground" /></span>
        <div><p className="text-[15px] font-semibold">Square isn't connected for {site.name}</p><p className="mx-auto mt-1 max-w-sm text-[13px] text-muted-foreground">Add an access token once and timecards can be pulled in one click.</p></div>
        <Button asChild size="sm"><Link href="/settings/locations">Connect in Settings</Link></Button>
      </div>
    );
  }
  const fetchIt = async () => {
    setBusy(true); setError("");
    try {
      const r = await api<{ shifts: Shift[]; warnings: string[] }>("GET", `/api/sites/${site.id}/square/pull?start=${start}&end=${end}`, undefined, { timeoutMs: 90000 });
      if (!r.shifts.length) { setError("No closed timecards were found for that range."); return; }
      onResult({ shifts: r.shifts, source: "square", filename: `Square ${app.date(start)} – ${app.date(end)}`, label: "", warnings: r.warnings, period: { start, end } });
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {[{ l: "Last pay period", p: prev }, { l: "Current pay period", p: cur }].map(({ l, p }) => (
          <Button key={l} size="sm" variant={start === p.start && end === p.end ? "tinted" : "outline"} aria-pressed={start === p.start && end === p.end} onClick={() => { setStart(p.start); setEnd(p.end); }}>
            {l} <span className="font-normal tabular opacity-75">{app.date(p.start)} – {app.date(p.end)}</span>
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5"><Label>From</Label><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} data-testid="input-square-start" /></div>
        <div className="space-y-1.5"><Label>To</Label><Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} data-testid="input-square-end" /></div>
      </div>
      <p className="text-xs text-muted-foreground">Times are converted to {site.rules.timezone}. Unpaid breaks are recorded on each shift.</p>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button onClick={fetchIt} disabled={busy || !start || !end} className="w-full" data-testid="button-square-fetch">
        {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}{busy ? "Fetching timecards…" : "Fetch timecards"}
      </Button>
    </div>
  );
}

function KioskStep({ site, onResult }: { site: Site; onResult: (r: ImportResult) => void }) {
  const app = useApp();
  const cur = payPeriod(site.rules, 0);
  const prev = payPeriod(site.rules, -1);
  const [start, setStart] = useState(prev.start);
  const [end, setEnd] = useState(prev.end);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fetchIt = async () => {
    setBusy(true); setError("");
    try {
      const r = await api<{ shifts: Shift[]; warnings: string[] }>("GET", `/api/sites/${site.id}/punches/shifts?start=${start}&end=${end}`, undefined, { timeoutMs: 60000 });
      if (!r.shifts.length) { setError(r.warnings.length ? r.warnings.join(" ") : "No completed shifts were found on the time clock for that range."); return; }
      onResult({ shifts: r.shifts, source: "kiosk", filename: `Time clock ${app.date(start)} – ${app.date(end)}`, label: "", warnings: r.warnings, period: { start, end } });
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {[{ l: "Last pay period", p: prev }, { l: "Current pay period", p: cur }].map(({ l, p }) => (
          <Button key={l} size="sm" variant={start === p.start && end === p.end ? "tinted" : "outline"} aria-pressed={start === p.start && end === p.end} onClick={() => { setStart(p.start); setEnd(p.end); }}>
            {l} <span className="font-normal tabular opacity-75">{app.date(p.start)} – {app.date(p.end)}</span>
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5"><Label>From</Label><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} data-testid="input-kiosk-start" /></div>
        <div className="space-y-1.5"><Label>To</Label><Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} data-testid="input-kiosk-end" /></div>
      </div>
      <p className="text-xs text-muted-foreground">Clock-ins are paired with clock-outs in {site.rules.timezone}; breaks are recorded on each shift. Shifts without a clock-out are listed as warnings. <Link href="/live" className="font-medium text-primary hover:underline">Fix punches</Link> first if needed.</p>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button onClick={fetchIt} disabled={busy || !start || !end} className="w-full" data-testid="button-kiosk-fetch">
        {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}{busy ? "Getting shifts…" : "Get shifts"}
      </Button>
    </div>
  );
}

function FileDrop({ accept, onFile, label, busy }: { accept: string; onFile: (f: File) => void; label: string; busy?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}
      onClick={() => ref.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") ref.current?.click(); }}
      className={cn("flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors duration-150 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35", over ? "border-primary bg-primary/5" : "border-border hover:border-primary/40 hover:bg-foreground/[0.015]")}
      data-testid="dropzone"
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">{busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}</span>
      <p className="max-w-full truncate text-[14px] font-semibold" title={label}>{label}</p>
      <p className="text-xs text-muted-foreground">{busy ? "Reading the file…" : "Drag a file here or click to browse"}</p>
      <input ref={ref} type="file" accept={accept} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} data-testid="input-file" />
    </div>
  );
}

function CsvStep({ onResult }: { onResult: (r: ImportResult) => void }) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [parsed, setParsed] = useState<CsvParseResult | null>(null);
  const [mapping, setMapping] = useState<CsvMapping>({});
  const [error, setError] = useState("");
  const { prefs } = useApp();
  const dayFirst = prefs?.dateFormat === "D/M/YY";

  const load = async (f: File) => {
    setError("");
    if (f.size > 15 * 1024 * 1024) { setError("That file is larger than 15 MB."); return; }
    const text = await f.text();
    const r = parseCsvText(text, { dayFirst });
    setFile({ name: f.name, text });
    setParsed(r);
    setMapping(r.mapping);
    if (!r.needsMapping && r.shifts.length) onResult({ shifts: r.shifts, source: "csv", filename: f.name, label: "", warnings: [`Detected: ${r.format}`, ...r.warnings] });
  };
  const remap = () => {
    if (!file) return;
    const r = parseCsvText(file.text, { mapping, dayFirst });
    setParsed(r);
    if (r.shifts.length) onResult({ shifts: r.shifts, source: "csv", filename: file.name, label: "", warnings: r.warnings });
    else setError(r.warnings.join(" ") || "No shifts found with that mapping.");
  };
  const fields: CsvField[] = ["name", "firstName", "lastName", "date", "start", "endDate", "end", "breakMinutes", "breakHours", "role"];
  return (
    <div className="space-y-4">
      <FileDrop accept=".csv,text/csv" onFile={load} label={file ? file.name : "Choose a CSV file"} />
      {error && <ErrorNote>{error}</ErrorNote>}
      {parsed?.needsMapping && (
        <div className="space-y-3 rounded-xl border border-border/80 p-4">
          <p className="text-[14px] font-semibold">Match the columns</p>
          <p className="text-xs text-muted-foreground">We couldn't recognise this layout automatically. Pick which column holds each value. Dates can include the time (e.g. "9/20/26 10:44 AM").</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((f) => (
              <div key={f} className="space-y-1">
                <Label className="text-xs">{CSV_FIELD_LABELS[f]}</Label>
                <Select value={mapping[f] ?? NONE} onValueChange={(v) => setMapping({ ...mapping, [f]: v === NONE ? undefined : v })}>
                  <SelectTrigger className="h-9 text-[13px]" aria-label={CSV_FIELD_LABELS[f]} data-testid={`select-map-${f}`}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Not in file</SelectItem>
                    {parsed.headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
          <Button onClick={remap} size="sm" data-testid="button-apply-mapping">Use this mapping</Button>
        </div>
      )}
    </div>
  );
}

function PdfStep({ site, onResult }: { site: Site; onResult: (r: ImportResult) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [res, setRes] = useState<ScheduleParseResult | null>(null);
  const [weekStart, setWeekStart] = useState("");
  const [year, setYear] = useState("");

  const run = async (f: File, ws = weekStart, yr = year) => {
    setBusy(true); setError("");
    try {
      if (f.size > 25 * 1024 * 1024) throw new Error("That PDF is larger than 25 MB.");
      const q = new URLSearchParams({ weekStartsOn: String(site.rules.weekStartsOn) });
      if (ws) q.set("weekStart", ws);
      if (yr) q.set("year", yr);
      const r = await api<ScheduleParseResult>("POST", `/api/import/pdf?${q}`, undefined, { raw: await f.arrayBuffer(), contentType: "application/pdf", timeoutMs: 90000 });
      setRes(r);
      if (r.shifts.length && !r.needsWeekStart) {
        onResult({ shifts: r.shifts, source: "toast", filename: f.name, label: "", warnings: [`Read ${r.shifts.length} shifts from a ${r.format === "grid" ? "week schedule" : "list"} layout on ${r.pages} page${r.pages === 1 ? "" : "s"}.`, "Scheduled times are used as clock-in/out — adjust any shifts that ran differently.", ...r.warnings] });
      }
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <FileDrop accept="application/pdf,.pdf" busy={busy} onFile={(f) => { setFile(f); run(f); }} label={file ? file.name : "Choose a schedule PDF"} />
      <details className="rounded-lg bg-foreground/[0.03] px-3 py-2.5 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none font-medium text-foreground/80">How to get a PDF from Toast / Sling</summary>
        <ul className="mt-2 list-disc pl-5 space-y-1">
          <li>Sling by Toast: Schedule → choose Week view → Print → Download PDF.</li>
          <li>Toast Web: Reports → Labor → Time entries → export, or print the page to PDF.</li>
          <li>Week-grid and list layouts are both supported. Scanned images aren't.</li>
        </ul>
      </details>
      {error && <ErrorNote>{error}</ErrorNote>}
      {res && (res.needsWeekStart || !res.shifts.length) && (
        <div className="space-y-3 rounded-xl border border-border/80 p-4">
          {res.warnings.map((w, i) => <p key={i} className="text-[13px]">{w}</p>)}
          {res.unmatched.length > 0 && (
            <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Lines with times we couldn't place ({res.unmatched.length})</summary>
              <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-[11px]">{res.unmatched.join("\n")}</pre>
            </details>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label className="text-xs">First day shown</Label><Input type="date" value={weekStart} onChange={(e) => setWeekStart(e.target.value)} data-testid="input-pdf-weekstart" /></div>
            <div className="space-y-1"><Label className="text-xs">Year (optional)</Label><Input inputMode="numeric" placeholder="e.g. 2026" value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))} /></div>
          </div>
          <Button size="sm" disabled={!file || busy} onClick={() => file && run(file)} data-testid="button-pdf-reread"><RefreshCw /> Read again</Button>
        </div>
      )}
    </div>
  );
}

function BlankStep({ site, onResult }: { site: Site; onResult: (r: ImportResult) => void }) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await onResult({ shifts: [], source: "manual", filename: label || "Manual timesheet", label, warnings: [] }); } finally { setBusy(false); } }}>
      <div className="space-y-1.5"><Label>Name (optional)</Label><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`e.g. ${site.name} — week 45`} data-testid="input-blank-label" /></div>
      <p className="text-xs text-muted-foreground">You can add shifts, manual employees and lump-sum pay inside the timesheet.</p>
      <Button type="submit" className="w-full" disabled={busy} data-testid="button-blank-create">{busy && <Loader2 className="animate-spin" />} Create timesheet</Button>
    </form>
  );
}

function ReviewStep({ result, onBack, onConfirm, mode }: { result: ImportResult; onBack: () => void; onConfirm: (r: ImportResult) => Promise<void>; mode: "create" | "append" }) {
  const app = useApp();
  const names = useMemo(() => shiftEmployeeNames(result.shifts), [result.shifts]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [label, setLabel] = useState(result.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const byEmp = useMemo(() => {
    const m = new Map<string, Shift[]>();
    for (const s of result.shifts) {
      const k = employeeKey(s.employee);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(s);
    }
    return m;
  }, [result.shifts]);
  const kept = result.shifts.filter((s) => !excluded.has(employeeKey(s.employee)));
  const dates = kept.map((s) => s.date).sort();

  return (
    <div className="space-y-4">
      {result.warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-foreground/[0.04] px-3 py-2.5 text-xs leading-snug text-muted-foreground">
          {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
      <div className="grid grid-cols-3 divide-x divide-border/70 rounded-xl border border-border/80 text-center">
        <div className="px-3 py-2.5"><p className="text-[20px] font-semibold tabular">{kept.length}</p><p className="text-xs text-muted-foreground">shifts</p></div>
        <div className="px-3 py-2.5"><p className="text-[20px] font-semibold tabular">{names.length - excluded.size}</p><p className="text-xs text-muted-foreground">employees</p></div>
        <div className="flex flex-col justify-center px-3 py-2.5"><p className="text-[13px] font-semibold tabular">{dates.length > 0 ? `${app.date(dates[0])} – ${app.date(dates[dates.length - 1])}` : "—"}</p><p className="text-xs text-muted-foreground">dates</p></div>
      </div>
      <div className="max-h-[40dvh] divide-y divide-border/70 overflow-y-auto rounded-xl border border-border/80">
        {names.map((n) => {
          const list = byEmp.get(employeeKey(n)) ?? [];
          const off = excluded.has(employeeKey(n));
          return (
            <label key={n} className={cn("flex cursor-pointer items-center gap-3 px-3.5 py-2.5 text-[13px] transition-colors hover:bg-foreground/[0.02]", off && "opacity-50")}>
              <Checkbox checked={!off} onCheckedChange={(v) => { const s = new Set(excluded); v ? s.delete(employeeKey(n)) : s.add(employeeKey(n)); setExcluded(s); }} data-testid={`checkbox-import-${employeeKey(n)}`} />
              <span className="min-w-0 flex-1 truncate font-medium" title={n}>{n}</span>
              <span className="text-xs text-muted-foreground tabular whitespace-nowrap">{list.length} shift{list.length === 1 ? "" : "s"}</span>
            </label>
          );
        })}
      </div>
      {mode === "create" && (
        <div className="space-y-1.5"><Label>Timesheet name (optional)</Label><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={result.filename} data-testid="input-import-label" /></div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex flex-col-reverse gap-2 border-t border-border/70 pt-4 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onBack}>Back</Button>
        <Button
          disabled={busy || !kept.length}
          onClick={async () => { setBusy(true); setError(""); try { await onConfirm({ ...result, shifts: kept, label }); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } }}
          data-testid="button-import-confirm"
        >
          {busy && <Loader2 className="animate-spin" />} {mode === "append" ? "Add shifts" : "Create timesheet"}
        </Button>
      </div>
    </div>
  );
}
