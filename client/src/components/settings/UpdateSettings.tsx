import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, RefreshCw, RotateCcw, XCircle } from "lucide-react";
import { api, errorMessage, queryClient } from "@/lib/api";
import { timeAgo } from "@/lib/doc";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Section } from "@/components/workspace/fields";

interface UpdateInfo {
  managed: boolean;
  version: string | null;
  autoUpdate: boolean;
  requested: boolean;
  status: { state: string; from?: string; to?: string; at?: string; message?: string } | null;
}

const KEY = ["/api/system/update"];
const short = (sha?: string | null) => (sha ? sha.slice(0, 7) : "unknown");

/** Settings → Software update: version, last result, and a one-click "Update now". */
export function UpdateSettings() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [asked, setAsked] = useState(false);
  const q = useQuery<UpdateInfo>({ queryKey: KEY, retry: false });
  const d = q.data;
  const running = !!d && (d.requested || d.status?.state === "checking" || d.status?.state === "updating");
  const waiting = asked || running;

  // While an update runs, check every few seconds. The app restarts near the
  // end, so a failed check just means "try again shortly".
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => { void queryClient.invalidateQueries({ queryKey: KEY }); }, 4000);
    return () => clearInterval(t);
  }, [waiting]);
  useEffect(() => {
    if (asked && d && !running && d.status?.at && Date.now() - Date.parse(d.status.at) < 10 * 60_000) setAsked(false);
  }, [asked, d, running]);

  const updateNow = async () => {
    if (!(await confirm({ title: "Update now?", description: "The app downloads the newest version, backs up your data first, and restarts. That takes a few minutes and signs nobody out. If the new version doesn't start, the current one is put back automatically.", confirmLabel: "Update now" }))) return;
    try {
      await api("POST", "/api/system/update");
      setAsked(true);
      await queryClient.invalidateQueries({ queryKey: KEY });
    } catch (e) { toast({ title: "Couldn't start the update", description: errorMessage(e), variant: "destructive" }); }
  };

  const st = d?.status;
  const result = !st || running ? null
    : st.state === "ok" ? { icon: <CheckCircle2 className="h-4 w-4 text-success" />, text: st.to && st.from !== st.to ? `Updated to ${short(st.to)}` : "Up to date" }
    : st.state === "rolled_back" ? { icon: <RotateCcw className="h-4 w-4 text-warning" />, text: "The newest version didn't start, so the previous one was put back. Your data was not changed." }
    : st.state === "failed" ? { icon: <XCircle className="h-4 w-4 text-destructive" />, text: st.message || "The last update didn't finish." }
    : null;

  return (
    <div className="space-y-5">
      <Section title="Updates" description="New versions come from the app's GitHub repository. Your data is backed up before every update.">
        {q.isLoading ? <Skeleton className="h-5 w-64 max-w-full rounded-md" /> : !d ? (
          <p className="text-[13px] text-muted-foreground">Update information isn't available right now.</p>
        ) : !d.managed ? (
          <p className="text-[13px] text-muted-foreground">This server wasn't set up with the Linux installer, so updates are done on the server itself (git pull, then rebuild). With the installer, an Update now button appears here.</p>
        ) : (
          <div className="space-y-4">
            <dl className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[13px]">
              <dt className="text-muted-foreground">Version</dt><dd className="font-mono" data-testid="text-version">{short(d.version)}</dd>
              <dt className="text-muted-foreground">Automatic updates</dt>
              <dd>{d.autoUpdate ? <Badge variant="success">On</Badge> : <Badge variant="secondary">Off</Badge>} <span className="text-xs text-muted-foreground">{d.autoUpdate ? "Checked every 10 minutes." : "Turn on with: sudo payroll auto-update on"}</span></dd>
              <dt className="text-muted-foreground">Last update</dt>
              <dd className="min-w-0">
                {running ? <span className="inline-flex items-center gap-1.5"><Loader2 className="h-4 w-4 animate-spin text-primary" /> Updating… the app may be unavailable for a minute.</span>
                  : result ? <span className="inline-flex items-start gap-1.5">{result.icon}<span>{result.text}{st?.at ? <span className="text-muted-foreground"> · {timeAgo(st.at)}</span> : null}</span></span>
                  : <span className="text-muted-foreground">Never</span>}
              </dd>
            </dl>
            <Button onClick={updateNow} disabled={waiting} data-testid="button-update-now">{waiting ? <Loader2 className="animate-spin" /> : <RefreshCw />} {waiting ? "Updating…" : "Update now"}</Button>
          </div>
        )}
      </Section>
    </div>
  );
}
