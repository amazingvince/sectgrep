// The harness tools an ingest agent gets beside the seven sect verbs (spec D.1): read the
// preprocessed input, stage a section by copying it with the agent's judgment fields applied,
// write any other staging file, validate the staging, and submit. Every write goes through the
// run directory's path guard, and `beforeToolCall` refuses the rest.

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { splitFrontMatter, validateStaging, type Issue, type ValidateReport } from "@sectgrep/convert";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TSchema } from "typebox";
import YAML from "yaml";
import { insideRun } from "./staging.js";

export interface RunContext {
  runId: string;
  /** Absolute run directory, `staging/<run_id>`: a corpus root holding one source directory. */
  runDir: string;
  /** The source name; its files stage under `<runDir>/<source>/`. */
  source: string;
  /** Absolute directory holding WS2's output for this document (a converted source). */
  inputDir: string;
  /** The corpus the staging will join; links resolve against it. */
  corpus: string;
  rawRoot: string;
  work: string;
  sectBin?: string;
  /** Collected by section_stage and submit. */
  staged: StagedRecord[];
  log?: (line: string) => void;
}

export interface XrefResolution {
  text: string;
  id: string;
  anchor?: string | null;
  confidence: number;
  search?: string;
}

export interface StagedRecord {
  id: string;
  input: string;
  path: string;
  context: string;
  defines: string[];
  xrefs: XrefResolution[];
  flags: string[];
  body_tokens: number;
}

export interface SubmitSummary {
  run_id: string;
  sections_added: number;
  sections_changed: number;
  xrefs_resolved: number;
  low_confidence: Array<{ id: string; text: string; target: string; confidence: number }>;
  flags: Array<{ id: string; flag: string }>;
  validators: ValidateReport["validators"];
  errors: number;
  warnings: number;
  notes?: string;
}

const text = (t: string): AgentToolResult<unknown> => ({ content: [{ type: "text", text: t }], details: undefined });
const schema = (properties: Record<string, unknown>, required: string[] = []): TSchema => ({ type: "object", properties, required, additionalProperties: false }) as unknown as TSchema;

function safeInput(cx: RunContext, rel: string): string {
  const base = path.resolve(cx.inputDir);
  const target = path.resolve(base, rel);
  const r = path.relative(base, target);
  if (r.startsWith("..") || path.isAbsolute(r)) throw new Error(`input path ${rel} is outside the run's input`);
  return target;
}

function safeStaging(cx: RunContext, rel: string): string {
  if (!insideRun(cx.runDir, rel)) throw new Error(`refused: ${rel} is outside staging/${cx.runId}/`);
  return path.resolve(cx.runDir, rel);
}

/** Where an input file stages: under the run's source directory. */
export function stagingPathFor(cx: RunContext, inputRel: string): string {
  return `${cx.source}/${inputRel.replace(/\\/g, "/")}`;
}

const tokenCount = (s: string) => (s.match(/[A-Za-z0-9]+(?:[.,][A-Za-z0-9]+)*/g) ?? []).length;

/** Apply a resolved reference as a markdown link at the first bare occurrence of its text. */
export function applyXrefs(body: string, xrefs: XrefResolution[]): { body: string; applied: number } {
  let out = body;
  let applied = 0;
  for (const x of xrefs) {
    if (!x.text || !x.id) continue;
    const target = `${x.id}${x.anchor ? "#" + x.anchor : ""}`;
    // Not already the text of a link, and not inside a link target.
    const idx = findBare(out, x.text);
    if (idx < 0) continue;
    out = `${out.slice(0, idx)}[${x.text}](${target})${out.slice(idx + x.text.length)}`;
    applied++;
  }
  return { body: out, applied };
}

function findBare(body: string, needle: string): number {
  let from = 0;
  for (;;) {
    const i = body.indexOf(needle, from);
    if (i < 0) return -1;
    const before = body.slice(Math.max(0, i - 1), i);
    const after = body.slice(i + needle.length, i + needle.length + 2);
    const inLinkText = before === "[" && after.startsWith("](");
    const inTarget = body.lastIndexOf("](", i) > body.lastIndexOf(")", i);
    if (!inLinkText && !inTarget) return i;
    from = i + needle.length;
  }
}

/**
 * Copy an input section into staging with the agent's judgment fields applied: the context
 * prefix, defined terms, resolved references as links, the run in provenance. The body is
 * copied, never rewritten, so validator 2 holds by construction.
 */
export function stageSection(cx: RunContext, p: { input: string; context: string; defines?: string[]; xrefs?: XrefResolution[]; flags?: string[] }): StagedRecord {
  const src = safeInput(cx, p.input);
  const raw = readFileSync(src, "utf-8");
  const split = splitFrontMatter(raw);
  if (!split) throw new Error(`${p.input}: no front matter`);
  const front = (YAML.parse(split.front) ?? {}) as Record<string, unknown>;
  const context = p.context.replace(/\s+/g, " ").trim();
  const words = context.split(" ").filter(Boolean).length;
  if (words < 30 || words > 110) throw new Error(`context is ${words} words; write 50-100 tokens (about 40-80 words)`);
  front.context = context;
  if (p.defines) front.defines = [...new Set(p.defines.map((d) => d.trim()).filter(Boolean))];
  const prov = (front.provenance ?? {}) as Record<string, unknown>;
  prov.ingest_run = cx.runId;
  const verified = Array.isArray(prov.verified_by) ? (prov.verified_by as unknown[]).map(String) : [];
  if (!verified.includes(`ingest:${cx.runId}`)) verified.push(`ingest:${cx.runId}`);
  prov.verified_by = verified;
  front.provenance = prov;
  const { body, applied } = applyXrefs(split.body, p.xrefs ?? []);
  const outRel = stagingPathFor(cx, p.input);
  const outPath = safeStaging(cx, outRel);
  mkdirSync(path.dirname(outPath), { recursive: true });
  const fm = YAML.stringify(front, { lineWidth: 0 }).trimEnd();
  writeFileSync(outPath, `---\n${fm}\n---\n${body.startsWith("\n") ? "" : "\n"}${body}`, "utf-8");
  const record: StagedRecord = { id: String(front.id ?? ""), input: p.input, path: outRel, context, defines: (front.defines as string[]) ?? [], xrefs: (p.xrefs ?? []).filter((x) => x.id), flags: p.flags ?? [], body_tokens: tokenCount(split.body) };
  const meta = path.join(cx.runDir, ".ingest");
  mkdirSync(meta, { recursive: true });
  writeFileSync(path.join(meta, `${record.id.replace(/[^A-Za-z0-9._-]+/g, "_") || "section"}.json`), JSON.stringify({ ...record, applied }, null, 2) + "\n", "utf-8");
  cx.staged = cx.staged.filter((s) => s.input !== record.input);
  cx.staged.push(record);
  return record;
}

export function validateRun(cx: RunContext): ValidateReport {
  return validateStaging({ staging: cx.runDir, corpus: cx.corpus, rawRoot: cx.rawRoot, work: cx.work, sectBin: cx.sectBin, skipIndex: !cx.sectBin && !process.env.SECT_BIN });
}

/** The submit summary (spec D.2 step 11); throws while the staging has validator errors. */
export function submitRun(cx: RunContext, notes?: string): SubmitSummary {
  const report = validateRun(cx);
  if (report.errors > 0) {
    const first = report.issues.filter((i) => i.level === "error").slice(0, 12).map((i) => `[${i.validator}] ${i.path}: ${i.message}`);
    throw new Error(`staging has ${report.errors} validator error(s); fix them before submit:\n${first.join("\n")}`);
  }
  const summary: SubmitSummary = {
    run_id: cx.runId,
    sections_added: cx.staged.length,
    sections_changed: 0,
    xrefs_resolved: cx.staged.reduce((n, s) => n + s.xrefs.length, 0),
    low_confidence: cx.staged.flatMap((s) => s.xrefs.filter((x) => x.confidence < 0.8).map((x) => ({ id: s.id, text: x.text, target: `${x.id}${x.anchor ? "#" + x.anchor : ""}`, confidence: x.confidence }))),
    flags: cx.staged.flatMap((s) => s.flags.map((f) => ({ id: s.id, flag: f }))),
    validators: report.validators,
    errors: report.errors,
    warnings: report.warnings,
    notes,
  };
  writeFileSync(path.join(cx.runDir, "submit.json"), JSON.stringify(summary, null, 2) + "\n", "utf-8");
  return summary;
}

const formatIssues = (issues: Issue[], max = 30) => issues.slice(0, max).map((i) => `${i.level} [${i.validator}] ${i.path}: ${i.message}`).join("\n");

/** The harness tools as Pi AgentTools. */
export function harnessTools(cx: RunContext): AgentTool[] {
  return [
    {
      name: "input_list",
      label: "input_list",
      description: "List the files of this run's preprocessed input (WS2's output), relative paths.",
      parameters: schema({ dir: { type: "string", description: "Subdirectory, default the whole input" } }),
      executionMode: "parallel",
      async execute(_id: string, raw: unknown) {
        const params = raw as { dir?: string };
        const base = safeInput(cx, params.dir ?? ".");
        const out: string[] = [];
        const walk = (d: string) => {
          if (!existsSync(d)) return;
          for (const n of readdirSync(d).sort()) {
            const p = path.join(d, n);
            if (statSync(p).isDirectory()) walk(p);
            else out.push(path.relative(cx.inputDir, p).replace(/\\/g, "/"));
          }
        };
        walk(base);
        return text(out.join("\n") || "(empty)");
      },
    },
    {
      name: "input_read",
      label: "input_read",
      description: "Read one file of this run's preprocessed input (a converted section with front matter and body, an elements.jsonl, a _source.yaml).",
      parameters: schema({ path: { type: "string" } }, ["path"]),
      executionMode: "parallel",
      async execute(_id: string, raw: unknown) {
        const params = raw as { path: string };
        const t = readFileSync(safeInput(cx, params.path), "utf-8");
        return text(t.length > 60_000 ? t.slice(0, 60_000) + "\n[truncated]" : t);
      },
    },
    {
      name: "staging_write",
      label: "staging_write",
      description: `Write a file under staging/${cx.runId}/ (relative path; sections live under ${cx.source}/). Refused outside it. For sections use section_stage, which copies the text for you.`,
      parameters: schema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
      executionMode: "sequential",
      async execute(_id: string, raw: unknown) {
        const params = raw as { path: string; content: string };
        const p = safeStaging(cx, params.path);
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, params.content, "utf-8");
        return text(`wrote staging/${cx.runId}/${params.path} (${params.content.length} chars)`);
      },
    },
    {
      name: "section_stage",
      label: "section_stage",
      description:
        "Stage one input section: the body is copied verbatim; you supply the context prefix (50-100 tokens, names at least one referenced section's subject, no paraphrase of the body), the terms the section defines, the prose references you resolved with sect_search (text as it appears, the real id, optional anchor, confidence 0-1, the search used), and flags for anything a human should see.",
      parameters: schema(
        {
          input: { type: "string", description: "Input path of the section, as listed by input_list" },
          context: { type: "string" },
          defines: { type: "array", items: { type: "string" } },
          xrefs: {
            type: "array",
            items: { type: "object", properties: { text: { type: "string" }, id: { type: "string" }, anchor: { type: "string" }, confidence: { type: "number" }, search: { type: "string" } }, required: ["text", "id", "confidence"] },
          },
          flags: { type: "array", items: { type: "string" } },
        },
        ["input", "context"],
      ),
      executionMode: "sequential",
      async execute(_id: string, raw: unknown) {
        const params = raw as { input: string; context: string; defines?: string[]; xrefs?: XrefResolution[]; flags?: string[] };
        const r = stageSection(cx, params);
        cx.log?.(`staged ${r.id} (${r.xrefs.length} xrefs, ${r.defines.length} defines${r.flags.length ? ", flags: " + r.flags.join("; ") : ""})`);
        return { content: [{ type: "text", text: `staged ${r.id} -> staging/${cx.runId}/${r.path}; ${r.xrefs.length} reference(s) linked, ${r.defines.length} term(s)` }], details: r };
      },
    },
    {
      name: "staging_validate",
      label: "staging_validate",
      description: "Run the seven C.5 validators on this run's staging against the corpus. Returns errors and warnings; fix errors, then submit.",
      parameters: schema({}),
      executionMode: "sequential",
      async execute() {
        const r = validateRun(cx);
        return { content: [{ type: "text", text: `${r.errors} error(s), ${r.warnings} warning(s) over ${r.documents} document(s)\n${formatIssues(r.issues.filter((i) => i.level === "error"))}` }], details: { errors: r.errors, warnings: r.warnings, validators: r.validators } };
      },
    },
    {
      name: "submit",
      label: "submit",
      description: "Validate and submit the run: writes submit.json with sections added, references resolved with the low-confidence list, and flags. Refused while validators report errors. Never writes to the corpus.",
      parameters: schema({ notes: { type: "string" } }),
      executionMode: "sequential",
      async execute(_id: string, raw: unknown) {
        const params = raw as { notes?: string };
        const s = submitRun(cx, params.notes);
        return { content: [{ type: "text", text: `submitted ${s.run_id}: ${s.sections_added} section(s), ${s.xrefs_resolved} reference(s) resolved (${s.low_confidence.length} low-confidence), ${s.flags.length} flag(s)` }], details: s };
      },
    },
  ];
}

/** Tools the ingest agent may call: the read-only sect verbs and the harness tools; nothing else. */
export const ALLOWED_TOOLS = new Set(["sect_search", "sect_grep", "sect_read", "sect_refs", "sect_define", "sect_map", "sect_status", "input_list", "input_read", "staging_write", "section_stage", "staging_validate", "submit"]);

/** The `beforeToolCall` guard: refuses unknown tools and any staging write outside the run directory. */
export function guardToolCall(cx: RunContext, toolCall: { name: string; arguments: Record<string, unknown> }): { block: true; reason: string } | undefined {
  if (!ALLOWED_TOOLS.has(toolCall.name)) return { block: true, reason: `${toolCall.name} is not available to the ingest agent` };
  if (toolCall.name === "staging_write" || toolCall.name === "section_stage") {
    const p = String((toolCall.arguments as { path?: unknown; input?: unknown }).path ?? (toolCall.arguments as { input?: unknown }).input ?? "");
    if (!insideRun(cx.runDir, p)) return { block: true, reason: `refused: writes are allowed only under staging/${cx.runId}/ (got ${p || "(empty)"})` };
  }
  return undefined;
}
