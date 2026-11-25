// Extract positioned text from a PDF with pdf.js (no native dependencies).
import type { TextItem } from "@shared/importers/schedule";

// A real dynamic import that esbuild will not rewrite into require() (pdf.js is ESM-only).
const importESM = new Function("s", "return import(s)") as (s: string) => Promise<any>;
let pdfjsPromise: Promise<any> | null = null;

function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = importESM("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

export async function extractPdfText(buf: Buffer, maxPages = 30): Promise<TextItem[]> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const items: TextItem[] = [];
  try {
    const n = Math.min(doc.numPages, maxPages);
    for (let p = 1; p <= n; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      for (const it of content.items as any[]) {
        if (typeof it.str !== "string" || !it.str.trim()) continue;
        const [, , , d, e, f] = it.transform;
        items.push({ str: it.str, x: e, y: f, w: it.width ?? 0, h: Math.abs(it.height || d || 8), page: p });
      }
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return items;
}
