// Spec C.4 deterministic passes over elements: running headers and footers, hyphenation,
// native-id headings by the source's id_pattern, explicit-reference regex, glossary detection,
// table stitching. Outputs structure.json, xrefs_candidates.jsonl, terms_candidates.json.
// No model, no judgment: everything here is a regex or a count.

import type { Element } from "./elements/types.js";

export interface SourcePattern {
  /** Python-style named-group regex from _source.yaml; converted to JavaScript here. */
  id_pattern: string;
  id_template: string;
  anchor_template?: string;
}

export interface XrefCandidate {
  seq: number;
  page: number;
  text: string;
  /** Resolved with the source's id_template when the pattern matched; null for a bare form. */
  id: string | null;
  anchor: string | null;
  form: "section" | "part" | "paragraph-of-this-section" | "cfr";
}

export interface TermCandidate {
  term: string;
  seq: number;
  page: number;
  definition: string;
  form: "means" | "is defined as" | "the term";
}

export interface StructureNode {
  seq: number;
  page: number;
  level: number;
  text: string;
  native_id: string | null;
  /** Element seqs covered until the next heading of the same or higher level. */
  range: [number, number];
  children: StructureNode[];
}

export interface PassesOutput {
  elements: Element[];
  structure: StructureNode[];
  xrefs: XrefCandidate[];
  terms: TermCandidate[];
  notes: string[];
}

/** `(?P<name>...)` and `(?i)` as JavaScript. */
export function jsRegex(pythonPattern: string): RegExp {
  let flags = "";
  let p = pythonPattern.replace(/^\(\?([a-z]+)\)/, (_, f: string) => {
    if (f.includes("i")) flags += "i";
    return "";
  });
  p = p.replace(/\(\?P</g, "(?<");
  return new RegExp(p, flags + "g");
}

export function applyTemplate(template: string, groups: Record<string, string | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => groups[k] ?? "");
}

/** Lines that repeat on several pages near the top or bottom are running heads. */
export function markHeadersFooters(elements: Element[], pageHeights: Record<number, number>): number {
  const keyOf = (e: Element) => e.text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
  const counts = new Map<string, Set<number>>();
  for (const e of elements) {
    if (!e.bbox) continue;
    const h = pageHeights[e.page];
    const nearEdge = h ? e.bbox[1] < h * 0.08 || e.bbox[3] > h * 0.92 : false;
    if (nearEdge && e.text.length < 120) (counts.get(keyOf(e)) ?? counts.set(keyOf(e), new Set()).get(keyOf(e))!).add(e.page);
  }
  let n = 0;
  for (const e of elements) {
    if (!e.bbox) continue;
    const pages = counts.get(keyOf(e));
    const h = pageHeights[e.page];
    if (pages && pages.size >= 2 && h && !e.heading_level && (e.bbox[1] < h * 0.08 || e.bbox[3] > h * 0.92)) {
      e.type = e.bbox[1] < h * 0.08 ? "header" : "footer";
      n++;
    }
  }
  // GPO running heads alternate between verso and recto, so nothing repeats on a two-page
  // excerpt, and they sit a fifth of the way down the page, so no edge band holds them. What
  // marks them is isolation: a row of short blocks at the top or bottom of the page's content
  // with a gap beside it well above the page's line pitch (a head is often two fragments on one
  // row, one per column). A bare page number anywhere near an edge is one too.
  const pagesSeen = [...new Set(elements.map((e) => e.page))];
  for (const pg of pagesSeen) {
    const boxed = elements.filter((e) => e.page === pg && e.bbox).sort((a, b) => a.bbox![1] - b.bbox![1]);
    if (boxed.length < 3) continue;
    const rows: Element[][] = [];
    for (const e of boxed) {
      const row = rows[rows.length - 1];
      if (row && e.bbox![1] < Math.max(...row.map((r) => r.bbox![3])) - 1) row.push(e);
      else rows.push([e]);
    }
    const top = (row: Element[]) => Math.min(...row.map((r) => r.bbox![1]));
    const bottom = (row: Element[]) => Math.max(...row.map((r) => r.bbox![3]));
    // The threshold comes from the body's font size (a line pitch), not from row gaps: on a
    // two-column page a row spans both columns and the gaps between rows say little.
    const sizes = boxed.map((e) => e.font_size ?? 0).filter((x) => x > 0).sort((a, b) => a - b);
    const size = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
    const big = Math.max(8, size * 1.1);
    const short = (row: Element[]) => row.every((e) => e.text.length < 120 && !e.text.includes("\n"));
    const mark = (row: Element[], type: "header" | "footer") => {
      for (const e of row) {
        if (e.type !== type && !e.heading_level) {
          e.type = type;
          n++;
        }
      }
    };
    // One row each way: a title under a running head is isolated too, and is not one.
    if (rows.length >= 2 && short(rows[0]) && top(rows[1]) - bottom(rows[0]) > big) mark(rows[0], "header");
    const last = rows.length - 1;
    if (rows.length >= 2 && short(rows[last]) && top(rows[last]) - bottom(rows[last - 1]) > big) mark(rows[last], "footer");
    const h = pageHeights[pg] ?? 0;
    for (const e of boxed) {
      if (/^\d{1,5}$/.test(e.text.trim()) && h && (e.bbox![1] < h * 0.15 || e.bbox![3] > h * 0.85) && e.type !== "header" && e.type !== "footer") {
        e.type = e.bbox![1] < h * 0.5 ? "header" : "footer";
        n++;
      }
    }
  }
  return n;
}

/** "employ-\nment" inside a block becomes "employment"; "well-\nknown" keeps its hyphen. */
export function rejoinHyphenation(elements: Element[]): number {
  let n = 0;
  for (const e of elements) {
    const before = e.text;
    e.text = e.text.replace(/(\w)-\n([a-z])/g, (m, a: string, b: string) => {
      n++;
      return `${a}${b}`;
    });
    e.text = e.text.replace(/\n/g, " ");
    if (e.text !== before.replace(/\n/g, " ")) e.flags.push("hyphen_joined");
  }
  return n;
}

/** Headings that start with a native id (`§ 1910.27 ...`) get `native_id:<id>`. */
export function nativeIdHeadings(elements: Element[], pattern: SourcePattern | null): number {
  if (!pattern) return 0;
  const re = jsRegex(pattern.id_pattern);
  let n = 0;
  for (const e of elements) {
    if (e.type !== "heading" && e.type !== "paragraph") continue;
    re.lastIndex = 0;
    const m = re.exec(e.text);
    if (m && m.index <= 2 && m.groups) {
      const id = applyTemplate(pattern.id_template, m.groups);
      e.flags.push(`native_id:${id}`);
      if (e.type === "paragraph" && e.text.length < 160) e.type = "heading";
      n++;
    }
  }
  return n;
}

const PARA = /paragraphs?\s+((?:\([a-z0-9]{1,4}\))+)(?:\s+of\s+this\s+section)?/gi;
const SECTION = /§+\s*(\d+\.\d+[a-z]?(?:-\d+)?)((?:\([a-z0-9]{1,4}\))+)?/g;
const CFR = /(\d+)\s+CFR\s+(?:part\s+)?(\d+(?:\.\d+[a-z]?)?)((?:\([a-z0-9]{1,4}\))+)?/gi;
const PART = /\bparts?\s+(\d+)\b(?!\.\d)/gi;

const anchorOf = (d: string | undefined) => (d ? d.replace(/\s+/g, "").split(/[()]+/).filter(Boolean).join("-") : null);

/** Explicit references in prose, resolved with the source's template when possible. */
export function xrefCandidates(elements: Element[], pattern: SourcePattern | null, homeTitle?: string): XrefCandidate[] {
  const out: XrefCandidate[] = [];
  const re = pattern ? jsRegex(pattern.id_pattern) : null;
  for (const e of elements) {
    if (e.type === "header" || e.type === "footer") continue;
    for (const m of e.text.matchAll(CFR)) {
      out.push({ seq: e.seq, page: e.page, text: m[0], id: `CFR:${m[1]}-${m[2]}`, anchor: anchorOf(m[3]), form: "cfr" });
    }
    for (const m of e.text.matchAll(SECTION)) {
      let id: string | null = null;
      if (re) {
        re.lastIndex = 0;
        const g = re.exec(m[0]);
        if (g?.groups && pattern) id = applyTemplate(pattern.id_template, g.groups);
      }
      if (!id && homeTitle) id = `CFR:${homeTitle}-${m[1]}`;
      out.push({ seq: e.seq, page: e.page, text: m[0], id, anchor: anchorOf(m[2]), form: "section" });
    }
    for (const m of e.text.matchAll(PART)) {
      out.push({ seq: e.seq, page: e.page, text: m[0], id: homeTitle ? `CFR:${homeTitle}-${m[1]}` : null, anchor: null, form: "part" });
    }
    for (const m of e.text.matchAll(PARA)) {
      if (/of this section/i.test(m[0])) out.push({ seq: e.seq, page: e.page, text: m[0], id: null, anchor: anchorOf(m[1]), form: "paragraph-of-this-section" });
    }
  }
  return out;
}

/** Definitions in prose: "*Term* means ...", "Term is defined as ...", "The term X means". */
export function termCandidates(elements: Element[]): TermCandidate[] {
  const out: TermCandidate[] = [];
  const seen = new Set<string>();
  for (const e of elements) {
    if (e.type === "header" || e.type === "footer" || e.type === "table") continue;
    for (const m of e.text.matchAll(/(?:^|[.;:]\s+|\(\w{1,4}\)\s+)(?:The term\s+)?[*_]?([A-Z][\w\- ]{1,60}?)[*_]?\s+(means|is defined as)\s+([^.]{10,300}\.)/g)) {
      const term = m[1].trim();
      const key = term.toLowerCase();
      if (seen.has(key) || term.split(" ").length > 6) continue;
      seen.add(key);
      out.push({ term, seq: e.seq, page: e.page, definition: m[3].trim(), form: m[2] === "means" ? (/The term/.test(m[0]) ? "the term" : "means") : "is defined as" });
    }
  }
  return out;
}

/** A table continued on the next page (same column count, first cell not a fresh header) is one table. */
export function stitchTables(elements: Element[]): number {
  let n = 0;
  for (let i = 1; i < elements.length; i++) {
    const prev = elements[i - 1];
    const cur = elements[i];
    if (prev.type === "table" && cur.type === "table" && prev.table_grid && cur.table_grid && cur.page === prev.page + 1 && prev.table_grid[0]?.length === cur.table_grid[0]?.length) {
      prev.table_grid.push(...cur.table_grid);
      prev.text += "\n" + cur.text;
      prev.flags.push("stitched");
      elements.splice(i, 1);
      i--;
      n++;
    }
  }
  return n;
}

/** Heading tree by heading level (font size rank or explicit level flag), with element ranges. */
export function buildStructure(elements: Element[]): StructureNode[] {
  const heads = elements.filter((e) => e.type === "heading");
  const sizes = [...new Set(heads.map((h) => h.font_size ?? 0))].sort((a, b) => b - a);
  const levelOf = (h: Element) => {
    const flag = h.flags.find((f) => f.startsWith("level:"));
    if (flag) return Number(flag.slice(6));
    return sizes.indexOf(h.font_size ?? 0) + 1;
  };
  const roots: StructureNode[] = [];
  const stack: StructureNode[] = [];
  for (const h of heads) {
    const node: StructureNode = { seq: h.seq, page: h.page, level: levelOf(h), text: h.text, native_id: h.flags.find((f) => f.startsWith("native_id:"))?.slice(10) ?? null, range: [h.seq, h.seq], children: [] };
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    stack.push(node);
  }
  const last = elements.length ? elements[elements.length - 1].seq : 0;
  const flat: StructureNode[] = [];
  const walk = (n: StructureNode) => {
    flat.push(n);
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  flat.sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < flat.length; i++) {
    const next = flat.slice(i + 1).find((m) => m.level <= flat[i].level);
    flat[i].range = [flat[i].seq, next ? next.seq - 1 : last];
  }
  return roots;
}

export function runPasses(elements: Element[], pageHeights: Record<number, number>, pattern: SourcePattern | null, homeTitle?: string): PassesOutput {
  const notes: string[] = [];
  notes.push(`headers/footers: ${markHeadersFooters(elements, pageHeights)}`);
  notes.push(`hyphenation joins: ${rejoinHyphenation(elements)}`);
  notes.push(`native-id headings: ${nativeIdHeadings(elements, pattern)}`);
  notes.push(`tables stitched: ${stitchTables(elements)}`);
  elements.forEach((e, i) => (e.seq = i));
  const xrefs = xrefCandidates(elements, pattern, homeTitle);
  const terms = termCandidates(elements);
  const structure = buildStructure(elements);
  return { elements, structure, xrefs, terms, notes };
}
