// Bare references and their candidates, shared by the ingest side and the verifier so both see
// the same spans and the same real ids. An explicit citation with exactly one real candidate is
// linked in code before any model call (G-N2): it costs no model turn, is recorded as
// deterministic, and is not a judgment the verifier has to redo.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { XrefResolution } from "./tools.js";

export interface Known {
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

/** Bare references in a body that are not yet links: what has to be resolved. */
export function bareReferences(body: string): string[] {
  const seen = new Set<string>();
  // Headings carry the section's own number, which is not a citation.
  const plain = body.replace(/^\s*#.*$/gm, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, " ");
  const forms = [
    /§§?\s*\d{1,4}\.\d{1,4}[a-z]?(?:-\d+)?(?:\([a-z0-9]{1,4}\))*/gi,
    /\bparts?\s+\d{1,4}\b/gi,
    /\d{1,2}\s+CFR\s+(?:parts?\s+)?\d{1,4}(?:\.\d{1,4}[a-z]?)?/gi,
    // One paragraph of this section (a list of paragraphs is left to the agent).
    /\bparagraph\s*\([a-z0-9]{1,4}\)(?:\([a-z0-9]{1,4}\))*\s+of this section\b/gi,
  ];
  for (const re of forms) for (const m of plain.matchAll(re)) seen.add(m[0].replace(/\s+/g, " ").trim());
  return [...seen].slice(0, 20);
}

/** An explicit citation: a form whose target is a matter of lookup, not judgment. */
export const isExplicit = (text: string): boolean => /^(?:§§?\s*\d|\d{1,2}\s+CFR\s+|parts?\s+\d{1,4}$|paragraph\s*\(.+of this section$)/i.test(text.trim());

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
    const titleWanted = /(\d{1,2})\s+CFR/i.exec(text)?.[1] ?? homeTitle;
    for (const [id, title] of known.ids) {
      const m = /^CFR:(\d+)-(\d+)$/.exec(id);
      if (m && m[2] === part[1] && (!titleWanted || m[1] === titleWanted)) out.push({ id, title });
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

/**
 * Link every explicit citation with exactly one real candidate, in code. A paragraph anchor is
 * kept only when the target has it. What remains is the agent's to resolve.
 */
export function preResolve(body: string, selfId: string, known: Known, anchorsOf?: Map<string, Set<string>>): { resolved: XrefResolution[]; remaining: string[] } {
  const resolved: XrefResolution[] = [];
  const remaining: string[] = [];
  const homeTitle = /^CFR:(\d+)-/.exec(selfId)?.[1];
  for (const text of bareReferences(body)) {
    const c = isExplicit(text) ? candidatesFor(text, selfId, known) : [];
    let ids = [...new Set(c.map((x) => x.id))];
    // A bare citation that names no title resolves against the home title when it is there
    // (spec-changes #11); other titles' sections of the same number do not make it ambiguous.
    if (ids.length > 1 && homeTitle && !/\d\s+CFR\s/i.test(text)) {
      const home = ids.filter((id) => id.startsWith(`CFR:${homeTitle}-`));
      if (home.length === 1) ids = home;
    }
    if (ids.length !== 1) {
      remaining.push(text);
      continue;
    }
    const wanted = c[0].anchor;
    const anchor = wanted && (!anchorsOf || anchorsOf.get(ids[0])?.has(wanted)) ? wanted : null;
    // A paragraph reference whose anchor the section does not have is not a link at all.
    if (wanted && !anchor && ids[0] === selfId) {
      remaining.push(text);
      continue;
    }
    resolved.push({ text, id: ids[0], anchor, confidence: 1, search: "deterministic", deterministic: true });
  }
  return { resolved, remaining };
}
