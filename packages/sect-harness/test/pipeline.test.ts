import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stage, Held } from "../src/pipeline/stages.js";
import { Budget } from "../src/pipeline/budget.js";
import {
  ReviewStore,
  sampleRecords,
  lotPolicy,
  type ReviewItem,
} from "../src/pipeline/review.js";
import { digest, hash } from "../src/pipeline/io.js";
import { publishFiles } from "../src/pipeline/publication.js";
const dir = () => mkdtempSync(path.join(tmpdir(), "sect-pipeline-"));
describe("resumable stage dependencies", () => {
  it("reuses complete stages only when both inputs and output bytes match", async () => {
    const run = dir();
    let calls = 0;
    const task = () => ({ calls: ++calls });
    const a = await stage(run, "doc", "extract", { raw: 1 }, "v1", task);
    expect(
      (await stage(run, "doc", "extract", { raw: 1 }, "v1", task)).reused,
    ).toBe(true);
    writeFileSync(
      path.join(run, "documents/doc/extract", a.receipt.output, "result.json"),
      "{}",
    );
    expect(
      (await stage(run, "doc", "extract", { raw: 1 }, "v1", task)).reused,
    ).toBe(false);
    await stage(run, "doc", "extract", { raw: 2 }, "v1", task);
    expect(calls).toBe(3);
  });
  it("resumes failed and held attempts without accepting partial output", async () => {
    const run = dir();
    await expect(
      stage(run, "doc", "extract", {}, "v1", () => {
        throw new Held("needs OCR");
      }),
    ).rejects.toThrow("OCR");
    const result = await stage(run, "doc", "extract", {}, "v1", () => ({
      ok: true,
    }));
    expect(result.value.ok).toBe(true);
  });
});
describe("campaign reservations", () => {
  it("shares a cap across connections and preserves ambiguous charges", () => {
    const file = path.join(dir(), "budget.sqlite");
    const a = new Budget(file),
      b = new Budget(file);
    try {
      a.reserve("first", { prompt: 1 }, 70);
      expect(() => b.reserve("second", { prompt: 2 }, 31)).toThrow("exhausted");
      expect(() => b.reserve("first", { prompt: 1 }, 70)).toThrow("ambiguous");
      a.reconcile("first", 2, { answer: "ok" });
      expect(b.reserve("first", { prompt: 1 }, 70).cached).toEqual({
        answer: "ok",
      });
      expect(b.status().remaining).toBe(98);
    } finally {
      a.close();
      b.close();
    }
  });
  it("rejects unknown prices and records unexpected provider overruns", () => {
    const b = new Budget(path.join(dir(), "budget.sqlite"));
    try {
      expect(() => b.reserve("bad", {}, NaN)).toThrow("unknown");
      b.reserve("call", {}, 1);
      expect(() => b.reconcile("call", 2, {})).toThrow("exceeded");
      expect(b.status().charged).toBe(2);
      expect(() => new Budget(path.join(dir(), "other.sqlite"), 101)).toThrow(
        "top-ups",
      );
    } finally {
      b.close();
    }
  });
});
describe("review receipts and sampling", () => {
  const fixture = () => {
    const run = dir();
    const file = path.join(run, "raw.txt");
    writeFileSync(file, "must not exceed 43%");
    const store = new ReviewStore(run);
    const item: ReviewItem = {
      id: "item",
      kind: "extraction",
      document: "doc",
      domain: "lending",
      format: "text",
      title: "Income",
      prompt: "Read source",
      source: [
        {
          file,
          sha256: hash(readFileSync(file)),
          locator: { type: "text", line_start: 1, line_end: 1 },
          text: "must not exceed 43%",
        },
      ],
      bindings: { [file]: hash(readFileSync(file)) },
      batch: 1,
    };
    store.put(item);
    return { run, file, store, item };
  };
  it("binds receipts to exact sources, keeps history, rejects stale decisions", () => {
    const { store, item, file } = fixture();
    try {
      const d = {
        item: item.id,
        item_sha256: digest(item),
        reviewer: "test-reviewer",
        decision: "accept" as const,
        reason: "Fixture check",
        checks: {
          text_fidelity: "passed" as const,
          reading_order: "passed" as const,
          structure: "not_applicable" as const,
          table_associations: "not_applicable" as const,
        },
      };
      const one = store.decide(d);
      const two = store.decide({ ...d, decision: "defer" });
      expect(two.previous).toBe(one.sha256);
      expect(store.accepted(item.id)).toBeNull();
      writeFileSync(file, "changed");
      expect(() => store.decide(d)).toThrow("stale");
      expect(store.export().receipts).toHaveLength(2);
    } finally {
      store.close();
    }
  });
  it("rejects incomplete checklists and model self-acceptance without a reviewer", () => {
    const { store, item } = fixture();
    try {
      expect(() =>
        store.decide({
          item: item.id,
          item_sha256: digest(item),
          reviewer: "",
          decision: "accept",
          reason: "",
          checks: {},
        }),
      ).toThrow();
      expect(() => store.put({ ...item, title: "changed" })).toThrow(
        "immutable",
      );
    } finally {
      store.close();
    }
  });
  it("is reproducibly randomized and keeps the minimum at 20", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      type: i % 2 ? "relation" : "concept",
    }));
    expect(sampleRecords(rows, 20, "seed", (r) => r.type)).toEqual(
      sampleRecords(rows, 20, "seed", (r) => r.type),
    );
    expect(
      sampleRecords(rows, 20, "seed", (r) => r.type).map((r) => r.id),
    ).not.toEqual(rows.slice(0, 20).map((r) => r.id));
    expect(lotPolicy([{ accepted: false }]).n).toBe(32);
    expect(
      lotPolicy([{ accepted: false }, ...Array(5).fill({ accepted: true })]).n,
    ).toBe(20);
  });
});
describe("publication failure", () => {
  it("restores exact corpus bytes when indexing fails", async () => {
    const corpus = dir();
    writeFileSync(path.join(corpus, "existing.md"), "original");
    await expect(
      publishFiles(
        corpus,
        { "existing.md": "new", "new.md": "new" },
        process.execPath,
      ),
    ).rejects.toThrow("index failed");
    expect(readFileSync(path.join(corpus, "existing.md"), "utf8")).toBe(
      "original",
    );
  });
});
