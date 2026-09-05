import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { ingestFile } from "../src/ingest-file.js";
import { extract } from "../src/extract.js";
import { parseKnowledge } from "../src/knowledge.js";
import { mergeTranscriptions } from "../src/ocr/dual.js";
import JSZip from "jszip";
import { jsonElements } from "../src/elements/generic.js";

it("preserves JSON number tokens beyond binary64 precision and range", () => {
  const tokens = ["9007199254740993", "-9007199254740993", "1.2300e-7", "-0", "1e9999", "1e-9999"];
  const elements = jsonElements(`{"records":[{"values":[${tokens.join(",")}]}]}`, "a".repeat(64));
  expect(elements.map(e => e.text.split(": ")[1])).toEqual(tokens);
  expect(elements.every(e => e.flags.includes("json_numeric_source_preserved"))).toBe(true);
  expect(jsonElements("9007199254740993", "a".repeat(64))[0].text).toBe("/: 9007199254740993");
  expect(jsonElements('{"text":"9007199254740993","empty":{},"no":null}', "a".repeat(64)).map(e => e.text)).toEqual([
    '/text: "9007199254740993"', "/empty: {}", "/no: null",
  ]);
});

it("finds the original large numeric identifier after JSON ingestion and Rust indexing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sect-json-number-"));
  const input = path.join(root, "records.json"), out = path.join(root, "corpus");
  writeFileSync(input, '{"records":[{"id":9007199254740993,"threshold":1.2300e-7}]}');
  await ingestFile({ input, out, work: path.join(root, "work"), source: "research", id: "records", effective: "2026-01-01", profile: "generic" });
  const bin = process.env.SECT_BIN ?? path.resolve("../../target/debug/sect" + (process.platform === "win32" ? ".exe" : ""));
  const indexed = spawnSync(bin, ["index", out, "--embedding", "none", "--json"], { encoding: "utf8" });
  expect(indexed.status, indexed.stderr + indexed.stdout).toBe(0);
  for (const needle of ["9007199254740993", "1.2300e-7"]) {
    const found = spawnSync(bin, ["--corpus", out, "grep", "-F", needle, "-g", "*.md", "--json"], { encoding: "utf8" });
    expect(found.status, found.stderr).toBe(0);
    const result = JSON.parse(found.stdout).result;
    expect(result.total_matches).toBeGreaterThan(0);
    expect(result.lines.some((line: { text: string }) => line.text.includes(needle))).toBe(true);
  }
  const rounded = spawnSync(bin, ["--corpus", out, "grep", "-F", "9007199254740992", "-g", "*.md", "--json"], { encoding: "utf8" });
  expect(JSON.parse(rounded.stdout).result.total_matches).toBe(0);
});

it("builds and searches lending and research documents through the same adapter contract", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sect-general-"));
  const out = path.join(root, "corpus");
  const work = path.join(root, "work");
  for (const [source, content] of [["lending", "# Income documentation\n\nThe borrower must not exceed 1.0 percent.\n\n# Exception\n\nSeasonal income requires supporting records."], ["research", "# Experiment\n\nThe ablation experiment measures predictive accuracy.\n\n# Dataset\n\nA biomedical cohort contains 120 participants."]]) {
    const input = path.join(root, `${source}.md`); writeFileSync(input, content);
    const r = await ingestFile({ input, out, work, source, id: "guide", effective: "2026-01-01", profile: source });
    expect(r.held).toBe(0); expect(r.documents).toBe(3);
    expect(parseKnowledge(JSON.parse(readFileSync(r.artifact, "utf8"))).profile.name).toBe(source);
  }
  const bin = process.env.SECT_BIN ?? path.resolve("../../target/debug/sect" + (process.platform === "win32" ? ".exe" : ""));
  const build = spawnSync(bin, ["index", out, "--embedding", "none", "--json"], { encoding: "utf8" });
  expect(build.status, build.stderr + build.stdout).toBe(0);
  for (const [query, source] of [["seasonal income", "lending"], ["ablation experiment", "research"]]) {
    const r = spawnSync(bin, ["search", query, "--corpus", out, "--fts", "--json"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).result.hits[0].source).toBe(source);
  }
}, 30000);

it.each([["json", '{"method":"ablation","value":-1.5}'], ["xml", '<article><title>Experiment</title><p>Observed response is not positive.</p></article>'], ["csv", 'Class,Maximum\nA,10\nB,20\n'], ["tsv", 'Class\tMaximum\nA\t10\nB\t20\n']])("extracts %s with addressable native records", async (extension, content) => {
  const root = mkdtempSync(path.join(tmpdir(), "sect-adapter-"));
  const input = path.join(root, `input.${extension}`); writeFileSync(input, content);
  const r = await extract({ input, work: path.join(root, "work") });
  expect(r.report.format).toBe(extension);
  expect(r.report.elements).toBeGreaterThan(0);
  const elements = readFileSync(path.join(r.dir, "elements.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  if (["xml", "json"].includes(extension)) expect(elements.every((e) => e.locator)).toBe(true);
});

it("does not reconcile a decimal shift or negation deletion as OCR agreement", () => {
  for (const [a, b] of [["The value is 1.0 percent.", "The value is 10 percent."], ["This must not apply.", "This must apply."]]) {
    const r = mergeTranscriptions(a, b, "a".repeat(64), 1, 0);
    expect(r.divergent).toBeGreaterThan(0);
  }
});

it("rejects unversioned and malformed enrichment at the TypeScript boundary", () => {
  expect(() => parseKnowledge({})).toThrow(/invalid knowledge/);
});

it("holds same-date replacements and invalid dates, and preserves earlier revisions", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sect-revision-"));
  const input = path.join(root, "guide.md");
  const options = { input, work: path.join(root, "work"), out: path.join(root, "corpus"), source: "lending", id: "manual", effective: "2026-01-01" };
  writeFileSync(input, "# Index\n\nBorrower must not exceed 1.0 percent.");
  await ingestFile(options);
  const unit = path.join(options.out, "lending/manual/section-index.md");
  const prior = readFileSync(unit, "utf8");
  writeFileSync(input, "# Index\n\nBorrower must not exceed 2.0 percent.");
  await expect(ingestFile(options)).rejects.toThrow(/immutable/);
  expect(readFileSync(unit, "utf8")).toBe(prior);
  await expect(ingestFile({ ...options, effective: "2026-02-30" })).rejects.toThrow(/real/);
  await ingestFile({ ...options, effective: "2026-02-01" });
  expect(readFileSync(unit.replace(".md", "@2026-01-01.md"), "utf8")).toContain("1.0 percent");
  expect(readFileSync(unit, "utf8")).toContain("2.0 percent");
  writeFileSync(input, "# Renamed\n\nChanged topology.");
  await expect(ingestFile({ ...options, effective: "2026-03-01" })).rejects.toThrow(/topology/);
});

it("rejects tampered extraction cache outputs", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sect-cache-tamper-"));
  const input = path.join(root, "a.txt"); writeFileSync(input, "Must not exceed 1.0 percent.");
  const options = { input, work: path.join(root, "work") };
  const first = await extract(options);
  writeFileSync(path.join(first.dir, "elements.jsonl"), "[]");
  const second = await extract(options);
  expect(second.fromCache).toBe(false);
  expect(readFileSync(path.join(second.dir, "elements.jsonl"), "utf8")).toContain("Must not exceed");
});

it("retains presentation order, shape locators and table cells", async () => {
  const zip = new JSZip();
  zip.file("ppt/presentation.xml", '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="second"/><p:sldId r:id="first"/></p:sldIdLst></p:presentation>');
  zip.file("ppt/_rels/presentation.xml.rels", '<Relationships><Relationship Id="first" Target="slides/slide1.xml"/><Relationship Id="second" Target="slides/slide2.xml"/></Relationships>');
  for (const i of [1, 2]) zip.file(`ppt/slides/slide${i}.xml`, `<p:sld xmlns:p="p" xmlns:a="a"><p:sp><p:cNvPr id="${i}"/><p:ph type="title"/><a:p><a:t>Slide ${i}</a:t></a:p></p:sp><a:tbl><a:tr><a:tc><a:t>Rate</a:t></a:tc><a:tc><a:t>1.0</a:t></a:tc></a:tr></a:tbl></p:sld>`);
  const root = mkdtempSync(path.join(tmpdir(), "sect-slides-"));
  const input = path.join(root, "deck.pptx"); writeFileSync(input, await zip.generateAsync({ type: "nodebuffer" }));
  const result = await extract({ input, work: path.join(root, "work") });
  const elements = readFileSync(path.join(result.dir, "elements.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s));
  expect(elements[0].text).toBe("Slide 2");
  expect(elements[0].locator).toMatchObject({ type: "slide", slide: 1, shape: "2" });
  expect(elements.find(e => e.table_grid).table_grid).toEqual([["Rate", "1.0"]]);
});
