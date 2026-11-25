// Weekly schedule PDF: one landscape page (more if the team is large) with
// people down the side and the seven days across. Pure, so it runs in Node.
import type { jsPDF } from "jspdf";
import { autoTable, type RowInput } from "jspdf-autotable";
import type { AnalysisResult, Prefs, Site } from "@shared/schema";
import { type ScheduleWeek, type ScheduledShift, type TimeOff, personKey, shiftMinutes, timeOffOn, weekDates } from "@shared/schedule";
import { C, brandHeader, createCtx, finishPages, flushEdges, font, plural, tableBase } from "./kit";

export interface SchedulePdfOptions {
  week: ScheduleWeek;
  /** People in display order (directory first, then anyone else on the schedule). */
  people: { employeeId: string; employeeName: string; role?: string }[];
  timeOff: TimeOff[];
  prefs: Prefs;
  site: Site;
  generatedAt?: Date;
}

const emptyResult = (start: string, end: string): AnalysisResult => ({
  periodStart: start, periodEnd: end, employees: [], warnings: [],
  totals: { employees: 0, totalPay: 0, netPay: 0, grossPay: 0, bonuses: 0, deductions: 0, docked: 0, fullDays: 0, halfDays: 0, flaggedDays: 0, hours: 0, overtimeHours: 0, cash: 0, bank: 0, check: 0 },
});

const hrs = (min: number) => {
  const h = min / 60;
  return Number.isInteger(h) ? `${h}` : h.toFixed(1);
};

export function buildSchedulePdf(o: SchedulePdfOptions): jsPDF {
  const dates = weekDates(o.week.weekStart);
  const title = "Weekly schedule";
  const ctx = createCtx({ result: emptyResult(dates[0], dates[6]), prefs: o.prefs, site: o.site, title, generatedAt: o.generatedAt }, { orientation: "landscape" });
  const { fmt } = ctx;
  const status = o.week.publishedAt ? `Published ${fmt.date(o.week.publishedAt.slice(0, 10))}` : "Draft (not published)";
  let y = brandHeader(ctx, title, [{ text: `Week of ${fmt.period(dates[0], dates[6])}`, bold: true }, { text: status }]);

  const byCell = new Map<string, ScheduledShift[]>();
  for (const s of o.week.shifts) {
    const k = `${personKey(s)}|${s.date}`;
    byCell.set(k, [...(byCell.get(k) ?? []), s]);
  }
  const range = (s: ScheduledShift) => `${fmt.time(s.start)} – ${fmt.time(s.end)}${s.end > 1440 ? " (+1)" : ""}`;
  const dayTotals = dates.map(() => 0);
  let total = 0;
  const body: RowInput[] = o.people.map((p) => {
    let mins = 0;
    const cells = dates.map((d, i) => {
      const list = byCell.get(`${personKey(p)}|${d}`) ?? [];
      const off = timeOffOn(o.timeOff, p, d);
      const lines: string[] = [];
      if (off) lines.push(`Time off${off.reason ? ` (${fmt.text(off.reason)})` : ""}`);
      for (const s of list) {
        mins += shiftMinutes(s);
        dayTotals[i] += shiftMinutes(s);
        lines.push(range(s));
        const extra = [s.station, s.note].filter(Boolean).map(fmt.text).join(" · ");
        if (extra) lines.push(extra);
      }
      return { content: lines.join("\n") || "", styles: off && !list.length ? { textColor: C.faint, fontStyle: "italic" as const } : {} };
    });
    total += mins;
    return [
      { content: `${fmt.text(p.employeeName)}${p.role ? `\n${fmt.text(p.role)}` : ""}`, styles: { fontStyle: "bold" as const, textColor: C.ink } },
      ...cells,
      { content: mins ? hrs(mins) : "—", styles: { halign: "right" as const } },
    ];
  });

  y += 1;
  font(ctx, 8.5, "normal", C.muted);
  ctx.pdf.text(`${plural(o.people.length, "person", "people")} · ${hrs(total)} scheduled hours`, ctx.M, y);
  y += 4;

  const base = tableBase(ctx, 7.5, 1.6);
  const avail = ctx.W - 2 * ctx.M;
  const nameW = Math.min(36, avail * 0.15);
  const hoursW = 13;
  const dayW = (avail - nameW - hoursW) / 7;
  autoTable(ctx.pdf, {
    ...base,
    startY: y,
    head: [["Employee", ...dates.map((d) => fmt.day(d)), { content: "Hours", styles: { halign: "right" } }]],
    body: body.length ? body : [[{ content: "No one is on the schedule this week.", colSpan: 9, styles: { textColor: C.muted, fontStyle: "italic" } }]],
    foot: body.length ? [["Total", ...dayTotals.map((m) => (m ? `${hrs(m)} h` : "")), { content: hrs(total), styles: { halign: "right" } }]] : undefined,
    columnStyles: Object.fromEntries([[0, { cellWidth: nameW }], ...dates.map((_, i) => [i + 1, { cellWidth: dayW }]), [8, { cellWidth: hoursW }]]),
    styles: { ...base.styles, valign: "top" },
    didParseCell: flushEdges,
  });
  finishPages(ctx);
  return ctx.pdf;
}
