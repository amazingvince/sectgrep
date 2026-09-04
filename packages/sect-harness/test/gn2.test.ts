import { convertEcfr } from "@sectgrep/convert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ingest, sectionPrompt } from "../src/ingest.js";
import { mergeRun } from "../src/merge.js";
import { bareReferences, knownFromNodes, preResolve } from "../src/refs.js";
import { cfrSource } from "./registry-helpers.js";
import { resolveConflict } from "../src/resolve.js";
import { trimResult } from "../src/sect-tools.js";
import { verifyRun, type VerifyReport } from "../src/verifier.js";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const tmp = () => mkdtempSync(path.join(tmpdir(), "sect-gn2-"));

describe("pre-resolution of explicit citations (G-N2)", () => {
  const known = knownFromNodes(
    [
      { id: "CFR:77", title: "Title 77", level: "title", parent: null, source: "cfr-title-77" },
      { id: "CFR:77-1", title: "General", level: "part", parent: "CFR:77", source: "cfr-title-77" },
      { id: "CFR:77-2", title: "Ladders", level: "part", parent: "CFR:77", source: "cfr-title-77" },
      { id: "CFR:77-1.1", title: "Purpose", level: "section", parent: "CFR:77-1", source: "cfr-title-77" },
      { id: "CFR:77-1.2", title: "Fixed ladders", level: "section", parent: "CFR:77-1", source: "cfr-title-77" },
      { id: "CFR:77-2.5", title: "Other", level: "section", parent: "CFR:77-2", source: "cfr-title-77" },
      { id: "CFR:1-1.2", title: "Scope", level: "section", parent: null, source: "cfr-title-1" },
    ],
    [cfrSource(77), cfrSource(1)],
  );
  const anchors = new Map([["CFR:77-1.1", new Set(["a", "b", "b-1"])], ["CFR:77-2.5", new Set(["a"])]]);

  it("finds the registry's forms, containers by level and number, paragraphs and ancestors, and leaves prose alone", () => {
    const body = "# § 1.1 Purpose\n\nSee § 2.5(a), part 1, 1 CFR 1.2 and paragraph (b)(1) of this section; also paragraphs (a) and (b) of this section, this part and this title.";
    expect([...bareReferences(body, known, "CFR:77-1.1")].sort()).toEqual(["§ 2.5(a)", "part 1", "1 CFR 1.2", "paragraph (b)(1) of this section", "this part", "this title"].sort());
  });

  it("links a citation with exactly one real target in code, keeps an anchor only when the target has it, and leaves the rest to the agent", () => {
    const body = "See § 2.5(a) and § 2.5(z); part 1; 1 CFR 1.2; paragraph (b)(1) of this section; paragraph (c) of this section; § 9.9; § 1.2.";
    const r = preResolve(body, "CFR:77-1.1", known, anchors);
    const byText = Object.fromEntries(r.resolved.map((x) => [x.text, x]));
    expect(byText["§ 2.5(a)"]).toMatchObject({ id: "CFR:77-2.5", anchor: "a", confidence: 1, deterministic: true });
    // The target has no anchor z: the section link stands, the anchor is dropped.
    expect(byText["§ 2.5(z)"]).toMatchObject({ id: "CFR:77-2.5", anchor: null });
    expect(byText["part 1"]).toMatchObject({ id: "CFR:77-1" });
    expect(byText["1 CFR 1.2"]).toMatchObject({ id: "CFR:1-1.2" });
    expect(byText["paragraph (b)(1) of this section"]).toMatchObject({ id: "CFR:77-1.1", anchor: "b-1" });
    // § 1.2 exists in two sources: the node's own source wins (spec-changes #11).
    expect(byText["§ 1.2"]).toMatchObject({ id: "CFR:77-1.2" });
    // Paragraph (c) is not an anchor of this section; § 9.9 is nowhere.
    expect([...r.remaining].sort()).toEqual(["paragraph (c) of this section", "§ 9.9"].sort());
    // From a node of no known source, a number two sources have stays with the agent.
    expect(preResolve("See § 1.2.", "CFR:5-1.1", known).remaining).toEqual(["§ 1.2"]);
  });

  it("builds a prompt that names the links made, the references left, and the converter's terms, and shows a long body's head with the sentences that matter", () => {
    const long = "A. ".repeat(7000) + "The word *widget* means a thing. See § 9.9 for more.";
    const p = sectionPrompt("x/1.1.md", long, [{ text: "part 1", id: "CFR:77-1", confidence: 1, deterministic: true }], ["§ 9.9"], ["widget"]);
    expect(p).toContain('"part 1" -> CFR:77-1');
    expect(p).toContain('Resolve with sect_search (limit 3, one search each): "§ 9.9"');
    expect(p).toContain("Terms the converter detected as defined: widget");
    expect(p).toContain("[the rest of the section is not shown]");
    expect(p).toContain("- The word *widget* means a thing.");
    expect(p).toContain("- See § 9.9 for more.");
    expect(p.length).toBeLessThan(13_500);
  });
});

describe("trimmed search results", () => {
  const raw = [
    "freshness: fresh (218 files indexed; stat 11 ms; built 2026-09-04T06:24:12Z)",
    "counts: 3 shown of 130 matched; 218 works, 218 expressions (0 superseded), 1 sources; candidates-lexical 100; candidates-vector 100; limit 3",
    'search: "practice by attorneys"; mode fuse (bm25 + vector, rrf k=60); weights lex 1.0 vec 1.0; embedding model2vec:minishlab/potion-retrieval-32M',
    "1. CFR:4-11.2@2024-07-18  § 11.2 Practice by attorneys  eff 2024-07-18  score 1.089 (lex 1, vec 1)  refs in 1 / out 0",
    "   Title 4 Accounts > Chapter I Government Accountability Office > Subchapter A Personnel System > Part 11 Recognition of Attorneys and Other Representatives > § 11.2 Practice by attorneys",
    "   L3: Any person who is a member in good standing of the bar of the Supreme Court may practice before the Office.",
    "2. CFR:4-28.89@2024-07-18  § 28.89 Fees and costs  eff 2024-07-18  score 1.036 (lex 4, vec 6)  refs in 2 / out 2",
    "   Title 4 Accounts > Chapter I > Part 28 Procedures > § 28.89 Fees and costs",
    "   L1: # § 28.89 Fees and costs",
    "   L9: Nothing here about the query at all.",
  ].join("\n");
  it("drops the preamble, keeps the hit headers, shortens breadcrumbs, and keeps matching lines with one line of context", () => {
    const t = trimResult(raw, "practice by attorneys");
    expect(t).not.toContain("freshness:");
    expect(t).not.toContain("candidates-lexical");
    expect(t).toContain("1. CFR:4-11.2@2024-07-18  § 11.2 Practice by attorneys");
    expect(t).not.toContain("score 1.089");
    expect(t).toContain("... > Part 11 Recognition of Attorneys and Other Representatives > § 11.2 Practice by attorneys");
    expect(t).toContain("L3: Any person");
    expect(t).toContain("2. CFR:4-28.89@2024-07-18  § 28.89 Fees and costs");
    expect(t).not.toContain("L9: Nothing here");
    expect(t.length).toBeLessThan(raw.length / 2);
  });
  it("caps a long result", () => {
    expect(trimResult("1. CFR:1-1.1 x\n" + "   query line\n".repeat(1000), "query", 500).length).toBeLessThan(560);
  });
});

describe("resolve: a person's decision carried back into the run", () => {
  it("re-stages the section, re-checks it, merges it with what it unblocked, and appends the example to the skill", async () => {
    const root = tmp();
    const XML = readFileSync(path.join(here, "harness.test.ts"), "utf-8").match(/const XML = `([\s\S]*?)`;/)![1];
    const r = convertEcfr(XML, { title: 77, rawPath: "raw/cfr-title-77/2024-01-01/ECFR-title77.xml", ingestRun: "ws2" });
    const input = path.join(root, "input", "cfr-title-77");
    for (const f of r.files) {
      const p = path.join(root, "input", f.path);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, f.text, "utf-8");
    }
    mkdirSync(path.join(root, "raw", "cfr-title-77", "2024-01-01"), { recursive: true });
    writeFileSync(path.join(root, "raw", "cfr-title-77", "2024-01-01", "ECFR-title77.xml"), XML, "utf-8");
    const corpus = path.join(root, "corpus");
    mkdirSync(corpus, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
    const staging = path.join(root, "staging");
    const review = path.join(root, "review");
    const run = await ingest({ input, source: "cfr-title-77", corpus, staging, rawRoot: root, work: path.join(root, "work"), dryRun: true, log: () => {} });
    expect(run.summary).not.toBeNull();
    // The verifier disagrees on § 1.3's definitions; everything else agrees.
    await verifyRun({
      runDir: run.runDir, input, source: "cfr-title-77", corpus, staging, review, work: path.join(root, "work"), log: () => {},
      verify: async (prompt) => ({ answer: { xrefs: [], defines: prompt.includes("77-1.3.md") ? ["Fixed ladder", "Extra term"] : [] } }),
    });
    const first = mergeRun({ runDir: run.runDir, source: "cfr-title-77", corpus, review, commit: true, log: () => {} });
    expect(first.held).toBe(2);
    const skill = path.join(root, "SKILL-ingest.md");
    writeFileSync(skill, "# Ingest agent\n\nRules.\n", "utf-8");
    // A person sides with ingest on the definitions.
    const res = resolveConflict({ runDir: run.runDir, input, source: "cfr-title-77", corpus, review, work: path.join(root, "work"), rawRoot: root, id: "CFR:77-1.3", pick: "ingest", why: "the extra term is only mentioned, not defined", skillPath: skill, commit: true, log: () => {} });
    expect(res.applied).toHaveLength(1);
    expect(res.applied[0]).toMatchObject({ field: "defines", resolved: "ingest", agree: true });
    expect(res.tier).toBe("auto");
    expect(res.remaining).toBe(0);
    // The section, the one that linked to it, and the part whose listing had been de-linked are
    // written now; the rest was already there unchanged.
    expect(res.merge?.merged).toBe(3);
    expect(res.merge?.held).toBe(0);
    expect(res.merge?.unchanged).toBe(first.merged - 1);
    const listing = readFileSync(path.join(corpus, "cfr-title-77", "I", "1", "77-1.md"), "utf-8");
    expect(listing).not.toContain("(held for review)");
    expect(listing).toContain("](CFR:77-1.3)");
    expect(res.merge?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(path.join(corpus, "cfr-title-77", "I", "1", "1.3", "77-1.3.md"))).toBe(true);
    expect(existsSync(path.join(corpus, "cfr-title-77", "I", "1", "1.1", "77-1.1.md"))).toBe(true);
    const staged = readFileSync(path.join(run.runDir, "cfr-title-77", "I", "1", "1.3", "77-1.3.md"), "utf-8");
    expect(staged).toContain("resolutions:");
    expect(staged).toContain("defines -> Fixed ladder (ingest,");
    const report = JSON.parse(readFileSync(path.join(run.runDir, "verify.json"), "utf-8")) as VerifyReport;
    expect(report.counts.conflict).toBe(0);
    expect(report.resolutions).toHaveLength(1);
    expect(report.resolutions?.[0]).toMatchObject({ id: "CFR:77-1.3", pick: "ingest", value: "Fixed ladder" });
    const md = readFileSync(path.join(review, `${run.runId}.md`), "utf-8");
    expect(md).toContain("## Resolved");
    expect(md).toContain("No conflicts.");
    const skillText = readFileSync(skill, "utf-8");
    expect(skillText).toContain("## Examples from review");
    expect(skillText).toContain("- CFR:77-1.3, defines: ingest proposed `Fixed ladder`, the verifier `Fixed ladder, Extra term`; a person chose `Fixed ladder` because the extra term is only mentioned, not defined");
    // Nothing left to resolve.
    expect(() => resolveConflict({ runDir: run.runDir, input, source: "cfr-title-77", corpus, review, id: "CFR:77-1.3", pick: "ingest", skillPath: skill, noMerge: true, log: () => {} })).toThrow(/no open disagreement/);
  });
});
