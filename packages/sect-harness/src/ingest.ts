// The ingest run (spec D.2): one preprocessed source in, one `staging/<run_id>/` out. Steps 1-7
// are the agent's, one section at a time with the seven verbs and the harness tools; step 10
// re-prompts the agent with the validator's findings up to three times; step 11 submits. The
// harness copies section text itself (section_stage) and never writes to the corpus. Without a
// model (`dryRun`) the harness stages every section with WS2's own context, which is how the
// tests and a key-less CI exercise the whole path.

import { Agent } from "@mariozechner/pi-agent-core";
import type { Usage } from "@mariozechner/pi-ai";
import { loadDotEnv, providerExtras, splitFrontMatter } from "@sectgrep/convert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { modelFromEnv, type ModelChoice } from "./model.js";
import { connectSect } from "./sect-tools.js";
import { claimRun, finishRun, lockSource, runDir, runIdFor, type RunEntry } from "./staging.js";
import { collectIds, guardToolCall, harnessTools, loadRecords, removeStrayFiles, stageSection, stagingPathFor, submitRun, validateRun, type RunContext, type SubmitSummary } from "./tools.js";

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

/** Bare references in a body that are not yet links: what the agent is asked to resolve. */
export function bareReferences(body: string): string[] {
  const seen = new Set<string>();
  // Headings carry the section's own number, which is not a citation.
  const plain = body.replace(/^\s*#.*$/gm, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, " ");
  for (const m of plain.matchAll(/§§?\s*\d{1,4}\.\d{1,4}[a-z]?(?:-\d+)?(?:\([a-z0-9]{1,4}\))*|\bparts?\s+\d{1,4}\b|\d{1,2}\s+CFR\s+(?:parts?\s+)?\d{1,4}(?:\.\d{1,4}[a-z]?)?/gi)) seen.add(m[0].replace(/\s+/g, " ").trim());
  return [...seen].slice(0, 20);
}

function sectionPrompt(rel: string, content: string, refs: string[]): string {
  const lines = [
    `Ingest this section from the input file \`${rel}\`. Follow SKILL-ingest.md: read it, resolve its bare references, then call section_stage exactly once with input="${rel}", your context prefix, the terms it defines, the references you resolved, and any flags.`,
    refs.length ? `Bare references to resolve with sect_search (skip any you cannot resolve to a real id; note them in flags): ${refs.join("; ")}` : "No bare references were detected; still check the body for any and resolve them.",
    "",
    "```markdown",
    content.length > 40_000 ? content.slice(0, 40_000) + "\n[truncated]" : content,
    "```",
  ];
  return lines.join("\n");
}

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
    const usage = existsSync(path.join(dir, "usage.json")) ? (JSON.parse(readFileSync(path.join(dir, "usage.json"), "utf-8")) as RunUsage) : { input: 0, output: 0, cost: 0, calls: 0, document_tokens: 0 };
    return { runId, runDir: dir, reused: true, sections: summary?.sections_added ?? 0, staged: summary?.sections_added ?? 0, failed: [], fixRounds: 0, usage, summary, errors: 0, entry: claim.existing };
  }
  const release = lockSource(o.staging, o.source);
  const cx: RunContext = { runId, runDir: dir, source: o.source, inputDir, corpus: path.resolve(o.corpus), rawRoot: path.resolve(o.rawRoot ?? "."), work: path.resolve(o.work ?? "work"), sectBin: o.sectBin ?? process.env.SECT_BIN, staged: [], log };
  cx.knownIds = collectIds([cx.corpus, inputDir]);
  mkdirSync(path.join(dir, o.source), { recursive: true });
  const files = walkMarkdown(inputDir).map((f) => path.relative(inputDir, f).replace(/\\/g, "/"));
  // Structural nodes (title, chapter, part, subpart) carry a heading and a listing of their
  // children, not rule text: the harness stages them with WS2's context, and the agent's turns
  // go to sections.
  const levelOf = (rel: string) => {
    const split = splitFrontMatter(readFileSync(path.join(inputDir, rel), "utf-8"));
    return String(((YAML.parse(split?.front ?? "") ?? {}) as { level?: string }).level ?? "section");
  };
  const structural = files.filter((f) => levelOf(f) !== "section");
  const sectionFiles = files.filter((f) => levelOf(f) === "section");
  const sections = o.limit ? sectionFiles.slice(0, o.limit) : sectionFiles;
  // The source's registry entry travels with the sections: the run directory is a corpus root
  // and the source is its one subdirectory, so validators and `sect index` read it as a corpus.
  if (existsSync(path.join(inputDir, "_source.yaml"))) writeFileSync(path.join(dir, o.source, "_source.yaml"), readFileSync(path.join(inputDir, "_source.yaml")), "utf-8");
  else throw new Error(`${o.input} has no _source.yaml; point --input at the converted source directory`);
  const failed: Array<{ input: string; error: string }> = [];
  const usage: RunUsage = { input: 0, output: 0, cost: 0, calls: 0, document_tokens: 0 };
  for (const rel of sections) {
    const split = splitFrontMatter(readFileSync(path.join(inputDir, rel), "utf-8"));
    usage.document_tokens += tokenCount(split?.body ?? "");
  }
  let fixRounds = 0;
  try {
    for (const rel of structural) {
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
          const front = (YAML.parse(split?.front ?? "") ?? {}) as { context?: string; defines?: string[] };
          stageSection(cx, { input: rel, context: String(front.context ?? ""), defines: front.defines ?? [], xrefs: [], flags: ["dry-run: WS2 context kept, no references resolved"] });
        } catch (e) {
          failed.push({ input: rel, error: e instanceof Error ? e.message : String(e) });
        }
      }
    } else {
      const choice = o.model ?? modelFromEnv();
      if (!choice.model || !choice.config.apiKey) throw new Error(`no model available: provider ${choice.config.provider}, model ${choice.config.model}; copy .env.example to .env, or pass --dry-run`);
      const skill = readFileSync(o.skillPath ?? path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../../../docs/SKILL-ingest.md"), "utf-8");
      const sect = await connectSect({ bin: cx.sectBin ?? "sect", corpus: cx.corpus });
      try {
        const tools = [...sect.tools, ...harnessTools(cx)];
        const runOne = async (rel: string, extra?: string) => {
          const content = readFileSync(path.join(inputDir, rel), "utf-8");
          const body = splitFrontMatter(content)?.body ?? content;
          const agent = new Agent({
            initialState: { systemPrompt: skill, model: choice.model!, tools },
            beforeToolCall: async ({ toolCall }) => guardToolCall(cx, toolCall as { name: string; arguments: Record<string, unknown> }),
          });
          const prompt = sectionPrompt(rel, content, bareReferences(body)) + (extra ? `\n\nThe validators reported on your previous attempt:\n${extra}\nFix the section and call section_stage again.` : "");
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
          while (next < sections.length) {
            const rel = sections[next++];
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
  const records = loadRecords(dir);
  for (const r of records) {
    try {
      stageSection(cx, { input: r.input, context: r.context, defines: r.defines, xrefs: r.xrefs, flags: r.flags.filter((f) => !f.startsWith("unresolved: ")) });
    } catch (e) {
      log(`re-stage of ${r.input} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
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
