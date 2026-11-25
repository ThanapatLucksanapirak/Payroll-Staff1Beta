// Late / no-show alerts for the Live page. Compares today's schedule with the
// punches on the server; refreshes on every punch or schedule change and once
// a minute (someone becomes late just by the clock moving on).
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AlarmClock, ChevronRight, UserX } from "lucide-react";
import type { ScheduleAlert } from "@shared/schedule";
import { useApp } from "@/context/AppData";
import { queryClient } from "@/lib/api";
import { useLiveEvents } from "@/lib/live";
import { SectionLabel } from "@/components/ui/page";
import { cn } from "@/lib/utils";

interface AlertsData { date: string; hasSchedule: boolean; alerts: ScheduleAlert[] }

export function ScheduleAlerts() {
  const app = useApp();
  const site = app.site;
  const key = ["/api/sites", site.id, "schedule/alerts"];
  const q = useQuery<AlertsData>({ queryKey: key, staleTime: 0, refetchInterval: 60_000 });
  useLiveEvents((e) => {
    if ((e.type === "punch" || e.type === "schedule" || e.type === "hello") && (!e.siteId || e.siteId === site.id)) void queryClient.invalidateQueries({ queryKey: key });
  });
  const alerts = q.data?.alerts ?? [];
  if (!q.data?.hasSchedule || !alerts.length) return null;
  const open = alerts.filter((a) => a.kind !== "arrived_late");
  const arrived = alerts.filter((a) => a.kind === "arrived_late");

  return (
    <section className="mb-8" data-testid="section-schedule-alerts">
      <SectionLabel action={<Link href="/schedule" className="inline-flex items-center gap-0.5 text-[13px] font-medium text-primary hover:underline">Schedule<ChevronRight className="h-3.5 w-3.5" /></Link>}>
        Against the schedule
      </SectionLabel>
      <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-card-border bg-card shadow-card">
        {open.map((a) => (
          <li key={a.shiftId} className="flex items-center gap-3 px-4 py-3 text-[13px]" data-testid={`alert-${a.kind}-${a.employeeId || a.employeeName}`}>
            <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full", a.kind === "no_show" ? "bg-danger-soft text-danger" : "bg-warning-soft text-warning")}>
              {a.kind === "no_show" ? <UserX className="h-4 w-4" /> : <AlarmClock className="h-4 w-4" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{a.message}</span>
              <span className="block text-xs text-muted-foreground">{a.employeeName} · scheduled {app.time(a.start)} – {app.time(a.end)}</span>
            </span>
          </li>
        ))}
        {arrived.length > 0 && (
          <li className="px-4 py-2.5 text-xs text-muted-foreground">
            Came in late today: {arrived.map((a) => `${a.employeeName} (${a.minutesLate} min)`).join(", ")}
          </li>
        )}
      </ul>
    </section>
  );
}
