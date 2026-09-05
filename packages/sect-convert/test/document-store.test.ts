import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { extract } from "../src/extract.js";
import { organizeDocument, reconcileIdentity } from "../src/document.js";
import { ingestFile } from "../src/ingest-file.js";
import { packSource, exportSource } from "../src/document-store.js";

it.each(["migrate", "native"])(
  "%s document store retains revisions, retirements, and exact export bytes",
  async (mode) => {
    const root = mkdtempSync(path.join(tmpdir(), "sect-document-store-"));
    const out = path.join(root, "corpus"),
      input = path.join(root, "guide.md"),
      work = path.join(root, "work");
    const bin =
      process.env.SECT_BIN ??
      path.resolve(
        "../../target/debug/sect" +
          (process.platform === "win32" ? ".exe" : ""),
      );
    const invoke = (...args: string[]) => {
      const run = spawnSync(bin, [...args, "--corpus", out, "--json"], {
        encoding: "utf8",
      });
      expect(run.status, run.stderr + run.stdout).toBe(0);
      return JSON.parse(run.stdout);
    };
    const ingest = async (
      effective: string,
      text: string,
      inputMode?: "markdown" | "document",
    ) => {
      writeFileSync(input, text);
      const extraction = await extract({ input, work });
      const elements = readFileSync(
        path.join(extraction.dir, "elements.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      // The fixture supplies the same simple ordinal identities across these known revisions.
      const { document } = reconcileIdentity(
        organizeDocument({
          document: "DOC:test:guide",
          effective,
          raw: `assets/${extraction.report.doc_sha}.md`,
          report: extraction.report,
          elements,
        }),
      );
      await ingestFile({
        input,
        work,
        out,
        source: "test",
        id: "guide",
        effective,
        inputMode,
        prepared: { ...extraction, document },
      });
      return document;
    };
    const first = await ingest(
      "2025-01-01",
      "# Eligibility\n\nA naïve borrower must not exceed 1.0 percent.\n\n# Exceptions\n\nA waiver requires seven records.",
      mode === "native" ? "document" : "markdown",
    );
    const id = first.units[0].id;
    if (mode === "migrate") {
      const before = readFileSync(
        path.join(out, "test/guide/u000001.md"),
        "utf8",
      );
      expect(packSource(out, "test").sections).toBe(3);
      const bundle = JSON.parse(
        readFileSync(path.join(out, "test/guide.sections.json"), "utf8"),
      );
      expect(bundle.sections["test/guide/u000001.md"]).toBe(before);
    } else
      expect(existsSync(path.join(out, "test/guide/u000001.md"))).toBe(false);
    invoke("index", out, "--embedding", "none", "--ngram", "on");
    expect(JSON.stringify(invoke("read", id))).toContain("1.0 percent");
    await ingest(
      "2025-02-01",
      "# Eligibility\n\nA naïve borrower must not exceed 2.0 percent.",
    );
    invoke("index", out);
    expect(JSON.stringify(invoke("read", `${id}@2025-01-01`))).toContain(
      "1.0 percent",
    );
    expect(JSON.stringify(invoke("read", id))).toContain("2.0 percent");
    const retired = first.units[1].id;
    expect(JSON.stringify(invoke("read", `${retired}@2025-01-01`))).toContain(
      "seven records",
    );
    const search = invoke("search", "waiver", "--fts", "--as-of", "2025-03-01");
    expect(
      search.result.hits.some((h: { id: string }) => h.id === retired),
    ).toBe(false);
    const exported = exportSource(out, "test");
    expect(exported.sections).toBe(5);
    const packed = JSON.parse(
      readFileSync(path.join(out, "test/guide.sections.json"), "utf8"),
    );
    expect(
      readFileSync(path.join(out, "test/exports/guide/u000001.md"), "utf8"),
    ).toBe(packed.sections["test/guide/u000001.md"]);
    writeFileSync(
      path.join(out, "test/exports/guide/u000001.md"),
      "Fake ignored export",
    );
    expect(JSON.stringify(invoke("read", id))).toContain("2.0 percent");
    const lines = invoke("grep", "naïve", "-g", "*.md", "--source", "test");
    expect(lines.result.total_matches).toBe(2);
  },
  30000,
);
