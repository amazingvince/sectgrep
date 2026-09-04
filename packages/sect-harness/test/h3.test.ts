import { splitFrontMatter } from "@sectgrep/convert";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { ingest } from "../src/ingest.js";
import { mergeRun } from "../src/merge.js";
import { resolveConflict } from "../src/resolve.js";
import { verifyRun, type VerifyReport } from "../src/verifier.js";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const fixtureRoot = path.resolve(here, "../../../fixtures");
const fixture = path.join(fixtureRoot, "corpus");
const tmp = () => mkdtempSync(path.join(tmpdir(), "sect-h3-"));

/** A git corpus from the fixture, with the fixture's amended § 2.7 rolled back to its prior text. */
function priorCorpus(root: string): string {
  const corpus = path.join(root, "corpus");
  cpSync(fixture, corpus, { recursive: true, filter: (p) => !p.includes(".sect") && !path.basename(p).startsWith("2026-00001") });
  rmSync(path.join(corpus, "fr"), { recursive: true, force: true });
  const dir = path.join(corpus, "cfr-title-99", "I", "A", "2", "2.7");
  rmSync(path.join(dir, "99-2.7.md"));
  renameSync(path.join(dir, "99-2.7@2024-01-01.md"), path.join(dir, "99-2.7.md"));
  const prior = readFileSync(path.join(dir, "99-2.7.md"), "utf-8").replace(/^superseded_by:.*$/m, "superseded_by: null");
  writeFileSync(path.join(dir, "99-2.7.md"), prior, "utf-8");
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: root });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "prior"], { cwd: root });
  return corpus;
}

describe("notices end to end (D.2 step 9) on the fixture register document", () => {
  it("stages the notice, composes the new Expression in code, verifies the Actions, merges both Expressions, and answers history", async () => {
    const root = tmp();
    const corpus = priorCorpus(root);
    // WS2's output for the notice: the fixture's converted notice, as delivered, with its registry entry.
    const input = path.join(root, "input", "fr");
    mkdirSync(path.join(input, "2026"), { recursive: true });
    writeFileSync(path.join(input, "2026", "2026-00001.md"), readFileSync(path.join(fixture, "fr", "2026", "2026-00001.md"), "utf-8"), "utf-8");
    writeFileSync(path.join(input, "_source.yaml"), readFileSync(path.join(fixture, "fr", "_source.yaml"), "utf-8"), "utf-8");
    const staging = path.join(root, "staging");
    const review = path.join(root, "review");
    const run = await ingest({ input, source: "fr", corpus, staging, rawRoot: fixtureRoot, work: path.join(fixtureRoot, "work"), dryRun: true, log: () => {} });
    expect(run.errors).toBe(0);
    expect(run.summary).not.toBeNull();
    // The staging holds the notice, the new Expression of § 2.7, its prior text marked superseded, and the ancestors.
    const newFile = path.join(run.runDir, "cfr-title-99", "I", "A", "2", "2.7", "99-2.7.md");
    const priorFile = path.join(run.runDir, "cfr-title-99", "I", "A", "2", "2.7", "99-2.7@2024-01-01.md");
    expect(existsSync(newFile)).toBe(true);
    expect(existsSync(priorFile)).toBe(true);
    const nf = YAML.parse(splitFrontMatter(readFileSync(newFile, "utf-8"))!.front) as Record<string, unknown>;
    expect(nf.effective).toBe("2026-01-01");
    expect(nf.supersedes).toBe("CFR:99-2.7@2024-01-01");
    expect(nf.amended_by).toEqual(["FR:2026-00001#instr-1"]);
    expect((nf.provenance as { legal_status: string; derived_from: string }).legal_status).toBe("derived");
    expect(readFileSync(newFile, "utf-8")).toContain("A cage or well is not a means of fall protection");
    expect(YAML.parse(splitFrontMatter(readFileSync(priorFile, "utf-8"))!.front).superseded_by).toBe("CFR:99-2.7@2026-01-01");
    expect(existsSync(path.join(run.runDir, "cfr-title-99", "I", "A", "2", "99-2.md"))).toBe(true);
    // The verifier confirms the Action's target; consensus agrees; the evidence checks pass.
    const report = await verifyRun({
      runDir: run.runDir, input, source: "fr", corpus, staging, review, work: path.join(fixtureRoot, "work"), log: () => {},
      verify: async (prompt) => ({ answer: { xrefs: [], defines: [], actions: prompt.includes("instr-1") ? [{ action_id: "FR:2026-00001#instr-1", target_id: "CFR:99-2.7", target_anchor: "b", kind: "amend" }] : [] } }),
    });
    const notice = report.sections.find((s) => s.id === "FR:2026-00001")!;
    expect(notice.judgments.some((j) => j.field === "action" && j.agree)).toBe(true);
    expect(notice.tier).toBe("auto");
    const derived = report.sections.find((s) => s.id === "CFR:99-2.7")!;
    expect(derived.evidence.filter((e) => e.level === "fail")).toEqual([]);
    expect(derived.tier).toBe("auto");
    // Merge: the notice and both Expressions reach the corpus; the prior file is superseded.
    const m = mergeRun({ runDir: run.runDir, source: "fr", corpus, review, commit: true, log: () => {} });
    expect(m.held).toBe(0);
    expect(existsSync(path.join(corpus, "fr", "2026", "2026-00001.md"))).toBe(true);
    expect(existsSync(path.join(corpus, "cfr-title-99", "I", "A", "2", "2.7", "99-2.7@2024-01-01.md"))).toBe(true);
    expect(readFileSync(path.join(corpus, "cfr-title-99", "I", "A", "2", "2.7", "99-2.7.md"), "utf-8")).toContain("amended_by:\n  - FR:2026-00001#instr-1");
  });
});

describe("overlays end to end (D.2 step 8) on the fixture city amendments", () => {
  it("stages the items with their overrides, verifies against search-derived candidates, holds a disagreement, and merges the rest; resolve settles it", async () => {
    const root = tmp();
    const corpus = path.join(root, "corpus");
    cpSync(fixture, corpus, { recursive: true, filter: (p) => !p.includes(".sect") && !p.includes("city-amendments") });
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
    const input = path.join(root, "input", "city-amendments");
    cpSync(path.join(fixture, "city-amendments"), input, { recursive: true });
    const staging = path.join(root, "staging");
    const review = path.join(root, "review");
    const run = await ingest({ input, source: "city-amendments", corpus, staging, rawRoot: fixtureRoot, work: path.join(fixtureRoot, "work"), dryRun: true, log: () => {} });
    expect(run.errors).toBe(0);
    // A dry run keeps the converter's proposals in the staged file; the agent's would be in the record.
    const am1 = YAML.parse(splitFrontMatter(readFileSync(path.join(run.runDir, "city-amendments", "AM-1.md"), "utf-8"))!.front) as { overrides: string[] };
    expect(am1.overrides).toEqual(["CFR:99-2.8"]);
    // The verifier agrees on AM-1 and disagrees on AM-2's narrowing.
    const report = await verifyRun({
      runDir: run.runDir, input, source: "city-amendments", corpus, staging, review, work: path.join(fixtureRoot, "work"), log: () => {},
      verify: async (prompt) => ({ answer: { xrefs: [], defines: [], overrides: prompt.includes("AM-1.md") ? ["CFR:99-2.8"] : [], narrows: prompt.includes("AM-2.md") ? [{ id: "CFR:99-1.1", anchor: null }] : [] } }),
    });
    expect(report.sections.find((s) => s.id === "CITY:AM-1")?.tier).toBe("auto");
    expect(report.sections.find((s) => s.id === "CITY:AM-2")?.tier).toBe("conflict");
    const m = mergeRun({ runDir: run.runDir, source: "city-amendments", corpus, review, commit: true, log: () => {} });
    expect(m.merged).toBe(1);
    expect(m.held).toBe(1);
    expect(existsSync(path.join(corpus, "city-amendments", "AM-1.md"))).toBe(true);
    // A person sides with ingest on AM-2; it merges.
    const skill = path.join(root, "SKILL.md");
    writeFileSync(skill, "# skill\n", "utf-8");
    const res = resolveConflict({ runDir: run.runDir, input, source: "city-amendments", corpus, review, work: path.join(fixtureRoot, "work"), rawRoot: fixtureRoot, id: "CITY:AM-2", pick: "ingest", skillPath: skill, commit: true, log: () => {} });
    expect(res.tier).toBe("auto");
    expect(existsSync(path.join(corpus, "city-amendments", "AM-2.md"))).toBe(true);
    expect(readFileSync(skill, "utf-8")).toContain("CITY:AM-2");
    const final = JSON.parse(readFileSync(path.join(run.runDir, "verify.json"), "utf-8")) as VerifyReport;
    expect(final.counts.conflict).toBe(0);
  });
});
