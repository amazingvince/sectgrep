// Spec D.3 layer 2: evidence checks on judgment fields. Deterministic, no model. An overlay's
// overrides/narrows target must be base-kind, of lower precedence, active at the overlay's date,
// and share a defined term or clear a similarity floor (and, for tables, differ in a value); a
// section's amended_by Actions must exist, name it, carry text present in it, and date
// consistently with the Expression it supersedes; a prose reference the ingest agent linked must
// be active and share a term with its sentence; an OCR-divergent span must not sit in rule text.

import { dateOf, loadCorpus, paragraphAnchors, spanMatch, splitExpr, tokens, type Doc } from "@sectgrep/convert";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { StagedRecord } from "./tools.js";

export interface EvidenceIssue {
  path: string;
  id: string;
  field: "overrides" | "narrows" | "amended_by" | "xref" | "ocr";
  level: "fail" | "warn";
  message: string;
}

export interface EvidenceOptions {
  /** The run directory (a corpus root with the staged source). */
  staging: string;
  corpus: string;
  /** The ingest records, for the references the agent linked. */
  records?: StagedRecord[];
  work?: string;
  /** Overlap the smaller of overlay and target (paragraph, when anchored) must reach when they share no defined term. */
  similarityFloor?: number;
}

export interface EvidenceReport {
  issues: EvidenceIssue[];
  checked: { overlays: number; actions: number; xrefs: number; ocr: number };
}

/** |A ∩ B| / min(|A|, |B|) over content tokens: a short paragraph against a long overlay is judged on what the paragraph holds. */
function overlap(a: string[], b: string[]): number {
  const x = new Set(a);
  const y = new Set(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / Math.min(x.size, y.size);
}

/** The paragraph an anchor names, with its sub-paragraphs; the whole body when there is no anchor or it is not found. */
function paragraphText(body: string, anchor: string | null): string {
  if (!anchor) return body;
  const anchors = paragraphAnchors(body);
  const i = anchors.findIndex((a) => a.anchor === anchor);
  if (i < 0) return body;
  const lines = body.split("\n");
  const end = anchors.slice(i + 1).find((a) => !a.anchor.startsWith(anchor + "-"));
  // Anchor lines are one-based.
  return lines.slice(anchors[i].line - 1, end ? end.line - 1 : lines.length).join(" ");
}

const STOP = new Set("the a an of to in and or for on by with as is are be this that these those any all each shall must may not no such under from at it its their which who whom whose than then when where within without into upon per".split(" "));
const content = (ts: string[]) => ts.filter((t) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t));

/** The Expression of `id` in force at `date` (latest effective on or before it, not superseded by then). */
function expressionAt(byId: Map<string, Doc[]>, id: string, date: string | null): Doc | null {
  const exprs = byId.get(id) ?? [];
  const live = exprs.filter((e) => {
    const eff = dateOf(e.front);
    if (!date) return true;
    if (!eff || eff > date) return false;
    const sup = e.front.superseded_by ? splitExpr(String(e.front.superseded_by)).date : null;
    return !(sup && sup <= date);
  });
  live.sort((a, b) => (dateOf(b.front) ?? "").localeCompare(dateOf(a.front) ?? ""));
  return live[0] ?? null;
}

const numericCells = (body: string): Set<string> => {
  const out = new Set<string>();
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || /^\|?\s*:?-{3,}/.test(t)) continue;
    for (const c of t.replace(/^\|/, "").replace(/\|$/, "").split("|")) if (/\d/.test(c)) out.add(c.trim().toLowerCase());
  }
  return out;
};

const targetsOf = (v: unknown): Array<{ id: string; anchor: string | null }> =>
  ((v ?? []) as unknown[]).map((t) => (t && typeof t === "object" ? { id: String((t as { id?: unknown }).id ?? ""), anchor: (t as { anchor?: unknown }).anchor ? String((t as { anchor?: unknown }).anchor) : null } : { id: splitExpr(String(t)).id, anchor: null })).filter((t) => t.id);

export function evidenceChecks(o: EvidenceOptions): EvidenceReport {
  const staging = loadCorpus(o.staging);
  const corpus = path.resolve(o.corpus) === staging.root ? null : loadCorpus(o.corpus);
  const all = [...staging.docs, ...(corpus?.docs ?? [])];
  const byId = new Map<string, Doc[]>();
  for (const d of all) if (d.front.id) byId.set(d.front.id, [...(byId.get(d.front.id) ?? []), d]);
  const floor = o.similarityFloor ?? 0.3;
  // Terms defined anywhere in the corpus or the staging: an overlay and its target sharing one is evidence they speak of the same thing.
  const definedTerms = new Set(all.flatMap((d) => (d.front.defines ?? []).map((t) => String(t).toLowerCase())).filter((t) => t.length > 2));
  const issues: EvidenceIssue[] = [];
  const checked = { overlays: 0, actions: 0, xrefs: 0, ocr: 0 };
  const issue = (d: Doc, field: EvidenceIssue["field"], level: EvidenceIssue["level"], message: string) => issues.push({ path: d.rel, id: d.front.id, field, level, message });

  for (const d of staging.docs) {
    const date = dateOf(d.front);
    // Overlays.
    for (const field of ["overrides", "narrows"] as const) {
      for (const t of targetsOf(d.front[field])) {
        checked.overlays++;
        const target = expressionAt(byId, t.id, date);
        if (!target) {
          issue(d, field, "fail", `${t.id} has no Expression active at ${date ?? "any date"}`);
          continue;
        }
        if (target.source?.kind !== "base") issue(d, field, "fail", `${t.id} is ${target.source?.kind ?? "unknown"}-kind, not base`);
        if (d.source && target.source && !(target.source.precedence < d.source.precedence)) issue(d, field, "fail", `${t.id} precedence ${target.source.precedence} is not below ${d.source.precedence}`);
        const overlayBody = d.body.toLowerCase();
        const targetText = paragraphText(target.body, t.anchor);
        const targetLower = targetText.toLowerCase();
        const shared = [...definedTerms].filter((term) => overlayBody.includes(term) && targetLower.includes(term));
        if (!shared.length) {
          const sim = overlap(content(tokens(d.body)), content(tokens(targetText)));
          if (sim < floor) issue(d, field, "fail", `${t.id}${t.anchor ? "#" + t.anchor : ""}: shares no defined term and similarity ${sim.toFixed(2)} is below ${floor}`);
        }
        const a = numericCells(d.body);
        const b = numericCells(target.body);
        if (a.size && b.size && [...a].every((c) => b.has(c)) && [...b].every((c) => a.has(c))) issue(d, field, "fail", `${t.id}: the overlay's table repeats the target's values; an override must differ in at least one value`);
      }
    }
    // Notices' effect: amended_by on a new Expression.
    for (const ref of (d.front.amended_by ?? []).map(String)) {
      checked.actions++;
      const noticeId = ref.includes("#") ? ref.slice(0, ref.indexOf("#")) : ref;
      const notice = (byId.get(noticeId) ?? []).find((n) => (n.front.actions?.length ?? 0) > 0);
      const action = notice?.front.actions?.find((a) => a.action_id === ref);
      if (!action) {
        issue(d, "amended_by", "fail", `${ref}: no such Action`);
        continue;
      }
      const above = new Set<string>();
      for (let p = d.front.parent ? String(d.front.parent) : null, n = 0; p && n < 12; n++) {
        above.add(p);
        const pd = (byId.get(p) ?? [])[0];
        p = pd?.front.parent ? String(pd.front.parent) : null;
      }
      if (action.target_id !== d.front.id && !above.has(action.target_id)) issue(d, "amended_by", "fail", `${ref} targets ${action.target_id}, not this section nor a container above it`);
      if (String(action.kind ?? "") !== "remove") {
        const paras = String(action.text ?? "").split(/\n{2,}/).map((p) => p.trim()).filter((p) => p && !/^#{1,6}\s/.test(p) && !/^\*\s?\*\s?\*\s*$/.test(p) && !/reads? as follows:?$/i.test(p) && !/\*\s?\*\s?\*/.test(p));
        const bodyTokens = tokens(d.body);
        const missing = paras.filter((p) => tokens(p).length >= 4 && spanMatch(tokens(p), bodyTokens).score < 0.92).length;
        if (missing) issue(d, "amended_by", "fail", `${ref}: ${missing} of ${paras.length} quoted paragraph(s) not present in this Expression`);
      }
      if (action.effective && date && String(action.effective).slice(0, 10) !== date) issue(d, "amended_by", "fail", `${ref} is effective ${action.effective} but this Expression ${date}`);
      if (d.front.supersedes) {
        const prev = splitExpr(String(d.front.supersedes));
        const prior = (byId.get(prev.id) ?? []).find((e) => dateOf(e.front) === prev.date);
        if (!prior) issue(d, "amended_by", "fail", `supersedes ${d.front.supersedes}, which does not exist`);
        else {
          if (date && (dateOf(prior.front) ?? "") >= date) issue(d, "amended_by", "fail", `the superseded Expression ${d.front.supersedes} is not earlier than ${date}`);
          if (prior.front.superseded_by && String(prior.front.superseded_by) !== `${d.front.id}@${date}`) issue(d, "amended_by", "warn", `${d.front.supersedes} says it is superseded by ${prior.front.superseded_by}, not by this Expression`);
        }
      } else issue(d, "amended_by", "warn", "amended_by without supersedes: a first Expression cannot be an amendment");
    }
  }
  // Prose references the ingest agent linked. With per-section dates (G-N2) a section whose text
  // dates from 2012 may cite one amended in 2024: the link is read as of the source's latest
  // Expression, so a target active at either date is active.
  const stagingByInput = new Map(staging.docs.map((d) => [d.rel.replace(/\\/g, "/"), d]));
  const latestBySource = new Map<string, string>();
  for (const d of all) {
    const k = d.source?.name ?? "";
    const dt = dateOf(d.front) ?? "";
    if (dt > (latestBySource.get(k) ?? "")) latestBySource.set(k, dt);
  }
  for (const r of o.records ?? []) {
    const d = stagingByInput.get(r.path.replace(/\\/g, "/"));
    if (!d) continue;
    const date = dateOf(d.front);
    const asOf = latestBySource.get(d.source?.name ?? "") ?? null;
    for (const x of r.xrefs) {
      checked.xrefs++;
      const target = expressionAt(byId, x.id, date) ?? (asOf && (!date || asOf > date) ? expressionAt(byId, x.id, asOf) : null);
      if (!target) {
        if (byId.has(x.id)) issue(d, "xref", "fail", `"${x.text}" -> ${x.id} is not active at ${date}`);
        else issue(d, "xref", "warn", `"${x.text}" -> ${x.id} is not in the corpus or the staging`);
        continue;
      }
      const at = d.body.indexOf(`[${x.text}]`);
      const sentence = at >= 0 ? d.body.slice(Math.max(0, d.body.lastIndexOf(". ", at) + 1), d.body.indexOf(".", at + x.text.length + 1) + 1 || undefined) : "";
      const near = new Set(content(tokens(sentence || d.body)));
      const far = content(tokens(`${target.front.title ?? ""} ${target.body.slice(0, 600)}`));
      if (!far.some((t) => near.has(t))) issue(d, "xref", "warn", `"${x.text}" -> ${x.id}: the citing sentence and the target share no term`);
    }
  }
  // OCR-divergent spans in rule text.
  const work = path.resolve(o.work ?? "work");
  for (const d of staging.docs) {
    const prov = (d.front.provenance ?? {}) as { raw?: string; raw_sha256?: string };
    if (!prov.raw || /\.xml$/i.test(String(prov.raw)) || !prov.raw_sha256) continue;
    const elements = path.join(work, String(prov.raw_sha256), "elements.jsonl");
    if (!existsSync(elements)) continue;
    checked.ocr++;
    const body = tokens(d.body).join(" ");
    for (const line of readFileSync(elements, "utf-8").split("\n")) {
      if (!line.includes("ocr_divergent")) continue;
      const e = JSON.parse(line) as { text: string; flags: string[] };
      if (!e.flags.includes("ocr_divergent")) continue;
      const span = tokens(e.text).slice(0, 8).join(" ");
      if (span && body.includes(span)) issue(d, "ocr", "fail", `an OCR-divergent span sits in rule text: "${e.text.slice(0, 60)}"`);
    }
  }
  return { issues, checked };
}
