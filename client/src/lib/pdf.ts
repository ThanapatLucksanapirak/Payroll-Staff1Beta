// PDF + CSV exports. The builders in ./pdf/* are pure (they run in Node for
// tests); this module adds the browser download wrappers.
import { PAYMENT_LABELS, type AnalysisResult } from "@shared/schema";
import { csvCell } from "@shared/csvSafe";
import { downloadBlob, safeFilename } from "./doc";
import type { PdfOptions } from "./pdf/kit";
import { buildPayrollPdf } from "./pdf/report";
import { buildPayStatementsPdf } from "./pdf/statements";
import { buildSummaryPdf } from "./pdf/summary";
import { buildPayoutSheetPdf } from "./pdf/payout";

export type { PdfOptions } from "./pdf/kit";
export { buildPayrollPdf, buildPayStatementsPdf, buildSummaryPdf, buildPayoutSheetPdf };

type DownloadOptions = PdfOptions & { fileBase?: string };

function save(pdf: { output(type: "arraybuffer"): ArrayBuffer }, name: string) {
  downloadBlob(pdf.output("arraybuffer"), `${safeFilename(name)}.pdf`, "application/pdf");
}

/** Full report: overview page + per-employee detail. */
export function downloadPayrollPdf(o: DownloadOptions) {
  save(buildPayrollPdf(o), o.fileBase || o.title);
}

/** One-page manager summary. */
export function downloadSummaryPdf(o: DownloadOptions) {
  save(buildSummaryPdf(o), o.fileBase || `${o.title} summary`);
}

/** Pay statements, one page per employee (pass `only` for a single employee). */
export function downloadPayStatementsPdf(o: DownloadOptions) {
  save(buildPayStatementsPdf(o), o.fileBase || `${o.title} pay statements`);
}

/** Pay-out sheet: cash (with signature lines), bank transfers and checks. */
export function downloadPayoutSheetPdf(o: DownloadOptions) {
  save(buildPayoutSheetPdf(o), o.fileBase || `${o.title} payout`);
}

/** Summary CSV (one row per employee) — opens cleanly in Excel / Sheets. */
export function payrollSummaryCsv(result: AnalysisResult): string {
  const rows = [["Employee", "Category", "Pay basis", "Full days", "Half days", "Flagged days", "Hours", "Overtime hours", "Base pay", "Docked", "Bonuses", "Deductions", "Total pay", "Net/Gross", "Paid by", "Cash", "Bank transfer", "Check", "Included"]];
  for (const e of result.employees) {
    rows.push([e.name, e.isManual ? "Manual" : e.categoryName ?? "Custom", e.payBasis, e.fullDays, e.halfDays, e.flaggedDays, e.hoursWorked, e.overtimeHours, e.totalBasePay, e.totalDocked, e.totalBonuses, e.totalDeductions, e.totalPay, e.isNetPay ? "Net" : "Gross", PAYMENT_LABELS[e.payment.method], e.payment.cash, e.payment.bank, e.payment.check, e.excluded ? "No" : "Yes"].map(String));
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}
