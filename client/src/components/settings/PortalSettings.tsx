import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, ExternalLink, Loader2, Smartphone } from "lucide-react";
import type { Site } from "@shared/schema";
import type { PortalSettings } from "@shared/portal";
import { api, errorMessage, queryClient } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { UnsavedDot, usePendingChange } from "./pendingChanges";

/** Settings → Locations → Time clock: the employee portal (/me) on or off for this location. Saved with the page's Save changes button. */
export function PortalSettingsCard({ site }: { site: Site }) {
  const { toast } = useToast();
  const key = ["/api/sites", site.id, "portal"];
  const q = useQuery<PortalSettings>({ queryKey: key });
  const [busy, setBusy] = useState(false);
  const savedOn = !!q.data?.enabled;
  const [on, setOn] = useState(savedOn);
  useEffect(() => setOn(savedOn), [savedOn]);
  const dirty = !!q.data && on !== savedOn;
  const url = `${window.location.origin}/me`;

  const persist = async () => {
    const next = await api<PortalSettings>("PUT", `/api/sites/${site.id}/portal`, { enabled: on });
    queryClient.setQueryData(key, next);
  };
  const inPage = usePendingChange(`portal:${site.id}`, dirty, { label: on ? "Turn on the employee portal" : "Turn off the employee portal", save: persist, discard: () => setOn(savedOn) });
  const set = async (enabled: boolean) => {
    setOn(enabled);
    if (inPage) return; // saved with the page
    setBusy(true);
    try {
      const next = await api<PortalSettings>("PUT", `/api/sites/${site.id}/portal`, { enabled });
      queryClient.setQueryData(key, next);
      toast({ title: enabled ? "Employee portal is on" : "Employee portal is off" });
    } catch (e) { setOn(savedOn); toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" }); } finally { setBusy(false); }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(url); toast({ title: "Link copied" }); } catch { toast({ title: url }); }
  };

  return (
    <div className="space-y-3 border-t border-border/70 pt-4" data-testid="settings-employee-portal">
      <div className="flex items-start gap-3">
        <Smartphone className="mt-0.5 h-4 w-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[13px] font-semibold">Employee portal {q.isLoading ? null : savedOn ? <Badge variant="success">On</Badge> : <Badge variant="secondary">Off</Badge>} <UnsavedDot show={dirty} /></p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Staff see their own hours, pay statements, published schedule and time off on their phone, and can ask for time off. They sign in with their name and time clock PIN. People without a PIN can't sign in.
          </p>
        </div>
        {q.error ? <span className="text-xs text-destructive">{errorMessage(q.error)}</span> : q.data ? (
          <span className="flex items-center gap-2">
            {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            <Switch checked={on} disabled={busy} onCheckedChange={(v) => void set(v)} aria-label="Employee portal" data-testid="switch-employee-portal" />
          </span>
        ) : <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>
      {dirty && !on && <p className="text-xs text-muted-foreground">When you save, everyone signed in to the portal here is signed out.</p>}
      {savedOn && on && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-foreground/[0.04] px-3.5 py-2.5">
          <span className="min-w-0 grow basis-full truncate text-[13px] font-medium tabular sm:basis-0" data-testid="text-portal-url">{url}</span>
          <Button variant="outline" size="sm" onClick={copy}><Copy />Copy link</Button>
          <Button asChild variant="ghost" size="sm"><a href="/me" target="_blank" rel="noreferrer"><ExternalLink />Open</a></Button>
        </div>
      )}
    </div>
  );
}
