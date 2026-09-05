import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Document, Packer, Paragraph, Table, TableCell, TableRow, HeadingLevel } from "docx";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { paragraphAnchors } from "../src/anchors.js";
import { extract } from "../src/extract.js";
import { alignLines, mergeTranscriptions, similarity } from "../src/ocr/dual.js";
import type { PageImage } from "../src/ocr/render.js";
import type { Transcriber, Transcription } from "../src/ocr/transcriber.js";
import { buildStructure, jsRegex, rejoinHyphenation, termCandidates, xrefCandidates } from "../src/passes.js";
import type { Element } from "../src/elements/types.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "sect-c1-"));

describe("paragraph anchors (port of the sect rule)", () => {
  it("nests letters, numbers, numerals, and compound runs", () => {
    const a = paragraphAnchors("(a) First.\n(b)(1) Opens b and b-1.\n(i) Under b-1.\n(ii) Also.\n(2)(i) Second.\n(c) Plain.").map((x) => x.anchor);
    expect(a).toEqual(["a", "b", "b-1", "b-1-i", "b-1-ii", "b-2", "b-2-i", "c"]);
    expect(paragraphAnchors("(h) H.\n(1) One.\n(i) Letter.\n(j) J.").map((x) => x.anchor)).toEqual(["h", "h-1", "i", "j"]);
  });
});

async function makePdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const page of [1, 2]) {
    const pg = pdf.addPage([612, 792]);
    pg.drawText("29 CFR Ch. XVII (7-1-24 Edition)", { x: 72, y: 760, size: 8, font });
    pg.drawText(page === 1 ? "§ 1910.27 Scaffolds and rope descent systems." : "§ 1910.28 Duty to have fall protection.", { x: 72, y: 700, size: 14, font: bold });
    const lines = page === 1
      ? ["(a) Scaffolds. Scaffolds used in general industry must meet the require-", "ments in 29 CFR part 1926, subpart L and paragraph (b)(1) of this section.", "(b) Rope descent systems. Anchorage means a secure point of attachment.", "See § 1910.140 for personal fall protection systems and part 1926."]
      : ["(a) General. The employer must ensure that each employee is protected.", "(b) Unprotected sides and edges. Guardrail systems are required."];
    lines.forEach((t, i) => pg.drawText(t, { x: 72, y: 660 - i * 16, size: 10, font }));
    pg.drawText(String(page), { x: 300, y: 30, size: 8, font });
  }
  return Buffer.from(await pdf.save());
}

describe("elements from born-digital inputs", () => {
  it("pdf: lines, blocks, headings, bboxes, passes, cache", async () => {
    const work = tmp();
    const file = path.join(work, "in.pdf");
    writeFileSync(file, await makePdf());
    const { report, dir, fromCache } = await extract({ input: file, work, homeTitle: "29", pattern: { id_pattern: "(?i)§\\s*(?P<part>\\d+)\\.(?P<section>\\d+)", id_template: "CFR:29-{part}.{section}" } });
    expect(fromCache).toBe(false);
    expect(report.format).toBe("pdf");
    expect(report.pages).toHaveLength(2);
    expect(report.scanned_pages).toEqual([]);
    const els: Element[] = readFileSync(path.join(dir, "elements.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    const heads = els.filter((e) => e.type === "heading");
    expect(heads.map((h) => h.text)).toEqual(["§ 1910.27 Scaffolds and rope descent systems.", "§ 1910.28 Duty to have fall protection."]);
    expect(heads[0].flags).toContain("native_id:CFR:29-1910.27");
    expect(heads[0].bbox![1]).toBeLessThan(heads[0].bbox![3]);
    expect(els.some((e) => e.type === "header")).toBe(true);
    expect(els.some((e) => e.text.includes("requirements in 29 CFR part 1926"))).toBe(true);
    const xrefs = readFileSync(path.join(dir, "xrefs_candidates.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(xrefs.some((x) => x.form === "section" && x.id === "CFR:29-1910.140")).toBe(true);
    expect(xrefs.some((x) => x.form === "cfr" && x.id === "CFR:29-1926")).toBe(true);
    expect(xrefs.some((x) => x.form === "paragraph-of-this-section" && x.anchor === "b-1")).toBe(true);
    const terms = JSON.parse(readFileSync(path.join(dir, "terms_candidates.json"), "utf-8"));
    expect(terms.some((t: { term: string }) => t.term === "Anchorage")).toBe(true);
    const structure = JSON.parse(readFileSync(path.join(dir, "structure.json"), "utf-8"));
    expect(structure).toHaveLength(2);
    expect(structure[0].native_id).toBe("CFR:29-1910.27");
    const again = await extract({ input: file, work });
    expect(again.fromCache).toBe(false); // The recipe changed: identifiers must be recomputed.
    expect((await extract({ input: file, work })).fromCache).toBe(true);
  });

  it("docx, html, xlsx", async () => {
    const work = tmp();
    const doc = new Document({ sections: [{ children: [new Paragraph({ text: "Fall protection policy", heading: HeadingLevel.HEADING_1 }), new Paragraph("Employees must use guardrails. Toeboard means a low barrier."), new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph("Item")] }), new TableCell({ children: [new Paragraph("Height")] })] }), new TableRow({ children: [new TableCell({ children: [new Paragraph("Top rail")] }), new TableCell({ children: [new Paragraph("42 in")] })] })] })] }] });
    const docx = path.join(work, "p.docx");
    writeFileSync(docx, await Packer.toBuffer(doc));
    const d = await extract({ input: docx, work });
    const dEls: Element[] = readFileSync(path.join(d.dir, "elements.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(dEls[0]).toMatchObject({ type: "heading", text: "Fall protection policy" });
    expect(dEls.find((e) => e.type === "table")?.table_grid).toEqual([["Item", "Height"], ["Top rail", "42 in"]]);
    expect(JSON.parse(readFileSync(path.join(d.dir, "terms_candidates.json"), "utf-8"))[0].term).toBe("Toeboard");

    const html = path.join(work, "p.html");
    writeFileSync(html, "<html><head><title>Policy</title></head><body><nav>menu</nav><article><h1>Ladder policy</h1><p>Each ladder shall be inspected. See § 1910.23(b) and part 1926.</p><h2>Cages</h2><p>A cage is not fall protection.</p><ul><li>Inspect daily</li></ul></article></body></html>");
    const h = await extract({ input: html, work, homeTitle: "29" });
    const hEls: Element[] = readFileSync(path.join(h.dir, "elements.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(hEls.filter(e=>!e.exclusion).map((e) => e.type)).toEqual(["heading", "paragraph", "heading", "paragraph", "list_item"]);
    expect(hEls.find(e=>e.text==="menu")?.exclusion).toBe("document chrome or hidden content");
    expect(readFileSync(path.join(h.dir, "xrefs_candidates.jsonl"), "utf-8")).toContain('"anchor":"b"');

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Occupancy", "Load"], ["Office", "50 psf"], ["* Values per ASCE 7, applies to new construction"]]), "Loads");
    const xlsx = path.join(work, "g.xlsx");
    writeFileSync(xlsx, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
    const x = await extract({ input: xlsx, work });
    expect(x.report.tables).toBe(1);
    const grids = JSON.parse(readFileSync(path.join(x.dir, "grids.jsonl"), "utf-8").trim().split("\n")[0]);
    expect(grids.sheet).toBe("Loads");
    expect(grids.rows[1]).toEqual(["Office", "50 psf"]);
    expect(grids.footnotes).toHaveLength(1);
  });
});

describe("C.4 passes", () => {
  it("converts python named groups, joins hyphenation, builds a structure tree", () => {
    const re = jsRegex("(?i)§\\s*(?P<part>\\d+)\\.(?P<section>\\d+)");
    expect(re.exec("§ 1910.27")?.groups?.part).toBe("1910");
    const els: Element[] = [{ doc_sha: "x", page: 1, seq: 0, type: "paragraph", text: "the require-\nments apply", bbox: null, font_size: 10, bold: false, flags: [], confidence: 1 }];
    expect(rejoinHyphenation(els)).toBe(1);
    expect(els[0].text).toBe("the requirements apply");
    const heads: Element[] = [
      { doc_sha: "x", page: 1, seq: 0, type: "heading", text: "Part 1910", bbox: null, font_size: 16, bold: true, flags: [], confidence: 1 },
      { doc_sha: "x", page: 1, seq: 1, type: "heading", text: "§ 1910.27", bbox: null, font_size: 12, bold: true, flags: [], confidence: 1 },
      { doc_sha: "x", page: 1, seq: 2, type: "paragraph", text: "body", bbox: null, font_size: 10, bold: false, flags: [], confidence: 1 },
      { doc_sha: "x", page: 1, seq: 3, type: "heading", text: "§ 1910.28", bbox: null, font_size: 12, bold: true, flags: [], confidence: 1 },
    ];
    const tree = buildStructure(heads);
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((c) => c.text)).toEqual(["§ 1910.27", "§ 1910.28"]);
    expect(tree[0].children[0].range).toEqual([1, 2]);
    expect(xrefCandidates(heads, null, "29").map((x) => x.id)).toEqual(["CFR:29-1910", "CFR:29-1910.27", "CFR:29-1910.28"]);
    expect(termCandidates([{ ...heads[2], text: "(a) Competent person means one who is capable of identifying hazards." }])[0].term).toBe("Competent person");
  });
});

describe("dual transcription", () => {
  it("aligns lines fuzzily and flags divergent readings", () => {
    expect(similarity("Guardrail height 42 inches", "Guardrail  height 42 inches.")).toBeGreaterThan(0.9);
    const a = ["(a) Each employer shall provide.", "(b) The top rail shall be 42 inches.", "(c) Toeboards."];
    const b = ["(a) Each employer shall provide.", "(b) The top rail shall be 24 inches.", "(c) Toeboards."];
    const pairs = alignLines(a, b);
    expect(pairs).toEqual([[0, 0], [1, 1], [2, 2]]);
    const m = mergeTranscriptions(a.join("\n"), b.join("\n"), "sha", 3, 0);
    expect(m.lines).toBe(3);
    expect(m.divergent).toBe(1);
    expect(m.elements[1].flags).toContain("ocr_divergent");
    expect(m.elements[1].alt_text).toBe("(b) The top rail shall be 24 inches.");
    expect(m.elements[0].flags).toEqual([]);
    expect(m.elements[0].confidence).toBe(1);
  });

  it("runs the scanned-page path through injected transcribers", async () => {
    const work = tmp();
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]); // no text layer: a scanned page
    const file = path.join(work, "scan.pdf");
    writeFileSync(file, Buffer.from(await pdf.save()));
    const fake = (name: string, text: string): Transcriber => ({
      name, kind: "local",
      async transcribePage(image: PageImage): Promise<Transcription> {
        return { markdown: text, model: name, kind: "local", image: { widthPx: image.widthPx, heightPx: image.heightPx, dpi: image.dpi }, elapsedMs: 1 };
      },
    });
    let r: Awaited<ReturnType<typeof extract>>;
    try {
      r = await extract({ input: file, work, transcribers: { primary: fake("local:p", "(a) Line one.\n(b) Line two reads 42."), secondary: fake("local:s", "(a) Line one.\n(b) Line two reads 24.") } });
    } catch (e) {
      // Rendering needs poppler; without it the path cannot run here, which the report would say.
      if (String(e).includes("pdftoppm") || String(e).includes("pdfinfo") || String(e).includes("ENOENT")) return;
      throw e;
    }
    expect(r.report.scanned_pages).toEqual([1]);
    expect(r.report.ocr?.divergent_lines).toBe(1);
    const els: Element[] = readFileSync(path.join(r.dir, "elements.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(els.filter((e) => e.flags.includes("ocr_divergent"))).toHaveLength(1);
  });
});
