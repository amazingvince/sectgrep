import { convertEcfr, validateStaging } from "@sectgrep/convert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bareReferences, ingest, rawHashOf } from "../src/ingest.js";
import { claimRun, insideRun, lockSource, readLedger, runIdFor } from "../src/staging.js";
import { ALLOWED_TOOLS, applyXrefs, guardToolCall, harnessTools, stageSection, type RunContext } from "../src/tools.js";

// A small Title 77 as WS2 would deliver it: two parts, three sections, one bare reference.
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<DLPSTEXTCLASS><TEXT><BODY><ECFRBRWS>
<AMDDATE>Jan. 1, 2024</AMDDATE>
<DIV1 N="77" NODE="77:1" TYPE="TITLE">
<HEAD>Title 77—Fixture</HEAD>
<DIV3 N="I" NODE="77:1.0.1" TYPE="CHAPTER">
<HEAD>CHAPTER I—FIXTURE ADMINISTRATION</HEAD>
<DIV5 N="1" NODE="77:1.0.1.1.1" TYPE="PART">
<HEAD>PART 1—GENERAL</HEAD>
<DIV8 N="§ 1.1" NODE="77:1.0.1.1.1.0.1.1" TYPE="SECTION"><HEAD>§ 1.1   Purpose.</HEAD><P>(a) This part sets the minimum requirements for walking surfaces in covered workplaces, and refers to the ladder rules in § 1.2 and the definitions in § 1.3.</P><P>(b) <I>Covered workplace</I> means any workplace where an employee works on a walking surface.</P></DIV8>
<DIV8 N="§ 1.2" NODE="77:1.0.1.1.1.0.1.2" TYPE="SECTION"><HEAD>§ 1.2   Fixed ladders.</HEAD><P>(a) Each fixed ladder must be inspected before use.</P><P>(b) A cage is not fall protection on a ladder taller than 24 feet.</P></DIV8>
<DIV8 N="§ 1.3" NODE="77:1.0.1.1.1.0.1.3" TYPE="SECTION"><HEAD>§ 1.3   Definitions.</HEAD><P><I>Fixed ladder</I> means a ladder permanently attached to a structure.</P></DIV8>
</DIV5>
</DIV3></DIV1>
</ECFRBRWS></BODY></TEXT></DLPSTEXTCLASS>
`;

function makeInput(): { root: string; input: string; corpus: string } {
  const root = mkdtempSync(path.join(tmpdir(), "sect-h1-"));
  const rawDir = path.join(root, "raw", "cfr-title-77", "2024-01-01");
  mkdirSync(rawDir, { recursive: true });
  writeFileSync(path.join(rawDir, "ECFR-title77.xml"), XML, "utf-8");
  const r = convertEcfr(XML, { title: 77, rawPath: "raw/cfr-title-77/2024-01-01/ECFR-title77.xml", ingestRun: "ws2" });
  const input = path.join(root, "input");
  for (const f of r.files) {
    const p = path.join(input, f.path);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, f.text, "utf-8");
  }
  // The corpus the staging will join: empty but present.
  const corpus = path.join(root, "corpus");
  mkdirSync(corpus, { recursive: true });
  return { root, input: path.join(input, "cfr-title-77"), corpus };
}

describe("staging guard", () => {
  const run = path.resolve("/tmp/staging/run-1");
  it("keeps writes inside staging/<run_id>/ and out of the run's bookkeeping", () => {
    expect(insideRun(run, "cfr-title-77/1/1.1/77-1.1.md")).toBe(true);
    expect(insideRun(run, "./_source.yaml")).toBe(true);
    expect(insideRun(run, "../run-2/x.md")).toBe(false);
    expect(insideRun(run, "../../corpus/x.md")).toBe(false);
    expect(insideRun(run, path.resolve("/tmp/corpus/x.md"))).toBe(false);
    expect(insideRun(run, path.join(run, "a.md"))).toBe(true);
    expect(insideRun(run, "")).toBe(false);
    expect(insideRun(run, "submit.json")).toBe(false);
    expect(insideRun(run, ".ingest/x.json")).toBe(false);
  });

  it("beforeToolCall refuses writes outside the run and tools the agent does not have", () => {
    const cx = { runId: "run-1", runDir: run } as RunContext;
    expect(guardToolCall(cx, { name: "staging_write", arguments: { path: "cfr-title-77/x.md", content: "" } })).toBeUndefined();
    expect(guardToolCall(cx, { name: "staging_write", arguments: { path: "../../corpus/cfr-title-99/x.md", content: "" } })).toMatchObject({ block: true });
    expect(guardToolCall(cx, { name: "staging_write", arguments: { path: "/etc/passwd", content: "" } })).toMatchObject({ block: true });
    expect(guardToolCall(cx, { name: "section_stage", arguments: { input: "../elsewhere.md", context: "" } })).toMatchObject({ block: true });
    expect(guardToolCall(cx, { name: "sect_index", arguments: {} })).toMatchObject({ block: true });
    expect(guardToolCall(cx, { name: "bash", arguments: { cmd: "rm -rf /" } })).toMatchObject({ block: true });
    expect(guardToolCall(cx, { name: "sect_search", arguments: { query: "guardrail" } })).toBeUndefined();
    expect(ALLOWED_TOOLS.has("sect_rebuild")).toBe(false);
  });
});

describe("harness tools", () => {
  it("stages a section by copying the body, applying references and the context, and refuses bad paths", async () => {
    const { root, input, corpus } = makeInput();
    const runDir = path.join(root, "staging", "run-a");
    mkdirSync(runDir, { recursive: true });
    const cx: RunContext = { runId: "run-a", runDir, source: "cfr-title-77", inputDir: input, corpus, rawRoot: root, work: path.join(root, "work"), staged: [] };
    const tools = harnessTools(cx);
    expect(tools.map((t) => t.name)).toEqual(["input_list", "input_read", "staging_write", "section_stage", "staging_validate", "submit"]);
    const list = await tools[0].execute("1", {});
    expect(list.content[0]).toMatchObject({ type: "text" });
    const files = (list.content[0] as { text: string }).text.split("\n");
    const sec = files.find((f) => f.endsWith("77-1.1.md"))!;
    const rec = stageSection(cx, {
      input: sec,
      context: "Opening section of Part 1 of the fixture title, on walking surfaces in covered workplaces. It points to the fixed-ladder inspection rules and to the definitions section for the term covered workplace, and sets the scope for the rest of the part.",
      defines: ["Covered workplace"],
      xrefs: [{ text: "§ 1.2", id: "CFR:77-1.2", confidence: 1, search: "§ 1.2" }, { text: "§ 1.3", id: "CFR:77-1.3", confidence: 0.6, search: "definitions" }],
      flags: [],
    });
    const staged = readFileSync(path.join(runDir, "cfr-title-77", sec), "utf-8");
    const original = readFileSync(path.join(input, sec), "utf-8");
    expect(staged).toContain("[§ 1.2](CFR:77-1.2)");
    expect(staged).toContain("[§ 1.3](CFR:77-1.3)");
    expect(staged).toContain("ingest_run: run-a");
    expect(staged).toContain("- ingest:run-a");
    expect(staged).toContain("defines:\n  - Covered workplace");
    // Body text apart from the two links is byte-identical to the input's.
    const bodyOf = (t: string) => t.slice(t.indexOf("\n---\n") + 5);
    expect(bodyOf(staged).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")).toBe(bodyOf(original).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"));
    expect(rec.body_tokens).toBeGreaterThan(20);
    expect(existsSync(path.join(runDir, ".ingest", "CFR_77-1.1.json"))).toBe(true);
    expect(() => stageSection(cx, { input: "../corpus/x.md", context: "x".repeat(200) })).toThrow(/outside/);
    expect(() => stageSection(cx, { input: sec, context: "too short" })).toThrow(/50-100 tokens/);
    await expect(tools[2].execute("2", { path: "../../escape.md", content: "x" })).rejects.toThrow(/outside staging/);
  });

  it("applyXrefs links the first bare occurrence only", () => {
    const r = applyXrefs("See § 1.2 and again § 1.2; also [§ 1.3](CFR:77-1.3).", [{ text: "§ 1.2", id: "CFR:77-1.2", confidence: 1 }, { text: "§ 1.3", id: "CFR:77-1.3", confidence: 1 }]);
    expect(r.body).toBe("See [§ 1.2](CFR:77-1.2) and again § 1.2; also [§ 1.3](CFR:77-1.3).");
    expect(r.applied).toBe(1);
    expect(bareReferences("See § 1.2 and [§ 1.3](CFR:77-1.3), part 1926, 29 CFR 1904.7.")).toEqual(["§ 1.2", "part 1926", "29 CFR 1904.7"]);
  });
});

describe("ingest run (dry run: no model)", () => {
  it("stages every section, validates, submits, and is idempotent per raw hash and serialized per source", async () => {
    const { root, input, corpus } = makeInput();
    const staging = path.join(root, "staging");
    const r = await ingest({ input, source: "cfr-title-77", corpus, staging, rawRoot: root, work: path.join(root, "work"), dryRun: true, log: () => {} });
    expect(r.reused).toBe(false);
    expect(r.staged).toBe(r.sections);
    expect(r.failed).toEqual([]);
    expect(r.summary).not.toBeNull();
    expect(r.summary!.sections_added).toBe(r.sections);
    expect(r.summary!.flags.length).toBe(r.sections);
    expect(existsSync(path.join(r.runDir, "submit.json"))).toBe(true);
    expect(existsSync(path.join(r.runDir, "usage.json"))).toBe(true);
    expect(r.usage.document_tokens).toBeGreaterThan(50);
    expect(r.runId).toBe(runIdFor("cfr-title-77", rawHashOf(input)));
    // The staging passes validators 2-7 against the corpus it will join.
    const v = validateStaging({ staging: r.runDir, corpus, rawRoot: root, work: path.join(root, "work"), skipIndex: true });
    expect(v.errors).toBe(0);
    // Same raw hash: nothing runs again.
    const again = await ingest({ input, source: "cfr-title-77", corpus, staging, rawRoot: root, dryRun: true, log: () => {} });
    expect(again.reused).toBe(true);
    expect(readLedger(staging).runs[r.runId].status).toBe("submitted");
    // Another run on the same source while one holds the lock is refused.
    const release = lockSource(staging, "cfr-title-77", process.pid);
    expect(() => lockSource(staging, "cfr-title-77", process.pid + 100000)).toThrow(/serialized per source/);
    release();
    // A lock whose owner is gone is stale and taken over.
    const stale = lockSource(staging, "cfr-title-77", 4242424);
    stale();
    const claim = claimRun(staging, { run_id: "cfr-title-77-other", source: "cfr-title-77", raw_sha256: "b".repeat(64), input });
    expect(claim.existing).toBeUndefined();
  });
});
