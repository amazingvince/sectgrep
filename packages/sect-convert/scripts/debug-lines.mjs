// Print the lines the PDF reader builds for one page, with column and block order (debugging aid).
// usage: node scripts/debug-lines.mjs <file.pdf> [page]
import { readFileSync } from "node:fs";
import { readPdfPages, pageBlocks } from "../dist/elements/pdf.js";
const pages = await readPdfPages(new Uint8Array(readFileSync(process.argv[2])));
const pg = pages[Number(process.argv[3] ?? 1) - 1];
console.log(`page ${pg.page} ${pg.width}x${pg.height} lines ${pg.lines.length} columns ${JSON.stringify([...new Set(pg.lines.map((l) => l.column))])}`);
for (const l of pg.lines.slice(0, Number(process.argv[4] ?? 12))) console.log(l.column, Math.round(l.y0), Math.round(l.x0), Math.round(l.x1), JSON.stringify(l.text.slice(0, 60)));
let n = 0;
for (const b of pageBlocks(pg)) { if (n++ < 8) console.log("block", b.column, JSON.stringify(b.lines.map((l) => l.text.slice(0, 40)).join(" / ").slice(0, 100))); }
