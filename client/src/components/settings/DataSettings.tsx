import { useRef, useState } from "react";
import { Download, Loader2, Upload } from "lucide-react";
import { useApp } from "@/context/AppData";
import { api, errorMessage, queryClient } from "@/lib/api";
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
    if (!(await confirm({ title: "Restore this backup?", description: `${n} timesheets and ${data.settings?.length ?? 0} settings will be written. Timesheets with the same ID are replaced; others are kept.`, confirmLabel: "Restore" }))) return;
    setBusy("restore");
    try {
      const r = await api<{ settings: number; timesheets: number }>("POST", "/api/backup/restore", data);
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
      <Section title="Keep history" description="Automatically remove the oldest timesheets per location when there are more than this many. 0 keeps everything.">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Timesheets per location" className="w-48"><NumberInput step="1" value={keep} onChange={(n) => setKeep(Math.max(0, Math.round(n)))} data-testid="input-retention" /></Field>
          <Button variant="outline" className="mb-0.5" disabled={keep === app.prefs.retentionPerSite} onClick={async () => {
            if (keep > 0 && !(await confirm({ title: `Keep only ${keep} timesheets per location?`, description: "Older ones are deleted the next time a timesheet is created there.", confirmLabel: "Save" }))) return;
            try { await api("PUT", "/api/prefs", { retentionPerSite: keep }); await app.refresh(); toast({ title: "Saved" }); } catch (e) { toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" }); }
          }}>Save</Button>
        </div>
      </Section>
    </div>
  );
}
