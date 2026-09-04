import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { activeAt, buildContext, validateIndex, validateStaging, type Issue } from "../src/validators/index.js";
import { spanMatch, tokens } from "../src/validators/text.js";

// A staging in the B.2 layout: a base title with two sections (one with a table), an overlay that
// overrides one of them, and a notice whose Action produced the second section's Expression.
// Every raw source exists, so all seven validators have something to check.

const RAW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ECFR>
<DIV1 N="77" NODE="77:1" TYPE="TITLE"><HEAD>Title 77—Fixture</HEAD><P>One part on walking surfaces and ladders.</P></DIV1>
<DIV5 N="1" NODE="77:1.1.1.1.1" TYPE="PART"><HEAD>PART 1—GENERAL</HEAD><P>Part 1 states the purpose and the penalties.</P></DIV5>
<DIV8 N="1.1" NODE="77:1.1.1.1.1.0.1.1" TYPE="SECTION"><HEAD>§ 1.1 Purpose.</HEAD>
<P>(a) This part sets the minimum requirements for walking surfaces in covered workplaces.</P>
<P>(b) Penalties are assessed by class as shown in the table.</P>
<GPOTABLE><ROW><ENT>Class</ENT><ENT>Minimum</ENT><ENT>Maximum</ENT></ROW><ROW><ENT>Serious</ENT><ENT>$1,190</ENT><ENT>$16,131</ENT></ROW><ROW><ENT>Willful</ENT><ENT>$11,524</ENT><ENT>$161,323</ENT></ROW></GPOTABLE>
</DIV8>
<DIV8 N="1.2" NODE="77:1.1.1.1.1.0.1.2" TYPE="SECTION"><HEAD>§ 1.2 Fixed ladders.</HEAD>
<P>(a) Each fixed ladder must be inspected before use.</P>
<P>(b) The employer shall ensure that each fixed ladder taller than 24 feet is equipped with a ladder safety system. A cage is not fall protection.</P>
</DIV8>
</ECFR>
`;

// The title as first issued: § 1.2 still accepts cages. The superseded Expression points here.
const RAW_XML_2024 = RAW_XML.replace("<P>(b) The employer shall ensure that each fixed ladder taller than 24 feet is equipped with a ladder safety system. A cage is not fall protection.</P>", "<P>(b) A cage may serve as fall protection on any fixed ladder.</P>");

interface Files {
  [rel: string]: string;
}

function front(fields: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (v === null) lines.push(`${k}: null`);
    else if (Array.isArray(v)) lines.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(", ")}]`);
    else if (typeof v === "object") lines.push(`${k}:`, ...Object.entries(v as Record<string, unknown>).map(([a, b]) => `  ${a}: ${typeof b === "object" && b !== null && !Array.isArray(b) ? `{${Object.entries(b as Record<string, unknown>).map(([c, d]) => `${c}: ${JSON.stringify(d)}`).join(", ")}}` : JSON.stringify(b)}`));
    else if (typeof v === "string" && v.includes("\n")) lines.push(`${k}: >-`, ...v.split("\n").map((l) => `  ${l}`));
    else lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function staging(mutate: (f: Files) => void = () => {}): { dir: string; run: (skipIndex?: boolean) => ReturnType<typeof validateStaging> } {
  const root = mkdtempSync(path.join(tmpdir(), "sect-c2-"));
  const stg = path.join(root, "staging");
  const rawSha = sha(RAW_XML);
  const prov = (locator: string, raw = "raw/cfr-title-77/2026-01-01/ECFR-title77.xml", hash = rawSha) => ({ raw, raw_sha256: hash, locator: { xpath: locator }, legal_status: "unofficial-xml", ingest_run: "2026-09-03T00:00Z/test", confidence: 1.0, verified_by: ["test"] });
  const base = (id: string, node: string, level: string, title: string, effective: string, extra: Record<string, unknown>) =>
    ({ id, node, source: "cfr-title-77", title, level, parent: level === "section" ? "CFR:77-1" : level === "part" ? "CFR:77" : null, order: 1, effective, supersedes: null, superseded_by: null, amended_by: [], overrides: [], narrows: [], defines: [], authority: "77 U.S.C. 1", citation: "89 FR 1", tags: [], ...extra });
  const f: Files = {
    "raw/cfr-title-77/2026-01-01/ECFR-title77.xml": RAW_XML,
    "raw/cfr-title-77/2024-01-01/ECFR-title77.xml": RAW_XML_2024,
    "staging/cfr-title-77/77.md": front(base("CFR:77", "77:1", "title", "Title 77—Fixture", "2024-01-01", { parent: null, context: "Top of the fixture title: a single part whose sections cover floors, penalties by violation class, and fixed ladder inspection and fall arrest.", provenance: prov("//DIV1[@NODE='77:1']") })) + "# Title 77—Fixture\n\nOne part on walking surfaces and ladders.\n",
    "staging/cfr-title-77/_source.yaml": "name: cfr-title-77\nkind: base\ntitle: T\npublisher: P\nprecedence: 100\nid_prefix: \"CFR:77-\"\nid_pattern: '(?i)§\\s*(?P<part>\\d)\\.(?P<section>\\d)'\nid_template: \"CFR:77-{part}.{section}\"\nlegal_status: unofficial-xml\nversion: \"2024-01-01\"\n",
    "staging/cfr-title-77/1/77-1.md": front(base("CFR:77-1", "77:1.1.1.1.1", "part", "PART 1—GENERAL", "2024-01-01", { context: "Part 1 of the fixture title: purpose and penalties for walking surfaces.", provenance: prov("//DIV5[@NODE='77:1.1.1.1.1']") })) + "# PART 1—GENERAL\n\nPart 1 states the purpose and the penalties.\n",
    "staging/cfr-title-77/1/1.1/77-1.1.md": front(base("CFR:77-1.1", "77:1.1.1.1.1.0.1.1", "section", "Purpose", "2024-01-01", { context: "Opening section of Part 1: scope of the walking-surface rules and the penalty classes; ladders are in § 1.2.", provenance: prov("//DIV8[@NODE='77:1.1.1.1.1.0.1.1']") })) +
      "# § 1.1 Purpose.\n\n(a) This part sets the minimum requirements for walking surfaces in covered workplaces.\n\n(b) Penalties are assessed by class as shown in the table.\n\n| Class | Minimum | Maximum |\n|---|---|---|\n| Serious | $1,190 | $16,131 |\n| Willful | $11,524 | $161,323 |\n",
    "staging/cfr-title-77/1/1.2/77-1.2.md": front(base("CFR:77-1.2", "77:1.1.1.1.1.0.1.2", "section", "Fixed ladders", "2026-01-01", { supersedes: "CFR:77-1.2@2024-01-01", amended_by: ["FR:2026-00009#instr-1"], context: "Fixed ladder rules of Part 1 as amended in 2026: inspection before use and a ladder safety system above 24 feet, with reference to the purpose in § 1.1.", provenance: prov("//DIV8[@NODE='77:1.1.1.1.1.0.1.2']") })) +
      "# § 1.2 Fixed ladders.\n\n(a) Each fixed ladder must be inspected before use. See [§ 1.1](CFR:77-1.1#a).\n\n(b) The employer shall ensure that each fixed ladder taller than 24 feet is equipped with a ladder safety system. A cage is not fall protection.\n",
    "staging/cfr-title-77/1/1.2/77-1.2@2024-01-01.md": front(base("CFR:77-1.2", "77:1.1.1.1.1.0.1.2", "section", "Fixed ladders", "2024-01-01", { superseded_by: "CFR:77-1.2@2026-01-01", context: "Fixed ladder rules of Part 1 as first issued: inspection before use; cages accepted.", provenance: prov("//DIV8[@NODE='77:1.1.1.1.1.0.1.2']", "raw/cfr-title-77/2024-01-01/ECFR-title77.xml", sha(RAW_XML_2024)) })) +
      "# § 1.2 Fixed ladders.\n\n(a) Each fixed ladder must be inspected before use.\n\n(b) A cage may serve as fall protection on any fixed ladder.\n",
    "staging/city/_source.yaml": "name: city\nkind: overlay\ntitle: C\npublisher: P\nprecedence: 200\nid_prefix: \"CITY:\"\nid_pattern: '(?i)(?P<num>AM-\\d+)'\nid_template: \"CITY:{num}\"\nlegal_status: official\nversion: \"2025-03-01\"\n",
    "staging/city/AM-1.md": front({ id: "CITY:AM-1", node: null, source: "city", title: "Local purpose", level: "section", parent: null, order: 1, effective: "2025-03-01", supersedes: null, superseded_by: null, amended_by: [], overrides: ["CFR:77-1.1"], narrows: [], defines: [], authority: "Ordinance 1", citation: "City Register 1", tags: [], context: "City amendment that replaces the purpose section of the fixture title with a wider scope.", provenance: { raw: "raw/city/ordinance-1.pdf", raw_sha256: "0".repeat(64), locator: { pages: [1] }, legal_status: "official", ingest_run: "2026-09-03T00:00Z/test", confidence: 1.0, verified_by: ["test"] } }) +
      "# AM-1 Local purpose\n\nWithin the city, [§ 1.1](CFR:77-1.1) applies to every workplace, covered or not.\n",
    "staging/fr/_source.yaml": "name: fr\nkind: notice\ntitle: F\npublisher: P\nprecedence: 100\nid_prefix: \"FR:\"\nid_pattern: '(?i)FR:(?P<doc>\\d{4}-\\d{5})'\nid_template: \"FR:{doc}\"\nlegal_status: official\nversion: rolling\n",
    "staging/fr/2026/2026-00009.md": front({ id: "FR:2026-00009", node: null, source: "fr", kind: "notice", title: "Fixed ladders; cages", level: "notice", parent: null, order: 1, effective: "2026-01-01", published: "2025-10-01", supersedes: null, superseded_by: null, amended_by: [], overrides: [], narrows: [], defines: [], authority: "77 U.S.C. 1", citation: "90 FR 1", tags: ["notice"], parts_affected: ["CFR:77-1"], actions: [{ action_id: "FR:2026-00009#instr-1", notice: "FR:2026-00009", target_id: "CFR:77-1.2", target_anchor: "b", kind: "amend", effective: "2026-01-01", text: "(b) The employer shall ensure that each fixed ladder taller than 24 feet is equipped with a ladder safety system. A cage is not fall protection." }], context: "Final rule amending § 1.2 of the fixture title effective 2026-01-01: cages are no longer fall protection on fixed ladders above 24 feet.", provenance: { raw: "raw/fr/2025/2026-00009.xml", raw_sha256: "1".repeat(64), locator: { xpath: "//RULE[@DOCID='2026-00009']" }, legal_status: "official", ingest_run: "2026-09-03T00:00Z/test", confidence: 1.0, verified_by: ["test"] } }) +
      "# Fixed ladders; cages\n\nThis rule amends [§ 1.2](CFR:77-1.2) by revising paragraph (b).\n",
  };
  mutate(f);
  for (const [rel, text] of Object.entries(f)) {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text, "utf-8");
  }
  return { dir: root, run: (skipIndex = true) => validateStaging({ staging: stg, rawRoot: root, work: path.join(root, "work"), skipIndex }) };
}

const errorsOf = (r: { issues: Issue[] }, n: number) => r.issues.filter((i) => i.level === "error" && i.validator === n).map((i) => i.message);

describe("C.5 validators on a passing staging", () => {
  it("reports no errors; raw sources that are absent are warnings, not errors", () => {
    const r = staging().run();
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(r.validators.map((v) => v.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // The overlay's PDF and the notice's XML are not in this staging: round-trip and hash are unchecked there.
    expect(r.issues.some((i) => i.validator === 2 && i.level === "warning" && i.path.includes("AM-1"))).toBe(true);
    expect(r.issues.some((i) => i.validator === 5 && i.level === "warning" && i.path.includes("2026-00009"))).toBe(true);
  });

  it("token span match and activity are what the validators use", () => {
    expect(spanMatch(tokens("the employer shall ensure"), tokens("Before use, the employer shall ensure that each ladder is inspected.")).score).toBe(1);
    expect(spanMatch(tokens("the employer must ensure that nothing"), tokens("the employer shall ensure that each ladder")).score).toBeLessThan(0.92);
    const cx = buildContext({ staging: path.join(staging().dir, "staging"), skipIndex: true });
    expect(activeAt(cx, "CFR:77-1.2", "2025-06-01")).toBe(true);
    expect(activeAt(cx, "CFR:77-1.2", "2023-06-01")).toBe(false);
    expect(activeAt(cx, "CFR:77-1.1", null)).toBe(true);
  });
});

describe("each validator has a failing case", () => {
  it("2: a body that is not the source, and a context that paraphrases the body", () => {
    const r = staging((f) => {
      f["staging/cfr-title-77/1/1.1/77-1.1.md"] = f["staging/cfr-title-77/1/1.1/77-1.1.md"].replace("(a) This part sets the minimum requirements for walking surfaces in covered workplaces.", "(a) Employers must keep every floor clean, dry, and free of nails and splinters at all times.");
      f["staging/cfr-title-77/1/1.2/77-1.2.md"] = f["staging/cfr-title-77/1/1.2/77-1.2.md"].replace(/context: .*\n/, "context: Each fixed ladder must be inspected before use. The employer shall ensure that each fixed ladder taller than 24 feet is equipped with a ladder safety system. A cage is not fall protection.\n");
    }).run();
    expect(errorsOf(r, 2).some((m) => m.includes("77-1.1") || m.includes("matches its xml source"))).toBe(true);
    expect(errorsOf(r, 2).some((m) => m.includes("paraphrases"))).toBe(true);
  });

  it("3: a table cell that is not in the source grid", () => {
    const r = staging((f) => {
      f["staging/cfr-title-77/1/1.1/77-1.1.md"] = f["staging/cfr-title-77/1/1.1/77-1.1.md"].replace("| Willful | $11,524 | $161,323 |", "| Willful | $11,524 | $161,332 |");
    }).run();
    expect(errorsOf(r, 3)).toEqual([expect.stringContaining('"$161,332"')]);
  });

  it("4: a link to a missing section, a target not active at the date, and a missing anchor", () => {
    const r = staging((f) => {
      f["staging/cfr-title-77/1/1.2/77-1.2.md"] = f["staging/cfr-title-77/1/1.2/77-1.2.md"].replace("[§ 1.1](CFR:77-1.1#a)", "[§ 1.1](CFR:77-1.1#z) and [§ 1.9](CFR:77-1.9)");
      f["staging/city/AM-1.md"] = f["staging/city/AM-1.md"].replace("effective: \"2025-03-01\"", "effective: \"2023-03-01\"");
    }).run();
    const msgs = errorsOf(r, 4);
    expect(msgs.some((m) => m.includes("CFR:77-1.9 does not resolve"))).toBe(true);
    expect(msgs.some((m) => m.includes("anchor CFR:77-1.1#z not found"))).toBe(true);
    expect(msgs.some((m) => m.includes("CFR:77-1.1 is not active at 2023-03-01"))).toBe(true);
  });

  it("5: provenance without an ingest run, and a hash that does not match the raw", () => {
    const r = staging((f) => {
      f["staging/cfr-title-77/1/1.1/77-1.1.md"] = f["staging/cfr-title-77/1/1.1/77-1.1.md"].replace(/  ingest_run: .*\n/, "");
      f["staging/cfr-title-77/1/1.2/77-1.2.md"] = f["staging/cfr-title-77/1/1.2/77-1.2.md"].replace(/raw_sha256: "[0-9a-f]+"/, `raw_sha256: "${"a".repeat(64)}"`).replace(/^(\s*)verified_by:.*$/m, "");
    }).run();
    const msgs = errorsOf(r, 5);
    expect(msgs.some((m) => m.includes("missing ingest_run"))).toBe(true);
    expect(msgs.some((m) => m.includes("raw_sha256 does not match"))).toBe(true);
  });

  it("6: an override whose target is not base-kind or not lower precedence", () => {
    const r = staging((f) => {
      f["staging/city/AM-1.md"] = f["staging/city/AM-1.md"].replace('overrides: ["CFR:77-1.1"]', 'overrides: ["CFR:77-1.1", "FR:2026-00009"]');
      f["staging/city/_source.yaml"] = f["staging/city/_source.yaml"].replace("precedence: 200", "precedence: 50");
    }).run();
    const msgs = errorsOf(r, 6);
    expect(msgs.some((m) => m.includes("FR:2026-00009") && m.includes("not base"))).toBe(true);
    expect(msgs.some((m) => m.includes("CFR:77-1.1") && m.includes("not below 50"))).toBe(true);
  });

  it("7: an amended_by Action that is missing, targets another section, or whose text is absent", () => {
    const missing = staging((f) => {
      f["staging/cfr-title-77/1/1.2/77-1.2.md"] = f["staging/cfr-title-77/1/1.2/77-1.2.md"].replace('amended_by: ["FR:2026-00009#instr-1"]', 'amended_by: ["FR:2026-00009#instr-7"]');
    }).run();
    expect(errorsOf(missing, 7)).toEqual([expect.stringContaining("no such Action")]);
    const wrong = staging((f) => {
      f["staging/fr/2026/2026-00009.md"] = f["staging/fr/2026/2026-00009.md"].replace('"target_id":"CFR:77-1.2"', '"target_id":"CFR:77-1.1"').replace("is equipped with a ladder safety system. A cage is not fall protection.", "carries a warning label in red letters, and nothing more is required.");
    }).run();
    const msgs = errorsOf(wrong, 7);
    expect(msgs.some((m) => m.includes("is not this section"))).toBe(true);
    expect(msgs.some((m) => m.includes("not present in this Expression"))).toBe(true);
  });

  it("1: the sect binary's contract check runs when a binary is available", () => {
    const candidates = [process.env.SECT_BIN, path.resolve("../../target/debug/sect.exe"), path.resolve("../../target/debug/sect"), path.resolve("../../target/release/sect.exe"), path.resolve("../../target/release/sect")].filter((p): p is string => !!p && existsSync(p));
    const s = staging();
    const r = validateIndex(path.join(s.dir, "staging"), candidates[0] ?? "sect-binary-that-does-not-exist");
    if (!candidates.length) {
      expect(r.skipped).toContain("not found");
      return;
    }
    expect(r.skipped).toBeUndefined();
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
    const bad = staging((f) => {
      f["staging/cfr-title-77/1/1.1/77-1.1.md"] = f["staging/cfr-title-77/1/1.1/77-1.1.md"].replace("id: \"CFR:77-1.1\"", "id: \"CFR:77-1.1\"\nnarrows: [\"CFR:77-9.9\"]").replace("narrows: []\n", "");
    });
    const bar = validateIndex(path.join(bad.dir, "staging"), candidates[0]);
    expect(bar.issues.some((i) => i.level === "error")).toBe(true);
    expect(readFileSync(path.join(bad.dir, "staging/cfr-title-77/1/1.1/77-1.1.md"), "utf-8")).toContain("CFR:77-9.9");
  });
});
