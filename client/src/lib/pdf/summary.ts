// One-page manager summary: the report's first page, squeezed onto one page.
import type { jsPDF } from "jspdf";
import type { RowInput } from "jspdf-autotable";
import type { EmployeeSummary } from "@shared/schema";
import { C, type PdfOptions, brandHeader, createCtx, finishPages, font, hero, notesBlock, people, plural, sectionTitle, summaryTable, totalsOf } from "./kit";

const STEPS = [
  { fs: 8.5, padY: 2.1 },
  { fs: 8, padY: 1.6 },
  { fs: 7.5, padY: 1.2 },
  { fs: 7, padY: 0.9 },
  { fs: 6.5, padY: 0.7 },
  { fs: 6, padY: 0.55 },
];

function render(o: PdfOptions, list: EmployeeSummary[], step: (typeof STEPS)[number], limit?: number): jsPDF {
  const ctx = createCtx(o);
  const t = totalsOf(list);
  let y = brandHeader(ctx, "Payroll summary", [{ text: o.title, bold: true }, { text: o.result.periodStart ? `Pay period ${ctx.periodText}` : "No shifts yet" }]);
  y = hero(ctx, y, t, { compact: true });
  y = notesBlock(ctx, y, o.notes, 2);
  y = sectionTitle(ctx, y + 1, "Employees", list.length ? plural(list.length, "employee") : undefined);
  if (!list.length) {
    font(ctx, 9, "normal", C.muted);
    ctx.pdf.text("No employees to report for this period.", ctx.M, y + 8);
  } else {
    let shown = list;
    let extraRow: RowInput | undefined;
    if (limit != null && limit < list.length) {
      shown = [...list].sort((a, b) => b.totalPay - a.totalPay).slice(0, limit).sort((a, b) => list.indexOf(a) - list.indexOf(b));
      const rest = list.filter((e) => !shown.includes(e));
      const rt = totalsOf(rest);
      extraRow = [{ content: `+ ${plural(rest.length, "more employee")} (see full report)`, colSpan: 3, styles: { fontStyle: "italic", textColor: C.muted } }, ctx.fmt.money(rt.base), ctx.fmt.signed(rt.bonus - rt.ded - rt.dock) || "—", ctx.fmt.money(rt.pay), ""];
    }
    summaryTable(ctx, shown, y + 1, t, { fs: step.fs, padY: step.padY, singleLine: true, extraRow });
  }
  finishPages(ctx);
  return ctx.pdf;
}

export function buildSummaryPdf(o: PdfOptions): jsPDF {
  const list = people(o);
  for (const step of STEPS) {
    const pdf = render(o, list, step);
    if (pdf.getNumberOfPages() === 1) return pdf;
  }
  // Still too long: list the highest-paid employees and roll the rest into one line.
  const step = STEPS[STEPS.length - 1];
  let lo = 0, hi = list.length - 1, best = render(o, list, step, 0);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const pdf = render(o, list, step, mid);
    if (pdf.getNumberOfPages() === 1) { best = pdf; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}
