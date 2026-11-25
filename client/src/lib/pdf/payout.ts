// Pay-out sheet: who gets paid how. Cash recipients get a "received by"
// signature column for hand-outs; bank transfers and checks are listed with
// their amounts so they can be keyed in or written up.
import type { jsPDF } from "jspdf";
import { autoTable, type RowInput } from "jspdf-autotable";
import type { EmployeeSummary } from "@shared/schema";
import { pdfText } from "./format";
import { C, type Ctx, type PdfOptions, brandHeader, createCtx, finishPages, flushEdges, font, lastY, newPage, people, plural, sectionTitle, tableBase } from "./kit";

type Kind = "cash" | "bank" | "check";
const TITLES: Record<Kind, string> = { cash: "Cash", bank: "Bank transfers", check: "Checks" };

export function buildPayoutSheetPdf(o: PdfOptions): jsPDF {
  const ctx = createCtx(o, { orientation: "portrait" });
  const list = people(o);
  const amount = (e: EmployeeSummary, k: Kind) => e.payment?.[k] ?? 0;
  const groups = (["cash", "bank", "check"] as Kind[])
    .map((k) => ({ k, rows: list.filter((e) => amount(e, k) > 0), total: list.reduce((s, e) => s + amount(e, k), 0) }))
    .filter((g) => g.rows.length);

  let y = brandHeader(ctx, "Pay-out sheet", [{ text: o.title, bold: true }, { text: o.result.periodStart ? `Pay period ${ctx.periodText}` : "No shifts yet" }]);

  // Totals strip
  const grand = groups.reduce((s, g) => s + g.total, 0);
  font(ctx, 8, "normal", C.muted);
  ctx.pdf.text("TO PAY OUT", ctx.M, y + 4);
  font(ctx, 22, "bold", C.ink);
  ctx.pdf.text(ctx.fmt.money(grand), ctx.M, y + 13);
  font(ctx, 9, "normal", C.body);
  const parts = groups.map((g) => `${TITLES[g.k]} ${ctx.fmt.money(g.total)}`).join("   ·   ");
  ctx.pdf.text(parts || "Nothing to pay out", ctx.M, y + 19.5);
  y += 28;

  if (!groups.length) {
    font(ctx, 9, "normal", C.muted);
    ctx.pdf.text("No one is owed money for this period.", ctx.M, y + 6);
  }

  for (const g of groups) {
    if (y + 30 > ctx.bottom) y = newPage(ctx) + 6;
    y = sectionTitle(ctx, y + 4, TITLES[g.k], plural(g.rows.length, "person", "people"));
    const cash = g.k === "cash";
    const head = cash ? ["Employee", "Amount", "Received by (signature)", "Date"] : ["Employee", "Amount", g.k === "check" ? "Check no." : "Reference", "Note"];
    const body: RowInput[] = g.rows.map((e) => [
      pdfText(e.name),
      ctx.fmt.money(amount(e, g.k)),
      "",
      e.payment.method === "split" ? `Part of split (total ${ctx.fmt.money(e.totalPay)})` : "",
    ]);
    if (cash) body.forEach((r) => { (r as string[])[3] = ""; });
    autoTable(ctx.pdf, {
      ...tableBase(ctx, 9, cash ? 4.2 : 2.6),
      startY: y + 1,
      head: [head],
      body,
      foot: [["Total", ctx.fmt.money(g.total), "", ""]],
      columnStyles: {
        0: { fontStyle: "bold", textColor: C.ink, cellWidth: "auto" },
        1: { halign: "right", cellWidth: 30, fontStyle: "bold", textColor: C.ink },
        2: { cellWidth: cash ? 62 : 38 },
        3: { cellWidth: cash ? 26 : 50, textColor: C.muted, fontSize: 7.5 },
      },
      didParseCell: (d) => {
        flushEdges(d);
        if (d.column.index === 1) d.cell.styles.halign = "right";
      },
      didDrawCell: (d) => {
        // Writing lines for signatures and dates
        if (d.section !== "body" || (d.column.index !== 2 && d.column.index !== 3)) return;
        if (!cash && d.column.index === 3) return;
        const pdf = d.doc as jsPDF;
        pdf.setDrawColor(...C.rule);
        pdf.setLineWidth(0.2);
        const ly = d.cell.y + d.cell.height - 2.2;
        pdf.line(d.cell.x + 2, ly, d.cell.x + d.cell.width - 3, ly);
      },
    });
    y = lastY(ctx, y) + 6;
    if (cash) y = noteCashCount(ctx, y, g.total) + 6; // count the drawer right under the cash list
  }

  finishPages(ctx);
  return ctx.pdf;
}

/** A small box for counting the cash drawn for the run. */
function noteCashCount(ctx: Ctx, y: number, total: number): number {
  if (y + 22 > ctx.bottom) y = newPage(ctx) + 6;
  const { pdf, M } = ctx;
  pdf.setDrawColor(...C.rule);
  pdf.setLineWidth(0.25);
  pdf.roundedRect(M, y, 110, 20, 2, 2, "S");
  font(ctx, 8, "bold", C.ink);
  pdf.text("Cash check", M + 4, y + 6);
  font(ctx, 8, "normal", C.body);
  pdf.text(`Cash needed: ${ctx.fmt.money(total)}`, M + 4, y + 12);
  pdf.text("Counted by: ____________________   Date: __________", M + 4, y + 17);
  return y + 20;
}
