import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, MoonStar } from "lucide-react";
import type { Site } from "@shared/schema";
import type { AutoCloseConfig } from "@shared/punchIssues";
import { inputToMinutes, minutesToInput } from "@shared/dates";
import { api, errorMessage, queryClient } from "@/lib/api";
import { type AutoCloseData, invalidateTimeclock, tcKeys } from "@/lib/timeclock";
import { timeAgo } from "@/lib/doc";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { NumberInput } from "@/components/workspace/fields";
import { UnsavedDot, usePendingChange } from "@/components/settings/pendingChanges";

/** Settings → Locations → Time clock: close shifts people forgot to clock out of. Saved with the page's Save changes button. */
export function AutoClockOutSettings({ site }: { site: Site }) {
  const { toast } = useToast();
  const q = useQuery<AutoCloseData>({ queryKey: tcKeys.autoClose(site.id) });
  const [cfg, setCfg] = useState<AutoCloseConfig | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) setCfg(q.data.config); }, [q.data]);
  const saved = q.data?.config;
  const dirty = !!cfg && !!saved && (cfg.cutoffMinutes !== saved.cutoffMinutes || cfg.maxShiftHours !== saved.maxShiftHours);
  const on = !!saved && (saved.cutoffMinutes != null || saved.maxShiftHours > 0);

  const persist = async () => {
    if (!cfg) return;
    const r = await api<{ config: AutoCloseConfig; closed: number }>("PUT", `/api/sites/${site.id}/timeclock/auto-close`, cfg);
    await queryClient.invalidateQueries({ queryKey: tcKeys.autoClose(site.id) });
    await invalidateTimeclock(site.id);
    if (r.closed) toast({ title: "Auto clock-out saved", description: `${r.closed} forgotten shift${r.closed === 1 ? " was" : "s were"} closed. Review them in Live → Fix punches.` });
  };
  const discard = () => { if (saved) setCfg(saved); };
  const inPage = usePendingChange(`auto-close:${site.id}`, dirty, { label: "Auto clock-out", save: persist, discard });
  const save = async () => {
    setBusy(true);
    try { await persist(); toast({ title: "Auto clock-out saved" }); } catch (e) { toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" }); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3 rounded-xl border border-border/80 p-3" data-testid="settings-auto-clock-out">
      <div className="flex items-start gap-3">
        <MoonStar className="mt-0.5 h-4 w-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[13px] font-semibold">Auto clock-out {q.isLoading ? null : on ? <Badge variant="success">On</Badge> : <Badge variant="secondary">Off</Badge>} <UnsavedDot show={dirty} /></p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Closes shifts people forgot to clock out of, at the time you set (not when it's noticed). Each one is marked “Auto-closed” for you to check in Live → Fix punches.
            {q.data?.lastRun && <> Last checked {timeAgo(q.data.lastRun.at)}.</>}
          </p>
        </div>
      </div>
      {!cfg ? (
        q.error ? <p className="text-xs text-destructive">{errorMessage(q.error)}</p> : <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/80 px-3.5 py-2.5">
            <label htmlFor="auto-close-time" className="min-w-0">
              <span className="block text-[13px] font-medium">Close open shifts at</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">Local time ({site.rules.timezone}), e.g. 2:00 AM after closing.</span>
            </label>
            <div className="flex items-center gap-2">
              {cfg.cutoffMinutes != null && (
                <Input id="auto-close-time" type="time" className="w-32 tabular" value={minutesToInput(cfg.cutoffMinutes)} onChange={(e) => { const m = inputToMinutes(e.target.value); if (m != null) setCfg({ ...cfg, cutoffMinutes: m % 1440 }); }} data-testid="input-auto-close-time" />
              )}
              <Switch checked={cfg.cutoffMinutes != null} onCheckedChange={(v) => setCfg({ ...cfg, cutoffMinutes: v ? (saved?.cutoffMinutes ?? 120) : null })} aria-label="Close open shifts at a set time" data-testid="switch-auto-close-time" />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/80 px-3.5 py-2.5">
            <span className="min-w-0">
              <span className="block text-[13px] font-medium">Longest possible shift</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">A safety net: close any shift open longer than this. 0 = off.</span>
            </span>
            <div className="flex items-center gap-2">
              <NumberInput className="w-20" step="0.5" value={cfg.maxShiftHours} onChange={(n) => setCfg({ ...cfg, maxShiftHours: Math.min(48, n) })} aria-label="Longest possible shift in hours" data-testid="input-max-shift-hours" />
              <span className="text-[13px] text-muted-foreground">hours</span>
            </div>
          </div>
          {dirty && !inPage && (
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCfg(saved!)}>Cancel</Button>
              <Button size="sm" onClick={save} disabled={busy} data-testid="button-save-auto-close">{busy && <Loader2 className="animate-spin" />}Save auto clock-out</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
