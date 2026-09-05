import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runPipeline } from "../src/pipeline/pipeline.js";
import { hash } from "../src/pipeline/io.js";
import { ReviewStore } from "../src/pipeline/review.js";

it.each(["markdown", "document"])(
  "%s input publishes healthy documents, reuses review identities on resume, and holds human-rejected text",
  async (input_mode) => {
    const root = mkdtempSync(path.join(tmpdir(), "sect-e2e-"));
    const raw =
      "# Income\n\nThe value must not exceed 43%.\n\n# Income\n\nThe value must not exceed 43%.\n";
    writeFileSync(path.join(root, "raw.md"), raw);
    writeFileSync(
      path.join(root, "profile.json"),
      JSON.stringify({
        name: "generic",
        version: "1",
        unit_types: [],
        concept_types: [],
        relation_types: [],
        metadata_fields: [],
      }),
    );
    const source = {
      id: "healthy",
      source: "test",
      input: "raw.md",
      sha256: hash(raw),
      effective: "2026-01-01",
      input_mode,
      profile: "profile.json",
      domain: "lending",
      license: "synthetic",
      url: "https://example.invalid/fixture",
    };
    const manifest = path.join(root, "manifest.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        schema_version: 1,
        name: "fixture",
        root: ".",
        run: "run",
        corpus: "corpus",
        campaign: "campaign",
        seed: "test",
        sources: [{ ...source, id: "broken", sha256: "b".repeat(64) }, source],
        enrichment: "off",
        discover_profiles: false,
        extraction_sample: { lending: 2, ml: 0, biomedical: 0 },
        sect_bin: process.env.SECT_BIN,
      }),
    );
    const first = await runPipeline(manifest, { publish: true });
    expect(first.prepared).toBe(1);
    expect(first.failures[0].document).toBe("broken");
    expect(first.published).toHaveLength(1);
    const second = await runPipeline(manifest);
    expect(second.pending_review).toBe(first.pending_review);
    const document = JSON.parse(
      readFileSync(
        path.join(root, "corpus/test/healthy.document.json"),
        "utf8",
      ),
    );
    const query = spawnSync(
      process.env.SECT_BIN!,
      [
        "--corpus",
        path.join(root, "corpus"),
        "read",
        document.units[0].id,
        "--json",
      ],
      { encoding: "utf8" },
    );
    expect(query.status, query.stderr).toBe(0);
    expect(JSON.parse(query.stdout).result.source_region_count).toBe(2);
    const store = new ReviewStore(path.join(root, "run"));
    const item = store.items()[0];
    store.decide({
      item: item.id,
      item_sha256: item.item_sha256,
      reviewer: "Synthetic test",
      decision: "reject",
      reason: "Exercise publication hold",
      checks: { text_fidelity: "failed" },
    });
    store.close();
    const third = await runPipeline(manifest, { publish: true });
    expect(third.published).toHaveLength(0);
    expect(
      third.failures.some((f) => f.reason.includes("human extraction error")),
    ).toBe(true);
  },
);
