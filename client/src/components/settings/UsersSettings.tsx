import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, Loader2, ShieldOff, MoreHorizontal, MonitorSmartphone, Pencil, Plus, Trash2, UserX, UserCheck } from "lucide-react";
import { useApp } from "@/context/AppData";
import { api, errorMessage, queryClient } from "@/lib/api";
import { type Role, type SessionUser, ROLE_HELP, ROLE_LABELS } from "@/lib/roles";
import { timeAgo } from "@/lib/doc";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, Section } from "@/components/workspace/fields";
import { SiteDot } from "@/components/AppShell";
import { RolePermissionsPanel } from "@/components/settings/RolePermissions";

const MIN = 8;
const KEY = ["/api/users"];

export function UsersSettings() {
  const app = useApp();
  const me = app.user;
  const { toast } = useToast();
  const confirm = useConfirm();
  const list = useQuery<SessionUser[]>({ queryKey: KEY });
  const [editing, setEditing] = useState<SessionUser | "new" | null>(null);
  const [resetting, setResetting] = useState<SessionUser | null>(null);
  const users = list.data ?? [];
  const activeOwners = users.filter((u) => u.role === "owner" && u.active).length;
  const refresh = () => queryClient.invalidateQueries({ queryKey: KEY });

  /** Owners can manage everyone; administrators everyone but owners. */
  const canManage = (u: SessionUser) => me.role === "owner" || u.role !== "owner";
  const isLastOwner = (u: SessionUser) => u.role === "owner" && u.active && activeOwners <= 1;

  const run = async (title: string, fn: () => Promise<unknown>) => {
    try { await fn(); await refresh(); toast({ title }); } catch (e) { toast({ title: "Something went wrong", description: errorMessage(e), variant: "destructive" }); }
  };

  const remove = async (u: SessionUser) => {
    const ok = await confirm({ title: `Delete ${u.displayName || u.username}?`, description: "They won't be able to sign in any more. Their past activity stays in the activity log. This can't be undone.", confirmLabel: "Delete user", destructive: true });
    if (ok) await run("User deleted", () => api("DELETE", `/api/users/${u.id}`));
  };
  const toggleActive = async (u: SessionUser) => {
    if (u.active) {
      const ok = await confirm({ title: `Deactivate ${u.displayName || u.username}?`, description: "They'll be signed out everywhere and can't sign in until you activate the account again.", confirmLabel: "Deactivate" });
      if (!ok) return;
    }
    await run(u.active ? "User deactivated" : "User activated", () => api("PATCH", `/api/users/${u.id}`, { active: !u.active }));
  };
  const resetTwoFactor = async (u: SessionUser) => {
    const ok = await confirm({ title: `Reset two-factor for ${u.displayName || u.username}?`, description: "Use this if they lost their phone. They'll sign in with just their password and can set up two-factor again.", confirmLabel: "Reset two-factor" });
    if (ok) await run("Two-factor reset", () => api("POST", `/api/users/${u.id}/2fa/reset`));
  };
  const signOutUser = async (u: SessionUser) => run("Signed out everywhere", () => api("POST", `/api/users/${u.id}/logout-all`));

  const siteNames = (u: SessionUser) => {
    if (u.role === "owner" || u.role === "admin" || !u.siteIds.length) return "All locations";
    return u.siteIds.map((id) => app.sites.find((s) => s.id === id)?.name ?? "Removed location").join(", ");
  };

  return (
    <div className="space-y-4">
      <Section
        title="Users"
        description="Everyone who can sign in. Each person gets their own username and password."
        actions={<Button size="sm" onClick={() => setEditing("new")} data-testid="button-add-user"><Plus /> Add user</Button>}
      >
        {list.isLoading ? <Skeleton className="h-32" /> : list.error ? (
          <p className="text-sm text-destructive">{errorMessage(list.error)}</p>
        ) : (
          <div className="overflow-x-auto -mx-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Role</th>
                  <th className="px-4 py-2 font-medium hidden md:table-cell">Locations</th>
                  <th className="px-4 py-2 font-medium hidden sm:table-cell">Last sign-in</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const self = u.id === me.id;
                  const manage = canManage(u);
                  return (
                    <tr key={u.id} className="border-b last:border-0" data-testid={`row-user-${u.username}`}>
                      <td className="px-4 py-2.5">
                        <p className="font-medium">{u.displayName || u.username}{self && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}</p>
                        <p className="text-xs text-muted-foreground">Signs in as <span className="font-mono">{u.username}</span></p>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge variant={u.role === "owner" || u.role === "admin" ? "default" : "secondary"}>{ROLE_LABELS[u.role]}</Badge>
                          {!u.active && <Badge variant="outline">Inactive</Badge>}
                          {u.twoFactorEnabled && <Badge variant="outline" title="Signs in with a code from an authenticator app">2FA</Badge>}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 hidden md:table-cell text-muted-foreground max-w-[16rem] truncate">{siteNames(u)}</td>
                      <td className="px-4 py-2.5 hidden sm:table-cell text-muted-foreground">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : "Never"}</td>
                      <td className="px-4 py-2.5 text-right">
                        {manage && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Actions for ${u.username}`} data-testid={`button-user-menu-${u.username}`}><MoreHorizontal className="h-4 w-4" /></Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setEditing(u)}><Pencil className="h-4 w-4 mr-2" />Edit</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setResetting(u)}><KeyRound className="h-4 w-4 mr-2" />{self ? "Set a new password" : "Reset password"}</DropdownMenuItem>
                              {!self && me.role === "owner" && u.twoFactorEnabled && <DropdownMenuItem onClick={() => void resetTwoFactor(u)}><ShieldOff className="h-4 w-4 mr-2" />Reset two-factor</DropdownMenuItem>}
                              {!self && <DropdownMenuItem onClick={() => void signOutUser(u)}><MonitorSmartphone className="h-4 w-4 mr-2" />Sign out everywhere</DropdownMenuItem>}
                              {!self && (
                                <DropdownMenuItem disabled={u.active && isLastOwner(u)} onClick={() => void toggleActive(u)}>
                                  {u.active ? <><UserX className="h-4 w-4 mr-2" />Deactivate</> : <><UserCheck className="h-4 w-4 mr-2" />Activate</>}
                                </DropdownMenuItem>
                              )}
                              {!self && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem className="text-destructive focus:text-destructive" disabled={isLastOwner(u)} onClick={() => void remove(u)} data-testid={`button-delete-user-${u.username}`}><Trash2 className="h-4 w-4 mr-2" />Delete</DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <RolePermissionsPanel />
      <UserDialog
        user={editing === "new" ? null : editing}
        open={editing !== null}
        onClose={() => setEditing(null)}
        onSaved={() => void refresh()}
        lastOwner={editing && editing !== "new" ? isLastOwner(editing) : false}
      />
      <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />
    </div>
  );
}

function UserDialog({ user, open, onClose, onSaved, lastOwner }: { user: SessionUser | null; open: boolean; onClose: () => void; onSaved: () => void; lastOwner: boolean }) {
  const app = useApp();
  const me = app.user;
  const { toast } = useToast();
  const isNew = !user;
  const self = user?.id === me.id;
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("manager");
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUsername(user?.username ?? "");
    setDisplayName(user?.displayName ?? "");
    setPassword("");
    setRole(user?.role ?? "manager");
    setSiteIds(user?.siteIds ?? []);
    setActive(user?.active ?? true);
  }, [open, user]);

  const roles = (Object.keys(ROLE_LABELS) as Role[]).filter((r) => r !== "owner" || me.role === "owner");
  const roleLocked = self || lastOwner;
  const limited = role === "manager" || role === "viewer";
  const toggleSite = (id: string, on: boolean) => setSiteIds((cur) => (on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id)));

  const save = async () => {
    setBusy(true);
    try {
      const body = { username: username.trim(), displayName: displayName.trim(), role, siteIds: limited ? siteIds : [], active };
      if (isNew) await api("POST", "/api/users", { ...body, password });
      else await api("PATCH", `/api/users/${user!.id}`, roleLocked ? { username: body.username, displayName: body.displayName, siteIds: body.siteIds } : body);
      if (self) await app.refresh();
      onSaved();
      onClose();
      const signIn = body.username;
      toast({ title: isNew ? "User added" : "User updated", description: isNew || signIn !== user?.username ? `${self ? "You" : "They"} sign in as "${signIn}".` : undefined });
    } catch (e) {
      toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" });
    } finally { setBusy(false); }
  };

  const valid = username.trim().length >= 2 && (!isNew || password.length >= MIN);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isNew ? "Add user" : `Edit ${user?.displayName || user?.username}`}</DialogTitle>
          <DialogDescription>{isNew ? "They sign in with this username and password. You can reset the password later." : "Changes apply straight away."}</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) void save(); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Sign-in username" hint="Typed on the sign-in screen."><Input value={username} maxLength={64} autoCapitalize="none" spellCheck={false} autoComplete="off" onChange={(e) => setUsername(e.target.value)} data-testid="input-user-username" /></Field>
            <Field label="Display name" hint="Shown in the app. Not for sign-in."><Input value={displayName} maxLength={100} autoComplete="off" onChange={(e) => setDisplayName(e.target.value)} placeholder="Full name" data-testid="input-user-name" /></Field>
          </div>
          {isNew && <Field label="Password" hint={`At least ${MIN} characters. Share it with them privately.`}><Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="input-user-password" /></Field>}
          <Field label="Role" hint={roleLocked ? (self ? "You can't change your own role." : "This is the last owner. Make someone else an owner first.") : ROLE_HELP[role]}>
            <Select value={role} onValueChange={(v) => setRole(v as Role)} disabled={roleLocked}>
              <SelectTrigger data-testid="select-user-role"><SelectValue /></SelectTrigger>
              <SelectContent>{roles.map((r) => <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {limited && (
            <Field label="Locations" hint={siteIds.length ? undefined : "None ticked = all locations, including ones added later."}>
              <div className="max-h-40 overflow-y-auto rounded-lg border divide-y">
                {app.sites.map((s) => (
                  <label key={s.id} className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
                    <Checkbox checked={siteIds.includes(s.id)} onCheckedChange={(v) => toggleSite(s.id, v === true)} />
                    <SiteDot color={s.color} /><span className="truncate">{s.name}</span>
                  </label>
                ))}
              </div>
            </Field>
          )}
          {!self && (
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>Active <span className="block text-xs text-muted-foreground">Inactive users can't sign in.</span></span>
              <Switch checked={active} onCheckedChange={setActive} disabled={lastOwner && active} />
            </label>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !valid} data-testid="button-user-save">{busy && <Loader2 className="animate-spin" />}{isNew ? "Add user" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: SessionUser | null; onClose: () => void }) {
  const { toast } = useToast();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPassword(""); }, [user]);
  const save = async () => {
    if (!user) return;
    setBusy(true);
    try {
      await api("POST", `/api/users/${user.id}/password`, { password });
      toast({ title: "Password reset", description: `Sign in as "${user.username}" with the new password. ${user.displayName || user.username} has been signed out everywhere.` });
      onClose();
    } catch (e) {
      toast({ title: "Couldn't reset the password", description: errorMessage(e), variant: "destructive" });
    } finally { setBusy(false); }
  };
  return (
    <Dialog open={!!user} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>Set a new password for {user?.displayName || user?.username}. They'll be signed out on every device.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (password.length >= MIN) void save(); }}>
          <Field label="New password" hint={`At least ${MIN} characters`}><Input type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} data-testid="input-reset-password" /></Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || password.length < MIN} data-testid="button-reset-save">{busy && <Loader2 className="animate-spin" />}Reset password</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
