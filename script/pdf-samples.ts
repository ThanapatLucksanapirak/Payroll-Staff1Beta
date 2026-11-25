// Render sample PDFs (and PNG previews when pdftoppm is available) for visual review.
//   npx tsx script/pdf-samples.ts [outDir=/tmp/pdf-samples]
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { deflateSync, crc32 } from "node:zlib";
import { buildPayrollPdf } from "../client/src/lib/pdf/report";
import { buildPayStatementsPdf } from "../client/src/lib/pdf/statements";
import { buildSummaryPdf } from "../client/src/lib/pdf/summary";
import type { PdfOptions } from "../client/src/lib/pdf/kit";
import { bigResult, edgeResult, emptyResult, prefs, realisticResult, site } from "../tests/pdf-fixture";

const out = process.argv[2] || "/tmp/pdf-samples";
mkdirSync(out, { recursive: true });

/** A small two-tone logo mark as a PNG data URL (no image libraries needed). */
function sampleLogo(): string {
  const w = 120, h = 120;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 4 + 1) + 1 + x * 4;
      const dx = x - 60, dy = y - 60, r = Math.sqrt(dx * dx + dy * dy);
      const inCircle = r < 58;
      const wave = inCircle && y > 62 + 8 * Math.sin(x / 12);
      const c = wave ? [0, 102, 204] : inCircle ? [29, 29, 31] : [0, 0, 0];
      raw.set([...c, inCircle ? 255 : 0], i);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

const at = new Date(2026, 10, 16, 9, 41);
const base = (extra: Partial<PdfOptions> = {}): PdfOptions => ({
  result: realisticResult(), prefs: prefs({ pdfLogoDataUrl: sampleLogo(), pdfSignatureLine: true }), site: site(), title: "Payroll Nov 2 – Nov 15",
  notes: "Holiday cover approved by Sam. Uniform deduction agreed with Maria on 11/4.", generatedAt: at, payDate: "2026-11-20", ...extra,
});

const samples: [string, (o: PdfOptions) => { output(t: "arraybuffer"): ArrayBuffer }, PdfOptions][] = [
  ["report-landscape-letter", buildPayrollPdf, base()],
  ["report-portrait-a4", buildPayrollPdf, base({ prefs: prefs({ pdfOrientation: "portrait", pdfPageSize: "a4", dateFormat: "MMM D, YYYY", timeFormat: "24h", currencySymbol: "€" }) })],
  ["report-no-times-per-page", buildPayrollPdf, base({ prefs: prefs({ pdfShowShiftTimes: false, pdfPagePerEmployee: true, currencySymbol: "₱" }) })],
  ["summary-landscape", buildSummaryPdf, base()],
  ["summary-portrait-150", buildSummaryPdf, base({ result: bigResult(150, 14), notes: "", prefs: prefs({ pdfOrientation: "portrait" }) })],
  ["statements", buildPayStatementsPdf, base()],
  ["statements-a4-thb", buildPayStatementsPdf, base({ prefs: prefs({ pdfPageSize: "a4", currencySymbol: "฿", dateFormat: "D/M/YY", timeFormat: "24h" }), payDate: undefined })],
  ["report-150", buildPayrollPdf, base({ result: bigResult(150, 14) })],
  ["report-long-names", buildPayrollPdf, base({ result: bigResult(4, 31, (i) => `${"Maximiliana Alexandrina Wolfeschlegelsteinhausen-Bergerdorff ".repeat(i + 1).trim()} ${i}`) })],
  ["report-empty", buildPayrollPdf, base({ result: emptyResult(), notes: "" })],
  ["statements-edge", buildPayStatementsPdf, base({ result: edgeResult() })],
  ["statements-31-days", buildPayStatementsPdf, base({ result: bigResult(2, 31) })],
];

for (const [name, fn, o] of samples) {
  const file = `${out}/${name}.pdf`;
  writeFileSync(file, Buffer.from(fn(o).output("arraybuffer")));
  try { execFileSync("pdftoppm", ["-r", "80", "-l", "6", "-png", file, `${out}/${name}`]); } catch { /* no renderer */ }
  console.log(file);
}
