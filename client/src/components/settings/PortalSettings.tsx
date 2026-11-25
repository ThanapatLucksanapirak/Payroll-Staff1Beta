import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, ExternalLink, Loader2, Smartphone } from "lucide-react";
import type { Site } from "@shared/schema";
import type { PortalSettings } from "@shared/portal";
import { api, errorMessage, queryClient } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

/** Settings → Locations → Time clock: the employee portal (/me) on or off for this location. Saved right away. */
export function PortalSettingsCard({ site }: { site: Site }) {
  const { toast } = useToast();
  const key = ["/api/sites", site.id, "portal"];
  const q = useQuery<PortalSettings>({ queryKey: key });
  const [busy, setBusy] = useState(false);
  const on = !!q.data?.enabled;
  const url = `${window.location.origin}/me`;

  const set = async (enabled: boolean) => {
    setBusy(true);
    try {
      const next = await api<PortalSettings>("PUT", `/api/sites/${site.id}/portal`, { enabled });
      queryClient.setQueryData(key, next);
      toast({ title: enabled ? "Employee portal is on" : "Employee portal is off", description: enabled ? "Staff can sign in with their name and time clock PIN." : "Everyone signed in to the portal here is signed out." });
    } catch (e) { toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" }); } finally { setBusy(false); }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(url); toast({ title: "Link copied" }); } catch { toast({ title: url }); }
  };

  return (
    <div className="space-y-3 rounded-xl border border-border/80 p-3" data-testid="settings-employee-portal">
      <div className="flex items-start gap-3">
        <Smartphone className="mt-0.5 h-4 w-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[13px] font-semibold">Employee portal {q.isLoading ? null : on ? <Badge variant="success">On</Badge> : <Badge variant="secondary">Off</Badge>}</p>
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
      {on && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/80 px-3.5 py-2.5">
          <span className="min-w-0 grow basis-full truncate text-[13px] font-medium tabular sm:basis-0" data-testid="text-portal-url">{url}</span>
          <Button variant="outline" size="sm" onClick={copy}><Copy />Copy link</Button>
          <Button asChild variant="ghost" size="sm"><a href="/me" target="_blank" rel="noreferrer"><ExternalLink />Open</a></Button>
        </div>
      )}
    </div>
  );
}
