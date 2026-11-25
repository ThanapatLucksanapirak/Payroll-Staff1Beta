// Notices on Home for owners and administrators: an offsite backup that is
// failing, and a nudge to turn on two-factor sign-in.
import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ShieldCheck, X } from "lucide-react";
import { useApp } from "@/context/AppData";
import { isAdmin } from "@/lib/roles";
import { safeStorage } from "@/lib/storage";
import { Button } from "@/components/ui/button";
import type { OffsiteInfo } from "@/components/settings/OffsiteBackupSettings";
import type { TwoFactorStatus } from "@/components/settings/TwoFactorSettings";

const DISMISS_KEY = "payroll.2fa-prompt-dismissed";
const NAMES = { folder: "the backup folder", s3: "cloud storage" } as const;

export function AccessNotices() {
  const app = useApp();
  const admin = isAdmin(app.user);
  const offsite = useQuery<OffsiteInfo>({ queryKey: ["/api/offsite"], enabled: admin, staleTime: 60_000, retry: false });
  const tf = useQuery<TwoFactorStatus>({ queryKey: ["/api/auth/2fa"], enabled: admin, staleTime: 60_000, retry: false });
  const [dismissed, setDismissed] = useState(() => safeStorage.get(DISMISS_KEY) === app.user.id);
  if (!admin) return null;
  const failing = offsite.data?.failing ?? [];
  const prompt = tf.data && !tf.data.enabled && !dismissed;
  if (!failing.length && !prompt) return null;
  return (
    <div className="mb-6 space-y-3">
      {failing.map((f) => (
        <div key={f.target} className="flex flex-wrap items-center gap-3 rounded-xl bg-danger-soft px-4 py-3 text-[13px]" role="alert" data-testid={`notice-offsite-${f.target}`}>
          <AlertTriangle className="h-4 w-4 shrink-0 text-danger" />
          <span className="min-w-[12rem] flex-1">Backups aren't reaching {NAMES[f.target]}: {f.error}</span>
          <Button asChild size="sm" variant="outline"><Link href="/settings/data">Backup settings</Link></Button>
        </div>
      ))}
      {prompt && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-card-border bg-card px-4 py-3 text-[13px] shadow-card" data-testid="notice-2fa">
          <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
          <span className="min-w-[12rem] flex-1">Protect payroll with two-factor sign-in: a code from your phone after your password.</span>
          <Button asChild size="sm" variant="tinted"><Link href="/settings/security">Set up</Link></Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Not now" onClick={() => { safeStorage.set(DISMISS_KEY, app.user.id); setDismissed(true); }}><X className="h-4 w-4" /></Button>
        </div>
      )}
    </div>
  );
}
