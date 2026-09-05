import { describe, expect, it } from "vitest";
import { organizeDocument } from "../src/document.js";
import { htmlElements, xlsxElements } from "../src/elements/office.js";
import { xmlElements, jsonElements } from "../src/elements/generic.js";
import { pageBlocks, type PdfPage } from "../src/elements/pdf.js";
import { markHeadersFooters } from "../src/passes.js";
import type { Element, ExtractReport } from "../src/elements/types.js";

const sha = "a".repeat(64);
const element = (
  seq: number,
  text: string,
  type: Element["type"] = "heading",
  page = 1,
): Element => ({
  doc_sha: sha,
  page,
  seq,
  text,
  type,
  bbox: [72, 100 + seq * 10, 500, 110 + seq * 10],
  font_size: 12,
  bold: type === "heading",
  confidence: 1,
  flags: [],
});
const report: ExtractReport = {
  input: "manual.pdf",
  format: "pdf",
  doc_sha: sha,
  pages: [1, 2, 3].map((page) => ({
    page,
    width: 612,
    height: 792,
    chars: 1000,
  })),
  elements: 0,
  tables: 0,
  scanned_pages: [],
  elapsed_ms: 0,
  notes: [],
};
const organize = (elements: Element[]) =>
  organizeDocument({
    document: "DOC:test:manual",
    effective: "2026-09-05",
    raw: "manual.pdf",
    report,
    elements,
  });

describe("retrieval structure", () => {
  it("does not mistake alphabetic C/D or c/d for Roman hundred/five-hundred levels", () => {
    const d=organize([element(0,"II. Manual"),element(1,"C. Program"),element(2,"c. Income"),element(3,"d. Documentation"),element(4,"(A) Standard"),element(5,"D. Appraisers"),element(6,"E. Other programs")]);
    expect(d.regions.map(r=>r.heading_level)).toEqual([1,2,4,4,6,2,2]);
    expect(d.units[6].parent).toBe(d.units[0].id);
  });
  it("keeps JSON object records coherent and separate while retaining scalar pointers", () => {
    const elements = jsonElements(
      '{"records":[{"id":"a","temperature":283,"confirmed":true},{"id":"b","temperature":301,"confirmed":false}]}',
      sha,
    );
    const d = organizeDocument({
      document: "DOC:test:records",
      effective: "2026-09-05",
      raw: "records.json",
      report: { ...report, format: "json" },
      elements,
    });
    expect(d.units).toHaveLength(2);
    expect(d.units.map((u) => u.regions.length)).toEqual([3, 3]);
    expect(d.regions.map((r) => r.locator)).toContainEqual({
      type: "record",
      pointer: "/records/1/confirmed",
    });
    expect(d.units.every((u) => u.parent === null)).toBe(true);
    expect(jsonElements('{"empty":{}}', sha)).toHaveLength(1);
  });
  it("keeps sheets separate and preserves merged cells without inventing headers", () => {
    const elements = xlsxElements(
      [
        {
          sheet: "A",
          rows: [["Pressure", ""]],
          merges: [{ r0: 0, c0: 0, r1: 0, c1: 1 }],
          footnotes: [],
        },
        { sheet: "B", rows: [["Temperature"]], merges: [], footnotes: [] },
      ],
      sha,
    );
    const d = organizeDocument({
      document: "DOC:test:book",
      effective: "2026-09-05",
      raw: "book.xlsx",
      report: { ...report, format: "xlsx" },
      elements,
    });
    expect(d.units.map((u) => u.title)).toEqual(["A", "B"]);
    expect(d.regions[0].cells).toHaveLength(1);
    expect(d.regions[0].cells[0]).toMatchObject({
      column_span: 2,
      role: "unknown",
    });
  });
  it("does not demote the body heading because the same title appears in running heads", () => {
    const title = "4. Underwriting the Borrower";
    const source = [
      element(0, title, "heading", 1),
      element(1, title, "heading", 2),
      element(2, title, "heading", 3),
    ];
    source[0].bbox = [72, 20, 500, 35];
    source[1].bbox = [72, 20, 500, 35];
    source[2].bbox = [72, 100, 500, 112];
    source[2].heading_level = 3;
    markHeadersFooters(source, { 1: 792, 2: 792, 3: 792 });
    expect(source[2].type).toBe("heading");
    const d = organize([
      ...source,
      element(3, "c. Income Requirements"),
      element(4, "(A) Definition"),
    ]);
    expect(d.units.some((u) => u.title === title)).toBe(true);
  });
  it("preserves TOTAL and Manual scopes, nested standards and editorial annotations", () => {
    const texts = [
      "II. Origination",
      "A. Mortgages",
      "4. Underwriting (TOTAL)",
      "x. Self-Employment Income (TOTAL)",
      "(A) Definition",
      "(B) Standard",
      "(1) Minimum Length",
      "(2) Stability",
      "[Text was deleted in this section.]",
      "5. Manual Underwriting",
      "x. Self-Employment Income (Manual)",
      "(A) Definition",
      "(B) Standard",
      "(2) Stability",
    ];
    const source = texts.map((text, i) => element(i, text));
    const d = organize(source);
    const at = (title: string) => d.units.find((u) => u.title === title)!;
    const standards = d.units.filter((u) => u.title === "(B) Standard");
    expect(standards[0].parent).toBe(at(texts[3]).id);
    expect(standards[1].parent).toBe(at(texts[10]).id);
    expect(
      d.units.filter((u) => u.title === "(2) Stability").map((u) => u.parent),
    ).toEqual(standards.map((u) => u.id));
    expect(d.regions[8].kind).toBe("paragraph");
    expect(d.regions.map((r) => r.text)).toEqual(texts);
    expect(source.every((e) => e.heading_level === undefined)).toBe(true);
  });
  it("keeps repeated page furniture as evidence without interrupting a provision", () => {
    const source = [
      element(0, "II. Origination"),
      element(1, "(A) Definition"),
      element(2, "First paragraph.", "paragraph"),
    ];
    for (const page of [1, 2, 3]) {
      const e = element(
        source.length,
        "Handbook running title",
        "heading",
        page,
      );
      e.bbox = [72, 20, 500, 35];
      source.push(e);
    }
    source.push(element(6, "Continuation on another page.", "paragraph", 3));
    const d = organize(source);
    expect(d.regions.slice(3, 6).every((r) => r.exclusion)).toBe(true);
    expect(d.units.at(-1)!.regions).toContain(d.regions[6].id);
    expect(d.units).toHaveLength(2);
  });
  it("does not reorder a single-column page by indentation", () => {
    const page: PdfPage = {
      page: 1,
      width: 612,
      height: 792,
      chars: 1000,
      lines: [],
    };
    for (let i = 0; i < 10; i++)
      page.lines.push({
        items: [],
        x0: i % 2 ? 144 : 72,
        y0: 100 + i * 30,
        x1: 520,
        y1: 112 + i * 30,
        size: 12,
        bold: false,
        text: `Paragraph ${i}`,
      });
    expect(pageBlocks(page).flatMap((b) => b.lines.map((l) => l.text))).toEqual(
      page.lines.map((l) => l.text),
    );
  });
  it("keeps native HTML article locators and excludes footer divs inside main", () => {
    const { elements } = htmlElements(
      "<main><p>Share this page</p><article><h1>Policy</h1><h2>Income</h2><p>Keep this requirement.</p></article><div><h2>Have questions?</h2><p>Log in</p></div></main>",
      sha,
    );
    expect(
      elements.find((e) => e.text === "Keep this requirement.")?.exclusion,
    ).toBeUndefined();
    expect(elements.find((e) => e.text === "Log in")?.exclusion).toBeTruthy();
    expect(
      elements.find((e) => e.text === "Keep this requirement.")?.locator,
    ).toEqual({
      type: "xml",
      xpath: "/html[1]/body[1]/main[1]/article[1]/p[1]",
    });
  });
  it("preserves explicit table headers, spans, captions and JATS footnote links", () => {
    const xml =
      '<article><article-title>Study</article-title><sec><title>Results</title><table-wrap><caption>Participants</caption><table><thead><tr><th id="group" rowspan="2">Group</th><th colspan="2" scope="col">Outcome (mg)</th></tr><tr><th id="before">Before</th><th id="after">After</th></tr></thead><tbody><tr><td headers="group">Trial<xref ref-type="fn" rid="note">a</xref></td><td headers="before">5</td><td headers="after">7</td></tr></tbody></table><table-wrap-foot><fn id="note"><p>Adults only; exclude withdrawals.</p></fn></table-wrap-foot></table-wrap></sec></article>';
    const elements = xmlElements(xml, sha);
    const table = elements.find((e) => e.type === "table")!;
    const after = table.cells!.find((c) => c.text === "After")!;
    expect(after.column).toBe(2);
    expect(table.cells!.find((c) => c.text === "7")!.headers).toContain(
      after.id,
    );
    expect(elements.find((e) => e.type === "caption")!.caption_of).toBe(
      table.seq,
    );
    expect(elements.find((e) => e.native_id === "note")!.footnote_of).toContain(
      table.seq,
    );
    const d = organizeDocument({
      document: "DOC:test:study",
      effective: "2026-09-05",
      raw: "study.xml",
      report: { ...report, format: "xml" },
      elements,
    });
    expect(
      d.regions.some(
        (r) => r.footnote_of.length && r.text.includes("exclude withdrawals"),
      ),
    ).toBe(true);
  });
});
