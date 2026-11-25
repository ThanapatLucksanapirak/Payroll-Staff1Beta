// Pay-out sheet: who gets paid how. Cash recipients get a "received by"
// signature column for hand-outs; bank transfers and checks are listed with
// their amounts so they can be keyed in or written up.
import type { jsPDF } from "jspdf";
import { autoTable, type RowInput } from "jspdf-autotable";
import type { EmployeeSummary } from "@shared/schema";
import { cashPlan } from "@shared/payExtras";
import { pdfText } from "./format";
import { C, type Ctx, type PdfOptions, brandHeader, createCtx, finishPages, flushEdges, font, lastY, newPage, people, plural, sectionTitle, tableBase } from "./kit";

type Kind = "cash" | "bank" | "check";
const TITLES: Record<Kind, string> = { cash: "Cash", bank: "Bank transfers", check: "Checks" };

export function buildPayoutSheetPdf(o: PdfOptions): jsPDF {
  const ctx = createCtx(o, { orientation: "portrait" });
  const list = people(o);
  // With "round cash" on, cash hand-outs are rounded to whole amounts (the difference is noted).
  const roundCash = !!o.cash?.roundCash;
  const amount = (e: EmployeeSummary, k: Kind) => (k === "cash" && roundCash ? Math.round(e.payment?.cash ?? 0) : e.payment?.[k] ?? 0);
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
    if (cash && o.cash) y = denominations(ctx, y, list, o.cash) + 6;
  }

  // Tips are already inside the amounts above; list them so they can be checked against the pool.
  const tipped = list.filter((e) => (e.extras?.tips ?? 0) > 0);
  if (tipped.length) {
    if (y + 24 > ctx.bottom) y = newPage(ctx) + 6;
    const tipTotal = tipped.reduce((s, e) => s + (e.extras?.tips ?? 0), 0);
    y = sectionTitle(ctx, y + 4, "Tips included above", plural(tipped.length, "person", "people"));
    autoTable(ctx.pdf, {
      ...tableBase(ctx, 9, 2.2),
      startY: y + 1,
      head: [["Employee", "Tips"]],
      body: tipped.map((e) => [pdfText(e.name), ctx.fmt.money(e.extras!.tips)]),
      foot: [["Total tips", ctx.fmt.money(tipTotal)]],
      columnStyles: { 0: { textColor: C.ink, cellWidth: "auto" }, 1: { halign: "right", cellWidth: 30 } },
      didParseCell: (d) => { flushEdges(d); if (d.column.index === 1) d.cell.styles.halign = "right"; },
    });
    y = lastY(ctx, y) + 6;
  }

  finishPages(ctx);
  return ctx.pdf;
}

/** Bills and coins to pull from the bank: totals, then per person. */
function denominations(ctx: Ctx, y: number, list: EmployeeSummary[], cfg: { denominations: number[]; roundCash: boolean }): number {
  const plan = cashPlan(list.map((e) => ({ name: e.name, cash: e.payment?.cash ?? 0 })), cfg);
  if (!plan.rows.length) return y;
  if (y + 30 > ctx.bottom) y = newPage(ctx) + 6;
  const sym = (v: number) => (v < 1 ? ctx.fmt.money(v) : ctx.fmt.money(v).replace(/\.00$/, ""));
  y = sectionTitle(ctx, y + 4, "Bills and coins to pull", cfg.roundCash ? `rounded · owed ${ctx.fmt.money(plan.owed)}` : ctx.fmt.money(plan.total));
  autoTable(ctx.pdf, {
    ...tableBase(ctx, 9, 1.8),
    startY: y + 1,
    head: [["Denomination", "Count", "Amount"]],
    body: plan.totals.map((d) => [sym(d.value), String(d.count), ctx.fmt.money(d.value * d.count)]),
    foot: [["Total", String(plan.totals.reduce((s, d) => s + d.count, 0)), ctx.fmt.money(plan.total - plan.leftover)]],
    tableWidth: 100,
    columnStyles: { 0: { textColor: C.ink }, 1: { halign: "right" }, 2: { halign: "right" } },
    didParseCell: (d) => { flushEdges(d); if (d.column.index > 0) d.cell.styles.halign = "right"; },
  });
  y = lastY(ctx, y) + 4;
  autoTable(ctx.pdf, {
    ...tableBase(ctx, 8, 1.4),
    startY: y,
    head: [["Employee", "Amount", "Bills and coins"]],
    body: plan.rows.map((r) => [pdfText(r.name), ctx.fmt.money(r.amount), pdfText(r.counts.map((c) => `${c.count} x ${sym(c.value)}`).join(",  ") + (r.leftover ? `  (+${ctx.fmt.money(r.leftover)} not possible)` : ""))]),
    columnStyles: { 0: { textColor: C.ink, cellWidth: 45 }, 1: { halign: "right", cellWidth: 24 }, 2: { textColor: C.muted, cellWidth: "auto" } },
    didParseCell: (d) => { flushEdges(d); if (d.column.index === 1) d.cell.styles.halign = "right"; },
  });
  return lastY(ctx, y);
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
