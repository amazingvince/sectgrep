import { describe, expect, it } from "vitest";
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import JSZip from "jszip";
import { JSDOM } from "jsdom";
import { docxElements } from "../src/elements/office.js";
import { organizeDocument, parseDocument } from "../src/document.js";
import { validOfficeLocator, readOfficeXml } from "../src/locators.js";

describe("native DOCX source addresses", () => {
  it("resolves unique paragraphs and tables in original XML and leaves duplicate text uncertain", async () => {
    const buffer = await Packer.toBuffer(new Document({ sections: [{ children: [
      new Paragraph({ text: "Calibration rules", heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ children: [new TextRun("Keep the α pressure "), new TextRun({ text: "below 25 kPa.", bold: true })] }),
      new Paragraph("Repeated condition."), new Paragraph("Repeated condition."),
      new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph("Sample")] }), new TableCell({ children: [new Paragraph("Pressure (kPa)")] })] }),
        new TableRow({ children: [new TableCell({ children: [new Paragraph("sample-79")] }), new TableCell({ children: [new Paragraph("25")] })] })] }),
    ] }] }));
    const elements = await docxElements(buffer, "a".repeat(64));
    const mapped = elements.filter(e => e.locator?.type === "office");
    expect(mapped).toHaveLength(3);
    expect(elements.filter(e => e.text === "Repeated condition.")).toHaveLength(2);
    expect(elements.filter(e => e.text === "Repeated condition.").every(e => !e.locator && e.flags.includes("native_office_match_ambiguous"))).toBe(true);
    const zip = await JSZip.loadAsync(buffer);
    expect(await readOfficeXml(buffer, "word/document.xml")).toEqual(await zip.file("word/document.xml")!.async("string"));
    await expect(readOfficeXml(buffer, "../document.xml")).rejects.toThrow("invalid Office source part");
    for (const e of mapped) {
      const locator = e.locator!;
      if (locator.type !== "office") throw new Error("expected native Office locator");
      const dom = new JSDOM(await zip.file(locator.part)!.async("string"), { contentType: "application/xml" });
      try {
        const node = dom.window.document.evaluate(locator.xpath, dom.window.document, null, dom.window.XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        expect(node).not.toBeNull();
        expect(node!.textContent).toContain(e.type === "table" ? "sample-79" : e.text);
      } finally { dom.window.close(); }
    }
    const artifact = organizeDocument({ document: "DOC:test:office", effective: "2026-09-05", raw: "fixture.docx", elements,
      report: { input: "fixture.docx", doc_sha: "a".repeat(64), format: "docx", pages: [], elements: elements.length, tables: 1, scanned_pages: [], elapsed_ms: 0, notes: [] } });
    expect(parseDocument(artifact).regions.filter(r => r.locator.type === "office")).toHaveLength(3);
    const invalid = structuredClone(artifact);
    invalid.regions.find(r => r.locator.type === "office")!.locator = { type: "office", part: "../document.xml", xpath: "/*[1]" };
    expect(() => parseDocument(invalid)).toThrow("invalid region locator");
  });

  it("rejects unsafe package parts without treating them as filesystem paths", () => {
    for (const part of ["../document.xml", "/word/document.xml", "C:/document.xml", "word\\document.xml", "word//document.xml", "word/./document.xml", "word/evil\u0001.xml"])
      expect(validOfficeLocator(part, "/*[1]")).toBe(false);
    expect(validOfficeLocator("word/document.xml", "/*[1]/*[1]/*[3]")).toBe(true);
  });
});
