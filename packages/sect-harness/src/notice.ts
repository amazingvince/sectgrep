// Spec D.2 step 9, the harness half: once the agent has confirmed a notice's Actions, the new
// Expression of each target is composed in code from the current Expression and the Actions
// (actions.ts), and staged beside the notice under the target's own source directory: the new
// text as the Work's file, the prior text as `<file>@<date>.md` marked superseded, and the
// ancestors it needs so the staging is a corpus root of its own. Nothing here knows any
// publisher's shapes: targets, dates and paths come from the corpus and the notice.

import { loadCorpus, splitFrontMatter, type Doc } from "@sectgrep/convert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { applyActions, type Action } from "./actions.js";
import type { RunContext, StagedRecord } from "./tools.js";

export interface Composed {
  /** Records for the derived Expressions, one per target Work. */
  derived: StagedRecord[];
  unapplied: Array<{ action_id: string; target_id: string; why: string }>;
  /** Targets skipped: structural nodes, or Works the corpus does not hold. */
  skipped: Array<{ target_id: string; why: string }>;
}

const tokenCount = (s: string) => (s.match(/[A-Za-z0-9]+(?:[.,][A-Za-z0-9]+)*/g) ?? []).length;
const dateOf = (front: Record<string, unknown>) => String(front.effective ?? "").slice(0, 10);

/** The current Expression of a Work in the corpus: not superseded, latest effective. */
export function currentExpression(docs: Doc[], id: string): Doc | null {
  const live = docs.filter((d) => d.front.id === id && !d.front.superseded_by);
  live.sort((a, b) => dateOf(b.front as Record<string, unknown>).localeCompare(dateOf(a.front as Record<string, unknown>)));
  return live[0] ?? null;
}

const fileFor = (rel: string, effective: string) => rel.replace(/\.md$/, `@${effective}.md`);

function writeDoc(cx: RunContext, rel: string, front: Record<string, unknown>, body: string): string {
  const out = path.join(cx.runDir, rel);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `---\n${YAML.stringify(front, { lineWidth: 0 }).trimEnd()}\n---\n${body.startsWith("\n") ? "" : "\n"}${body}`, "utf-8");
  (cx.extraFiles ??= new Set()).add(rel.replace(/\\/g, "/"));
  return rel.replace(/\\/g, "/");
}

/** Copy a corpus document into the staging unchanged (an ancestor the new Expression needs). */
function copyDoc(cx: RunContext, corpusRoot: string, d: Doc): void {
  const out = path.join(cx.runDir, d.rel);
  (cx.extraFiles ??= new Set()).add(d.rel.replace(/\\/g, "/"));
  if (existsSync(out)) return;
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, readFileSync(path.join(corpusRoot, d.rel), "utf-8"), "utf-8");
}

/**
 * Compose and stage the new Expressions a staged notice produces. `noticeRel` is the notice's
 * path inside the run; the corpus is where the targets' current text lives.
 */
export function composeExpressions(cx: RunContext, noticeRel: string, corpusRoot: string, inputRel?: string): Composed {
  const noticeText = readFileSync(path.join(cx.runDir, noticeRel), "utf-8");
  const split = splitFrontMatter(noticeText);
  if (!split) throw new Error(`${noticeRel}: no front matter`);
  const front = (YAML.parse(split.front) ?? {}) as Record<string, unknown> & { id?: string; actions?: Action[]; provenance?: Record<string, unknown> };
  const actions = (front.actions ?? []).filter((a) => a && a.target_id);
  const corpus = loadCorpus(corpusRoot);
  const byId = new Map<string, Doc[]>();
  for (const d of corpus.docs) byId.set(String(d.front.id), [...(byId.get(String(d.front.id)) ?? []), d]);
  const hasChildren = new Set(corpus.docs.map((d) => String(d.front.parent ?? "")).filter(Boolean));
  const derived: StagedRecord[] = [];
  const unapplied: Composed["unapplied"] = [];
  const skipped: Composed["skipped"] = [];
  const byTarget = new Map<string, Action[]>();
  for (const a of actions) byTarget.set(a.target_id, [...(byTarget.get(a.target_id) ?? []), a]);
  const copiedSources = new Set<string>();
  for (const [target, list] of byTarget) {
    const prior = currentExpression(byId.get(target) ?? [], target);
    if (!prior) {
      skipped.push({ target_id: target, why: "not in the corpus" });
      continue;
    }
    if (hasChildren.has(target)) {
      skipped.push({ target_id: target, why: "a structural node; its heading, authority or listing changes are not text amendments" });
      continue;
    }
    const r = applyActions(prior.body, list);
    for (const u of r.unapplied) unapplied.push({ action_id: u.action.action_id, target_id: target, why: u.why });
    if (!r.applied.length) continue;
    const priorFront = prior.front as unknown as Record<string, unknown>;
    const priorDate = dateOf(priorFront);
    const effective = r.applied.map((a) => String(a.effective).slice(0, 10)).sort().pop()!;
    if (effective <= priorDate) {
      unapplied.push({ action_id: r.applied[0].action_id, target_id: target, why: `the Action is effective ${effective}, not after the current Expression's ${priorDate}` });
      continue;
    }
    const id = String(priorFront.id);
    const priorExpr = `${id}@${priorDate}`;
    const newExpr = `${id}@${effective}`;
    // The prior text, marked superseded, under its dated name.
    writeDoc(cx, fileFor(prior.rel, priorDate), { ...priorFront, superseded_by: newExpr }, prior.body);
    // The new text as the Work's file.
    const prov = (priorFront.provenance ?? {}) as Record<string, unknown>;
    const nprov = front.provenance ?? {};
    const newFront: Record<string, unknown> = {
      ...priorFront,
      effective,
      supersedes: priorExpr,
      superseded_by: null,
      amended_by: r.applied.map((a) => a.action_id),
      context: `${String(priorFront.context ?? "").trim()} Amended effective ${effective} by ${String(front.id)}.`.trim(),
      provenance: {
        raw: nprov.raw ?? prov.raw,
        raw_sha256: nprov.raw_sha256 ?? prov.raw_sha256,
        locator: { actions: r.applied.map((a) => a.action_id) },
        legal_status: "derived",
        derived_from: priorExpr,
        ingest_run: cx.runId,
        confidence: 1.0,
        verified_by: [`ingest:${cx.runId}`],
      },
    };
    const rel = writeDoc(cx, prior.rel, newFront, r.body);
    // Ancestors and the source's registry entry, unchanged, so the staging resolves as a corpus.
    let p = String(priorFront.parent ?? "");
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      seen.add(p);
      const anc = currentExpression(byId.get(p) ?? [], p);
      if (!anc) break;
      copyDoc(cx, corpusRoot, anc);
      p = String(anc.front.parent ?? "");
    }
    const srcDir = prior.source?.dir;
    if (srcDir && !copiedSources.has(srcDir)) {
      copiedSources.add(srcDir);
      const y = path.join(srcDir, "_source.yaml");
      const relSrc = path.relative(corpusRoot, y);
      const out = path.join(cx.runDir, relSrc);
      if (existsSync(y) && !existsSync(out)) {
        mkdirSync(path.dirname(out), { recursive: true });
        writeFileSync(out, readFileSync(y), "utf-8");
      }
    }
    const record: StagedRecord = {
      id,
      input: inputRel ?? noticeRel,
      path: rel,
      context: String(newFront.context),
      defines: ((priorFront.defines as string[]) ?? []).map(String),
      xrefs: [],
      flags: r.unapplied.map((u) => `unapplied: ${u.action.action_id} (${u.why})`),
      body_tokens: tokenCount(r.body),
      derived: { from: priorExpr, actions: r.applied.map((a) => a.action_id) },
    };
    const meta = path.join(cx.runDir, ".ingest");
    mkdirSync(meta, { recursive: true });
    writeFileSync(path.join(meta, `${id.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`), JSON.stringify(record, null, 2) + "\n", "utf-8");
    cx.staged = cx.staged.filter((s) => s.id !== id);
    cx.staged.push(record);
    derived.push(record);
  }
  return { derived, unapplied, skipped };
}
