// Pre-payroll checklist: everything still wrong for a pay period, as plain
// lines that each say where to fix it. Pure: the server builds the time-clock
// lines, and the timesheet workspace adds lines from the payroll result.
import type { AnalysisResult } from "./schema";
import { type WorkDay, ISSUE_LABELS, openIssues } from "./punchIssues";

export type ChecklistSeverity = "fix" | "review";

export interface ChecklistItem {
  id: string;
  severity: ChecklistSeverity;
  title: string;
  detail: string;
  count: number;
  /** In-app route that fixes it (hash route, e.g. "/live/fix/2026-11-01/2026-11-14"). */
  href: string | null;
  /** In the timesheet workspace: the tab that fixes it. */
  tab?: "payroll" | "rates" | "shifts";
  linkLabel: string;
  names: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const uniq = (xs: string[]) => [...new Set(xs)].sort((a, b) => a.localeCompare(b));
const listNames = (names: string[], max = 4) => (names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} and ${names.length - max} more`);

/** Lines from the time clock: open shifts, punch problems, auto-closed and unapproved days, missing rates. */
export function punchChecklist(days: WorkDay[], period: { start: string; end: string }, noRate: string[] = []): ChecklistItem[] {
  const fixHref = `/live/fix/${period.start}/${period.end}`;
  const items: ChecklistItem[] = [];
  const working = days.filter((d) => d.working);
  if (working.length) {
    const names = uniq(working.map((d) => d.employeeName));
    items.push({ id: "working", severity: "fix", title: `${plural(names.length, "person is", "people are")} still clocked in`, detail: `${listNames(names)}. Their current shift isn't in the hours yet.`, count: working.length, href: "/live", linkLabel: "Open Live", names });
  }
  const issues = openIssues(days);
  const fix = issues.filter((i) => i.severity === "fix");
  if (fix.length) {
    const names = uniq(fix.map((i) => i.employeeName));
    const kinds = uniq(fix.map((i) => ISSUE_LABELS[i.kind].toLowerCase()));
    items.push({ id: "punch-problems", severity: "fix", title: `${plural(fix.length, "punch problem")} to fix`, detail: `${kinds.join(", ")} · ${listNames(names)}`, count: fix.length, href: fixHref, linkLabel: "Fix punches", names });
  }
  const auto = issues.filter((i) => i.kind === "auto_closed");
  if (auto.length) {
    const names = uniq(auto.map((i) => i.employeeName));
    items.push({ id: "auto-closed", severity: "review", title: `${plural(auto.length, "shift")} closed automatically`, detail: `Forgot to clock out: ${listNames(names)}. Set the real time or approve the day.`, count: auto.length, href: fixHref, linkLabel: "Review", names });
  }
  const other = issues.filter((i) => i.severity === "review" && i.kind !== "auto_closed");
  if (other.length) {
    const names = uniq(other.map((i) => i.employeeName));
    const kinds = uniq(other.map((i) => ISSUE_LABELS[i.kind].toLowerCase()));
    items.push({ id: "review", severity: "review", title: `${plural(other.length, "shift")} to double-check`, detail: `${kinds.join(", ")} · ${listNames(names)}`, count: other.length, href: fixHref, linkLabel: "Review", names });
  }
  const unapproved = days.filter((d) => !d.approved && !d.working);
  if (unapproved.length) {
    const names = uniq(unapproved.map((d) => d.employeeName));
    const stale = unapproved.filter((d) => d.approvalStale).length;
    const clean = unapproved.filter((d) => d.clean).length;
    items.push({
      id: "unapproved", severity: "review", title: `${plural(unapproved.length, "day")} not approved`,
      detail: [`${listNames(names)}`, clean ? `${clean} clean, ready to approve` : "", stale ? `${stale} changed after approval` : ""].filter(Boolean).join(" · "),
      count: unapproved.length, href: fixHref, linkLabel: "Approve days", names,
    });
  }
  const missing = uniq(noRate);
  if (missing.length) {
    items.push({ id: "no-rate", severity: "fix", title: `${plural(missing.length, "employee")} with no pay rate`, detail: `${listNames(missing)}. Set a rate in the timesheet's Rates tab (and save it for next time).`, count: missing.length, href: "/timesheets", linkLabel: "Open timesheets", tab: "rates", names: missing });
  }
  return items;
}

/** Lines from a computed timesheet: flagged days, missing rates and other engine warnings. */
export function timesheetChecklist(result: Pick<AnalysisResult, "employees" | "warnings">): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const flagged = result.employees.filter((e) => !e.excluded).flatMap((e) => e.days.filter((d) => d.dayType === "flagged" && !d.cancelled).map(() => e.name));
  if (flagged.length) {
    const names = uniq(flagged);
    items.push({ id: "flagged", severity: "review", title: `${plural(flagged.length, "flagged day")}`, detail: `${listNames(names)}. Decide how to pay them on the Payroll tab.`, count: flagged.length, href: null, tab: "payroll", linkLabel: "Open Payroll", names });
  }
  const noRate = uniq(result.warnings.filter((w) => w.employee && /no pay rate/i.test(w.message)).map((w) => w.employee!));
  if (noRate.length) {
    items.push({ id: "no-rate", severity: "fix", title: `${plural(noRate.length, "employee")} with no pay rate`, detail: listNames(noRate), count: noRate.length, href: null, tab: "rates", linkLabel: "Open Rates", names: noRate });
  }
  const shiftWarn = result.warnings.filter((w) => w.level === "warn" && !/no pay rate/i.test(w.message));
  if (shiftWarn.length) {
    const names = uniq(shiftWarn.map((w) => w.employee ?? "").filter(Boolean));
    items.push({ id: "shift-warnings", severity: "review", title: `${plural(shiftWarn.length, "shift warning")}`, detail: uniq(shiftWarn.map((w) => w.message)).slice(0, 2).join(" · "), count: shiftWarn.length, href: null, tab: "shifts", linkLabel: "Open Shifts", names });
  }
  return items;
}

/** Merge time-clock and timesheet lines; the timesheet's own rate check replaces the saved-rates one. */
export function mergeChecklists(punch: ChecklistItem[], timesheet: ChecklistItem[] | null): ChecklistItem[] {
  if (!timesheet) return punch;
  const out = [...punch.filter((i) => i.id !== "no-rate"), ...timesheet];
  const rank: Record<ChecklistSeverity, number> = { fix: 0, review: 1 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
