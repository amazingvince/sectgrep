// The fixture corpus (fixtures/corpus) was written before any raw document existed. This script
// builds the raw sources its provenance points at, so the C.5 validators can run on it in CI:
//   fixtures/raw/cfr-title-99/<date>/ECFR-title99.xml   one snapshot per raw path named in provenance,
//                                                        one DIV per node, NODE ids as in the corpus
//   fixtures/raw/fr/2025/2026-00001.xml                  the notice as a RULE with DOCID
//   fixtures/raw/city-amendments/2025-03-01/ordinance-2025-7.pdf   each amendment on the page its locator names
//   fixtures/work/<sha256>/elements.jsonl                the PDF's elements (sect-convert extract)
// and then writes the real raw_sha256 into every fixture file. Everything is synthetic.
// usage: node scripts/make-fixture-raw.mjs <repo root>
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import YAML from "yaml";
import { extract } from "../dist/extract.js";

const root = path.resolve(process.argv[2] ?? ".");
const corpus = path.join(root, "fixtures", "corpus");
const rawRoot = path.join(root, "fixtures");

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
};
const docs = walk(corpus).map((file) => {
  const text = readFileSync(file, "utf-8");
  const end = text.indexOf("\n---", 3);
  const front = YAML.parse(text.slice(4, end));
  const body = text.slice(text.indexOf("\n", end + 1) + 1);
  return { file, text, front, body };
});

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const LINK_ITEM = /^\s*[-*]\s*\[(?:[^\[\]]|\[[^\]]*\])*\]\([^)]*\)\s*$/;
const flat = (s) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "");
/** The body's first heading line, which the converters put in HEAD. */
const headOf = (d) => {
  const m = /^\s*#{1,6}\s+(.*)$/m.exec(d.body);
  return flat(m ? m[1] : d.front.title ?? "");
};
// Markdown body to plain paragraphs: heading lines dropped (HEAD carries the first), links
// flattened, emphasis removed, tables to GPOTABLE rows.
function paragraphs(body) {
  const out = [];
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*#/.test(line)) {
      i++;
      continue;
    }
    if (line.trim().startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const t = lines[i].trim();
        if (!/^\|?\s*:?-{3,}/.test(t)) rows.push(t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
        i++;
      }
      out.push(`<GPOTABLE>${rows.map((r) => `<ROW>${r.map((c) => `<ENT>${esc(flat(c))}</ENT>`).join("")}</ROW>`).join("")}</GPOTABLE>`);
      continue;
    }
    if (!line.trim() || LINK_ITEM.test(line)) {
      // A list item that is only a link is the corpus's listing of child nodes; bulk XML nests
      // the children instead, so it is not the node's own text.
      i++;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !lines[i].trim().startsWith("|") && !/^\s*#/.test(lines[i])) para.push(lines[i].trim()), i++;
    out.push(`<P>${esc(flat(para.join(" ")))}</P>`);
  }
  return out.join("\n");
}
const DIV = { title: "DIV1", chapter: "DIV3", subchapter: "DIV4", part: "DIV5", subpart: "DIV6", section: "DIV8" };
const hashes = {};
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

// 1. One Title 99 XML per raw path named in provenance (2024-01-01 for the title, 2026-01-01 for the amended § 2.7).
const base = docs.filter((d) => d.front.source === "cfr-title-99" && d.front.provenance?.raw);
const byRaw = new Map();
for (const d of base) byRaw.set(d.front.provenance.raw, [...(byRaw.get(d.front.provenance.raw) ?? []), d]);
const written = [];
for (const [raw, group] of byRaw) {
  const date = /(\d{4}-\d{2}-\d{2})/.exec(raw)?.[1] ?? "2024-01-01";
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<ECFR>\n<AMDDATE>${date}</AMDDATE>\n<VOLUME N="1" AMDDATE="${date}"/>\n`;
  for (const d of group) {
    const tag = DIV[d.front.level] ?? "DIV5";
    xml += `<${tag} N="${esc(String(d.front.id).replace(/^CFR:99-/, ""))}" NODE="${esc(String(d.front.node ?? ""))}" TYPE="${String(d.front.level ?? "").toUpperCase()}">\n<HEAD>${esc(headOf(d))}</HEAD>\n${paragraphs(d.body)}\n</${tag}>\n`;
  }
  xml += "</ECFR>\n";
  const file = path.join(rawRoot, raw);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, xml, "utf-8");
  hashes[raw] = sha(file);
  written.push(`${path.relative(root, file)} (${group.length} nodes)`);
}

// 2. The notice as a RULE.
const notices = docs.filter((d) => d.front.source === "fr");
let fr = '<?xml version="1.0" encoding="UTF-8"?>\n<FEDREG>\n';
for (const d of notices) {
  const docid = String(d.front.id).replace(/^FR:/, "");
  fr += `<RULE DOCID="${esc(docid)}">\n<PREAMB><SUBJECT>${esc(headOf(d))}</SUBJECT></PREAMB>\n${paragraphs(d.body)}\n</RULE>\n`;
}
fr += "</FEDREG>\n";
const frRaw = notices[0]?.front.provenance?.raw ?? "raw/fr/2025/2026-00001.xml";
const frXml = path.join(rawRoot, frRaw);
mkdirSync(path.dirname(frXml), { recursive: true });
writeFileSync(frXml, fr, "utf-8");
hashes[frRaw] = sha(frXml);
written.push(path.relative(root, frXml));

// 3. The city ordinance as a PDF: each amendment starts on the first page its locator names.
const overlays = docs.filter((d) => d.front.source === "city-amendments");
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
const winAnsi = (s) => s.replace(/[^\x20-\x7e -ÿ–—‘’“”•]/g, "-");
const wrap = (s, max = 95) => {
  const lines = [];
  let cur = "";
  for (const w of s.split(/\s+/)) {
    if ((cur + " " + w).trim().length > max) {
      lines.push(cur.trim());
      cur = w;
    } else cur = cur + " " + w;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
};
const LINES_PER_PAGE = 52;
const pageCount = Math.max(2, ...overlays.map((d) => Math.max(...(d.front.provenance?.locator?.pages ?? [3]))));
const pages = Array.from({ length: pageCount }, () => ({ title: "", lines: [] }));
pages[0] = { title: "City of Fixture Ordinance 2025-7", lines: ["Local amendments to Title 99 (synthetic; not real law).", "Adopted March 1, 2025."] };
pages[1] = { title: "Contents", lines: overlays.map((d) => `${String(d.front.id).replace(/^CITY:/, "")}  ${headOf(d)}`) };
for (const d of overlays) {
  const lines = [];
  for (const para of flat(d.body).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))) lines.push(...wrap(para), "");
  const at = d.front.provenance?.locator?.pages ?? [3];
  let k = 0;
  for (let n = 0; n < at.length && k < lines.length; n++) {
    const pg = pages[at[n] - 1];
    pg.title = pg.title || (n === 0 ? headOf(d) : `${headOf(d)} (continued)`);
    const room = LINES_PER_PAGE - pg.lines.length;
    pg.lines.push(...lines.slice(k, k + room));
    k += room;
  }
}
for (const pg of pages) {
  const p = pdf.addPage([612, 792]);
  p.drawText(winAnsi(pg.title || "Reserved"), { x: 72, y: 730, size: 12, font: bold });
  let y = 700;
  for (const l of pg.lines) {
    if (y < 60) break;
    p.drawText(winAnsi(l), { x: 72, y, size: 9, font });
    y -= 12;
  }
}
const pdfRaw = overlays[0]?.front.provenance?.raw ?? "raw/city-amendments/2025-03-01/ordinance-2025-7.pdf";
const pdfPath = path.join(rawRoot, pdfRaw);
mkdirSync(path.dirname(pdfPath), { recursive: true });
writeFileSync(pdfPath, Buffer.from(await pdf.save()));
hashes[pdfRaw] = sha(pdfPath);
const work = path.join(rawRoot, "work");
const r = await extract({ input: pdfPath, work, force: true });
written.push(`${path.relative(root, pdfPath)} (${r.report.pages.length} pages, ${r.report.elements} elements -> ${path.relative(root, r.dir)})`);

// 4. Real hashes into the fixture files.
let rewritten = 0;
for (const d of docs) {
  const raw = d.front.provenance?.raw;
  if (!raw || !hashes[raw]) continue;
  const next = d.text.replace(/^(\s*raw_sha256:\s*)"[0-9a-f]{64}"/m, `$1"${hashes[raw]}"`);
  if (next !== d.text) {
    writeFileSync(d.file, next, "utf-8");
    rewritten++;
  }
}
console.log(`wrote ${written.join("; ")}; raw_sha256 rewritten in ${rewritten} files`);
