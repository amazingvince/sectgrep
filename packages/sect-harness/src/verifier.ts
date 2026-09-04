// Spec D.3 layer 3: the answer-blind Verifier and consensus. For every staged section the
// verifier gets the same inputs the ingest agent had, the WS2 section and the bare references in
// it with the candidate ids the corpus offers for each, and never the ingest agent's answers. It
// runs on a different model family (decisions #43) with a different prompt, one completion per
// section and no tools, and answers in JSON. Consensus compares the two runs field by field:
// agreement is the auto tier, disagreement is a conflict a person resolves.

import { complete, type AssistantMessage, type Usage } from "@mariozechner/pi-ai";
import { providerExtras, splitFrontMatter } from "@sectgrep/convert";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { evidenceChecks, type EvidenceIssue } from "./evidence.js";
import { bareReferences } from "./ingest.js";
import { verifierModelFromEnv, type ModelChoice } from "./model.js";
import { loadRecords, type StagedRecord, type XrefResolution } from "./tools.js";

export interface VerifierAnswer {
  xrefs: Array<{ text: string; id: string | null; anchor?: string | null; confidence: number; reason?: string }>;
  defines: string[];
  overrides?: string[];
  narrows?: Array<{ id: string; anchor?: string | null }>;
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
  run_id: string;
  verifier: { provider: string; model: string };
  level: SamplingLevel;
  sections: SectionVerdict[];
  counts: { sections: number; auto: number; conflict: number; judgments: number; deterministic: number; agreements: number; evidence_fails: number };
  agreement_rate: number;
  usage: { input: number; output: number; cost: number; calls: number };
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
  concurrency?: number;
  limit?: number;
  level?: SamplingLevel;
  log?: (line: string) => void;
}

interface Known {
  ids: Map<string, string>; // id -> title
}

/** Ids and titles under the given roots. */
export function collectTitles(roots: string[]): Known {
  const ids = new Map<string, string>();
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const n of readdirSync(d)) {
      if (n.startsWith(".")) continue;
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".md")) {
        const head = readFileSync(p, "utf-8").slice(0, 600);
        const id = /^id:\s*"?([^"\n]+?)"?\s*$/m.exec(head)?.[1]?.trim();
        const title = /^title:\s*"?([^"\n]*?)"?\s*$/m.exec(head)?.[1]?.trim() ?? "";
        if (id) ids.set(id, title);
      }
    }
  };
  for (const r of roots) walk(r);
  return { ids };
}

/**
 * Candidate ids for a bare reference, from the corpus and the input only: every known id whose
 * section number matches (any title), a part id for "part N", and the section itself with the
 * paragraph anchor for "paragraph (x) of this section".
 */
export function candidatesFor(text: string, selfId: string, known: Known): Array<{ id: string; title: string; anchor?: string }> {
  const out: Array<{ id: string; title: string; anchor?: string }> = [];
  const homeTitle = /^CFR:(\d+)-/.exec(selfId)?.[1];
  const sec = /(?:§§?|\bsections?)\s*(\d{1,4}\.\d{1,4}[a-z]?(?:-\d+)?)((?:\([a-z0-9]{1,4}\))*)/i.exec(text) ?? /(\d{1,2})\s+CFR\s+(?:parts?\s+)?(\d{1,4}\.\d{1,4}[a-z]?)/i.exec(text);
  if (sec) {
    const number = sec[0].match(/\d{1,4}\.\d{1,4}[a-z]?(?:-\d+)?/)?.[0] ?? "";
    const titleWanted = /(\d{1,2})\s+CFR/i.exec(text)?.[1];
    const anchor = (sec[2] ?? "").replace(/\s+/g, "").split(/[()]+/).filter(Boolean).join("-") || undefined;
    for (const [id, title] of known.ids) {
      const m = /^CFR:(\d+)-(.+)$/.exec(id);
      if (!m || m[2] !== number) continue;
      if (titleWanted && m[1] !== titleWanted) continue;
      out.push({ id, title, anchor });
    }
    out.sort((a, b) => (a.id.startsWith(`CFR:${homeTitle}-`) ? -1 : 0) - (b.id.startsWith(`CFR:${homeTitle}-`) ? -1 : 0));
  }
  const part = /\bparts?\s+(\d{1,4})\b/i.exec(text);
  if (part && !sec) {
    for (const [id, title] of known.ids) {
      const m = /^CFR:(\d+)-(\d+)$/.exec(id);
      if (m && m[2] === part[1] && (!homeTitle || m[1] === homeTitle)) out.push({ id, title });
    }
  }
  if (/paragraphs?\s*\(/i.test(text) && /of this section/i.test(text)) {
    const anchor = (text.match(/\(([a-z0-9]{1,4})\)/gi) ?? []).map((p) => p.replace(/[()]/g, "")).join("-");
    out.push({ id: selfId, title: known.ids.get(selfId) ?? "", anchor });
  }
  // "this part", "this regulation", "these regulations": the section's own part; "this section": itself.
  const partOfSelf = /^(CFR:\d+-\d+)/.exec(selfId)?.[1];
  if (/\bthis (part|regulation)\b|\bthese regulations\b/i.test(text) && partOfSelf && known.ids.has(partOfSelf)) out.push({ id: partOfSelf, title: known.ids.get(partOfSelf) ?? "" });
  if (/^this section$/i.test(text.trim())) out.push({ id: selfId, title: known.ids.get(selfId) ?? "" });
  return out.slice(0, 6);
}

export const VERIFIER_SYSTEM = `You are the Verifier of sectgrep (spec D.3). You check one section of a regulatory corpus, blind: you do not see the ingest agent's answers, and you decide every judgment field yourself from the section and the candidates given. You never invent an id: an id you give must be one of the candidates listed for that reference, or null. Answer with one JSON object and nothing else:
{"xrefs":[{"text":"<the reference exactly as listed>","id":"<candidate id or null>","anchor":"<paragraph anchor or null>","confidence":0.0-1.0,"reason":"<one short sentence>"}],"defines":["<term the section defines, as written, without emphasis marks>"],"overrides":["<ids, only for an overlay that replaces sections>"],"narrows":[{"id":"<id>","anchor":"<anchor or null>"}],"action_targets":["<ids, only for a notice>"],"notes":"<anything a person should see, or empty>"}
Rules: a reference to a section number that exists in exactly one title is that section; a bare "part N" is the part in the section's own title; "paragraph (x) of this section" is the section itself with anchor x; a reference whose candidates are all in other titles and the text names no title is uncertain (confidence below 0.5); a term is defined only by a sentence of the form "Term means ..." or "Term is defined as ...". Keep reasons short.`;

export function verifierPrompt(rel: string, inputText: string, refs: string[], candidates: Map<string, Array<{ id: string; title: string; anchor?: string }>>, kind: string): string {
  const lines = [`Section file: ${rel} (source kind: ${kind}).`, ""];
  if (refs.length) {
    lines.push("Bare references in the body and the candidate ids the corpus offers for each:");
    for (const r of refs) {
      const c = candidates.get(r) ?? [];
      lines.push(`- "${r}": ${c.length ? c.map((x) => `${x.id}${x.anchor ? "#" + x.anchor : ""} (${x.title.slice(0, 60) || "no title"})`).join("; ") : "no candidate"}`);
    }
  } else lines.push("No bare references were found in the body.");
  if (kind === "overlay") lines.push("", "This is an overlay: decide which base sections it overrides (replaces whole) or narrows (paragraphs), from the candidates above.");
  if (kind === "notice") lines.push("", "This is a notice: decide which sections its amendatory instructions target, from the candidates above.");
  lines.push("", "```markdown", inputText.length > 30_000 ? inputText.slice(0, 30_000) + "\n[truncated]" : inputText, "```");
  return lines.join("\n");
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
    action_targets: Array.isArray(j.action_targets) ? j.action_targets.map(String) : [],
    notes: j.notes ? String(j.notes) : undefined,
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
const idOf = (x: { id: string; anchor?: string | null }) => `${x.id}${x.anchor ? "#" + x.anchor : ""}`;

/** Whether an ingest reference was deterministic: an explicit citation with exactly one candidate, which it chose. */
export function isDeterministic(x: XrefResolution, candidates: Array<{ id: string; anchor?: string }>): boolean {
  return /§§?\s*\d/.test(x.text) && candidates.length === 1 && candidates[0].id === x.id;
}

/** Field-by-field comparison of the ingest record and the verifier's answer. */
export function consensus(record: StagedRecord, answer: VerifierAnswer, refs: string[], candidates: Map<string, Array<{ id: string; title: string; anchor?: string }>>, level: SamplingLevel, front: { overrides?: unknown; narrows?: unknown; amended_by?: unknown; actions?: Array<{ target_id: string }> }): Judgment[] {
  const out: Judgment[] = [];
  // The verifier may write the anchor into the id ("CFR:4-21.8#e"); ids compare without anchors.
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
    let agree = det || (!!vs?.id && vs.id === x.id);
    if (agree && level === "tightened" && !det && x.confidence < 0.8) agree = false;
    out.push({ field: "xref", text: x.text, ingest, verifier, agree, deterministic: det, ingest_confidence: x.confidence, ingest_search: x.search, verifier_reason: v?.reason });
  }
  for (const r of refs) {
    if (seen.has(norm(r))) continue;
    const v = byText.get(norm(r));
    const vs = v ? split(v) : null;
    if (vs?.id && v && v.confidence >= 0.8) out.push({ field: "xref", text: r, ingest: "(left bare)", verifier: idOf({ id: vs.id, anchor: vs.anchor }), agree: false, verifier_reason: v.reason });
  }
  const a = new Set(record.defines.map(norm));
  const b = new Set(answer.defines.map(norm));
  if (a.size || b.size) out.push({ field: "defines", ingest: [...a].join(", ") || "(none)", verifier: [...b].join(", ") || "(none)", agree: a.size === b.size && [...a].every((t) => b.has(t)) });
  const ov = ((front.overrides ?? []) as unknown[]).map((t) => (t && typeof t === "object" ? String((t as { id?: unknown }).id) : String(t)));
  if (ov.length || answer.overrides?.length) out.push({ field: "overrides", ingest: ov.join(", ") || "(none)", verifier: (answer.overrides ?? []).join(", ") || "(none)", agree: ov.length === (answer.overrides ?? []).length && ov.every((t) => answer.overrides?.includes(t)) });
  const na = ((front.narrows ?? []) as unknown[]).map((t) => (t && typeof t === "object" ? idOf(t as { id: string; anchor?: string }) : String(t)));
  const nv = (answer.narrows ?? []).map(idOf);
  if (na.length || nv.length) out.push({ field: "narrows", ingest: na.join(", ") || "(none)", verifier: nv.join(", ") || "(none)", agree: na.length === nv.length && na.every((t) => nv.includes(t)) });
  const at = (front.actions ?? []).map((x) => x.target_id);
  if (at.length || answer.action_targets?.length) out.push({ field: "action", ingest: [...new Set(at)].join(", ") || "(none)", verifier: [...new Set(answer.action_targets ?? [])].join(", ") || "(none)", agree: new Set(at).size === new Set(answer.action_targets ?? []).size && at.every((t) => answer.action_targets?.includes(t)) });
  return out;
}

function usageOf(m: AssistantMessage): { input: number; output: number; cost: number } {
  const u = (m as { usage?: Usage }).usage;
  return { input: (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0), output: u?.output ?? 0, cost: u?.cost?.total ?? 0 };
}

/** Run the verifier over a submitted run and write verify.json and the review file. */
export async function verifyRun(o: VerifyOptions): Promise<VerifyReport> {
  const log = o.log ?? ((l: string) => console.log(l));
  const runDir = path.resolve(o.runDir);
  const runId = path.basename(runDir);
  const inputDir = path.resolve(o.input);
  const records = loadRecords(runDir);
  if (!records.length) throw new Error(`${o.runDir} has no .ingest records; ingest first`);
  const known = collectTitles([path.resolve(o.corpus), inputDir]);
  const level = o.level ?? "normal";
  const choice = o.verify ? undefined : (o.model ?? verifierModelFromEnv());
  if (!o.verify && (!choice?.model || !choice.config.apiKey)) throw new Error(`no verifier model: provider ${choice?.config.provider}, model ${choice?.config.model}; set SECT_VERIFIER_MODEL and the key in .env`);
  const evidence = evidenceChecks({ staging: runDir, corpus: o.corpus, records, work: o.work });
  const evidenceByPath = new Map<string, EvidenceIssue[]>();
  for (const i of evidence.issues) evidenceByPath.set(i.path, [...(evidenceByPath.get(i.path) ?? []), i]);
  const sourceKind = (() => {
    const y = path.join(inputDir, "_source.yaml");
    return existsSync(y) ? String(((YAML.parse(readFileSync(y, "utf-8")) ?? {}) as { kind?: string }).kind ?? "base") : "base";
  })();
  const todo = (o.limit ? records.slice(0, o.limit) : records).filter((r) => existsSync(path.join(inputDir, r.input)));
  const usage = { input: 0, output: 0, cost: 0, calls: 0 };
  const verdicts: SectionVerdict[] = [];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const r = todo[next++];
      const text = readFileSync(path.join(inputDir, r.input), "utf-8");
      const split = splitFrontMatter(text);
      const front = (YAML.parse(split?.front ?? "") ?? {}) as { overrides?: unknown; narrows?: unknown; amended_by?: unknown; actions?: Array<{ target_id: string }>; level?: string };
      // The spans to judge: the references the harness detects, plus the spans the ingest agent
      // linked (their text only, never their targets), so every judgment field gets a second opinion.
      const refs = [...new Set([...bareReferences(split?.body ?? text), ...r.xrefs.map((x) => x.text)])].slice(0, 24);
      const candidates = new Map(refs.map((t) => [t, candidatesFor(t, r.id, known)]));
      const judgmentsPossible = r.xrefs.length || refs.length || r.defines.length || sourceKind !== "base";
      let judgments: Judgment[] = [];
      if (judgmentsPossible && front.level !== "title" && front.level !== "chapter" && front.level !== "part" && front.level !== "subpart" && front.level !== "subchapter" && front.level !== "subjectgroup") {
        const prompt = verifierPrompt(r.input, text, refs, candidates, sourceKind);
        let answer: VerifierAnswer;
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
            const ask = async (nudge: string) => {
              const m = await complete(choice!.model as never, { systemPrompt: VERIFIER_SYSTEM, messages: [{ role: "user", content: prompt + nudge, timestamp: Date.now() }] }, { apiKey: choice!.config.apiKey, temperature: 0, maxTokens: 2000, ...(Object.keys(providerExtras(choice!.config)).length ? {} : {}) });
              const u = usageOf(m);
              usage.input += u.input;
              usage.output += u.output;
              usage.cost += u.cost;
              return m.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
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
        }
        judgments = consensus(r, answer, refs, candidates, level, front);
      }
      const ev = evidenceByPath.get(r.path.replace(/\\/g, "/")) ?? [];
      const conflict = judgments.some((j) => !j.agree) || ev.some((i) => i.level === "fail");
      verdicts.push({ id: r.id, path: r.path, input: r.input, tier: conflict ? "conflict" : "auto", judgments, evidence: ev });
      if (verdicts.length % 25 === 0) log(`${verdicts.length}/${todo.length} verified`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 8) }, worker));
  verdicts.sort((a, b) => a.path.localeCompare(b.path));
  const judgments = verdicts.flatMap((v) => v.judgments);
  const nonDet = judgments.filter((j) => !j.deterministic);
  const report: VerifyReport = {
    run_id: runId,
    verifier: o.verify ? { provider: "injected", model: "injected" } : { provider: choice!.config.provider, model: choice!.config.model },
    level,
    sections: verdicts,
    counts: { sections: verdicts.length, auto: verdicts.filter((v) => v.tier === "auto").length, conflict: verdicts.filter((v) => v.tier === "conflict").length, judgments: nonDet.length, deterministic: judgments.length - nonDet.length, agreements: nonDet.filter((j) => j.agree).length, evidence_fails: evidence.issues.filter((i) => i.level === "fail").length },
    agreement_rate: nonDet.length ? nonDet.filter((j) => j.agree).length / nonDet.length : 1,
    usage,
  };
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
    md.push("", "Resolution: [ ] ingest  [ ] verifier  [ ] neither (write the right value): ____________", "");
  }
  return md.join("\n") + "\n";
}
