// Spec D.3 layer 3: the answer-blind Verifier and consensus. For every staged section the
// verifier gets the same inputs the ingest agent had, the WS2 section and the bare references in
// it with the candidate ids the corpus offers for each, and never the ingest agent's answers. It
// runs on a different model family (decisions #43) with a different prompt, one completion per
// section and no tools, and answers in JSON. Consensus compares the two runs field by field:
// agreement is the auto tier, disagreement is a conflict a person resolves.

import type { Usage } from "@mariozechner/pi-ai";
import { providerExtras, splitFrontMatter, tokens } from "@sectgrep/convert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { evidenceChecks, type EvidenceIssue } from "./evidence.js";
import { bareReferences, candidatesFor, collectKnown, hasChildren, isDeterministic, type Candidate, type Known } from "./refs.js";
import { verifierModelFromEnv, type ModelChoice } from "./model.js";
import { loadRecords, type StagedRecord } from "./tools.js";
import { assertBinding, bindVerification, evidenceDependencies, type VerificationBinding } from "./binding.js";

export interface VerifierAnswer {
  xrefs: Array<{ text: string; id: string | null; anchor?: string | null; confidence: number; reason?: string }>;
  defines: string[];
  overrides?: string[];
  narrows?: Array<{ id: string; anchor?: string | null }>;
  /** One entry per action_id: the target the instruction names, or null when no candidate fits. */
  actions?: Array<{ action_id: string; target_id: string | null; target_anchor?: string | null; kind?: string }>;
  action_targets?: string[];
  notes?: string;
}

export interface Judgment {
  field: "xref" | "defines" | "overrides" | "narrows" | "action";
  text?: string;
  ingest: string;
  verifier: string;
  agree: boolean;
  /** Not a judgment: an explicit citation with exactly one real id. */
  deterministic?: boolean;
  ingest_confidence?: number;
  ingest_search?: string;
  verifier_reason?: string;
  ingest_kind?: string;
  verifier_kind?: string;
  /** A person decided it (`ingest`, `verifier`, `none`, or an id); the two runs no longer matter. */
  resolved?: string;
  resolved_value?: string;
}

export interface Resolution {
  id: string;
  field: Judgment["field"];
  text?: string;
  ingest: string;
  verifier: string;
  pick: string;
  value: string;
  why?: string;
  date: string;
}

export interface SectionVerdict {
  id: string;
  path: string;
  input: string;
  tier: "auto" | "conflict";
  judgments: Judgment[];
  evidence: EvidenceIssue[];
}

export interface VerifyReport {
  binding?: VerificationBinding;
  run_id: string;
  verifier: { provider: string; model: string };
  level: SamplingLevel;
  sections: SectionVerdict[];
  counts: { sections: number; auto: number; conflict: number; judgments: number; deterministic: number; agreements: number; evidence_fails: number };
  agreement_rate: number;
  usage: { input: number; output: number; cost: number; calls: number };
  /** Decisions people made on conflicts of this run, in order. */
  resolutions?: Resolution[];
}

export type SamplingLevel = "normal" | "tightened" | "reduced";

export interface VerifyOptions {
  runDir: string;
  input: string;
  source: string;
  corpus: string;
  staging: string;
  /** Review directory for `<run_id>.md`. */
  review?: string;
  work?: string;
  model?: ModelChoice;
  /** Injected verifier (tests): the prompt in, the answer out. */
  verify?: (prompt: string, system: string) => Promise<{ answer: VerifierAnswer; usage?: Usage }>;
  /** The sect binary, for search-derived overlay candidates (default SECT_BIN). */
  sectBin?: string;
  concurrency?: number;
  limit?: number;
  level?: SamplingLevel;
  log?: (line: string) => void;
}

export { candidatesFor, collectKnown, isDeterministic, type Known };

export const VERIFIER_SYSTEM = `You are the Verifier of sectgrep (spec D.3). You check one section of a regulatory corpus, blind: you do not see the ingest agent's answers, and you decide every judgment field yourself from the section and the candidates given. You never invent an id: an id you give must be one of the candidates listed for that reference, or null. Answer with one JSON object and nothing else:
{"xrefs":[{"text":"<the reference exactly as listed>","id":"<candidate id or null>","anchor":"<paragraph anchor or null>","confidence":0.0-1.0,"reason":"<one short sentence>"}],"defines":["<term the section defines, as written, without emphasis marks>"],"overrides":["<candidate ids the overlay item replaces whole; only for an overlay>"],"narrows":[{"id":"<candidate id whose paragraph the item changes or excepts>","anchor":"<anchor or null>"}],"actions":[{"action_id":"<as listed>","target_id":"<candidate id or null>","target_anchor":"<anchor or null>","kind":"amend|add|remove|redesignate|stay"}],"notes":"<anything a person should see, or empty>"}
Rules: a citation in a form a source's id pattern recognizes is the id that pattern builds, when that id is a candidate; a citation that names no source is the candidate in the section's own source when there is one, and is uncertain (confidence below 0.5) when only other sources offer it; a container named by its level and number (a part, chapter, subpart, article) is that node in the section's own source; "paragraph (x) of this section" is the section itself with anchor x; "this <level>" is the nearest ancestor of that level; a term is defined only by a sentence of the form "Term means ..." or "Term is defined as ...". Keep reasons short.`;

export interface PromptExtras {
  /** Overlay: the base candidates search and the item's citations offer. */
  overlayCandidates?: Candidate[];
  /** Notice: each Action's instruction and the candidates its citations offer (the converter's proposal is not shown). */
  actions?: Array<{ action_id: string; instruction: string; candidates: Candidate[] }>;
}

export function verifierPrompt(rel: string, inputText: string, refs: string[], candidates: Map<string, Candidate[]>, kind: string, extras: PromptExtras = {}): string {
  const lines = [`Section file: ${rel} (source kind: ${kind}).`, ""];
  const show = (c: Candidate[]) => (c.length ? c.map((x) => `${x.id}${x.anchor ? "#" + x.anchor : ""} (${x.title.slice(0, 60) || "no title"})`).join("; ") : "no candidate");
  if (refs.length) {
    lines.push("Bare references in the body and the candidate ids the corpus offers for each:");
    for (const r of refs) lines.push(`- "${r}": ${show(candidates.get(r) ?? [])}`);
  } else lines.push("No bare references were found in the body.");
  if (kind === "overlay") {
    lines.push("", "This is an overlay item. From these base candidates (found by search on its subject and by its citations), list in overrides the ones it replaces whole and in narrows the ones whose paragraph it changes or excepts, with the paragraph anchor when the text names one; an item that only adopts the base as it stands has neither:");
    lines.push(`- candidates: ${show(extras.overlayCandidates ?? [])}`);
  }
  if (kind === "notice") {
    lines.push("", "This is a notice. For each Action below, name in actions the target its instruction amends (a candidate id or null), the paragraph anchor it names or null, and the kind of change:");
    for (const a of extras.actions ?? []) lines.push(`- ${a.action_id}: ${a.instruction.slice(0, 300)} | candidates: ${show(a.candidates)}`);
  }
  // The whole text of a long section drowns a reasoning model's budget: the verifier reads the
  // front matter and the head, then the sentences that hold each span it must judge.
  const shown = focusedText(inputText, [...refs, ...(extras.actions ?? []).map((a) => a.instruction.slice(0, 80))], kind === "notice" ? 6_000 : 8_000);
  lines.push("", "```markdown", shown, "```");
  return lines.join("\n");
}

/** The front matter and the head of a document, plus the sentences holding the given spans, within a budget. */
export function focusedText(text: string, spans: string[], budget: number): string {
  if (text.length <= budget) return text;
  const fm = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
  const front = fm > 0 ? text.slice(0, fm + 4) : "";
  const body = fm > 0 ? text.slice(fm + 4) : text;
  const headLen = Math.max(1_500, Math.floor(budget / 3));
  const parts = [front.length > budget / 2 ? front.slice(0, Math.floor(budget / 2)) + "\n[front matter truncated]" : front, body.slice(0, headLen), "[...]"];
  const seen = new Set<string>();
  for (const s of spans) {
    if (!s) continue;
    const at = body.indexOf(s, headLen);
    if (at < 0) continue;
    const start = Math.max(body.lastIndexOf("\n", at) + 1, body.lastIndexOf(". ", at) + 1, headLen);
    const ends = [body.indexOf(". ", at + s.length), body.indexOf("\n", at + s.length)].filter((i) => i >= 0).map((i) => i + 1);
    const sentence = body.slice(start, ends.length ? Math.min(...ends) : body.length).trim();
    if (sentence && !seen.has(sentence)) {
      seen.add(sentence);
      parts.push(sentence.slice(0, 600));
    }
  }
  let out = parts.join("\n\n");
  if (out.length > budget) out = out.slice(0, budget) + "\n[truncated]";
  return out;
}

export function parseAnswer(text: string): VerifierAnswer {
  const body = text.replace(/^[\s\S]*?```(?:json)?\s*/i, (m) => (text.includes("```") ? "" : m)).replace(/```[\s\S]*$/, "");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`verifier answered without JSON: ${text.slice(0, 120)}`);
  // Trailing commas are the one malformation seen; nothing else is repaired.
  const j = JSON.parse(body.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1")) as Partial<VerifierAnswer>;
  return {
    xrefs: Array.isArray(j.xrefs) ? j.xrefs.map((x) => ({ text: String(x.text ?? ""), id: x.id ? String(x.id) : null, anchor: x.anchor ? String(x.anchor) : null, confidence: Number(x.confidence ?? 0), reason: x.reason ? String(x.reason) : undefined })) : [],
    defines: Array.isArray(j.defines) ? j.defines.map(String) : [],
    overrides: Array.isArray(j.overrides) ? j.overrides.map(String) : [],
    narrows: Array.isArray(j.narrows) ? j.narrows.map((n) => ({ id: String((n as { id?: unknown }).id ?? n), anchor: (n as { anchor?: unknown }).anchor ? String((n as { anchor?: unknown }).anchor) : null })) : [],
    actions: Array.isArray(j.actions) ? j.actions.map((a) => ({ action_id: String(a.action_id ?? ""), target_id: a.target_id ? String(a.target_id) : null, target_anchor: a.target_anchor ? String(a.target_anchor) : null, kind: a.kind ? String(a.kind) : undefined })) : [],
    action_targets: Array.isArray(j.action_targets) ? j.action_targets.map(String) : [],
    notes: j.notes ? String(j.notes) : undefined,
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
const idOf = (x: { id: string; anchor?: string | null }) => `${x.id}${x.anchor ? "#" + x.anchor : ""}`;

/** Counts and the agreement rate over a run's verdicts. */
export function summarize(verdicts: SectionVerdict[], evidenceFails: number): { counts: VerifyReport["counts"]; agreement_rate: number } {
  const judgments = verdicts.flatMap((v) => v.judgments);
  const nonDet = judgments.filter((j) => !j.deterministic);
  return {
    counts: { sections: verdicts.length, auto: verdicts.filter((v) => v.tier === "auto").length, conflict: verdicts.filter((v) => v.tier === "conflict").length, judgments: nonDet.length, deterministic: judgments.length - nonDet.length, agreements: nonDet.filter((j) => j.agree).length, evidence_fails: evidenceFails },
    agreement_rate: nonDet.length ? nonDet.filter((j) => j.agree).length / nonDet.length : 1,
  };
}

/** Field-by-field comparison of the ingest record and the verifier's answer. */
export function consensus(record: StagedRecord, answer: VerifierAnswer, refs: string[], candidates: Map<string, Candidate[]>, level: SamplingLevel, front: { overrides?: unknown; narrows?: unknown; amended_by?: unknown; actions?: Array<{ action_id?: string; target_id: string; target_anchor?: string | null; kind?: string }> }): Judgment[] {
  const out: Judgment[] = [];
  // Normalize inline anchors, but require the complete target to agree.
  const split = (v: { id: string | null; anchor?: string | null }) => {
    const [base, inline] = (v.id ?? "").split("#");
    return { id: base || null, anchor: v.anchor ?? inline ?? null };
  };
  const byText = new Map(answer.xrefs.map((x) => [norm(x.text), x]));
  const seen = new Set<string>();
  for (const x of record.xrefs) {
    seen.add(norm(x.text));
    const v = byText.get(norm(x.text));
    const vs = v ? split(v) : null;
    const c = candidates.get(x.text) ?? [];
    const det = isDeterministic(x, c);
    const ingest = idOf(x);
    const verifier = vs?.id ? idOf({ id: vs.id, anchor: vs.anchor }) : v ? "(none)" : "(not judged)";
    let agree = (!!vs?.id && idOf({ id: vs.id, anchor: vs.anchor }) === idOf(split(x) as { id: string; anchor?: string | null })) || (det && !v);
    if (agree && level === "tightened" && !det && x.confidence < 0.8) agree = false;
    out.push({ field: "xref", text: x.text, ingest, verifier, agree, deterministic: det, ingest_confidence: x.confidence, ingest_search: x.search, verifier_reason: v?.reason });
  }
  for (const r of refs) {
    if (seen.has(norm(r))) continue;
    const v = byText.get(norm(r));
    const vs = v ? split(v) : null;
    if (vs?.id && v && v.confidence >= 0.8) out.push({ field: "xref", text: r, ingest: "(left bare)", verifier: idOf({ id: vs.id, anchor: vs.anchor }), agree: false, verifier_reason: v.reason });
  }
  // Compared without case or emphasis; shown as written, so a resolution keeps the original form.
  const a = new Set(record.defines.map(norm));
  const b = new Set(answer.defines.map(norm));
  if (a.size || b.size) out.push({ field: "defines", ingest: record.defines.join(", ") || "(none)", verifier: answer.defines.map((d) => d.replace(/[*_`]/g, "").trim()).join(", ") || "(none)", agree: a.size === b.size && [...a].every((t) => b.has(t)) });
  // Overlay proposals: the record's when the agent made them, else the input's (a dry run).
  const ov = record.overrides ? record.overrides.map((o) => o.id) : ((front.overrides ?? []) as unknown[]).map((t) => (t && typeof t === "object" ? String((t as { id?: unknown }).id) : String(t)));
  const vo = [...new Set((answer.overrides ?? []).map((t) => t.split("#")[0]))];
  if (ov.length || vo.length) out.push({ field: "overrides", ingest: ov.join(", ") || "(none)", verifier: vo.join(", ") || "(none)", agree: ov.length === vo.length && ov.every((t) => vo.includes(t)) });
  const na = record.narrows ? record.narrows.map((n) => idOf({ id: n.id, anchor: n.anchor ?? null })) : ((front.narrows ?? []) as unknown[]).map((t) => (t && typeof t === "object" ? idOf(t as { id: string; anchor?: string }) : String(t)));
  const nv = (answer.narrows ?? []).map((n) => idOf(split(n) as { id: string; anchor?: string | null }));
  if (na.length || nv.length) out.push({ field: "narrows", ingest: na.join(", ") || "(none)", verifier: nv.join(", ") || "(none)", agree: na.length === nv.length && na.every((t) => nv.includes(t)) });
  // Notice Actions, one judgment each: the target and paragraph the instruction amends.
  const acts = record.actions ?? (front.actions ?? []).map((a) => ({ action_id: String(a.action_id ?? ""), target_id: a.target_id, target_anchor: a.target_anchor ?? null, kind: a.kind ?? "amend" }));
  const va = new Map((answer.actions ?? []).map((a) => [a.action_id, a]));
  for (const a of acts) {
    if (!a.action_id) continue;
    const v = va.get(a.action_id);
    const vs = v?.target_id ? split({ id: v.target_id, anchor: v.target_anchor ?? null }) : null;
    const ingest = idOf({ id: a.target_id, anchor: a.target_anchor ?? null });
    const verifier = vs?.id ? idOf({ id: vs.id, anchor: vs.anchor }) : v ? "(none)" : "(not judged)";
    // A unique candidate proves neither the operation nor the affected paragraph.
    out.push({ field: "action", text: a.action_id, ingest, verifier, ingest_kind: a.kind, verifier_kind: v?.kind, agree: !!v && ingest === verifier && a.kind === v.kind, deterministic: false, verifier_reason: v ? `kind ${v.kind ?? "?"}` : undefined });
  }
  return out;
}

/** One completion at the provider's chat endpoint with a hard timeout; the usage priced by the model's table. */
async function askDirect(choice: ModelChoice, user: string, timeoutMs: number, reasoningOff = false): Promise<{ text: string; input: number; output: number; cost: number }> {
  const t0 = Date.now();
  if (process.env.SECT_VERIFIER_TRACE) console.error(`verifier: asking (${user.length} chars)`);
  const model = choice.model as { baseUrl?: string; cost: { input: number; output: number } } | undefined;
  const base = (model?.baseUrl ?? choice.config.baseUrl).replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { authorization: `Bearer ${choice.config.apiKey}`, "content-type": "application/json" },
    // A reasoning model thinks for thousands of tokens before it answers: the budget is generous and uncapped (the user's call: tokens are cheap), the timeout long; reasoning.enabled=false is the last resort when it still answers nothing.
    body: JSON.stringify({ model: choice.config.model, temperature: 0, max_tokens: 65_536, ...(reasoningOff ? { reasoning: { enabled: false } } : {}), ...providerExtras(choice.config), provider: { sort: "throughput", ...((providerExtras(choice.config) as { provider?: object }).provider ?? {}) }, messages: [{ role: "system", content: VERIFIER_SYSTEM }, { role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`verifier HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } };
  if (data.error) throw new Error(`verifier: ${data.error.message ?? "error"}`);
  const input = data.usage?.prompt_tokens ?? 0;
  const output = data.usage?.completion_tokens ?? 0;
  if (process.env.SECT_VERIFIER_TRACE) console.error(`verifier: answered in ${Date.now() - t0} ms, ${output} completion tokens, ${String(data.choices?.[0]?.message?.content ?? "").length} chars`);
  return { text: String(data.choices?.[0]?.message?.content ?? ""), input, output, cost: (input * (model?.cost.input ?? 0) + output * (model?.cost.output ?? 0)) / 1e6 };
}

/** Ids the corpus's own search returns for a query, through the sect binary; none without one. */
export function searchIds(bin: string | undefined, corpus: string, query: string, limit = 8): string[] {
  if (!bin || !query.trim()) return [];
  const r = spawnSync(bin.includes("/") || bin.includes("\\") ? path.resolve(bin) : bin, ["search", query.slice(0, 400), "--corpus", corpus, "--json", "--limit", String(limit), "--no-refresh"], { encoding: "utf-8" });
  if (r.status !== 0) return [];
  try {
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) as { result?: { hits?: Array<{ id?: string }> } };
    return (j.result?.hits ?? []).map((h) => String(h.id ?? "")).filter(Boolean);
  } catch {
    return [];
  }
}

/** Run the verifier over a submitted run and write verify.json and the review file. */
export async function verifyRun(o: VerifyOptions): Promise<VerifyReport> {
  const log = o.log ?? ((l: string) => console.log(l));
  const runDir = path.resolve(o.runDir);
  const runId = path.basename(runDir);
  const inputDir = path.resolve(o.input);
  const records = loadRecords(runDir);
  const roots = [runDir, inputDir, path.resolve(o.corpus)];
  const binding = bindVerification(runDir, [inputDir, path.resolve(o.corpus), ...evidenceDependencies(roots, o.work)]);
  if (!records.length) throw new Error(`${o.runDir} has no .ingest records; ingest first`);
  const known = collectKnown([path.resolve(o.corpus), inputDir]);
  const level = o.level ?? "normal";
  const sectBin = o.sectBin ?? process.env.SECT_BIN;
  const choice = o.verify ? undefined : (o.model ?? verifierModelFromEnv());
  if (!o.verify && (!choice?.model || !choice.config.apiKey)) throw new Error(`no verifier model: provider ${choice?.config.provider}, model ${choice?.config.model}; set SECT_VERIFIER_MODEL and the key in .env`);
  // What a link from this run can resolve at merge: the corpus and the run's own records.
  const available = new Set<string>([...collectKnown([path.resolve(o.corpus)]).ids.keys(), ...records.map((r) => r.id)]);
  const evidence = evidenceChecks({ staging: runDir, corpus: o.corpus, records, work: o.work });
  const evidenceByPath = new Map<string, EvidenceIssue[]>();
  for (const i of evidence.issues) evidenceByPath.set(i.path, [...(evidenceByPath.get(i.path) ?? []), i]);
  const sourceKind = (() => {
    const y = path.join(inputDir, "_source.yaml");
    return existsSync(y) ? String(((YAML.parse(readFileSync(y, "utf-8")) ?? {}) as { kind?: string }).kind ?? "base") : "base";
  })();
  const todo = (o.limit ? records.slice(0, o.limit) : records).filter((r) => r.derived || existsSync(path.join(inputDir, r.input)));
  const usage = { input: 0, output: 0, cost: 0, calls: 0 };
  const verdicts: SectionVerdict[] = [];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const r = todo[next++];
      // An Expression the harness composed carries no judgment of its own; the evidence checks see it.
      if (r.derived) {
        const ev = evidenceByPath.get(r.path.replace(/\\/g, "/")) ?? [];
        verdicts.push({ id: r.id, path: r.path, input: r.input, tier: ev.some((i) => i.level === "fail") ? "conflict" : "auto", judgments: [], evidence: ev });
        continue;
      }
      const text = readFileSync(path.join(inputDir, r.input), "utf-8");
      const split = splitFrontMatter(text);
      const front = (YAML.parse(split?.front ?? "") ?? {}) as { title?: string; overrides?: unknown; narrows?: unknown; amended_by?: unknown; actions?: Array<{ action_id?: string; target_id: string; target_anchor?: string | null; kind?: string; instruction?: string }> };
      // The spans to judge: the references the harness detects, plus the spans the ingest agent
      // linked (their text only, never their targets), so every judgment field gets a second opinion.
      const refs = [...new Set([...bareReferences(split?.body ?? text, known, r.id), ...r.xrefs.map((x) => x.text)])].slice(0, 24);
      const candidates = new Map(refs.map((t) => [t, candidatesFor(t, r.id, known)]));
      const extras: PromptExtras = {};
      if (sourceKind === "overlay") {
        // Candidates from the item's citations and from a search of the corpus on its subject.
        const fromRefs = refs.flatMap((t) => candidatesFor(t, r.id, known)).filter((c) => c.source !== (known.nodes.get(r.id)?.source ?? ""));
        const query = `${String(front.title ?? "")} ${(split?.body ?? "").replace(/^#.*$/m, "").replace(/\s+/g, " ").trim().slice(0, 300)}`.trim();
        const found = searchIds(sectBin, path.resolve(o.corpus), query, 8).filter((id) => known.nodes.has(id)).map((id) => ({ id, title: known.ids.get(id) ?? "", via: "pattern" as const, source: known.nodes.get(id)?.source }));
        const seen = new Set<string>();
        extras.overlayCandidates = [...fromRefs, ...found].filter((c) => !seen.has(c.id) && seen.add(c.id)).slice(0, 12);
        candidates.set("(overlay)", extras.overlayCandidates);
      }
      if (sourceKind === "notice") {
        extras.actions = [];
        for (const a of front.actions ?? []) {
          if (!a.action_id) continue;
          const cites = bareReferences(String(a.instruction ?? ""), known, r.id);
          const c = cites.flatMap((t) => candidatesFor(t, r.id, known));
          if (known.nodes.has(a.target_id) && !c.some((x) => x.id === a.target_id)) c.push({ id: a.target_id, title: known.ids.get(a.target_id) ?? "", via: "pattern", source: known.nodes.get(a.target_id)?.source });
          const seen = new Set<string>();
          const list = c.filter((x) => !seen.has(x.id) && seen.add(x.id)).slice(0, 8);
          candidates.set(a.action_id, list);
          extras.actions.push({ action_id: a.action_id, instruction: String(a.instruction ?? ""), candidates: list });
        }
      }
      const judgmentsPossible = r.xrefs.length || refs.length || r.defines.length || sourceKind !== "base";
      let judgments: Judgment[] = [];
      // A node with children is structural: a listing, staged by the harness, not a judgment.
      if (judgmentsPossible && !hasChildren(known, r.id)) {
        const prompt = verifierPrompt(r.input, text, refs, candidates, sourceKind, extras);
        let answer: VerifierAnswer;
        let verifierFailed = false;
        try {
          if (o.verify) {
            const v = await o.verify(prompt, VERIFIER_SYSTEM);
            answer = v.answer;
            if (v.usage) {
              usage.input += v.usage.input;
              usage.output += v.usage.output;
              usage.cost += v.usage.cost?.total ?? 0;
            }
          } else {
            // Transient provider errors (rate limits, gateway errors, resets) are retried with backoff.
            const withBackoff = async <T>(f: () => Promise<T>, attempt = 0): Promise<T> => {
              try {
                return await f();
              } catch (e) {
                if (attempt < 3 && /\b429\b|rate.?limit|\b5\d\d\b|ECONNRESET|ETIMEDOUT|timeout|overloaded|temporarily/i.test(String(e))) {
                  await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
                  return withBackoff(f, attempt + 1);
                }
                throw e;
              }
            };
            const ask = async (nudge: string) => {
              // One completion straight to the provider's OpenAI-compatible endpoint: the Pi client
              // streams and stalled for minutes on long sections where the endpoint answers in seconds.
              // Reasoning first, as the user chose; a model that spends the whole budget thinking and
              // answers nothing gets one more chance with reasoning off.
              let m = await withBackoff(() => askDirect(choice!, prompt + nudge, 1_800_000));
              if (!m.text.trim()) m = await withBackoff(() => askDirect(choice!, prompt + nudge, 300_000, true));
              usage.input += m.input;
              usage.output += m.output;
              usage.cost += m.cost;
              return m.text;
            };
            try {
              answer = parseAnswer(await ask(""));
            } catch {
              // One retry when the answer was empty or not JSON.
              usage.calls++;
              answer = parseAnswer(await ask("\n\nAnswer with the JSON object only."));
            }
          }
          usage.calls++;
        } catch (e) {
          log(`verifier failed on ${r.input}: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
          answer = { xrefs: [], defines: [], notes: "verifier call failed" };
          verifierFailed = true;
        }
        judgments = consensus(r, answer, refs, candidates, level, front);
        // Without a second opinion there is no consensus: every judgment stays open.
        if (verifierFailed) judgments = judgments.map((j) => ({ ...j, agree: false, deterministic: false, verifier: "(verifier call failed)" }));
        // A reference the ingest left bare because its target is outside this run and the corpus it
        // joins (a subset run) is not a judgment the ingest could have made; the verifier, reading the
        // whole input, sees a candidate the merge would not resolve.
        judgments = judgments.map((j) => (j.field === "xref" && j.ingest === "(left bare)" && !available.has(j.verifier.split("#")[0]) ? { ...j, agree: true, verifier_reason: `${j.verifier_reason ?? ""} (target outside this run and its corpus)`.trim() } : j));
      }
      const ev = evidenceByPath.get(r.path.replace(/\\/g, "/")) ?? [];
      const candidate = splitFrontMatter(readFileSync(path.join(runDir, r.path), "utf8"));
      if (!hasChildren(known, r.id) && JSON.stringify(tokens(candidate?.body ?? "")) !== JSON.stringify(tokens(split?.body ?? text))) {
        ev.push({ path: r.path, id: r.id, field: "xref", level: "fail", message: "staged source text differs from the submitted extraction" });
      }
      for (const x of r.xrefs) {
        const target = x.id + (x.anchor ? `#${x.anchor}` : "");
        if (!(candidate?.body ?? "").includes(`](${target})`)) ev.push({ path: r.path, id: r.id, field: "xref", level: "fail", message: `recorded link ${target} is absent from the candidate bytes` });
      }
      const conflict = judgments.some((j) => !j.agree) || ev.some((i) => i.level === "fail");
      verdicts.push({ id: r.id, path: r.path, input: r.input, tier: conflict ? "conflict" : "auto", judgments, evidence: ev });
      if (verdicts.length % 25 === 0) log(`${verdicts.length}/${todo.length} verified`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 8) }, worker));
  verdicts.sort((a, b) => a.path.localeCompare(b.path));
  const report: VerifyReport = {
    binding,
    run_id: runId,
    verifier: o.verify ? { provider: "injected", model: "injected" } : { provider: choice!.config.provider, model: choice!.config.model },
    level,
    sections: verdicts,
    ...summarize(verdicts, evidence.issues.filter((i) => i.level === "fail").length),
    usage,
  };
  assertBinding(runDir, binding);
  writeFileSync(path.join(runDir, "verify.json"), JSON.stringify(report, null, 2) + "\n", "utf-8");
  const review = path.resolve(o.review ?? "review");
  mkdirSync(review, { recursive: true });
  writeFileSync(path.join(review, `${runId}.md`), reviewMarkdown(report), "utf-8");
  return report;
}

/** The review artifact: conflicts only, both proposals, rationales, and the searches behind them. */
export function reviewMarkdown(r: VerifyReport): string {
  const md = [`# Review: ${r.run_id}`, "", `Verifier ${r.verifier.provider} ${r.verifier.model}; sampling level ${r.level}. ${r.counts.sections} sections: ${r.counts.auto} auto, ${r.counts.conflict} conflict. Agreement on ${r.counts.agreements} of ${r.counts.judgments} judgment fields (${(100 * r.agreement_rate).toFixed(1)}%); ${r.counts.deterministic} explicit citations were not judgments. ${r.counts.evidence_fails} evidence failure(s).`, "", "Conflicts stay here until a person resolves them; a resolution becomes a schema example.", ""];
  const conflicts = r.sections.filter((s) => s.tier === "conflict");
  if (!conflicts.length) md.push("No conflicts.");
  for (const s of conflicts) {
    md.push(`## ${s.id}`, "", `Staged at \`${s.path}\`.`, "");
    for (const j of s.judgments.filter((x) => !x.agree)) {
      md.push(`- **${j.field}**${j.text ? ` "${j.text}"` : ""}: ingest says \`${j.ingest}\`${j.ingest_confidence !== undefined ? ` (confidence ${j.ingest_confidence})` : ""}${j.ingest_search ? `, search: ${j.ingest_search}` : ""}; verifier says \`${j.verifier}\`${j.verifier_reason ? `, because: ${j.verifier_reason}` : ""}.`);
    }
    for (const e of s.evidence.filter((x) => x.level === "fail")) md.push(`- **evidence ${e.field}**: ${e.message}`);
    md.push("", `Resolution: \`sect-harness resolve --run ${r.run_id} --id ${s.id} --pick ingest|verifier|none|<id> [--text "<reference>"] [--why "<one sentence>"]\``, "");
  }
  if (r.resolutions?.length) {
    md.push("## Resolved", "", "Decisions people made; each was applied to staging, re-checked, and merged when nothing else held the section.", "");
    for (const x of r.resolutions) md.push(`- ${x.date} ${x.id}${x.text ? ` "${x.text}"` : " defines"}: ingest \`${x.ingest}\`, verifier \`${x.verifier}\`, chosen \`${x.value}\` (${x.pick})${x.why ? `: ${x.why}` : ""}`);
    md.push("");
  }
  return md.join("\n") + "\n";
}
