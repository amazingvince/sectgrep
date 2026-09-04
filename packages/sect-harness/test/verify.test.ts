import { convertEcfr } from "@sectgrep/convert";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { evidenceChecks } from "../src/evidence.js";
import { ingest } from "../src/ingest.js";
import { mergeRun, rollback } from "../src/merge.js";
import { drawSample, grade, nextLevel, plan, type SamplingState } from "../src/sampling.js";
import { candidatesFor, consensus, parseAnswer, verifyRun, type VerifierAnswer } from "../src/verifier.js";
import { knownFromNodes } from "../src/refs.js";
import { cfrSource } from "./registry-helpers.js";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const fixture = path.resolve(here, "../../../fixtures/corpus");
const tmp = () => mkdtempSync(path.join(tmpdir(), "sect-h2-"));

describe("evidence checks (D.3 layer 2)", () => {
  it("pass on the fixture: overlays target base sections of lower precedence and share terms; the amended Expression carries the notice's text", () => {
    const r = evidenceChecks({ staging: fixture, corpus: fixture });
    expect(r.checked.overlays).toBe(3);
    expect(r.checked.actions).toBe(1);
    expect(r.issues.filter((i) => i.level === "fail")).toEqual([]);
  });

  it("fail when an override targets a notice, a higher-precedence source, or text it does not resemble; and when an Action's text is absent", () => {
    const root = tmp();
    cpSync(fixture, root, { recursive: true, filter: (p) => !p.includes(".sect") });
    const am1 = path.join(root, "city-amendments", "AM-1.md");
    writeFileSync(am1, readFileSync(am1, "utf-8").replace("overrides: [CFR:99-2.8]", "overrides: [FR:2026-00001, CFR:99-1.1]"), "utf-8");
    const src = path.join(root, "city-amendments", "_source.yaml");
    writeFileSync(src, readFileSync(src, "utf-8").replace("precedence: 200", "precedence: 50"), "utf-8");
    const sec = path.join(root, "cfr-title-99", "I", "A", "2", "2.7", "99-2.7.md");
    const text = readFileSync(sec, "utf-8");
    const mutated = text.replace(/A cage or well is not a means of fall protection[^\n]*/, "Cages remain acceptable everywhere.");
    expect(mutated).not.toBe(text);
    writeFileSync(sec, mutated, "utf-8");
    const r = evidenceChecks({ staging: root, corpus: root });
    const fails = r.issues.filter((i) => i.level === "fail").map((i) => `${i.field}: ${i.message}`);
    // A notice has no Expression an overlay could replace at the overlay's date.
    expect(fails.some((m) => m.includes("FR:2026-00001 has no Expression active"))).toBe(true);
    expect(fails.some((m) => m.includes("precedence 100 is not below 50"))).toBe(true);
    expect(fails.some((m) => m.includes("amended_by") && m.includes("not present"))).toBe(true);
    // The purpose section shares a corpus-defined term with the guardrail overlay, so similarity is not asked.
    expect(fails.some((m) => m.includes("CFR:99-1.1: shares no defined term"))).toBe(false);
  });
});

describe("consensus and candidates", () => {
  const known = knownFromNodes(
    [
      { id: "CFR:77", title: "Title 77", level: "title", parent: null, source: "cfr-title-77" },
      { id: "CFR:77-1", title: "General", level: "part", parent: "CFR:77", source: "cfr-title-77" },
      { id: "CFR:77-1.1", title: "Purpose", level: "section", parent: "CFR:77-1", source: "cfr-title-77" },
      { id: "CFR:77-1.2", title: "Fixed ladders", level: "section", parent: "CFR:77-1", source: "cfr-title-77" },
      { id: "CFR:1-1", title: "General provisions", level: "part", parent: null, source: "cfr-title-1" },
      { id: "CFR:1-1.2", title: "Scope", level: "section", parent: "CFR:1-1", source: "cfr-title-1" },
    ],
    [cfrSource(77), cfrSource(1)],
  );
  it("offers only real ids as candidates, home title first", () => {
    expect(candidatesFor("§ 1.2", "CFR:77-1.1", known).map((c) => c.id)).toEqual(["CFR:77-1.2", "CFR:1-1.2"]);
    expect(candidatesFor("1 CFR 1.2", "CFR:77-1.1", known).map((c) => c.id)).toEqual(["CFR:1-1.2"]);
    // Two sources have a part 1: the node's own source first, and the choice is a judgment.
    expect(candidatesFor("part 1", "CFR:77-1.1", known).map((c) => c.id)).toEqual(["CFR:77-1", "CFR:1-1"]);
    expect(candidatesFor("paragraph (b)(1) of this section", "CFR:77-1.1", known)[0]).toMatchObject({ id: "CFR:77-1.1", anchor: "b-1" });
    expect(candidatesFor("this part", "CFR:77-1.1", known)[0]).toMatchObject({ id: "CFR:77-1" });
    expect(candidatesFor("§ 9.9", "CFR:77-1.1", known)).toEqual([]);
  });

  it("agrees on identical ids, treats a lone explicit citation as deterministic, and lists every disagreement with both proposals", () => {
    const record = { id: "CFR:77-1.1", input: "x.md", path: "cfr-title-77/x.md", context: "", defines: ["Covered workplace"], flags: [], body_tokens: 10, xrefs: [{ text: "§ 1.2", id: "CFR:77-1.2", confidence: 1, search: "§ 1.2" }, { text: "part 1", id: "CFR:77-1", confidence: 0.7, search: "part 1" }] };
    const refs = ["§ 1.2", "part 1", "§ 9.9"];
    const candidates = new Map(refs.map((t) => [t, candidatesFor(t, "CFR:77-1.1", known)]));
    const answer: VerifierAnswer = { xrefs: [{ text: "§ 1.2", id: "CFR:77-1.2", confidence: 1 }, { text: "part 1", id: null, confidence: 0.4, reason: "no part in this title" }, { text: "§ 9.9", id: null, confidence: 0 }], defines: ["covered workplace"] };
    const j = consensus(record, answer, refs, candidates, "normal", {});
    expect(j.find((x) => x.text === "§ 1.2")).toMatchObject({ agree: true, deterministic: false });
    expect(j.find((x) => x.text === "part 1")).toMatchObject({ agree: false, ingest: "CFR:77-1", verifier: "(none)" });
    expect(j.find((x) => x.field === "defines")).toMatchObject({ agree: true });
    // Tightened inspection turns a low-confidence agreement into a conflict.
    const tight = consensus(record, { ...answer, xrefs: [...answer.xrefs.slice(0, 1), { text: "part 1", id: "CFR:77-1", confidence: 0.9 }] }, refs, candidates, "tightened", {});
    expect(tight.find((x) => x.text === "part 1")).toMatchObject({ agree: false });
    expect(consensus(record, { ...answer, xrefs: [...answer.xrefs.slice(0, 1), { text: "part 1", id: "CFR:77-1", confidence: 0.9 }] }, refs, candidates, "normal", {}).find((x) => x.text === "part 1")).toMatchObject({ agree: true });
  });

  it("parses the verifier's JSON with or without fences", () => {
    expect(parseAnswer('```json\n{"xrefs":[{"text":"§ 1.2","id":"CFR:77-1.2","confidence":1}],"defines":["x"]}\n```').xrefs[0].id).toBe("CFR:77-1.2");
    expect(parseAnswer('Here: {"xrefs":[],"defines":[]} done').defines).toEqual([]);
    expect(() => parseAnswer("no json here")).toThrow(/without JSON/);
  });
});

describe("sampling (Z1.4 switching, spec defaults)", () => {
  it("plans 20/32/8 at accept 0 and switches as the standard says", () => {
    expect(plan("normal")).toEqual({ level: "normal", n: 20, accept: 0 });
    expect(plan("tightened").n).toBe(32);
    expect(plan("reduced").n).toBe(8);
    const lot = (accepted: boolean, errors = accepted ? 0 : 1): SamplingState["lots"][number] => ({ run_id: "r", date: "d", n: 20, graded: 20, errors, accepted });
    expect(nextLevel({ source: "s", level: "normal", lots: [lot(true), lot(false), lot(true), lot(false)] })).toBe("tightened");
    expect(nextLevel({ source: "s", level: "tightened", lots: [lot(false), lot(true), lot(true), lot(true), lot(true), lot(true)] })).toBe("normal");
    expect(nextLevel({ source: "s", level: "tightened", lots: [lot(true), lot(true), lot(true), lot(true)] })).toBe("tightened");
    expect(nextLevel({ source: "s", level: "normal", lots: Array.from({ length: 10 }, () => lot(true)) })).toBe("reduced");
    expect(nextLevel({ source: "s", level: "reduced", lots: [lot(true), lot(false)] })).toBe("normal");
  });
});

describe("verify, sample, grade, merge, rollback on a dry-run ingest", () => {
  it("runs end to end with an injected verifier; conflicts are held, the auto tier is merged and committed, and revert removes it", async () => {
    const root = tmp();
    // Input: the small Title 77 converted; corpus: an empty git repository with a corpus/ directory.
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
    const run = await ingest({ input, source: "cfr-title-77", corpus, staging, rawRoot: root, work: path.join(root, "work"), dryRun: true, log: () => {} });
    expect(run.summary).not.toBeNull();
    // The injected verifier disagrees on one section's definitions and agrees elsewhere.
    const report = await verifyRun({
      runDir: run.runDir, input, source: "cfr-title-77", corpus, staging, review: path.join(root, "review"), work: path.join(root, "work"), log: () => {},
      verify: async (prompt) => ({ answer: { xrefs: [], defines: prompt.includes("77-1.3.md") ? ["Fixed ladder", "Extra term"] : [] } }),
    });
    expect(report.counts.sections).toBe(run.staged);
    expect(report.sections.find((s) => s.id === "CFR:77-1.3")?.tier).toBe("conflict");
    expect(report.sections.find((s) => s.id === "CFR:77-1.1")?.tier).toBe("auto");
    const review = readFileSync(path.join(root, "review", `${run.runId}.md`), "utf-8");
    expect(review).toContain("CFR:77-1.3");
    expect(review).toContain("verifier says");
    expect(review).not.toContain("## CFR:77-1.1");
    // Sample from the auto tier and grade it.
    const sample = drawSample(report, "cfr-title-77", "normal");
    expect(sample.items.length).toBeGreaterThan(0);
    expect(sample.items.every((i) => i.id !== "CFR:77-1.3")).toBe(true);
    writeFileSync(path.join(run.runDir, "sample.json"), JSON.stringify(sample), "utf-8");
    const g = grade(run.runDir, path.join(root, "review"), sample.items[0].id, true);
    expect(g.lot?.graded).toBe(1);
    // Merge the auto tier with a commit, then roll it back.
    const m = mergeRun({ runDir: run.runDir, source: "cfr-title-77", corpus, review: path.join(root, "review"), commit: true, log: () => {} });
    // § 1.1 links to the held § 1.3, so it is blocked; everything else in the auto tier merges.
    expect(m.blocked).toBe(1);
    expect(m.held).toBe(2);
    expect(m.merged).toBe(report.counts.auto - 1);
    expect(m.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(path.join(root, "review", `${run.runId}.md`), "utf-8")).toContain("CFR:77-1.1: links to CFR:77-1.3");
    const merged = readFileSync(path.join(corpus, "cfr-title-77", "I", "1", "1.2", "77-1.2.md"), "utf-8");
    expect(merged).toContain(`verifier:${run.runId}`);
    expect(merged).toContain(`ingest:${run.runId}`);
    expect(existsSync(path.join(corpus, "cfr-title-77", "I", "1", "1.3", "77-1.3.md"))).toBe(false);
    expect(existsSync(path.join(corpus, "cfr-title-77", "I", "1", "1.1", "77-1.1.md"))).toBe(false);
    const rb = rollback(m.commit!, corpus);
    expect(rb.reverted).not.toBe(m.commit);
    expect(existsSync(path.join(corpus, "cfr-title-77", "I", "1", "1.2", "77-1.2.md"))).toBe(false);
  });
});
