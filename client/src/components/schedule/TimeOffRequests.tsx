// Schedule page: time-off requests waiting for an answer (mostly sent by
// employees from the portal at /me). Approve makes them ordinary approved time
// off; decline keeps them as declined so the employee sees the answer.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Check, Loader2, X } from "lucide-react";
import type { TimeOff, TimeOffStatus } from "@shared/schedule";
import { daysBetween } from "@shared/dates";
import { useApp } from "@/context/AppData";
import { api, errorMessage, queryClient } from "@/lib/api";
import { can } from "@/lib/roles";
import { timeAgo } from "@/lib/doc";
import { useToast } from "@/hooks/use-toast";
import { SectionLabel } from "@/components/ui/page";
import { Button } from "@/components/ui/button";

export function TimeOffRequests({ siteId, onChanged }: { siteId: string; onChanged?: () => void }) {
  const app = useApp();
  const { toast } = useToast();
  const key = ["/api/sites", siteId, "time-off"];
  const q = useQuery<TimeOff[]>({ queryKey: key, staleTime: 0 });
  const [busy, setBusy] = useState<string | null>(null);
  const editable = can(app.user, "schedule.manage");
  const pending = (q.data ?? []).filter((t) => t.status === "pending").sort((a, b) => a.start.localeCompare(b.start));
  if (!pending.length) return null;

  const decide = async (t: TimeOff, status: TimeOffStatus) => {
    setBusy(t.id);
    try {
      await api("PUT", `/api/sites/${siteId}/time-off/${encodeURIComponent(t.id)}`, { status });
      await queryClient.invalidateQueries({ queryKey: ["/api/sites", siteId] });
      onChanged?.();
      toast({ title: status === "approved" ? `Approved time off for ${t.employeeName}` : `Declined ${t.employeeName}'s request` });
    } catch (e) { toast({ title: "Couldn't save", description: errorMessage(e), variant: "destructive" }); } finally { setBusy(null); }
  };

  return (
    <section className="mb-6" data-testid="section-timeoff-requests">
      <SectionLabel>Time-off requests</SectionLabel>
      <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-card-border bg-card shadow-card">
        {pending.map((t) => {
          const days = daysBetween(t.start, t.end) + 1;
          return (
            <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]" data-testid={`timeoff-request-${t.id}`}>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning-soft text-warning"><CalendarClock className="h-4 w-4" /></span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{t.employeeName} · {t.start === t.end ? app.date(t.start) : `${app.date(t.start)} – ${app.date(t.end)}`} <span className="font-normal text-muted-foreground">({days} day{days === 1 ? "" : "s"})</span></span>
                <span className="block text-xs text-muted-foreground">{[t.reason, t.requestedBy === "employee" ? `asked ${timeAgo(t.createdAt)} from the employee portal` : `added ${timeAgo(t.createdAt)}`].filter(Boolean).join(" · ")}</span>
              </span>
              {editable && (
                <span className="flex items-center gap-2">
                  {busy === t.id && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                  <Button variant="outline" size="sm" disabled={!!busy} onClick={() => decide(t, "declined")} data-testid={`button-decline-${t.id}`}><X />Decline</Button>
                  <Button size="sm" disabled={!!busy} onClick={() => decide(t, "approved")} data-testid={`button-approve-${t.id}`}><Check />Approve</Button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
