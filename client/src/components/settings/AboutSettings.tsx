import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowUpRight, CheckCircle2, ChevronRight, Loader2, RotateCcw, XCircle } from "lucide-react";
import { timeAgo } from "@/lib/doc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/workspace/fields";
import { cn } from "@/lib/utils";

interface Change { sha?: string; date: string | null; title: string; pr: number | null; notes: string[] }

interface AboutInfo {
  appVersion: string | null;
  version: string | null;
  committedAt: string | null;
  installedAt: string | null;
  runningSince: string | null;
  previousVersion: string | null;
  managed: boolean;
  autoUpdate: boolean;
  status: { state: string; from?: string; to?: string; at?: string; message?: string } | null;
  repoUrl: string | null;
  historySource: string | null;
  history: Change[];
  changelog: Change[];
}

const short = (sha?: string | null) => (sha ? sha.slice(0, 7) : "unknown");
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.slice(0, 7) === b.slice(0, 7);

function when(iso: string | null | undefined, withTime = true) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // A bare date (CHANGELOG.md) is a calendar day, not midnight UTC.
  const day = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : d;
  return day.toLocaleString(undefined, withTime && !/^\d{4}-\d{2}-\d{2}$/.test(iso)
    ? { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", year: "numeric" });
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function lastCheck(d: AboutInfo) {
  const st = d.status;
  if (!st) return <span className="text-muted-foreground">Not yet</span>;
  const ago = st.at ? <span className="text-muted-foreground"> · {timeAgo(st.at)}</span> : null;
  if (st.state === "checking" || st.state === "updating") return <span className="inline-flex items-center gap-1.5"><Loader2 className="h-4 w-4 animate-spin text-primary" /> Updating now…</span>;
  if (st.state === "ok") return <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4 text-success" />{st.from && st.to && st.from !== st.to ? `Updated to ${short(st.to)}` : "Up to date"}{ago}</span>;
  if (st.state === "rolled_back") return <span className="inline-flex items-start gap-1.5"><RotateCcw className="mt-0.5 h-4 w-4 shrink-0 text-warning" /><span>A newer version didn't start, so this one was kept{ago}</span></span>;
  if (st.state === "failed") return <span className="inline-flex items-start gap-1.5"><XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /><span>{st.message || "The last update didn't finish."}{ago}</span></span>;
  return <span className="text-muted-foreground">{st.state}{ago}</span>;
}

/** A changelog bullet; `backticks` become inline code. */
function Note({ text }: { text: string }) {
  return <>{text.split(/(`[^`]+`)/).map((part, i) => part.length > 2 && part.startsWith("`") && part.endsWith("`")
    ? <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[12px]">{part.slice(1, -1)}</code>
    : part)}</>;
}

function ChangeItem({ c, repoUrl, installed, isNew, last }: { c: Change; repoUrl: string | null; installed: boolean; isNew: boolean; last: boolean }) {
  const ref = c.pr != null
    ? { label: `#${c.pr}`, href: repoUrl ? `${repoUrl}/pull/${c.pr}` : null }
    : c.sha ? { label: short(c.sha), href: repoUrl ? `${repoUrl}/commit/${c.sha}` : null } : null;
  return (
    <li className="relative flex gap-3 pb-5 last:pb-0" data-testid={`about-change-${c.pr ?? c.sha ?? c.title}`}>
      {/* timeline rail */}
      {!last && <span className="absolute left-[5px] top-4 h-full w-px bg-border" aria-hidden />}
      <span className={cn("relative mt-[5px] h-[11px] w-[11px] shrink-0 rounded-full border-2", installed ? "border-primary bg-primary" : "border-border bg-card")} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[14px] font-semibold leading-5">{c.title}</span>
          {installed && <Badge variant="solid">Installed</Badge>}
          {isNew && !installed && <Badge variant="success">New</Badge>}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {c.date && <span>{when(c.date, false)}</span>}
          {ref && (ref.href
            ? <a href={ref.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-mono hover:text-foreground hover:underline">{ref.label}<ArrowUpRight className="h-3 w-3" /></a>
            : <span className="font-mono">{ref.label}</span>)}
        </div>
        {c.notes.length > 0 && (
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[13px] leading-snug text-foreground/85 marker:text-muted-foreground/60">
            {c.notes.map((n, i) => <li key={i}><Note text={n} /></li>)}
          </ul>
        )}
      </div>
    </li>
  );
}

const PAGE = 8;

/** Settings → About: what's installed on this server, and the history of updates. */
export function AboutSettings() {
  const q = useQuery<AboutInfo>({ queryKey: ["/api/system/about"], retry: false, refetchInterval: 60_000 });
  const [all, setAll] = useState(false);
  const d = q.data;

  if (q.isLoading) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  if (!d) return <p className="text-[13px] text-muted-foreground">Version information isn't available right now.</p>;

  const list: Change[] = d.history.length ? [...d.history, ...d.changelog] : d.changelog;
  const prevIdx = d.history.findIndex((c) => same(c.sha, d.previousVersion));
  const shown = all ? list : list.slice(0, PAGE);
  const commitHref = d.repoUrl && d.version ? `${d.repoUrl}/commit/${d.version}` : null;

  return (
    <div className="space-y-5">
      <Section
        title="This server"
        description={d.managed
          ? `The app checks GitHub for a newer version${d.autoUpdate ? " every 10 minutes" : " when you press Update now"} and installs it after backing up your data.`
          : "This server wasn't set up with the Linux installer, so it updates when someone pulls and rebuilds it."}
        actions={<Button asChild variant="outline" size="sm"><Link href="/settings/updates" data-testid="link-about-updates">Software update<ChevronRight /></Link></Button>}
      >
        <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 sm:grid-cols-[9.5rem_minmax(0,1fr)] text-[13px]">
          <Row label="Version">
            <span className="font-medium">Payroll Admin {d.appVersion ?? ""}</span>{" "}
            <span className="text-muted-foreground">· build </span>
            {commitHref
              ? <a href={commitHref} target="_blank" rel="noreferrer" className="font-mono hover:underline" data-testid="text-about-version">{short(d.version)}</a>
              : <span className="font-mono" data-testid="text-about-version">{short(d.version)}</span>}
          </Row>
          {d.committedAt && <Row label="Released">{when(d.committedAt)}</Row>}
          <Row label="Installed on this server">
            {d.installedAt ? <>{when(d.installedAt)} <span className="text-muted-foreground">· {timeAgo(d.installedAt)}</span></> : <span className="text-muted-foreground">Unknown</span>}
          </Row>
          {d.managed && <Row label="Last check">{lastCheck(d)}</Row>}
          {d.managed && (
            <Row label="Automatic updates">
              {d.autoUpdate ? <Badge variant="success">On</Badge> : <Badge variant="secondary">Off</Badge>}{" "}
              <span className="text-xs text-muted-foreground">{d.autoUpdate ? "Every 10 minutes from the main branch." : "Turn on with: sudo payroll auto-update on"}</span>
            </Row>
          )}
          {d.previousVersion && !same(d.previousVersion, d.version) && (
            <Row label="Previous version">
              <span className="font-mono">{short(d.previousVersion)}</span>{" "}
              <span className="text-xs text-muted-foreground">Kept so you can go back with: sudo payroll rollback</span>
            </Row>
          )}
          {d.runningSince && <Row label="Running since">{when(d.runningSince)}</Row>}
        </dl>
      </Section>

      <Section title="Version history" description="Every update to the app, newest first. The top one is what this server is running.">
        {list.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No version history is available on this server yet. It appears after the next update.</p>
        ) : (
          <>
            <ol className="pt-1" data-testid="list-about-history">
              {shown.map((c, i) => (
                <ChangeItem
                  key={`${c.sha ?? ""}-${c.pr ?? ""}-${i}`}
                  c={c}
                  repoUrl={d.repoUrl}
                  installed={i === 0 && d.history.length > 0}
                  isNew={prevIdx > 0 && i < prevIdx}
                  last={i === shown.length - 1}
                />
              ))}
            </ol>
            {list.length > PAGE && (
              <Button variant="ghost" size="sm" className="mt-3" onClick={() => setAll(!all)} data-testid="button-about-all">
                {all ? "Show fewer" : `Show all ${list.length} updates`}
              </Button>
            )}
          </>
        )}
      </Section>
    </div>
  );
}
