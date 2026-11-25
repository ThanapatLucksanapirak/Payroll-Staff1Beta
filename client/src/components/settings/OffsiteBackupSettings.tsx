// Settings → Backup & history → Offsite copies: a folder (USB disk / network
// share) and/or an S3-compatible bucket that each backup is also copied to.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CloudUpload, FlaskConical, HardDrive, Loader2 } from "lucide-react";
import { api, errorMessage, queryClient } from "@/lib/api";
import { timeAgo } from "@/lib/doc";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Field, NumberInput, Section, ToggleRow } from "@/components/workspace/fields";

interface TargetStatus { lastSuccessAt: string | null; lastFailureAt: string | null; lastError: string | null; lastFile: string | null }
interface FolderCfg { enabled: boolean; path: string; keep: number }
interface S3Cfg { enabled: boolean; endpoint: string; region: string; bucket: string; prefix: string; accessKeyId: string; keep: number; hasSecret: boolean; secretHint: string }
export interface OffsiteInfo {
  config: { folder: FolderCfg; s3: S3Cfg };
  status: { folder: TargetStatus; s3: TargetStatus };
  failing: { target: "folder" | "s3"; error: string; since: string }[];
}
export const OFFSITE_KEY = ["/api/offsite"];

function StatusLine({ st, enabled }: { st: TargetStatus; enabled: boolean }) {
  if (!enabled) return null;
  const failed = st.lastFailureAt && (!st.lastSuccessAt || Date.parse(st.lastFailureAt) > Date.parse(st.lastSuccessAt));
  if (failed) {
    return <p className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger" role="alert" data-testid="text-offsite-failed"><AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" /><span>Last copy failed {timeAgo(st.lastFailureAt)}: {st.lastError}</span></p>;
  }
  if (st.lastSuccessAt) return <p className="flex items-center gap-2 text-xs text-muted-foreground"><CheckCircle2 className="h-3.5 w-3.5 text-success" />Last copied {timeAgo(st.lastSuccessAt)}</p>;
  return <p className="text-xs text-muted-foreground">No copy yet. The next backup will be copied here.</p>;
}

export function OffsiteBackupSettings() {
  const { toast } = useToast();
  const q = useQuery<OffsiteInfo>({ queryKey: OFFSITE_KEY });
  const [folder, setFolder] = useState<FolderCfg | null>(null);
  const [s3, setS3] = useState<(S3Cfg & { secretAccessKey: string }) | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!q.data) return;
    setFolder(q.data.config.folder);
    setS3({ ...q.data.config.s3, secretAccessKey: "" });
  }, [q.data]);

  if (q.isLoading || !folder || !s3) return <Section title="Offsite copies"><Skeleton className="h-40" /></Section>;
  if (q.error) return <Section title="Offsite copies"><p className="text-sm text-destructive">{errorMessage(q.error)}</p></Section>;
  const saved = q.data!.config;
  const s3Body = () => ({ enabled: s3.enabled, endpoint: s3.endpoint, region: s3.region, bucket: s3.bucket, prefix: s3.prefix, accessKeyId: s3.accessKeyId, keep: s3.keep, ...(s3.secretAccessKey ? { secretAccessKey: s3.secretAccessKey } : {}) });
  const plain = (c: S3Cfg) => [c.enabled, c.endpoint, c.region, c.bucket, c.prefix, c.accessKeyId, c.keep].join("|");
  const dirty = JSON.stringify(folder) !== JSON.stringify(saved.folder) || plain(s3) !== plain(saved.s3) || !!s3.secretAccessKey;

  const save = async () => {
    setBusy("save");
    try {
      const r = await api<OffsiteInfo>("PUT", "/api/offsite", { folder, s3: s3Body() });
      queryClient.setQueryData(OFFSITE_KEY, { ...q.data!, ...r });
      await queryClient.invalidateQueries({ queryKey: OFFSITE_KEY });
      toast({ title: "Saved", description: "Each backup will also be copied to the places that are on." });
    } catch (e) { toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" }); }
    finally { setBusy(null); }
  };

  const test = async (target: "folder" | "s3") => {
    setBusy(`test-${target}`);
    try {
      const r = await api<{ ok: boolean; message: string }>("POST", "/api/offsite/test", { target, folder, s3: s3Body() }, { timeoutMs: 60_000 });
      toast({ title: r.ok ? "It works" : "Test failed", description: r.message, variant: r.ok ? undefined : "destructive" });
    } catch (e) { toast({ title: "Test failed", description: errorMessage(e), variant: "destructive" }); }
    finally { setBusy(null); }
  };

  const runNow = async () => {
    setBusy("run");
    try {
      const r = await api<{ failing: OffsiteInfo["failing"] }>("POST", "/api/offsite/run", {}, { timeoutMs: 180_000 });
      await queryClient.invalidateQueries({ queryKey: OFFSITE_KEY });
      toast(r.failing.length ? { title: "Copy failed", description: r.failing.map((f) => f.error).join(" "), variant: "destructive" } : { title: "Copied the newest backup" });
    } catch (e) { toast({ title: "Copy failed", description: errorMessage(e), variant: "destructive" }); }
    finally { setBusy(null); }
  };

  const anyOn = saved.folder.enabled || saved.s3.enabled;
  return (
    <Section
      title="Offsite copies"
      description="If this computer fails, backups on it go too. Also copy each backup to a USB disk, a network share or cloud storage. Copies leave out passwords and keys."
      actions={anyOn && <Button size="sm" variant="outline" onClick={() => void runNow()} disabled={!!busy || dirty} data-testid="button-offsite-run">{busy === "run" ? <Loader2 className="animate-spin" /> : <CloudUpload />}Copy now</Button>}
    >
      <div className="space-y-6">
        <div className="space-y-3">
          <ToggleRow label={<span className="inline-flex items-center gap-2"><HardDrive className="h-4 w-4 text-muted-foreground" />Copy to a folder</span>} hint="A USB disk or network share mounted on the server." checked={folder.enabled} onChange={(v) => setFolder({ ...folder, enabled: v })} testid="switch-offsite-folder" />
          {folder.enabled && (
            <div className="grid gap-3 sm:grid-cols-[1fr_8rem] items-start">
              <Field label="Folder on the server" hint="For example /mnt/usb/payroll. It must already exist; the app never creates it, so an unplugged disk shows up as a failure."><Input value={folder.path} spellCheck={false} placeholder="/mnt/usb/payroll" onChange={(e) => setFolder({ ...folder, path: e.target.value })} data-testid="input-offsite-folder" /></Field>
              <Field label="Keep newest"><NumberInput step="1" min={1} value={folder.keep} onChange={(n) => setFolder({ ...folder, keep: Math.max(1, Math.min(365, Math.round(n) || 1)) })} /></Field>
            </div>
          )}
          {folder.enabled && (
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" variant="outline" onClick={() => void test("folder")} disabled={!!busy || !folder.path.trim()} data-testid="button-offsite-test-folder">{busy === "test-folder" ? <Loader2 className="animate-spin" /> : <FlaskConical />}Test</Button>
              <StatusLine st={q.data!.status.folder} enabled={saved.folder.enabled} />
            </div>
          )}
        </div>

        <div className="space-y-3">
          <ToggleRow label={<span className="inline-flex items-center gap-2"><CloudUpload className="h-4 w-4 text-muted-foreground" />Upload to cloud storage</span>} hint="Amazon S3, Backblaze B2, Cloudflare R2 or any S3-compatible service." checked={s3.enabled} onChange={(v) => setS3({ ...s3, enabled: v })} testid="switch-offsite-s3" />
          {s3.enabled && (
            <div className="grid gap-3 sm:grid-cols-2 items-start">
              <Field label="Endpoint" hint="Leave blank for Amazon S3. B2: https://s3.<region>.backblazeb2.com · R2: https://<account>.r2.cloudflarestorage.com" className="sm:col-span-2"><Input value={s3.endpoint} spellCheck={false} placeholder="https://s3.us-west-004.backblazeb2.com" onChange={(e) => setS3({ ...s3, endpoint: e.target.value })} /></Field>
              <Field label="Bucket"><Input value={s3.bucket} spellCheck={false} onChange={(e) => setS3({ ...s3, bucket: e.target.value })} data-testid="input-offsite-bucket" /></Field>
              <Field label="Region" hint={'e.g. us-west-004, or "auto" for R2'}><Input value={s3.region} spellCheck={false} onChange={(e) => setS3({ ...s3, region: e.target.value })} /></Field>
              <Field label="Access key ID"><Input value={s3.accessKeyId} spellCheck={false} autoComplete="off" onChange={(e) => setS3({ ...s3, accessKeyId: e.target.value })} /></Field>
              <Field label="Secret key" hint={s3.hasSecret ? `Saved (ends ${s3.secretHint.replace("…", "")}). Leave blank to keep it.` : "Use a key that can only write to this bucket."}><Input type="password" autoComplete="new-password" value={s3.secretAccessKey} placeholder={s3.hasSecret ? "••••••••" : ""} onChange={(e) => setS3({ ...s3, secretAccessKey: e.target.value })} /></Field>
              <Field label="Folder in the bucket"><Input value={s3.prefix} spellCheck={false} onChange={(e) => setS3({ ...s3, prefix: e.target.value })} /></Field>
              <Field label="Keep newest"><NumberInput step="1" min={1} value={s3.keep} onChange={(n) => setS3({ ...s3, keep: Math.max(1, Math.min(365, Math.round(n) || 1)) })} /></Field>
            </div>
          )}
          {s3.enabled && (
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" variant="outline" onClick={() => void test("s3")} disabled={!!busy || !s3.bucket} data-testid="button-offsite-test-s3">{busy === "test-s3" ? <Loader2 className="animate-spin" /> : <FlaskConical />}Test</Button>
              <StatusLine st={q.data!.status.s3} enabled={saved.s3.enabled} />
            </div>
          )}
        </div>

        {(!folder.enabled && saved.folder.enabled) || (!s3.enabled && saved.s3.enabled) || folder.enabled || s3.enabled ? (
          <Button onClick={() => void save()} disabled={!!busy || !dirty} data-testid="button-offsite-save">{busy === "save" && <Loader2 className="animate-spin" />}Save</Button>
        ) : null}
      </div>
    </Section>
  );
}
