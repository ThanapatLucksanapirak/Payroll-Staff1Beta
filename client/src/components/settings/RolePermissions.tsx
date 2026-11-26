// Settings → Users → Roles: what Managers and Viewers can see and do.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import {
  type LimitedRole, type Permission, type PermissionInfo, type RolePermissions, LIMITED_ROLES, PERMISSIONS, PERMISSION_INFO,
} from "@shared/permissions";
import { useApp } from "@/context/AppData";
import { api, errorMessage, queryClient } from "@/lib/api";
import { ROLE_LABELS } from "@/lib/roles";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Section } from "@/components/workspace/fields";

interface PermissionsResponse { roles: RolePermissions; defaults: RolePermissions; info: Record<Permission, PermissionInfo> }
const KEY = ["/api/permissions"];

export function RolePermissionsPanel() {
  const app = useApp();
  const { toast } = useToast();
  const q = useQuery<PermissionsResponse>({ queryKey: KEY });
  const [busy, setBusy] = useState<string | null>(null);
  const roles = q.data?.roles;
  const isDefault = !!q.data && JSON.stringify(q.data.roles) === JSON.stringify(q.data.defaults);

  const save = async (role: LimitedRole, perm: Permission, value: boolean) => {
    setBusy(`${role}:${perm}`);
    try {
      const r = await api<{ roles: RolePermissions }>("PUT", "/api/permissions", { [role]: { [perm]: value } });
      queryClient.setQueryData(KEY, { ...q.data!, roles: r.roles });
      await app.refresh();
    } catch (e) {
      toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" });
    } finally { setBusy(null); }
  };

  const reset = async () => {
    setBusy("reset");
    try {
      const r = await api<{ roles: RolePermissions }>("POST", "/api/permissions/reset", {});
      queryClient.setQueryData(KEY, { ...q.data!, roles: r.roles });
      toast({ title: "Roles reset to the standard settings" });
    } catch (e) {
      toast({ title: "Couldn't reset", description: errorMessage(e), variant: "destructive" });
    } finally { setBusy(null); }
  };

  return (
    <Section
      title="Roles"
      description="Owners and administrators can do everything. Accountants only see payroll you publish (read only). Choose what managers and viewers can see and do. Changes apply straight away."
      actions={!isDefault && q.data && <Button size="sm" variant="ghost" onClick={() => void reset()} disabled={!!busy}>{busy === "reset" && <Loader2 className="animate-spin" />}Reset to standard</Button>}
    >
      {q.isLoading ? <Skeleton className="h-64" /> : q.error || !roles ? (
        <p className="text-sm text-destructive">{errorMessage(q.error)}</p>
      ) : (
        <div className="-mx-5">
          <table className="w-full text-sm max-sm:block" data-testid="table-role-permissions">
            <thead>
              <tr className="border-b border-border/70 text-left text-xs text-muted-foreground max-sm:hidden">
                <th className="px-5 py-2 font-medium">Permission</th>
                <th className="w-24 px-2 py-2 text-center font-medium leading-tight">Owner &amp; Admin</th>
                {LIMITED_ROLES.map((r) => <th key={r} className="w-24 px-2 py-2 text-center font-medium">{ROLE_LABELS[r]}</th>)}
              </tr>
            </thead>
            <tbody className="max-sm:block">
              {PERMISSIONS.map((p) => {
                const info = PERMISSION_INFO[p];
                return (
                  <tr key={p} className="border-b border-border/60 last:border-0 max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-5 max-sm:px-5 max-sm:py-3">
                    <td className="px-5 py-2.5 max-sm:w-full max-sm:p-0 max-sm:pb-2.5">
                      <p className="text-[13px] font-medium">{info.label}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{info.help}{info.requires ? ` Needs “${info.requires.map((x) => PERMISSION_INFO[x].label).join(", ")}”.` : ""}</p>
                    </td>
                    <td className="px-2 py-2.5 text-center max-sm:hidden"><Check className="mx-auto h-4 w-4 text-muted-foreground" aria-label="Always" /></td>
                    {LIMITED_ROLES.map((r) => {
                      const blocked = info.requires?.some((x) => !roles[r][x]) ?? false;
                      return (
                        <td key={r} className="px-2 py-2.5 text-center max-sm:flex max-sm:items-center max-sm:gap-2 max-sm:p-0">
                          <span className="text-xs text-muted-foreground sm:hidden" aria-hidden>{ROLE_LABELS[r]}</span>
                          <Switch
                            checked={roles[r][p]}
                            disabled={blocked || !!busy}
                            onCheckedChange={(v) => void save(r, p, v)}
                            aria-label={`${ROLE_LABELS[r]}: ${info.label}`}
                            data-testid={`switch-perm-${r}-${p}`}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
