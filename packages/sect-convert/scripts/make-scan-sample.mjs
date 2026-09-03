// Build a scanned-PDF sample (no text layer) from the bake-off's Federal Register page images,
// so the dual-transcriber path can be exercised end to end on a real scan.
// usage: node scripts/make-scan-sample.mjs <out.pdf> <page.png> [page.png ...]   (PNGs at 100 dpi)
import { readFileSync, writeFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";

const [out, ...pages] = process.argv.slice(2);
const pdf = await PDFDocument.create();
for (const file of pages) {
  const img = await pdf.embedPng(readFileSync(file));
  const w = (img.width / 100) * 72;
  const h = (img.height / 100) * 72;
  const pg = pdf.addPage([w, h]);
  pg.drawImage(img, { x: 0, y: 0, width: w, height: h });
}
writeFileSync(out, await pdf.save());
console.log(`${out}: ${pages.length} page(s)`);
