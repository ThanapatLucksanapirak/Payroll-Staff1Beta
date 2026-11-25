import { useLocation } from "wouter";
import { LogOut, MonitorSmartphone, UserRound } from "lucide-react";
import { useApp } from "@/context/AppData";
import { signOut } from "@/lib/api";
import { ROLE_LABELS } from "@/lib/roles";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** Header menu with the signed-in user, account settings and sign out. */
export function AccountMenu() {
  const { user } = useApp();
  const [, navigate] = useLocation();
  const confirm = useConfirm();
  const name = user.displayName || user.username;

  const everywhere = async () => {
    const ok = await confirm({ title: "Sign out everywhere?", description: "You'll be signed out on every device and browser, including this one.", confirmLabel: "Sign out everywhere" });
    if (ok) await signOut(true);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2 px-1.5 sm:px-2" aria-label={`Account: ${name}`} data-testid="button-account">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{initials(name)}</span>
          <span className="hidden lg:inline max-w-[9rem] truncate">{name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <p className="truncate text-sm font-medium" data-testid="text-account-name">{name}</p>
          <p className="truncate text-xs text-muted-foreground">{user.username} · {ROLE_LABELS[user.role]}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/settings/security")} data-testid="menu-account-settings"><UserRound className="h-4 w-4 mr-2" />Account & password</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void signOut()} data-testid="button-signout"><LogOut className="h-4 w-4 mr-2" />Sign out</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void everywhere()} data-testid="button-signout-all"><MonitorSmartphone className="h-4 w-4 mr-2" />Sign out everywhere</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
