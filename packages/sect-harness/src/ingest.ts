// The ingest run (spec D.2): one preprocessed source in, one `staging/<run_id>/` out. Steps 1-7
// are the agent's, one section at a time with the seven verbs and the harness tools; step 10
// re-prompts the agent with the validator's findings up to three times; step 11 submits. The
// harness copies section text itself (section_stage) and never writes to the corpus. Without a
// model (`dryRun`) the harness stages every section with WS2's own context, which is how the
// tests and a key-less CI exercise the whole path.

import { Agent } from "@mariozechner/pi-agent-core";
import type { Usage } from "@mariozechner/pi-ai";
import { loadDotEnv, splitFrontMatter } from "@sectgrep/convert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { modelFromEnv, type ModelChoice } from "./model.js";
import { connectSect } from "./sect-tools.js";
import { claimRun, finishRun, lockSource, runDir, runIdFor, type RunEntry } from "./staging.js";
import { composeExpressions, holdFailedCompositions } from "./notice.js";
import { ancestorsOf, collectKnown, preResolve, type Known } from "./refs.js";

/** `--only a,b`: a leaf is chosen when its input path contains any of the parts. */
export const matchesOnly = (rel: string, only: string): boolean => only.split(",").map((s) => s.trim()).filter(Boolean).some((part) => rel.includes(part));

/** A subset run keeps links to the chosen leaves, their ancestors, and what the corpus already holds. */
export function subsetKeepIds(known: Known, leafIds: string[], corpus: string): Set<string> {
  const keep = new Set<string>(leafIds);
  for (const id of leafIds) for (const a of ancestorsOf(known, id)) keep.add(a.id);
  for (const id of collectKnown([corpus]).ids.keys()) keep.add(id);
  return keep;
}
import { collectIds, guardToolCall, harnessTools, loadRecords, removeStrayFiles, stageSection, stagingPathFor, submitRun, validateRun, type RunContext, type SubmitSummary, type XrefResolution } from "./tools.js";

export { bareReferences } from "./refs.js";

export interface IngestOptions {
  /** WS2's output for one source: a directory in the B.2 layout (`sect-convert ecfr --out`). */
  input: string;
  source: string;
  corpus: string;
  staging: string;
  sectBin?: string;
  rawRoot?: string;
  work?: string;
  /** Stage with WS2's context and no model. */
  dryRun?: boolean;
  concurrency?: number;
  /** Only the first N sections (a smoke run). */
  limit?: number;
  /** Only leaves whose input path contains this text, with their ancestors (a part of a title). */
  only?: string;
  /** Keep the records an interrupted run already staged; the model sees only what is missing, then the fix rounds. */
  resume?: boolean;
  skillPath?: string;
  model?: ModelChoice;
  log?: (line: string) => void;
}

export interface RunUsage {
  input: number;
  output: number;
  cost: number;
  calls: number;
  document_tokens: number;
  /** References linked in code, without a model turn. */
  deterministic: number;
}

export interface IngestResult {
  runId: string;
  runDir: string;
  reused: boolean;
  sections: number;
  staged: number;
  failed: Array<{ input: string; error: string }>;
  fixRounds: number;
  usage: RunUsage;
  summary: SubmitSummary | null;
  errors: number;
  entry: RunEntry;
}

const tokenCount = (s: string) => (s.match(/[A-Za-z0-9]+(?:[.,][A-Za-z0-9]+)*/g) ?? []).length;

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      if (n.startsWith(".")) continue;
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".md")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** The raw document's hash, from the first section's provenance, else of the input itself. */
export function rawHashOf(inputDir: string): string {
  for (const f of walkMarkdown(inputDir)) {
    const split = splitFrontMatter(readFileSync(f, "utf-8"));
    const prov = split ? ((YAML.parse(split.front) ?? {}) as { provenance?: { raw_sha256?: string } }).provenance : undefined;
    if (prov?.raw_sha256 && /^[0-9a-f]{64}$/.test(String(prov.raw_sha256))) return String(prov.raw_sha256);
  }
  const h = createHash("sha256");
  for (const f of walkMarkdown(inputDir)) h.update(readFileSync(f));
  return h.digest("hex");
}

const HEAD_CHARS = 12_000;

/** Sentences of a text holding any of the given spans, for the part of a long section the prompt does not show. */
function sentencesWith(text: string, spans: string[]): string[] {
  const out: string[] = [];
  for (const s of spans) {
    if (!s) continue;
    const at = text.indexOf(s);
    if (at < 0) continue;
    const start = Math.max(text.lastIndexOf(". ", at) + 1, text.lastIndexOf("\n", at) + 1, 0);
    const ends = [text.indexOf(". ", at + s.length), text.indexOf("\n", at + s.length)].filter((i) => i >= 0).map((i) => i + 1);
    out.push(text.slice(start, ends.length ? Math.min(...ends) : text.length).trim());
  }
  return [...new Set(out)];
}

/**
 * The per-section prompt: what the harness already linked, what remains to resolve, the terms
 * the converter detected, and the body (its head, with the sentences that matter from the rest).
 */
export function sectionPrompt(rel: string, body: string, linked: XrefResolution[], remaining: string[], ws2Defines: string[], hints: string[] = []): string {
  const lines = [`Section \`${rel}\`.`];
  if (linked.length) lines.push(`Already linked by the harness, do not search for them: ${linked.map((x) => `"${x.text}" -> ${x.id}${x.anchor ? "#" + x.anchor : ""}`).join("; ")}.`);
  lines.push(remaining.length ? `Resolve with sect_search (limit 3, one search each): ${remaining.map((r) => `"${r}"`).join("; ")}.` : "No reference remains to resolve: do not search.");
  lines.push(ws2Defines.length ? `Terms the converter detected as defined: ${ws2Defines.join("; ")}.` : "The converter detected no defined term.");
  lines.push(...hints);
  lines.push(`Then call section_stage once with input="${rel}", context, defines, xrefs (only the ones you resolved) and flags${hints.length ? ", and the fields the hints above ask for" : ""}.`, "", "```markdown");
  const long = body.length > HEAD_CHARS;
  lines.push(long ? body.slice(0, HEAD_CHARS) + "\n[the rest of the section is not shown]" : body, "```");
  if (long) {
    const extra = sentencesWith(body.slice(HEAD_CHARS), [...remaining, ...ws2Defines.map((d) => `*${d}*`), ...ws2Defines]);
    if (extra.length) lines.push("", "Sentences beyond the shown text that hold a reference or a definition:", ...extra.map((s) => `- ${s.slice(0, 400)}`));
  }
  return lines.join("\n");
}

/** The tools a section needs: search and the map for the remaining references, read for a doubt, stage. */
const PER_SECTION_TOOLS = new Set(["sect_search", "sect_map", "sect_read", "section_stage"]);

function usageOf(agent: Agent): { input: number; output: number; cost: number; calls: number } {
  let input = 0;
  let output = 0;
  let cost = 0;
  let calls = 0;
  for (const m of agent.state.messages) {
    if (m.role !== "assistant") continue;
    const u = (m as { usage?: Usage }).usage;
    if (!u) continue;
    calls++;
    input += u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    output += u.output;
    cost += u.cost?.total ?? 0;
  }
  return { input, output, cost, calls };
}

export async function ingest(o: IngestOptions): Promise<IngestResult> {
  loadDotEnv();
  const log = o.log ?? ((l: string) => console.log(l));
  const inputDir = path.resolve(o.input);
  if (!existsSync(inputDir)) throw new Error(`input ${o.input} not found`);
  const rawSha = rawHashOf(inputDir);
  const runId = runIdFor(o.source, rawSha);
  const dir = runDir(o.staging, runId);
  const claim = claimRun(o.staging, { run_id: runId, source: o.source, raw_sha256: rawSha, input: inputDir });
  if (claim.existing) {
    log(`run ${runId} already submitted (${claim.existing.finished}); nothing to do`);
    const summary = existsSync(path.join(dir, "submit.json")) ? (JSON.parse(readFileSync(path.join(dir, "submit.json"), "utf-8")) as SubmitSummary) : null;
    const usage = existsSync(path.join(dir, "usage.json")) ? (JSON.parse(readFileSync(path.join(dir, "usage.json"), "utf-8")) as RunUsage) : { input: 0, output: 0, cost: 0, calls: 0, document_tokens: 0, deterministic: 0 };
    return { runId, runDir: dir, reused: true, sections: summary?.sections_added ?? 0, staged: summary?.sections_added ?? 0, failed: [], fixRounds: 0, usage, summary, errors: 0, entry: claim.existing };
  }
  const release = lockSource(o.staging, o.source);
  const cx: RunContext = { runId, runDir: dir, source: o.source, inputDir, corpus: path.resolve(o.corpus), rawRoot: path.resolve(o.rawRoot ?? "."), work: path.resolve(o.work ?? "work"), sectBin: o.sectBin ?? process.env.SECT_BIN, staged: [], log };
  cx.knownIds = collectIds([cx.corpus, inputDir]);
  cx.preResolved = new Map();
  const known = collectKnown([cx.corpus, inputDir]);
  mkdirSync(path.join(dir, o.source), { recursive: true });
  const files = walkMarkdown(inputDir).map((f) => path.relative(inputDir, f).replace(/\\/g, "/"));
  // The source's kind decides what the agent is asked for (D.2 steps 8 and 9).
  const sourceYaml = path.join(inputDir, "_source.yaml");
  const sourceKind = existsSync(sourceYaml) ? String(((YAML.parse(readFileSync(sourceYaml, "utf-8")) ?? {}) as { kind?: string }).kind ?? "base") : "base";
  // A node other nodes name as their parent is structural: it carries a heading and a listing
  // of its children, not rule text. The harness stages it with WS2's context; the agent's turns
  // go to the leaves, whatever the levels are called.
  const idOf = (rel: string) => {
    const split = splitFrontMatter(readFileSync(path.join(inputDir, rel), "utf-8"));
    return String(((YAML.parse(split?.front ?? "") ?? {}) as { id?: string }).id ?? "");
  };
  const idOfFile = new Map(files.map((f) => [f, idOf(f)]));
  const leafFiles = files.filter((f) => !(known.children.get(idOfFile.get(f)!) ?? 0));
  const chosen = o.only ? leafFiles.filter((f) => matchesOnly(f, o.only!)) : leafFiles;
  const sections = o.limit ? chosen.slice(0, o.limit) : chosen;
  let structural = files.filter((f) => (known.children.get(idOfFile.get(f)!) ?? 0) > 0);
  if (o.only) {
    // A subset: only the ancestors of the chosen leaves are staged, and their listings keep a
    // link only to what this run stages or the corpus already holds.
    const keep = new Set<string>();
    for (const f of sections) for (const a of ancestorsOf(known, idOfFile.get(f)!)) keep.add(a.id);
    structural = structural.filter((f) => keep.has(idOfFile.get(f)!));
    cx.keepIds = subsetKeepIds(known, sections.map((f) => idOfFile.get(f)!), cx.corpus);
  }
  const structuralIds = new Set(structural.map((f) => idOfFile.get(f)!));
  // Resuming: what an interrupted run staged stands; only the missing leaves get a model turn.
  let pending = sections;
  if (o.resume) {
    const prior = loadRecords(dir).filter((r) => !r.derived && existsSync(path.join(dir, r.path)));
    cx.staged.push(...prior);
    const done = new Set(prior.map((r) => r.input));
    pending = sections.filter((rel) => !done.has(rel));
    log(`resume: ${prior.length} record(s) kept, ${pending.length} leaf(s) still to stage`);
  }
  // Step 9: after the leaves are staged, each notice's Actions compose the new Expressions.
  const composeNotices = () => {
    if (sourceKind !== "notice") return;
    for (const r of [...cx.staged]) {
      if (r.derived || structuralIds.has(r.id)) continue;
      const c = composeExpressions(cx, r.path, cx.corpus, r.input);
      log(`${r.id}: ${c.derived.length} Expression(s) composed${c.unapplied.length ? `; unapplied: ${c.unapplied.map((u) => `${u.action_id} (${u.why})`).join("; ")}` : ""}${c.skipped.length ? `; skipped: ${c.skipped.map((s) => `${s.target_id} (${s.why})`).join("; ")}` : ""}`);
    }
    const held = holdFailedCompositions(cx);
    if (held.length) log(`held for a person (composition failed validation): ${held.join(", ")}`);
  };
  /** What the prompt asks for beyond a base section, from the input's own fields. */
  const hintsFor = (front: Record<string, unknown>): string[] => {
    if (sourceKind === "overlay") {
      const ov = ((front.overrides ?? []) as unknown[]).map(String);
      const na = ((front.narrows ?? []) as Array<{ id?: string; anchor?: string } | string>).map((n) => (typeof n === "string" ? n : `${n.id}${n.anchor ? "#" + n.anchor : ""}`));
      return [
        "This is an overlay item: decide which base nodes it overrides (replaces whole) and which paragraphs it narrows (changes or excepts), searching the base with sect_search on its subject and the citations in it; give overrides [{id, rationale}] and narrows [{id, anchor, rationale}] with one sentence each, or neither when the item only adopts the base as it stands.",
        ov.length || na.length ? `The converter proposed overrides: ${ov.join(", ") || "(none)"}; narrows: ${na.join(", ") || "(none)"}. Confirm or correct them.` : "",
      ].filter(Boolean);
    }
    if (sourceKind === "notice") {
      const acts = (front.actions ?? []) as Array<{ action_id: string; target_id: string; target_anchor?: string | null; kind: string; instruction?: string }>;
      if (!acts.length) return ["This is a notice with no Action candidates from the converter: say so in flags."];
      const lines = ["This is a notice. Confirm or correct each Action below in `actions` (one entry per action_id: target_id, target_anchor or null, kind). A target must be a real id; an anchor must be one of the target's paragraphs listed. Use sect_read on a target when in doubt. Do not write amended text."];
      for (const a of acts) {
        const anchors = [...(cx.knownIds?.get(a.target_id) ?? [])].filter((x) => /^[a-z0-9-]+$/.test(x)).slice(0, 40);
        lines.push(`- ${a.action_id}: ${String(a.instruction ?? "").slice(0, 300)} -> proposed ${a.target_id}${a.target_anchor ? "#" + a.target_anchor : ""}, ${a.kind}${cx.knownIds?.has(a.target_id) ? `; target paragraphs: ${anchors.join(", ") || "(none)"}` : "; target not in the corpus"}`);
      }
      return lines;
    }
    return [];
  };
  // The source's registry entry travels with the sections: the run directory is a corpus root
  // and the source is its one subdirectory, so validators and `sect index` read it as a corpus.
  if (existsSync(path.join(inputDir, "_source.yaml"))) writeFileSync(path.join(dir, o.source, "_source.yaml"), readFileSync(path.join(inputDir, "_source.yaml")), "utf-8");
  else throw new Error(`${o.input} has no _source.yaml; point --input at the converted source directory`);
  const failed: Array<{ input: string; error: string }> = [];
  const usage: RunUsage = { input: 0, output: 0, cost: 0, calls: 0, document_tokens: 0, deterministic: 0 };
  for (const rel of sections) {
    const split = splitFrontMatter(readFileSync(path.join(inputDir, rel), "utf-8"));
    usage.document_tokens += tokenCount(split?.body ?? "");
  }
  let fixRounds = 0;
  try {
    for (const rel of structural) {
      if (o.resume && cx.staged.some((s) => s.input === rel)) continue;
      try {
        const split = splitFrontMatter(readFileSync(path.join(inputDir, rel), "utf-8"));
        const front = (YAML.parse(split?.front ?? "") ?? {}) as { context?: string; defines?: string[]; level?: string };
        stageSection(cx, { input: rel, context: String(front.context ?? ""), defines: front.defines ?? [], xrefs: [], flags: [`structural ${front.level ?? "node"}: staged by the harness with WS2's context`] });
      } catch (e) {
        failed.push({ input: rel, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (o.dryRun) {
      for (const rel of sections) {
        try {
          const split = splitFrontMatter(readFileSync(path.join(inputDir, rel), "utf-8"));
          const front = (YAML.parse(split?.front ?? "") ?? {}) as { id?: string; context?: string; defines?: string[] };
          // Explicit citations are linked in code even without a model.
          const { resolved } = preResolve(split?.body ?? "", String(front.id ?? ""), known, cx.knownIds);
          usage.deterministic += resolved.length;
          stageSection(cx, { input: rel, context: String(front.context ?? ""), defines: front.defines ?? [], xrefs: resolved, flags: ["dry-run: WS2 context kept, only explicit citations linked"] });
        } catch (e) {
          failed.push({ input: rel, error: e instanceof Error ? e.message : String(e) });
        }
      }
      composeNotices();
    } else {
      const choice = o.model ?? modelFromEnv();
      if (!choice.model || !choice.config.apiKey) throw new Error(`no model available: provider ${choice.config.provider}, model ${choice.config.model}; copy .env.example to .env, or pass --dry-run`);
      const skill = readFileSync(o.skillPath ?? path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../../../docs/SKILL-ingest.md"), "utf-8");
      // Compact tool schemas and trimmed results: the agent carries them on every call.
      const sect = await connectSect({ bin: cx.sectBin ?? "sect", corpus: cx.corpus, compact: true });
      try {
        const tools = [...sect.tools, ...harnessTools(cx)].filter((t) => PER_SECTION_TOOLS.has(t.name));
        const runOne = async (rel: string, extra?: string) => {
          const content = readFileSync(path.join(inputDir, rel), "utf-8");
          const split = splitFrontMatter(content);
          const body = split?.body ?? content;
          const front = (YAML.parse(split?.front ?? "") ?? {}) as { id?: string; defines?: string[] };
          // Explicit citations with one real target are linked here, before the agent's turn.
          const { resolved, remaining } = preResolve(body, String(front.id ?? ""), known, cx.knownIds);
          cx.preResolved!.set(rel, resolved);
          if (!extra) usage.deterministic += resolved.length;
          const agent = new Agent({
            initialState: { systemPrompt: skill, model: choice.model!, tools },
            beforeToolCall: async ({ toolCall }) => guardToolCall(cx, toolCall as { name: string; arguments: Record<string, unknown> }),
          });
          const prompt = sectionPrompt(rel, body, resolved, remaining, front.defines ?? [], hintsFor(front as Record<string, unknown>)) + (extra ? `\n\nThe validators reported on your previous attempt:\n${extra}\nFix the section and call section_stage again.` : "");
          await agent.prompt(prompt);
          await agent.waitForIdle();
          const u = usageOf(agent);
          usage.input += u.input;
          usage.output += u.output;
          usage.cost += u.cost;
          usage.calls += u.calls;
          if (!cx.staged.some((s) => s.input === rel)) throw new Error("the agent finished without calling section_stage");
        };
        const pool = Math.max(1, o.concurrency ?? 4);
        let next = 0;
        const worker = async () => {
          while (next < pending.length) {
            const rel = pending[next++];
            let lastError = "";
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                await runOne(rel);
                lastError = "";
                break;
              } catch (e) {
                lastError = e instanceof Error ? e.message : String(e);
                log(`section ${rel} attempt ${attempt + 1} failed: ${lastError.slice(0, 200)}`);
              }
            }
            if (lastError) failed.push({ input: rel, error: lastError });
            log(`${cx.staged.length + failed.length}/${sections.length} done`);
          }
        };
        await Promise.all(Array.from({ length: pool }, worker));
        composeNotices();
        // Step 10: fix hard failures, at most three rounds. Files the agents wrote beside the
        // staged sections go first: nothing can fix them, and they are not the document.
        const strays = removeStrayFiles(cx);
        if (strays.length) log(`removed ${strays.length} stray file(s) the agent wrote: ${strays.slice(0, 5).join(", ")}${strays.length > 5 ? ", ..." : ""}`);
        for (fixRounds = 0; fixRounds < 3; fixRounds++) {
          const report = validateRun(cx);
          const byPath = new Map<string, string[]>();
          for (const i of report.issues) if (i.level === "error") byPath.set(i.path, [...(byPath.get(i.path) ?? []), `[${i.validator}] ${i.message}`]);
          if (!byPath.size) break;
          log(`fix round ${fixRounds + 1}: ${byPath.size} document(s) with errors`);
          const todo = [...byPath].map(([p, msgs]) => ({ rel: sections.find((s) => stagingPathFor(cx, s) === p.replace(/\\/g, "/")), msgs })).filter((t): t is { rel: string; msgs: string[] } => !!t.rel);
          let k = 0;
          const fixer = async () => {
            while (k < todo.length) {
              const { rel, msgs } = todo[k++];
              try {
                await runOne(rel, msgs.join("\n"));
              } catch (e) {
                log(`fix of ${rel} failed: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
          };
          await Promise.all(Array.from({ length: Math.min(pool, todo.length || 1) }, fixer));
        }
      } finally {
        await sect.close();
      }
    }
    // Counted from what stands in staging, not per attempt (a retried section would count twice).
    usage.deterministic = cx.staged.reduce((n, s) => n + s.xrefs.filter((x) => x.deterministic).length, 0);
    writeFileSync(path.join(dir, "usage.json"), JSON.stringify(usage, null, 2) + "\n", "utf-8");
    let summary: SubmitSummary | null = null;
    let errors = 0;
    try {
      const strays = removeStrayFiles(cx);
      summary = submitRun(cx, [failed.length ? `${failed.length} section(s) not staged: ${failed.map((f) => f.input).join(", ")}` : "", strays.length ? `${strays.length} stray file(s) removed: ${strays.join(", ")}` : ""].filter(Boolean).join("; ") || undefined);
      finishRun(o.staging, runId, "submitted", { sections: summary.sections_added, xrefs: summary.xrefs_resolved, cost: usage.cost });
    } catch (e) {
      errors = validateRun(cx).errors;
      log(`submit refused: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      finishRun(o.staging, runId, "failed", { errors });
    }
    return { runId, runDir: dir, reused: false, sections: sections.length + structural.length, staged: cx.staged.length, failed, fixRounds, usage, summary, errors, entry: claim.entry };
  } finally {
    release();
  }
}

export interface ResubmitOptions {
  runDir: string;
  source: string;
  input: string;
  corpus: string;
  staging: string;
  sectBin?: string;
  rawRoot?: string;
  work?: string;
  /** The same subset filter the run was ingested with, so listings stay de-linked outside it. */
  only?: string;
  log?: (line: string) => void;
}

/**
 * Re-stage an existing run from its own records (the agent's context, definitions, references
 * and flags per section), drop stray files, validate, and submit. No model call: this is how a
 * run is closed after the harness rules changed, or after a person fixed a record by hand.
 */
export function resubmit(o: ResubmitOptions): { runId: string; staged: number; strays: string[]; summary: SubmitSummary | null; errors: number } {
  const log = o.log ?? ((l: string) => console.log(l));
  const dir = path.resolve(o.runDir);
  const runId = path.basename(dir);
  const inputDir = path.resolve(o.input);
  const cx: RunContext = { runId, runDir: dir, source: o.source, inputDir, corpus: path.resolve(o.corpus), rawRoot: path.resolve(o.rawRoot ?? "."), work: path.resolve(o.work ?? "work"), sectBin: o.sectBin ?? process.env.SECT_BIN, staged: [], log };
  cx.knownIds = collectIds([cx.corpus, inputDir]);
  let records = loadRecords(dir);
  if (o.only) {
    // The subset may be narrower than the run was: leaves outside it and ancestors nothing kept needs are dropped.
    const known = collectKnown([cx.corpus, inputDir]);
    const leaves = records.filter((r) => !r.derived && !known.children.get(r.id) && matchesOnly(r.input, o.only!));
    const keep = new Set(leaves.map((r) => r.id));
    for (const r of leaves) for (const a of ancestorsOf(known, r.id)) keep.add(a.id);
    records = records.filter((r) => keep.has(r.id));
    cx.keepIds = subsetKeepIds(known, leaves.map((r) => r.id), cx.corpus);
    log(`subset ${o.only}: ${leaves.length} leaf record(s) and ${records.length - leaves.length} ancestor(s) kept`);
  }
  for (const r of records) {
    if (r.derived) continue;
    try {
      stageSection(cx, { input: r.input, context: r.context, defines: r.defines, xrefs: r.xrefs, flags: r.flags.filter((f) => !f.startsWith("unresolved: ")), overrides: r.overrides, narrows: r.narrows, actions: r.actions });
    } catch (e) {
      log(`re-stage of ${r.input} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // A notice's Expressions are composed again from the corpus's current text.
  const kindYaml = path.join(inputDir, "_source.yaml");
  const kind = existsSync(kindYaml) ? String(((YAML.parse(readFileSync(kindYaml, "utf-8")) ?? {}) as { kind?: string }).kind ?? "base") : "base";
  if (kind === "notice") {
    for (const r of [...cx.staged]) {
      const c = composeExpressions(cx, r.path, cx.corpus, r.input);
      log(`${r.id}: ${c.derived.length} Expression(s) composed${c.unapplied.length ? `; unapplied: ${c.unapplied.map((u) => `${u.action_id} (${u.why})`).join("; ")}` : ""}`);
    }
    const held = holdFailedCompositions(cx);
    if (held.length) log(`held for a person (composition failed validation): ${held.join(", ")}`);
  }
  const strays = removeStrayFiles(cx);
  if (strays.length) log(`removed ${strays.length} stray file(s): ${strays.slice(0, 8).join(", ")}`);
  let summary: SubmitSummary | null = null;
  let errors = 0;
  try {
    summary = submitRun(cx, strays.length ? `resubmitted; ${strays.length} stray file(s) removed: ${strays.join(", ")}` : "resubmitted");
    finishRun(o.staging, runId, "submitted", { sections: summary.sections_added, xrefs: summary.xrefs_resolved });
  } catch (e) {
    errors = validateRun(cx).errors;
    log(`submit refused: ${e instanceof Error ? e.message.split("\n").slice(0, 6).join("\n") : String(e)}`);
    finishRun(o.staging, runId, "failed", { errors });
  }
  return { runId, staged: cx.staged.length, strays, summary, errors };
}
