import { describe, it, expect } from "vitest";
import {
  organizeDocument,
  parseDocument,
  reconcileIdentity,
} from "../src/document.js";
import type { Element, ExtractReport } from "../src/elements/types.js";
const sha = "a".repeat(64);
const report: ExtractReport = {
  input: "input.md",
  doc_sha: sha,
  format: "markdown",
  recipe_sha256: "b".repeat(64),
  pages: [],
  elements: 3,
  tables: 0,
  scanned_pages: [],
  elapsed_ms: 0,
  notes: [],
};
const element = (
  seq: number,
  text: string,
  type: Element["type"] = "paragraph",
): Element => ({
  doc_sha: sha,
  page: 1,
  seq,
  text,
  type,
  bbox: null,
  font_size: null,
  bold: false,
  confidence: 1,
  flags: [],
  locator: { type: "text", line_start: seq + 1, line_end: seq + 1 },
});
const doc = (
  effective = "2026-01-01",
  elements = [
    element(0, "# Income", "heading"),
    element(1, "Must not exceed 43%."),
    element(2, "## Records", "heading"),
    element(3, "Two years of records."),
  ],
) =>
  organizeDocument({
    document: "DOC:test:one",
    effective,
    raw: "input.md",
    report,
    elements,
  });
describe("source region contract and unit identity", () => {
  it("retains hierarchy and every source region independently of chunks", () => {
    const d = doc();
    expect(d.regions).toHaveLength(4);
    expect(d.units[1].parent).toBe(d.units[0].id);
    expect(d.regions[1].text).toContain("not");
  });
  it("rejects text hash changes, omissions, cycles and duplicate assignments", () => {
    const d = doc();
    d.regions[1].text = "different";
    expect(() => parseDocument(d)).toThrow("hash");
    const c = doc();
    c.regions[0].parent = c.regions[2].id;
    expect(() => parseDocument(c)).toThrow("cycle");
    const e = doc();
    e.units[1].regions.push(e.units[0].regions[0]);
    expect(() => parseDocument(e)).toThrow();
  });
  it("never guesses first-row table headers", () => {
    const e = element(0, "Measure | Value", "table");
    e.table_grid = [
      ["Measure", "Value"],
      ["Dose", "5 mg"],
    ];
    const d = doc("2026-01-01", [e]);
    expect(d.regions[0].cells.every((c) => !c.headers.length)).toBe(true);
    expect(d.regions[0].uncertainty).toContain(
      "table_header_associations_unknown",
    );
  });
  it("keeps exact unique units stable when moved", () => {
    const first = reconcileIdentity(doc());
    const next = doc("2026-02-01");
    next.units.reverse();
    const second = reconcileIdentity(next, first.ledger);
    expect(second.conflicts).toEqual([]);
    expect(second.document.units.map((u) => u.id)).toEqual(
      first.document.units.map((u) => u.id).reverse(),
    );
  });
  it("preserves unchanged native identity across textual revisions", () => {
    const d = doc();
    d.units[0].native_id = "policy-1";
    const first = reconcileIdentity(d);
    const n = doc("2026-02-01", [
      element(0, "# Income", "heading"),
      element(1, "Must not exceed 40%."),
      element(2, "## Records", "heading"),
      element(3, "Two years of records."),
    ]);
    n.units[0].native_id = "policy-1";
    expect(reconcileIdentity(n, first.ledger).document.units[0].id).toBe(
      first.document.units[0].id,
    );
  });
  it("holds fuzzy changes and retirements without inventing matches", () => {
    const first = reconcileIdentity(doc());
    const changed = doc("2026-02-01", [
      element(0, "# Income", "heading"),
      element(1, "Must not exceed 40%."),
    ]);
    expect(
      reconcileIdentity(changed, first.ledger).conflicts.length,
    ).toBeGreaterThan(0);
  });
  it("holds duplicate exact text instead of claiming either identity", () => {
    const first = reconcileIdentity(doc());
    const n = doc("2026-02-01");
    n.units[1].content_sha256 = n.units[0].content_sha256;
    expect(reconcileIdentity(n, first.ledger).conflicts.length).toBeGreaterThan(
      0,
    );
  });
  it("requires explicit receipts for reviewed mappings and retains transitions", () => {
    const first = reconcileIdentity(doc());
    const next = doc("2026-02-01", [
      element(0, "# New", "heading"),
      element(1, "New wording"),
    ]);
    const result = reconcileIdentity(next, first.ledger, [
      {
        from: first.document.units.map((u) => u.id),
        to: [next.units[0].id],
        receipt_sha256: "c".repeat(64),
      },
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.ledger.transitions.at(-1)?.basis).toBe("human");
    expect(Object.keys(result.ledger.revisions)).toHaveLength(2);
  });
});
