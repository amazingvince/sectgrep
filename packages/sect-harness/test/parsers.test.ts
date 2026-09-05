import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readDoclingArtifact } from "../src/pipeline/parsers.js";
import { hash } from "../src/pipeline/io.js";

it("retains Docling original equation text and its source coordinates when normalized text is empty", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sect-docling-"));
  try {
    const raw = path.join(root, "source.pdf"),
      file = path.join(root, "artifact.json");
    writeFileSync(raw, "synthetic pinned PDF bytes");
    const artifact = {
      sect_adapter: {
        version: "2",
        raw_sha256: hash(readFileSync(raw)),
        coverage: "complete",
        conversion_status: "success",
        input_pages: 4,
        converted_pages: [1, 2, 3, 4],
        packages: { docling: "2.126.0" },
      },
      document: {
        body: {
          self_ref: "#/body",
          label: "body",
          children: [{ $ref: "#/texts/0" }],
        },
        texts: [
          {
            self_ref: "#/texts/0",
            parent: { $ref: "#/body" },
            label: "formula",
            text: "",
            orig: "sqrt(d_k)",
            prov: [
              {
                page_no: 4,
                bbox: {
                  l: 10,
                  t: 60,
                  r: 70,
                  b: 40,
                  coord_origin: "BOTTOMLEFT",
                },
              },
            ],
          },
        ],
        tables: [],
        pictures: [],
        groups: [],
        pages: Object.fromEntries(
          [1, 2, 3, 4].map((p) => [
            String(p),
            { size: { width: 100, height: 100 } },
          ]),
        ),
      },
    };
    writeFileSync(file, JSON.stringify(artifact));
    const out = readDoclingArtifact(file, raw, path.join(root, "out"));
    const e = JSON.parse(
      readFileSync(path.join(out.dir, "elements.jsonl"), "utf8"),
    );
    expect(e).toMatchObject({
      type: "equation",
      text: "sqrt(d_k)",
      locator: { page: 4, bbox: [10, 40, 70, 60] },
    });
    expect(e.flags).toContain("mathematical_layout_unverified");
    artifact.document.texts[0].prov.push({ page_no: 3, bbox: { l: 4, t: 20, r: 30, b: 40, coord_origin: "TOPLEFT" } });
    writeFileSync(file, JSON.stringify(artifact));
    const multiple = readDoclingArtifact(file, raw, path.join(root, "multiple"));
    const combined = JSON.parse(readFileSync(path.join(multiple.dir, "elements.jsonl"), "utf8"));
    expect(combined.locator).toEqual({ type: "pages", locations: [
      { page: 4, elements: [0], bbox: [10, 40, 70, 60] },
      { page: 3, elements: [0], bbox: [4, 20, 30, 40] },
    ] });
    expect(combined.flags).toContain("per_box_text_alignment_unverified");
    artifact.document.texts[0].prov[1].page_no = 5;
    writeFileSync(file, JSON.stringify(artifact));
    expect(() => readDoclingArtifact(file, raw, path.join(root, "invalid-box"))).toThrow("invalid Docling source location");
    artifact.document.texts[0].prov.pop();
    artifact.sect_adapter.conversion_status = "partial_success";
    writeFileSync(file, JSON.stringify(artifact));
    expect(() =>
      readDoclingArtifact(file, raw, path.join(root, "incomplete")),
    ).toThrow("partial Docling comparisons");
    artifact.sect_adapter.conversion_status = "success";
    artifact.sect_adapter.converted_pages = [1, 2, 4];
    writeFileSync(file, JSON.stringify(artifact));
    expect(() =>
      readDoclingArtifact(file, raw, path.join(root, "missing-page")),
    ).toThrow("partial Docling comparisons");
    artifact.sect_adapter.converted_pages = [1, 2, 3, 4];
    artifact.sect_adapter.coverage = "partial";
    writeFileSync(file, JSON.stringify(artifact));
    expect(() =>
      readDoclingArtifact(file, raw, path.join(root, "partial")),
    ).toThrow("partial Docling comparisons");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
