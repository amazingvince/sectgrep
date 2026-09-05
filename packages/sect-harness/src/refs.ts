// Bare references and their candidates, shared by the ingest side and the verifier so both see
// the same spans and the same real ids. Every citation form comes from the source registry
// (`_source.yaml`: `id_pattern`, `id_template`, `anchor_template`) and every hierarchy name from
// the nodes' own `level` and `parent` fields; nothing here knows any one publisher's shapes. An
// explicit citation with one real target is linked in code before any model call (G-N2).

import { compileIdPattern, fillAnchor, fillTemplate, loadSources, type SourceInfo } from "@sectgrep/convert";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { XrefResolution } from "./tools.js";

export interface NodeInfo {
  id: string;
  title: string;
  level: string;
  parent: string | null;
  source: string;
}

export interface SourceSpec extends SourceInfo {
  /** The compiled id pattern, global and case-insensitive when the registry says so; null without one. */
  re: RegExp | null;
}

export interface Known {
  /** id -> title, for callers that only need the names. */
  ids: Map<string, string>;
  nodes: Map<string, NodeInfo>;
  sources: SourceSpec[];
  /** Ids that other nodes name as their parent: the structural nodes. */
  children: Map<string, number>;
}

export interface Candidate {
  id: string;
  title: string;
  anchor?: string;
  /** How the candidate was found: a registry pattern, a container by level and number, a paragraph of this node, an ancestor. */
  via: "pattern" | "container" | "paragraph" | "self";
  source?: string;
}

const front = (text: string, key: string): string | undefined => new RegExp(`^${key}:\\s*"?([^"\\n]*?)"?\\s*$`, "m").exec(text)?.[1]?.trim();

/** Nodes and sources under the given roots. */
export function collectKnown(roots: string[]): Known {
  const nodes: NodeInfo[] = [];
  const sources = new Map<string, SourceInfo>();
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const n of readdirSync(d)) {
      if (n.startsWith(".")) continue;
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".md")) {
        const head = readFileSync(p, "utf-8").slice(0, 1500);
        const id = front(head, "id");
        if (!id) continue;
        const parent = front(head, "parent");
        nodes.push({ id, title: front(head, "title") ?? "", level: front(head, "level") ?? "section", parent: parent && parent !== "null" ? parent : null, source: front(head, "source") ?? "" });
      }
    }
  };
  for (const r of roots) {
    walk(r);
    if (existsSync(r)) for (const s of loadSources(r).values()) if (!sources.has(s.name)) sources.set(s.name, s);
  }
  return knownFromNodes(nodes, [...sources.values()]);
}

/** A Known from explicit nodes and sources (tests, or a caller that already parsed them). */
export function knownFromNodes(nodes: NodeInfo[], sources: SourceInfo[]): Known {
  const ids = new Map<string, string>();
  const byId = new Map<string, NodeInfo>();
  const children = new Map<string, number>();
  for (const n of nodes) {
    ids.set(n.id, n.title);
    byId.set(n.id, n);
  }
  for (const n of nodes) if (n.parent && byId.has(n.parent)) children.set(n.parent, (children.get(n.parent) ?? 0) + 1);
  const specs: SourceSpec[] = sources.map((s) => ({ ...s, re: s.id_pattern ? compileIdPattern(s.id_pattern, "g") : null }));
  return { ids, nodes: byId, sources: specs, children };
}

export const hasChildren = (known: Known, id: string): boolean => (known.children.get(id) ?? 0) > 0;

/** The chain of ancestors of a node, nearest first. */
export function ancestorsOf(known: Known, id: string): NodeInfo[] {
  const out: NodeInfo[] = [];
  let cur = known.nodes.get(id)?.parent ?? null;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const n = known.nodes.get(cur);
    if (!n) break;
    out.push(n);
    cur = n.parent;
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LABEL = /^(?:\d[A-Za-z0-9.-]{0,11}|[A-Z]{1,2}|[IVXLivxl]{1,6})$/;
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** The levels that structural nodes carry in this corpus (from the data, not a list). */
function structuralLevels(known: Known): string[] {
  const out = new Set<string>();
  for (const id of known.children.keys()) {
    const l = known.nodes.get(id)?.level;
    if (l) out.add(l.toLowerCase());
  }
  return [...out].filter((l) => /^[a-z][a-z-]*$/.test(l));
}

/** The last component of an id after the source prefix: what a container is numbered by. */
function numberOf(id: string, prefix: string): string {
  const rest = id.startsWith(prefix) ? id.slice(prefix.length) : id.replace(/^[A-Z][A-Z0-9]*:/, "");
  const parts = rest.split(/[-.:/]/).filter(Boolean);
  return (parts[parts.length - 1] ?? rest).toLowerCase();
}

/**
 * Bare references in a body that are not yet links: every source pattern's matches, a container
 * named by a level this corpus has and a number, one paragraph of this node, and "this <level>"
 * for a level among the node's ancestors.
 */
export function bareReferences(body: string, known?: Known, selfId?: string): string[] {
  const seen = new Set<string>();
  // Headings carry the node's own number, which is not a citation.
  const plain = body.replace(/^\s*#.*$/gm, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, " ");
  const add = (t: string) => {
    const c = collapse(t);
    if (c) seen.add(c);
  };
  if (known) {
    for (const s of known.sources) if (s.re) for (const m of plain.matchAll(s.re)) add(m[0]);
    const levels = structuralLevels(known);
    // A container's number is a digit-led label, a capital letter or two, or a roman numeral.
    if (levels.length) for (const m of plain.matchAll(new RegExp(`\\b(?:${levels.map(escapeRe).join("|")})\\s+([A-Za-z0-9][A-Za-z0-9.-]{0,11})\\b(?![.-]\\d)`, "gi"))) if (LABEL.test(m[1])) add(m[0]);
    const selfLevel = selfId ? known.nodes.get(selfId)?.level : undefined;
    const ancestors = selfId ? ancestorsOf(known, selfId).map((a) => a.level.toLowerCase()) : [];
    if (ancestors.length) for (const m of plain.matchAll(new RegExp(`\\bthis (?:${[...new Set(ancestors)].map(escapeRe).join("|")})\\b`, "gi"))) add(m[0]);
    for (const m of plain.matchAll(new RegExp(`\\b(?:sub)?(?:paragraph|clause|item)\\s*\\([a-z0-9]{1,4}\\)(?:\\s*\\([a-z0-9]{1,4}\\))*\\s+of this ${selfLevel ? `(?:section|${escapeRe(selfLevel.toLowerCase())})` : "section"}\\b`, "gi"))) add(m[0]);
  } else {
    // Without a registry only the structural forms are visible.
    for (const m of plain.matchAll(/\b(?:sub)?(?:paragraph|clause|item)\s*\([a-z0-9]{1,4}\)(?:\s*\([a-z0-9]{1,4}\))*\s+of this section\b/gi)) add(m[0]);
  }
  return [...seen].slice(0, 24);
}

/**
 * Candidate ids for a bare reference, from the corpus and the input only: what each source's
 * pattern builds from the text when that id exists (the node's own source first), the container
 * a level and number name, the node itself with a paragraph anchor, or an ancestor by level.
 */
export function candidatesFor(text: string, selfId: string, known: Known): Candidate[] {
  const out: Candidate[] = [];
  const t = collapse(text);
  const self = known.nodes.get(selfId);
  const home = self?.source ?? "";
  for (const s of known.sources) {
    if (!s.re) continue;
    const whole = new RegExp(`^(?:${s.re.source})$`, s.re.flags.replace("g", ""));
    const m = whole.exec(t);
    if (!m) continue;
    const id = fillTemplate(s.id_template ?? "", m.groups);
    if (!id || id.includes("{") || !known.nodes.has(id)) continue;
    const anchor = fillAnchor(s.anchor_template, m.groups) ?? undefined;
    if (!out.some((c) => c.id === id)) out.push({ id, title: known.ids.get(id) ?? "", anchor, via: "pattern", source: s.name });
  }
  if (!out.length) {
    const levels = structuralLevels(known);
    const cm = levels.length ? new RegExp(`^(${levels.map(escapeRe).join("|")})\\s+([A-Za-z0-9][A-Za-z0-9.-]{0,11})$`, "i").exec(t) : null;
    if (cm && LABEL.test(cm[2])) {
      const level = cm[1].toLowerCase();
      const num = cm[2].toLowerCase();
      const prefixOf = (name: string) => known.sources.find((s) => s.name === name)?.id_prefix ?? "";
      for (const n of known.nodes.values()) {
        if (n.level.toLowerCase() !== level || numberOf(n.id, prefixOf(n.source)) !== num) continue;
        out.push({ id: n.id, title: n.title, via: "container", source: n.source });
      }
    }
  }
  const pm = /^(?:sub)?(?:paragraph|clause|item)\s*((?:\([a-z0-9]{1,4}\)\s*)+)of this \w+$/i.exec(t);
  if (pm && self) {
    const anchor = (pm[1].match(/\(([a-z0-9]{1,4})\)/gi) ?? []).map((p) => p.replace(/[()]/g, "").toLowerCase()).join("-");
    out.push({ id: selfId, title: self.title, anchor, via: "paragraph", source: self.source });
  }
  const tm = /^this (\w+)$/i.exec(t);
  if (tm && self) {
    const level = tm[1].toLowerCase();
    if (level === "section" || level === self.level.toLowerCase()) out.push({ id: selfId, title: self.title, via: "self", source: self.source });
    else {
      const a = ancestorsOf(known, selfId).find((x) => x.level.toLowerCase() === level);
      if (a) out.push({ id: a.id, title: a.title, via: "self", source: a.source });
    }
  }
  // The node's own source first, then the rest in registry order.
  out.sort((a, b) => Number(b.source === home) - Number(a.source === home));
  return out.slice(0, 8);
}

/**
 * Link every explicit reference with one real target, in code: a registry match that builds one
 * existing id (the node's own source wins over other sources' same-numbered nodes), a container
 * with one node of that level and number, a paragraph anchor the node has, an ancestor. What
 * remains is the agent's to resolve.
 */
export function preResolve(body: string, selfId: string, known: Known, anchorsOf?: Map<string, Set<string>>): { resolved: XrefResolution[]; remaining: string[] } {
  const resolved: XrefResolution[] = [];
  const remaining: string[] = [];
  const home = known.nodes.get(selfId)?.source ?? "";
  for (const text of bareReferences(body, known, selfId)) {
    let c = candidatesFor(text, selfId, known);
    if (c.length > 1 && home) {
      const own = c.filter((x) => x.source === home);
      if (own.length === 1) c = own;
    }
    const ids = [...new Set(c.map((x) => x.id))];
    if (ids.length !== 1) {
      remaining.push(text);
      continue;
    }
    const wanted = c[0].anchor;
    const anchor = wanted && (!anchorsOf || anchorsOf.get(ids[0])?.has(wanted)) ? wanted : null;
    // A paragraph reference whose anchor the node does not have is not a link at all.
    if (wanted && !anchor && c[0].via === "paragraph") {
      remaining.push(text);
      continue;
    }
    resolved.push({ text, id: ids[0], anchor, confidence: 1, search: "deterministic", deterministic: true });
  }
  return { resolved, remaining };
}

/** Whether a reference the ingest side linked was deterministic: one real candidate, which it chose. */
export function isDeterministic(x: XrefResolution, candidates: Candidate[]): boolean {
  // Only the registry-backed resolution path may claim deterministic evidence.
  // A single search candidate, or an ingest-supplied flag alone, is insufficient.
  if (!x.deterministic || x.search !== "deterministic") return false;
  const targets = [...new Set(candidates.filter((c) => c.via === "pattern" || c.via === "paragraph" || c.via === "self" || c.via === "container").map((c) => `${c.id}#${c.anchor ?? ""}`))];
  return targets.length === 1 && targets[0] === `${x.id}#${x.anchor ?? ""}`;
}
