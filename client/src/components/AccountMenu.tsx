import { useLocation } from "wouter";
import { ChevronsUpDown, LogOut, MonitorSmartphone, UserRound } from "lucide-react";
import { useApp } from "@/context/AppData";
import { signOut } from "@/lib/api";
import { ROLE_LABELS } from "@/lib/roles";
import { useConfirm } from "@/components/ConfirmDialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** Account block at the bottom of the sidebar: signed-in user, account settings and sign out. */
export function AccountMenu({ collapsed = false }: { collapsed?: boolean }) {
  const { user } = useApp();
  const [, navigate] = useLocation();
  const confirm = useConfirm();
  const name = user.displayName || user.username;

  const everywhere = async () => {
    const ok = await confirm({ title: "Sign out everywhere?", description: "You'll be signed out on every device and browser, including this one.", confirmLabel: "Sign out everywhere" });
    if (ok) await signOut(true);
  };

  const trigger = (
    <DropdownMenuTrigger
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md p-1.5 text-left transition-colors hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 data-[state=open]:bg-foreground/[0.05]",
        collapsed && "justify-center p-1",
      )}
      aria-label={`Account: ${name}`}
      data-testid="button-account"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[12px] font-semibold text-primary" aria-hidden>{initials(name)}</span>
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium" data-testid="text-sidebar-account-name">{name}</span>
            <span className="block truncate text-[11px] text-muted-foreground">{ROLE_LABELS[user.role]}</span>
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </>
      )}
    </DropdownMenuTrigger>
  );

  return (
    <DropdownMenu>
      {collapsed ? <Tooltip><TooltipTrigger asChild>{trigger}</TooltipTrigger><TooltipContent side="right">{name}</TooltipContent></Tooltip> : trigger}
      <DropdownMenuContent side={collapsed ? "right" : "top"} align={collapsed ? "end" : "start"} className="w-60">
        <DropdownMenuLabel className="text-[13px] font-normal normal-case tracking-normal text-foreground">
          <p className="truncate text-[13px] font-semibold" data-testid="text-account-name">{name}</p>
          <p className="truncate text-xs text-muted-foreground">{user.username} · {ROLE_LABELS[user.role]}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/settings/security")} data-testid="menu-account-settings"><UserRound />Account & password</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void signOut()} data-testid="button-signout"><LogOut />Sign out</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void everywhere()} data-testid="button-signout-all"><MonitorSmartphone />Sign out everywhere</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
