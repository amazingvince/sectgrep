// A person's decision on a conflict, carried back into the run (G-N2): the section is re-staged
// with the chosen value, the evidence checks and consensus run again for it, the merge script
// moves it and whatever it unblocked, and the decision becomes an example in the ingest skill.
// The harness still never decides a conflict itself: `--pick` is the person's.

import { splitFrontMatter } from "@sectgrep/convert";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { evidenceChecks } from "./evidence.js";
import { mergeRun, type MergeResult } from "./merge.js";
import { candidatesFor, collectKnown } from "./refs.js";
import { collectIds, loadRecords, stageSection, type RunContext, type XrefResolution } from "./tools.js";
import { consensus, reviewMarkdown, summarize, type Judgment, type Resolution, type SectionVerdict, type VerifierAnswer, type VerifyReport } from "./verifier.js";

export interface ResolveOptions {
  runDir: string;
  input: string;
  source: string;
  corpus: string;
  review?: string;
  sectBin?: string;
  rawRoot?: string;
  work?: string;
  /** The section (Work id) whose conflict is decided. */
  id: string;
  /** `ingest`, `verifier`, `none` (leave the span bare / no terms), or a real id for one reference. */
  pick: string;
  /** Narrow the decision to the judgment on this reference text (required when an id is picked and the section has several). */
  text?: string;
  /** One sentence for the skill's examples: why this is right. */
  why?: string;
  /** The skill file the example is appended to (default docs/SKILL-ingest.md). */
  skillPath?: string;
  /** Merge with a commit. */
  commit?: boolean;
  /** Skip the merge (tests, or a batch of decisions merged once at the end). */
  noMerge?: boolean;
  log?: (line: string) => void;
}

export interface ResolveResult {
  id: string;
  applied: Judgment[];
  tier: "auto" | "conflict";
  remaining: number;
  merge: MergeResult | null;
  example: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
const isId = (s: string) => /^[A-Z][A-Z0-9]*:\S+$/.test(s);
const splitId = (v: string): { id: string; anchor: string | null } => {
  const [id, anchor] = v.split("#");
  return { id, anchor: anchor || null };
};

export function defaultSkillPath(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../../../docs/SKILL-ingest.md");
}

export function resolveConflict(o: ResolveOptions): ResolveResult {
  const log = o.log ?? ((l: string) => console.log(l));
  const runDir = path.resolve(o.runDir);
  const runId = path.basename(runDir);
  const verifyFile = path.join(runDir, "verify.json");
  if (!existsSync(verifyFile)) throw new Error(`${o.runDir} has no verify.json; verify first`);
  const report = JSON.parse(readFileSync(verifyFile, "utf-8")) as VerifyReport;
  const idx = report.sections.findIndex((s) => s.id === o.id);
  if (idx < 0) throw new Error(`${o.id} is not in run ${runId}`);
  const section = report.sections[idx];
  const records = loadRecords(runDir);
  const record = records.find((r) => r.id === o.id);
  if (!record) throw new Error(`${o.id} has no ingest record in ${runId}`);
  const inputDir = path.resolve(o.input);
  const scope = section.judgments.filter((j) => !j.agree && (!o.text || norm(j.text ?? "") === norm(o.text)));
  if (!scope.length) throw new Error(`${o.id} has no open disagreement${o.text ? ` on "${o.text}"` : ""}`);
  const pick = o.pick.trim();
  if (!["ingest", "verifier", "none"].includes(pick) && !isId(pick)) throw new Error(`--pick must be ingest, verifier, none, or an id (got ${pick})`);
  if (isId(pick) && (scope.length !== 1 || scope[0].field !== "xref")) throw new Error(`an id can be picked for exactly one reference; name it with --text (open: ${scope.map((j) => `${j.field}${j.text ? ` "${j.text}"` : ""}`).join("; ")})`);
  for (const j of scope) if (j.field !== "xref" && j.field !== "defines") throw new Error(`${j.field} conflicts are resolved by editing the input's front matter (H3); resolve handles references and definitions`);

  // The chosen values, applied to the record.
  let xrefs: XrefResolution[] = record.xrefs.map((x) => ({ ...x }));
  let defines = [...record.defines];
  const flags = record.flags.filter((f) => !f.startsWith("resolved: "));
  const resolutions: string[] = [];
  const stamp = new Date().toISOString().slice(0, 10);
  const applied: Judgment[] = [];
  for (const j of scope) {
    let value: string;
    if (j.field === "xref") {
      const text = j.text ?? "";
      const chosen = pick === "ingest" ? j.ingest : pick === "verifier" ? j.verifier : pick === "none" ? "(none)" : pick;
      const bare = /^\((none|not judged|left bare)\)$/.test(chosen);
      xrefs = xrefs.filter((x) => norm(x.text) !== norm(text));
      if (!bare) {
        const { id, anchor } = splitId(chosen);
        xrefs.push({ text, id, anchor, confidence: 1, search: `resolved by a person (${pick})` });
      }
      value = bare ? "(left bare)" : chosen;
      flags.push(...record.flags.filter((f) => f.startsWith("unresolved") && f.includes(`"${text}"`)).map(() => "").filter(Boolean));
      resolutions.push(`"${text}" -> ${value} (${pick}, ${stamp})`);
    } else {
      const list = (v: string) => (v === "(none)" ? [] : v.split(",").map((t) => t.trim()).filter(Boolean));
      defines = pick === "ingest" ? [...record.defines] : pick === "verifier" ? list(j.verifier) : [];
      value = defines.join(", ") || "(none)";
      resolutions.push(`defines -> ${value} (${pick}, ${stamp})`);
    }
    applied.push({ ...j, agree: true, resolved: pick, resolved_value: value });
  }
  const keptFlags = flags.filter((f) => !(f.startsWith("unresolved") && scope.some((j) => j.text && f.includes(`"${j.text}"`))));
  keptFlags.push(...resolutions.map((r) => `resolved: ${r}`));

  // Re-stage from the input with the decision applied; the record on disk follows.
  const cx: RunContext = { runId, runDir, source: o.source, inputDir, corpus: path.resolve(o.corpus), rawRoot: path.resolve(o.rawRoot ?? "."), work: path.resolve(o.work ?? "work"), sectBin: o.sectBin ?? process.env.SECT_BIN, staged: [], log };
  cx.knownIds = collectIds([cx.corpus, inputDir]);
  const staged = stageSection(cx, { input: record.input, context: record.context, defines, xrefs, flags: keptFlags, resolutions: [...(readResolutions(runDir, section) ?? []), ...resolutions] });

  // Evidence and consensus again for this section, against the verifier's stored answer.
  const known = collectKnown([cx.corpus, inputDir]);
  const text = readFileSync(path.join(inputDir, record.input), "utf-8");
  const split = splitFrontMatter(text);
  const front = (YAML.parse(split?.front ?? "") ?? {}) as { overrides?: unknown; narrows?: unknown; amended_by?: unknown; actions?: Array<{ target_id: string }> };
  const refs = [...new Set(section.judgments.filter((j) => j.field === "xref" && j.text).map((j) => j.text!))];
  const answer: VerifierAnswer = {
    xrefs: section.judgments.filter((j) => j.field === "xref" && j.text).map((j) => {
      const v = /^\(/.test(j.verifier) ? null : splitId(j.verifier);
      return { text: j.text!, id: v?.id ?? null, anchor: v?.anchor ?? null, confidence: 1, reason: j.verifier_reason };
    }),
    defines: (() => {
      const d = section.judgments.find((j) => j.field === "defines");
      return d && d.verifier !== "(none)" ? d.verifier.split(",").map((t) => t.trim()).filter(Boolean) : [];
    })(),
  };
  const candidates = new Map(refs.map((t) => [t, candidatesFor(t, o.id, known)]));
  let judgments = consensus(staged, answer, refs, candidates, report.level, front);
  // A judgment a person decided agrees by that decision, whatever the two runs said.
  judgments = judgments.map((j) => {
    const a = applied.find((x) => x.field === j.field && norm(x.text ?? "") === norm(j.text ?? ""));
    return a ? { ...j, agree: true, resolved: a.resolved, resolved_value: a.resolved_value } : j;
  });
  for (const a of applied) if (!judgments.some((j) => j.field === a.field && norm(j.text ?? "") === norm(a.text ?? ""))) judgments.push(a);
  const evidence = evidenceChecks({ staging: runDir, corpus: cx.corpus, records: [staged], work: cx.work }).issues.filter((i) => i.path.replace(/\\/g, "/") === staged.path.replace(/\\/g, "/"));
  const conflict = judgments.some((j) => !j.agree) || evidence.some((i) => i.level === "fail");
  const verdict: SectionVerdict = { ...section, judgments, evidence, tier: conflict ? "conflict" : "auto" };
  report.sections[idx] = verdict;
  const entries: Resolution[] = applied.map((a) => ({ id: o.id, field: a.field, text: a.text, ingest: a.ingest, verifier: a.verifier, pick, value: a.resolved_value ?? "", why: o.why, date: stamp }));
  report.resolutions = [...(report.resolutions ?? []), ...entries];
  Object.assign(report, summarize(report.sections, report.counts.evidence_fails - section.evidence.filter((i) => i.level === "fail").length + evidence.filter((i) => i.level === "fail").length));
  writeFileSync(verifyFile, JSON.stringify(report, null, 2) + "\n", "utf-8");
  const review = path.resolve(o.review ?? "review");
  if (existsSync(review)) writeFileSync(path.join(review, `${runId}.md`), reviewMarkdown(report), "utf-8");

  // The decision as an example for the next agent.
  const example = entries.map((e) => `- ${e.id}${e.text ? `, "${e.text}"` : ", defines"}: ingest proposed \`${e.ingest}\`, the verifier \`${e.verifier}\`; a person chose \`${e.value}\`${e.why ? ` because ${e.why.replace(/\.?$/, "")}` : ""} (${e.date}).`).join("\n");
  appendExample(o.skillPath ?? defaultSkillPath(), example);

  const remaining = judgments.filter((j) => !j.agree).length + evidence.filter((i) => i.level === "fail").length;
  log(`${o.id}: ${applied.length} decision(s) applied; tier ${verdict.tier}${remaining ? ` (${remaining} still open)` : ""}`);
  let merge: MergeResult | null = null;
  if (!o.noMerge && verdict.tier === "auto") {
    merge = mergeRun({ runDir, source: o.source, corpus: o.corpus, review: o.review, sectBin: o.sectBin, commit: o.commit, log });
    log(`merge: ${merge.merged} section(s) written, ${merge.held} held (${merge.blocked} blocked)${merge.commit ? `, commit ${merge.commit.slice(0, 10)}` : ""}`);
  }
  return { id: o.id, applied, tier: verdict.tier, remaining, merge, example };
}

function readResolutions(runDir: string, section: SectionVerdict): string[] | null {
  const f = path.join(runDir, section.path);
  if (!existsSync(f)) return null;
  const split = splitFrontMatter(readFileSync(f, "utf-8"));
  const prov = ((YAML.parse(split?.front ?? "") ?? {}) as { provenance?: { resolutions?: unknown } }).provenance;
  return Array.isArray(prov?.resolutions) ? prov!.resolutions.map(String) : null;
}

const HEADING = "## Examples from review";

/** Append an example under the skill's review-examples heading, creating the heading once. */
export function appendExample(skillPath: string, example: string): void {
  const text = existsSync(skillPath) ? readFileSync(skillPath, "utf-8") : "";
  if (!text.includes(HEADING)) appendFileSync(skillPath, `${text.endsWith("\n") || !text ? "" : "\n"}\n${HEADING}\n\nDecisions people made on conflicts, appended by \`sect-harness resolve\`; each is the rule for the next case like it.\n\n`, "utf-8");
  appendFileSync(skillPath, example + "\n", "utf-8");
}
