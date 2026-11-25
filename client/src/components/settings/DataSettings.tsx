import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Archive, Download, Loader2, RotateCcw, Upload } from "lucide-react";
import { useApp } from "@/context/AppData";
import { api, apiRequest, errorMessage, queryClient } from "@/lib/api";
import { timeAgo } from "@/lib/doc";
import { downloadBlob } from "@/lib/doc";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, NumberInput, Section } from "@/components/workspace/fields";

export function DataSettings() {
  const app = useApp();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [secrets, setSecrets] = useState(false);
  const [busy, setBusy] = useState<"backup" | "restore" | null>(null);
  const [keep, setKeep] = useState(app.prefs.retentionPerSite);
  const file = useRef<HTMLInputElement>(null);

  const backup = async () => {
    setBusy("backup");
    try {
      const data = await api("GET", `/api/backup?secrets=${secrets ? 1 : 0}`);
      downloadBlob(JSON.stringify(data, null, 2), `payroll-backup-${new Date().toISOString().slice(0, 10)}.json`, "application/json");
    } catch (e) { toast({ title: "Backup failed", description: errorMessage(e), variant: "destructive" }); }
    finally { setBusy(null); }
  };

  const restore = async (f: File) => {
    let data: any;
    try { data = JSON.parse(await f.text()); } catch { toast({ title: "That file isn't a valid backup", variant: "destructive" }); return; }
    if (data?.app !== "payroll-admin") { toast({ title: "That file isn't a Payroll Admin backup", variant: "destructive" }); return; }
    const n = Array.isArray(data.timesheets) ? data.timesheets.length : 0;
    if (!(await confirm({ title: "Restore this backup?", description: `${n} timesheets and ${data.settings?.length ?? 0} settings will be written. Timesheets with the same ID are replaced; others are kept. A backup of the current data is taken first, and your current password is kept.`, confirmLabel: "Restore" }))) return;
    setBusy("restore");
    try {
      const r = await api<{ settings: number; timesheets: number }>("POST", "/api/backup/restore", data, { timeoutMs: 180_000 });
      await queryClient.invalidateQueries();
      toast({ title: "Backup restored", description: `${r.timesheets} timesheets, ${r.settings} settings.` });
    } catch (e) { toast({ title: "Restore failed", description: errorMessage(e), variant: "destructive" }); }
    finally { setBusy(null); }
  };

  return (
    <div className="space-y-4">
      <Section title="Backup" description="Download everything as one JSON file — timesheets, locations, categories, rates and preferences.">
        <div className="flex flex-wrap items-center gap-4">
          <Button onClick={backup} disabled={!!busy} data-testid="button-backup">{busy === "backup" ? <Loader2 className="animate-spin" /> : <Download />} Download backup</Button>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={secrets} onCheckedChange={(v) => setSecrets(!!v)} />Include password and Square tokens</label>
        </div>
      </Section>
      <Section title="Restore" description="Load a backup file into the current database.">
        <input ref={file} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void restore(f); }} />
        <Button variant="outline" onClick={() => file.current?.click()} disabled={!!busy} data-testid="button-restore">{busy === "restore" ? <Loader2 className="animate-spin" /> : <Upload />} Choose backup file</Button>
      </Section>
      <ServerBackups />
      <Section title="Keep history" description="When a location has more than this many draft timesheets, the oldest move to the Trash (kept 30 days). Finalized timesheets are never moved. 0 keeps everything.">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Timesheets per location" className="w-48"><NumberInput step="1" value={keep} onChange={(n) => setKeep(Math.max(0, Math.round(n)))} data-testid="input-retention" /></Field>
          <Button variant="outline" className="mb-0.5" disabled={keep === app.prefs.retentionPerSite} onClick={async () => {
            if (keep > 0 && !(await confirm({ title: `Keep only ${keep} timesheets per location?`, description: "Older drafts move to the Trash the next time a timesheet is created there.", confirmLabel: "Save" }))) return;
            try { await api("PUT", "/api/prefs", { retentionPerSite: keep }); await app.refresh(); toast({ title: "Saved" }); } catch (e) { toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" }); }
          }}>Save</Button>
        </div>
      </Section>
    </div>
  );
}

interface BackupFile { name: string; size: number; createdAt: string; kind: "export" | "database"; reason: string }

function ServerBackups() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const list = useQuery<BackupFile[]>({ queryKey: ["/api/backups"] });
  const exports = (list.data ?? []).filter((b) => b.kind === "export");
  const size = (n: number) => (n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const label = (r: string) => (r === "auto" ? "Daily" : r === "manual" ? "Manual" : r === "pre-restore" ? "Before restore" : r);

  const runNow = async () => {
    setBusy("run");
    try { await api("POST", "/api/backups", undefined, { timeoutMs: 120_000 }); await list.refetch(); toast({ title: "Backup saved on the server" }); }
    catch (e) { toast({ title: "Backup failed", description: errorMessage(e), variant: "destructive" }); }
    finally { setBusy(null); }
  };
  const download = async (b: BackupFile) => {
    setBusy(b.name);
    try {
      const res = await apiRequest("GET", `/api/backups/${encodeURIComponent(b.name)}`, undefined, { timeoutMs: 120_000 });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = b.name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { toast({ title: "Download failed", description: errorMessage(e), variant: "destructive" }); }
    finally { setBusy(null); }
  };
  const restore = async (b: BackupFile) => {
    const ok = await confirm({ title: "Restore this backup?", description: `Data from ${new Date(b.createdAt).toLocaleString()} will be written back. A backup of the current data is taken first, and your current password is kept.`, confirmLabel: "Restore" });
    if (!ok) return;
    setBusy(b.name);
    try {
      const r = await api<{ settings: number; timesheets: number }>("POST", `/api/backups/${encodeURIComponent(b.name)}/restore`, undefined, { timeoutMs: 180_000 });
      await queryClient.invalidateQueries();
      toast({ title: "Backup restored", description: `${r.timesheets} timesheets, ${r.settings} settings.` });
    } catch (e) { toast({ title: "Restore failed", description: errorMessage(e), variant: "destructive" }); }
    finally { setBusy(null); }
  };

  return (
    <Section title="Automatic backups" description="The server saves a full backup every day and keeps the last 30. They are stored in the app's data folder on the server.">
      <div className="space-y-3">
        <Button variant="outline" onClick={runNow} disabled={!!busy} data-testid="button-backup-now">{busy === "run" ? <Loader2 className="animate-spin" /> : <Archive />} Back up now</Button>
        {list.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : exports.length === 0 ? (
          <p className="text-sm text-muted-foreground">No server backups yet. The first one is made a minute after the app starts.</p>
        ) : (
          <ul className="divide-y rounded-lg border max-h-72 overflow-y-auto" data-testid="list-backups">
            {exports.map((b) => (
              <li key={b.name} className="flex items-center gap-3 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{new Date(b.createdAt).toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">{label(b.reason)} · {size(b.size)} · {timeAgo(b.createdAt)}</p>
                </div>
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Download" disabled={!!busy} onClick={() => download(b)}>{busy === b.name ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}</Button>
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => restore(b)}><RotateCcw className="h-3.5 w-3.5" />Restore</Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
