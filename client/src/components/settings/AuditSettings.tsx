import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import { useApp } from "@/context/AppData";
import { api, errorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, Section } from "@/components/workspace/fields";

interface AuditEntry { id: string; at: string; userId: string | null; userName: string; action: string; target: string; detail: string; ip: string; count?: number }
interface AuditPage { entries: AuditEntry[]; total: number; actions: string[] }

const PAGE = 50;
const GROUPS: Record<string, string> = { auth: "Sign-ins", user: "Users", timesheet: "Timesheets", settings: "Preferences", site: "Locations", categories: "Pay categories", wages: "Saved rates", square: "Square", database: "Database", backup: "Backups" };

const ACTION_LABELS: Record<string, string> = {
  "auth.login": "Signed in", "auth.login-failed": "Failed sign-in", "auth.logout": "Signed out", "auth.logout-all": "Signed out everywhere",
  "user.create": "Added user", "user.update": "Changed user", "user.delete": "Deleted user", "user.password": "Password changed",
  "timesheet.create": "Created timesheet", "timesheet.update": "Edited timesheet", "timesheet.finalize": "Finalized timesheet", "timesheet.reopen": "Reopened timesheet",
  "timesheet.rename": "Renamed timesheet", "timesheet.move": "Moved timesheet", "timesheet.duplicate": "Duplicated timesheet", "timesheet.trash": "Moved to Trash",
  "timesheet.restore": "Restored from Trash", "timesheet.delete": "Deleted forever", "timesheet.empty-trash": "Emptied Trash",
  "settings.update": "Changed preferences", "site.create": "Added location", "site.update": "Changed location", "site.delete": "Deleted location",
  "categories.update": "Changed pay categories", "wages.update": "Saved rates", "square.connect": "Connected Square", "square.disconnect": "Disconnected Square",
  "pay.settings": "Changed pay extras", "pay.advance.create": "Recorded advance", "pay.advance.update": "Changed advance", "pay.advance.writeoff": "Wrote off advance", "pay.advance.delete": "Deleted advance",
  "database.switch": "Switched database", "backup.export": "Downloaded export", "backup.restore": "Restored backup", "backup.create": "Made server backup", "backup.download": "Downloaded backup",
  "permissions.update": "Changed role permissions", "user.2fa-enable": "Turned on two-factor", "user.2fa-disable": "Turned off two-factor", "user.2fa-reset": "Reset two-factor", "user.2fa-recovery": "New recovery codes", "user.2fa-devices": "Forgot remembered devices", "settings.2fa-policy": "Changed two-factor requirement", "settings.offsite": "Changed offsite backups", "backup.offsite": "Copied backup offsite",
  "portal.login": "Signed in to the portal", "portal.lockout": "Locked out of the portal", "portal.settings": "Changed portal settings",
  "schedule.update": "Changed schedule", "schedule.copy": "Copied schedule", "schedule.settings": "Changed schedule settings",
  "timeoff.request": "Asked for time off", "timeoff.create": "Added time off", "timeoff.update": "Changed time off", "timeoff.cancel": "Cancelled time off", "timeoff.delete": "Deleted time off",
  "kiosk.settings": "Changed kiosk settings", "kiosk.fix-request": "Asked for a punch fix", "kiosk.fix-request.approve": "Approved a punch fix", "kiosk.fix-request.decline": "Declined a punch fix",
  "kiosk.note.create": "Left a kiosk note", "kiosk.note.delete": "Deleted a kiosk note", "timeclock.settings": "Changed time clock settings",
  "timesheet.unpublish": "Unpublished timesheet", "sales.update": "Changed sales", "settings.email": "Changed email settings", "email.test": "Sent test email", "system.update": "Updated the app",
};

export function AuditSettings() {
  const app = useApp();
  const [user, setUser] = useState("");
  const [action, setAction] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE) });
  if (user.trim()) params.set("user", user.trim());
  if (action !== "all") params.set("action", action);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const url = `/api/audit?${params}`;
  const q = useQuery<AuditPage>({ queryKey: [url], queryFn: () => api("GET", url), placeholderData: keepPreviousData, staleTime: 5_000 });
  const data = q.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;
  const reset = (fn: () => void) => { fn(); setPage(0); };

  const describeTarget = (t: string) => {
    const [kind, id] = t.split(":");
    if (kind === "site") return app.sites.find((s) => s.id === id)?.name ?? t;
    if (kind === "user" || kind === "timesheet") return "";
    return t;
  };

  return (
    <Section
      title="Sign-ins and changes"
      description="Who signed in and what changed. Repeated autosaves of the same timesheet are grouped."
      actions={<Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}><RefreshCw className={q.isFetching ? "animate-spin" : ""} /> Refresh</Button>}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Person" className="w-full sm:w-48">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-8" value={user} onChange={(e) => reset(() => setUser(e.target.value))} placeholder="Name or username" data-testid="input-audit-user" />
            </div>
          </Field>
          <Field label="What" className="w-full sm:w-44">
            <Select value={action} onValueChange={(v) => reset(() => setAction(v))}>
              <SelectTrigger data-testid="select-audit-action"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Everything</SelectItem>
                {Object.entries(GROUPS).map(([k, label]) => <SelectItem key={k} value={k}>{label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="From" className="w-[calc(50%-0.375rem)] sm:w-40"><Input type="date" value={from} onChange={(e) => reset(() => setFrom(e.target.value))} data-testid="input-audit-from" /></Field>
          <Field label="To" className="w-[calc(50%-0.375rem)] sm:w-40"><Input type="date" value={to} onChange={(e) => reset(() => setTo(e.target.value))} data-testid="input-audit-to" /></Field>
        </div>

        {q.isLoading ? <div className="space-y-2"><Skeleton className="h-9 rounded-lg" /><Skeleton className="h-9 rounded-lg" /><Skeleton className="h-9 rounded-lg" /></div> : q.error ? (
          <p className="text-sm text-destructive">{errorMessage(q.error)}</p>
        ) : !data?.entries.length ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground">No activity matches these filters. Clear a filter or pick a wider date range.</p>
        ) : (
          <div className="-mx-5 border-t border-border/70">
            <table className="w-full text-[13px] max-sm:block" data-testid="table-audit">
              <thead className="max-sm:hidden">
                <tr className="border-b border-border/70 text-left text-xs text-muted-foreground">
                  <th className="py-2 pl-5 pr-3 font-medium whitespace-nowrap">When</th>
                  <th className="px-3 py-2 font-medium">Who</th>
                  <th className="px-3 py-2 font-medium">What</th>
                  <th className="px-3 py-2 font-medium hidden md:table-cell">Details</th>
                  <th className="py-2 pl-3 pr-5 text-right font-medium hidden lg:table-cell">Address</th>
                </tr>
              </thead>
              <tbody className="max-sm:block">
                {data.entries.map((e) => (
                  <tr key={e.id} className="border-b border-border/60 last:border-0 align-baseline max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-x-3 max-sm:px-5 max-sm:py-2.5">
                    <td className="py-2.5 pl-5 pr-3 whitespace-nowrap tabular text-muted-foreground max-sm:col-start-2 max-sm:row-start-1 max-sm:p-0 max-sm:text-xs" title={e.at}>{app.date(e.at.slice(0, 10))} {new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</td>
                    <td className="px-3 py-2.5 max-sm:col-start-1 max-sm:row-start-1 max-sm:min-w-0 max-sm:truncate max-sm:p-0 max-sm:font-medium">{e.userName || <span className="text-muted-foreground">Unknown</span>}</td>
                    <td className={`px-3 py-2.5 max-sm:col-span-2 max-sm:p-0 max-sm:pt-0.5 ${e.action === "auth.login-failed" ? "text-destructive" : ""}`}>
                      {ACTION_LABELS[e.action] ?? e.action}
                      {e.count && e.count > 1 ? <span className="ml-1 text-xs text-muted-foreground tabular">×{e.count}</span> : null}
                    </td>
                    <td className="px-3 py-2.5 hidden md:table-cell text-muted-foreground max-w-[22rem] [overflow-wrap:anywhere]">{[describeTarget(e.target), e.detail].filter(Boolean).join(" · ")}</td>
                    <td className="py-2.5 pl-3 pr-5 text-right hidden lg:table-cell text-xs text-muted-foreground font-mono whitespace-nowrap">{e.ip.replace(/^::ffff:/, "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && data.total > PAGE && (
          <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
            <span className="tabular">Page {page + 1} of {pages} · {data.total} entries</span>
            <Button variant="outline" size="icon" className="h-8 w-8" aria-label="Previous page" disabled={page === 0} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="h-4 w-4" /></Button>
            <Button variant="outline" size="icon" className="h-8 w-8" aria-label="Next page" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        )}
      </div>
    </Section>
  );
}
