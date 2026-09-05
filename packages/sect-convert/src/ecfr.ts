/**
 * eCFR bulk XML native parser (spec C.3, first row): DIV1..DIV8 -> tree, NODE -> node and derived
 * Work id, HEAD -> title, AUTH/SOURCE -> authority/citation, <I>Term</I> means -> defines, explicit
 * "§ X.Y" / "part N" references -> markdown links (spec C.4 explicit-ref pass). No OCR, no layout,
 * no model. The `context` prefix is a deterministic placeholder that names the section's place in
 * the hierarchy and what it refers to; WS3 rewrites it (spec D.2 step 4).
 */
import { createHash } from "node:crypto";
import { paragraphAnchors } from "./anchors.js";
import { attr, children, child, Elem, inlineMd, parseXml, squash, textOf } from "./xml.js";

export interface ConvertOptions {
  title: number;
  /** Corpus-relative path of the raw XML, recorded in provenance. */
  rawPath: string;
  /** Effective date (YYYY-MM-DD). Defaults to the AMDDATE in the XML. */
  effective?: string;
  /** Per-section dates from the versioner (identifier "21.8" to YYYY-MM-DD); a section without one takes the title date. */
  sectionDates?: Record<string, string>;
  /** The title's up-to-date-as-of date: no section may be dated after it. */
  titleDate?: string | null;
  ingestRun?: string;
}

export interface OutFile {
  /** Path relative to the corpus root, forward slashes. */
  path: string;
  text: string;
}

/** Keep source case distinctions on case-insensitive filesystems, including directories. */
export function caseSafePaths(paths: string[]): string[] {
  type Branch = { children: Map<string, Branch>; index?: number };
  const root: Branch = { children: new Map() };
  paths.forEach((path, index) => {
    let branch = root;
    for (const name of path.split("/")) {
      if (!branch.children.has(name)) branch.children.set(name, { children: new Map() });
      branch = branch.children.get(name)!;
    }
    if (branch.index !== undefined) throw new Error(`duplicate output path: ${path}`);
    branch.index = index;
  });
  const result = new Array<string>(paths.length);
  const visit = (branch: Branch, prefix: string) => {
    if (branch.index !== undefined) {
      if (branch.children.size) throw new Error(`output path is both file and directory: ${prefix}`);
      result[branch.index] = prefix;
    }
    const groups = new Map<string, number>();
    for (const name of branch.children.keys()) groups.set(name.toLowerCase(), (groups.get(name.toLowerCase()) ?? 0) + 1);
    const emitted = new Set<string>();
    for (const [name, child] of branch.children) {
      let mapped = name;
      if (groups.get(name.toLowerCase())! > 1) {
        const suffix = "~" + createHash("sha256").update(name).digest("hex").slice(0, 12);
        const dot = child.index === undefined ? -1 : name.lastIndexOf(".");
        mapped = dot > 0 ? name.slice(0, dot) + suffix + name.slice(dot) : name + suffix;
      }
      if (emitted.has(mapped.toLowerCase())) throw new Error(`disambiguated output path collides: ${prefix}/${mapped}`);
      emitted.add(mapped.toLowerCase());
      visit(child, prefix ? `${prefix}/${mapped}` : mapped);
    }
  };
  visit(root, "");
  return result;
}

export interface NodeRec {
  id: string;
  node: string;
  level: string;
  label: string;
  title: string;
  parent: string | null;
  order: number;
  dir: string;
  file: string;
  body: string;
  defines: string[];
  authority: string | null;
  citation: string | null;
  refs: string[];
}

const LEVELS: Record<string, string> = {
  TITLE: "title",
  SUBTITLE: "subtitle",
  CHAPTER: "chapter",
  SUBCHAP: "subchapter",
  PART: "part",
  SUBPART: "subpart",
  SUBJGRP: "subjectgroup",
  SECTION: "section",
};

const SMALL = new Set(["of", "the", "and", "for", "to", "in", "on", "by", "or", "a", "an", "at", "with"]);

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function headTitle(head: string, level: string): string {
  let h = squash(head).replace(/--Volume \d+$/i, "");
  const dash = h.search(/[—–-]/);
  if (level !== "section" && dash > 0) h = h.slice(dash + 1).trim();
  if (level === "section") h = h.replace(/^§+\s*[\d.]+[a-z]?(?:-\d+)?\s*/i, "").replace(/\.$/, "").trim();
  if (level !== "section" && h === h.toUpperCase()) h = titleCase(h);
  return h || "[Reserved]";
}

export function parseAmdDate(s: string): string | undefined {
  // Versioner XML writes "May 1, 2018(fm)"; the suffix is not part of the date.
  s = s.replace(/\(.*$/, "").trim();
  const m = s.match(/([A-Z][a-z]+)\.?\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return undefined;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const mi = months.indexOf(m[1].slice(0, 3).toLowerCase());
  if (mi < 0) return undefined;
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** A shallow copy of a structural node without its nested DIV children: the node's own blocks only. */
function ownOnly(el: Elem): Elem {
  const copy = (el as unknown as Node).cloneNode(false) as unknown as Elem;
  for (const c of Array.from((el as unknown as Node).childNodes)) {
    if (c.nodeType === 1 && (/^DIV[1-9]$/.test((c as Element).tagName) || XML_TOC_TAGS.has((c as Element).tagName))) continue;
    (copy as unknown as Node).appendChild(c.cloneNode(true));
  }
  return copy;
}

/** The bulk XML's own tables of contents inside a title, chapter, or part; the converter writes its own listing. */
const XML_TOC_TAGS = new Set(["CFRTOC", "CHAPTI", "PTHD", "PG", "TOC", "CONTENTS", "SECTNO", "SUBJECT", "SECHD"]);

/** Render the block children of a section (everything but HEAD/CITA/AUTH/SOURCE) to markdown. */
function renderBlocks(sec: Elem): string {
  const out: string[] = [];
  let tableRows: string[] = [];
  const flushTable = () => {
    if (tableRows.length) {
      const cols = tableRows[0].split("|").length - 2;
      out.push([tableRows[0], "|" + "---|".repeat(Math.max(cols, 1)), ...tableRows.slice(1)].join("\n"));
      tableRows = [];
    }
  };
  for (const c of children(sec)) {
    const tag = c.tagName;
    if (tag !== "TR") flushTable();
    switch (tag) {
      case "HEAD":
      case "CITA":
      case "AUTH":
      case "SOURCE":
        break;
      case "P":
      case "FP":
      case "NOTE":
      case "EXAMPLE": {
        const t = squash(inlineMd(c));
        if (t) out.push(t);
        break;
      }
      case "HD": {
        const t = squash(inlineMd(c));
        if (t) out.push(`### ${t}`);
        break;
      }
      case "EXTRACT": {
        const lines = children(c).map((p) => squash(inlineMd(p))).filter(Boolean);
        if (lines.length) out.push(lines.map((l) => `> ${l}`).join("\n>\n"));
        break;
      }
      case "TR": {
        const cells = children(c).map((td) => squash(inlineMd(td)).replace(/\|/g, "\\|"));
        tableRows.push(`| ${cells.join(" | ")} |`);
        break;
      }
      case "DIV":
      case "TABLE":
      case "THEAD":
      case "TBODY": {
        // HTML-style tables sit in plain DIV wrappers; their rows render like any other.
        const t = renderBlocks(c);
        if (t) out.push(t);
        break;
      }
      case "FTNT": {
        const t = squash(inlineMd(c));
        if (t) out.push(`Footnote: ${t}`);
        break;
      }
      case "GPOTABLE": {
        const rows: string[] = [];
        for (const row of children(c)) {
          const cells = children(row).map((cell) => squash(inlineMd(cell)).replace(/\|/g, "\\|"));
          if (cells.length) rows.push(`| ${cells.join(" | ")} |`);
        }
        if (rows.length) {
          const cols = rows[0].split("|").length - 2;
          out.push([rows[0], "|" + "---|".repeat(Math.max(cols, 1)), ...rows.slice(1)].join("\n"));
        }
        break;
      }
      default: {
        const t = squash(inlineMd(c));
        if (t) out.push(t);
      }
    }
  }
  flushTable();
  return out.join("\n\n");
}

const DEF_RE = /^\*([^*]{1,80})\*\s+(?:means|includes|has the meaning|is defined as)\b/;

function definedTerms(body: string): string[] {
  const out: string[] = [];
  for (const para of body.split("\n\n")) {
    const m = para.match(DEF_RE);
    if (m) {
      const term = m[1].replace(/[.,;:]$/, "").trim();
      if (term && !out.includes(term)) out.push(term);
    }
  }
  return out;
}

/** Link "§ X.Y", "§§ X.Y and X.Z", "part N" to Works that exist in this title. */
function linkRefs(body: string, title: number, ids: Set<string>, selfId: string, refs: string[]): string {
  const sec = /§§?\s*(\d{1,4})\.(\d{1,4}[a-z]?(?:-\d+)?)((?:\s*\([a-z0-9]{1,4}\))*)/g;
  let out = body.replace(sec, (m, part: string, num: string) => {
    const id = `CFR:${title}-${part}.${num}`;
    if (!ids.has(id) || id === selfId) return m;
    if (!refs.includes(id)) refs.push(id);
    return `[${m.trim()}](${id})`;
  });
  // A "§§ 1.1 and 1.2" continuation: the second number has no § in front.
  out = out.replace(/\]\((CFR:\d+-\d+\.[^)]+)\)\s+(and|through|or|to)\s+(\d{1,4})\.(\d{1,4}[a-z]?)(?![\w.])/g, (m, _prev: string, _conj: string, part: string, num: string) => {
    const id = `CFR:${title}-${part}.${num}`;
    if (!ids.has(id) || id === selfId) return m;
    if (!refs.includes(id)) refs.push(id);
    // Replace only the trailing number: the earlier link's target may contain the same digits.
    const tail = `${part}.${num}`;
    const cut = m.lastIndexOf(tail);
    return `${m.slice(0, cut)}[${tail}](${id})`;
  });
  const part = /\b[Pp]art\s+(\d{1,4})\b(?!\.)/g;
  out = out.replace(part, (m, num: string) => {
    const id = `CFR:${title}-${num}`;
    if (!ids.has(id) || id === selfId) return m;
    if (!refs.includes(id)) refs.push(id);
    return `[${m}](${id})`;
  });
  return out;
}

function q(s: string | null | undefined): string {
  return s == null ? "null" : JSON.stringify(s);
}

function contextFor(n: NodeRec, byId: Map<string, NodeRec>, titleName: string, title: number, kids: NodeRec[]): string {
  const chain: NodeRec[] = [];
  let cur = n.parent ? byId.get(n.parent) : undefined;
  while (cur) {
    chain.push(cur);
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  const where = chain
    .filter((c) => c.level !== "title")
    .map((c) => `${c.label} (${c.title})`)
    .join(", ");
  const parts: string[] = [];
  parts.push(`${n.label} ${n.title}${where ? `, within ${where}` : ""} of Title ${title} (${titleName}).`);
  const refTitles = n.refs
    .map((r) => byId.get(r))
    .filter((r): r is NodeRec => !!r)
    .slice(0, 4)
    .map((r) => `${r.label} (${r.title})`);
  if (refTitles.length) parts.push(`It refers to ${refTitles.join(", ")}.`);
  if (n.defines.length) parts.push(`It defines ${n.defines.length} term${n.defines.length > 1 ? "s" : ""}: ${n.defines.slice(0, 6).join(", ")}.`);
  if (kids.length) {
    // Counts only: naming the children would paraphrase the container's own table of contents.
    const first = kids[0];
    const last = kids[kids.length - 1];
    parts.push(`It contains ${kids.length} ${first.level}${kids.length > 1 ? "s" : ""}, from ${first.label} to ${last.label}.`);
  }
  if (n.authority) parts.push(`Authority: ${n.authority.slice(0, 120)}.`);
  if (n.citation) parts.push(`Source: ${n.citation.slice(0, 120)}.`);
  let ctx = parts.join(" ");
  if (ctx.split(/\s+/).length < 40) {
    ctx += ` This deterministic context prefix was written by sect-convert from the eCFR XML hierarchy, headings, and explicit references only; it names where the text sits and what it points to, and the WS3 ingest agent replaces it with a written prefix.`;
  }
  const words = squash(ctx).split(" ");
  return words.length > 110 ? words.slice(0, 110).join(" ") : words.join(" ");
}

export interface Candidate {
  kind: "effdnot" | "crossref";
  /** Nearest enclosing node id. */
  scope: string;
  node: string;
  text: string;
  dates: string[];
}

export interface DateStats {
  /** Sections dated from the versioner. */
  dated: number;
  /** Sections the versioner had no date for (the title date stands). */
  missing: number;
  /** Sections whose versioner date was after the title date (the title date stands). */
  late: number;
  /** Sections per year of their effective date. */
  spread: Record<string, number>;
}

export function convertEcfr(xml: string, opts: ConvertOptions): { files: OutFile[]; sections: number; nodes: number; effective: string; titleName: string; dates: DateStats; candidates: Candidate[]; records: NodeRec[] } {
  const doc = parseXml(xml);
  const root = doc.documentElement;
  // The first AMDDATE: under ECFRBRWS in bulk XML, directly under ECFR in versioner XML.
  const amd = textOf((root as unknown as Elem).getElementsByTagName("AMDDATE")[0]);
  const effective = opts.effective ?? parseAmdDate(amd) ?? "1970-01-01";
  const rawSha = createHash("sha256").update(xml).digest("hex");
  const ingestRun = opts.ingestRun ?? `${new Date().toISOString().slice(0, 16)}Z/sect-convert`;
  const t = opts.title;
  const nodes: NodeRec[] = [];
  const byId = new Map<string, NodeRec>();
  const childCount = new Map<string, number>();
  const candidates: Candidate[] = [];
  let titleName = "";

  function walk(el: Elem, parent: NodeRec | null, dir: string, order: number, partAuth: string | null, partSource: string | null): void {
    const type = attr(el, "TYPE");
    const level = LEVELS[type];
    if (!level) return;
    const n = attr(el, "N").replace(/^§+\s*/, "").trim();
    const head = textOf(child(el, "HEAD"));
    const title = headTitle(head, level);
    let id: string;
    let label: string;
    let subdir: string;
    switch (level) {
      case "title":
        id = `CFR:${t}`;
        label = `Title ${t}`;
        subdir = "";
        titleName = title;
        break;
      case "subtitle":
        id = `CFR:${t}-subtitle-${n}`;
        label = `Subtitle ${n}`;
        subdir = `subtitle-${n}`;
        break;
      case "chapter":
        id = `CFR:${t}-${n}`;
        label = `Chapter ${n}`;
        subdir = n;
        break;
      case "subchapter":
        id = `${parent!.id}-${n}`;
        label = `Subchapter ${n}`;
        subdir = n;
        break;
      case "part":
        id = `CFR:${t}-${n}`;
        label = `Part ${n}`;
        subdir = n;
        break;
      case "subpart":
        id = `${parent!.id}-${n}`;
        label = `Subpart ${n}`;
        subdir = n;
        break;
      case "subjectgroup":
        id = `${parent!.id}-sg${order}`;
        label = "Subject group";
        subdir = `sg${order}`;
        break;
      default:
        id = `CFR:${t}-${n}`;
        label = `§ ${n}`;
        subdir = n;
    }
    const authEl = child(el, "AUTH");
    const srcEl = child(el, "SOURCE");
    const authority = authEl ? textOf(child(authEl, "PSPACE") ?? authEl).replace(/^Authority:\s*/i, "") : partAuth;
    const source = srcEl ? textOf(child(srcEl, "PSPACE") ?? srcEl).replace(/^Source:\s*/i, "") : partSource;
    const cita = level === "section" ? textOf(child(el, "CITA")).replace(/^\[|\]$/g, "") : "";
    const nodeDir = dir ? `${dir}/${subdir}` : subdir;
    // GovInfo splits a title into volumes, each a DIV1 with its own copy of the subtitle and
    // chapter containers; the same id from a later volume reuses the record already built.
    const existing = byId.get(id);
    const rec: NodeRec = existing ?? {
      id,
      node: attr(el, "NODE"),
      level,
      label,
      title,
      parent: parent ? parent.id : null,
      order,
      dir: nodeDir,
      file: `${t}-${id.slice(`CFR:${t}-`.length) || t}.md`,
      body: level === "section" ? renderBlocks(el) : renderBlocks(ownOnly(el)),
      defines: [],
      authority: authority || null,
      citation: cita || source || null,
      refs: [],
    };
    if (!existing) {
      if (level === "title") rec.file = `${t}.md`;
      nodes.push(rec);
      byId.set(id, rec);
    }
    for (const c of children(el)) {
      if (c.tagName === "EFFDNOT" || c.tagName === "CROSSREF") {
        const text = textOf(c).replace(/\s+/g, " ").replace(/^(Effective Date Note|Cross Reference):\s*/i, "").trim();
        const dates = Array.from(text.matchAll(/([A-Z][a-z]+\.? \d{1,2}, \d{4})/g)).map((m) => m[1]);
        candidates.push({ kind: c.tagName === "EFFDNOT" ? "effdnot" : "crossref", scope: id, node: attr(el, "NODE"), text, dates });
      }
    }
    let i = childCount.get(id) ?? 0;
    for (const c of children(el)) {
      if (/^DIV\d$/.test(c.tagName) && LEVELS[attr(c, "TYPE")]) {
        i += 1;
        walk(c, rec, rec.dir, i, level === "part" ? authority : partAuth, level === "part" ? source : partSource);
      }
    }
    childCount.set(id, i);
  }

  const volumes = Array.from(root.getElementsByTagName("DIV1"));
  if (!volumes.length) throw new Error("no DIV1 (title) element in the XML");
  for (const v of volumes) walk(v as Elem, null, "", 1, null, null);

  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    if (n.level === "section") {
      n.body = linkRefs(n.body, t, ids, n.id, n.refs);
    }
  }
  const anchorsOf = new Map<string, Set<string>>();
  for (const n of nodes) if (n.level === "section") anchorsOf.set(n.id, new Set(paragraphAnchors(n.body).map((a) => a.anchor)));
  for (const n of nodes) {
    if (n.level === "section") {
      n.body = n.body.replace(/\]\((CFR:[^)#]+)#([a-z0-9-]+)\)/g, (m, id: string, anchor: string) => (anchorsOf.get(id)?.has(anchor) ? m : `](${id})`));
      n.defines = definedTerms(n.body);
    }
  }
  const childrenOf = new Map<string, NodeRec[]>();
  for (const n of nodes) if (n.parent) (childrenOf.get(n.parent) ?? childrenOf.set(n.parent, []).get(n.parent)!).push(n);

  // A section's Expression is dated when its current text took effect; the title date bounds it.
  const dates: DateStats = { dated: 0, missing: 0, late: 0, spread: {} };
  const sectionDate = (n: NodeRec): string => {
    if (!opts.sectionDates) return effective;
    const d = opts.sectionDates[n.id.slice(`CFR:${t}-`.length)];
    if (!d) dates.missing++;
    else if (opts.titleDate && d > opts.titleDate) dates.late++;
    else {
      dates.dated++;
      return d;
    }
    return effective;
  };
  // A structural node's listing is in force from its earliest section, so an as-of query at a
  // section's date still finds the tree above it.
  const dateOfNode = new Map<string, string>();
  const effectiveOf = (n: NodeRec): string => {
    const memo = dateOfNode.get(n.id);
    if (memo) return memo;
    let d: string;
    if (n.level === "section") d = sectionDate(n);
    else {
      const kids = (childrenOf.get(n.id) ?? []).map(effectiveOf);
      d = kids.length ? kids.reduce((a, b) => (a < b ? a : b)) : effective;
    }
    dateOfNode.set(n.id, d);
    return d;
  };
  // Source IDs are case-sensitive. Disambiguate the whole path tree before any
  // writes so e.g. Subparts Cc and CC survive on Windows with separate children.
  const paths = caseSafePaths(nodes.map((n) => `${n.dir ? n.dir + "/" : ""}${n.file}`));
  nodes.forEach((n, i) => {
    const slash = paths[i].lastIndexOf("/");
    n.dir = slash < 0 ? "" : paths[i].slice(0, slash);
    n.file = paths[i].slice(slash + 1);
  });
  const files: OutFile[] = [];
  for (const n of nodes) {
    const kids = childrenOf.get(n.id) ?? [];
    const nodeEffective = effectiveOf(n);
    if (n.level === "section") dates.spread[nodeEffective.slice(0, 4)] = (dates.spread[nodeEffective.slice(0, 4)] ?? 0) + 1;
    const heading = n.level === "section" ? `# ${n.label} ${n.title}` : `# ${n.label} - ${n.title}`;
    const toc = kids.map((k) => `- [${k.label} ${k.title}](${k.id})`).join("\n");
    // A structural node's own text (an editorial note, a reserved marker) comes before its listing.
    const body = n.level === "section" ? n.body || "[Reserved]" : [n.body, toc].filter(Boolean).join("\n\n");
    const navigation = n.level !== "section" && !n.body.trim();
    const fm = [
      "---",
      `id: ${q(n.id)}`,
      `node: ${q(n.node)}`,
      `source: ${q(`cfr-title-${t}`)}`,
      `title: ${q(n.title)}`,
      `level: ${q(n.level)}`,
      `parent: ${q(n.parent)}`,
      `order: ${n.order}`,
      `effective: ${nodeEffective}`,
      "supersedes: null",
      "superseded_by: null",
      "amended_by: []",
      "overrides: []",
      "narrows: []",
      `defines: ${JSON.stringify(n.defines)}`,
      `authority: ${q(n.authority)}`,
      `citation: ${q(n.citation)}`,
      "tags: []",
      `context: ${q(contextFor(n, byId, titleName, t, kids))}`,
      ...(navigation ? ["context_kind: navigation", "retrieval_role: navigation"] : []),
      "provenance:",
      `  raw: ${q(opts.rawPath)}`,
      `  raw_sha256: ${q(rawSha)}`,
      `  locator: {xpath: ${q(`//${n.level === "section" ? "DIV8" : "DIV*"}[@NODE='${n.node}']`)}}`,
      "  legal_status: unofficial-xml",
      `  ingest_run: ${q(ingestRun)}`,
      "  confidence: 1.0",
      "  verified_by: [sect-convert]",
      "---",
      "",
      heading,
      "",
      body,
      "",
    ].join("\n");
    const path = `cfr-title-${t}/${n.dir ? n.dir + "/" : ""}${n.file}`;
    files.push({ path, text: fm });
  }
  const sourceYaml = [
    `name: cfr-title-${t}`,
    "kind: base",
    `title: ${q(`Title ${t} - ${titleName}`)}`,
    'publisher: "Office of the Federal Register; GPO eCFR bulk XML (not the official legal edition)"',
    "precedence: 100",
    `id_prefix: ${q(`CFR:${t}-`)}`,
    `id_pattern: ${q(`(?i)(?:\\b${t}\\s*C\\.?F\\.?R\\.?\\s*(?:§\\s*)?|§\\s*|\\bsection\\s+)(?P<part>\\d{1,4})\\.(?P<section>\\d{1,4}[a-z]?(?:-\\d+)?)(?:\\s*\\((?P<p1>[a-z]|\\d{1,2}|[ivx]{1,4})\\))?(?:\\s*\\((?P<p2>[a-z]|\\d{1,2}|[ivx]{1,4})\\))?`)}`,
    `id_template: ${q(`CFR:${t}-{part}.{section}`)}`,
    'anchor_template: "{p1}-{p2}"',
    "legal_status: unofficial-xml",
    `version: ${q(effective)}`,
    `acquire: ${q(`https://www.govinfo.gov/bulkdata/ECFR/title-${t}/ECFR-title${t}.xml`)}`,
    "",
  ].join("\n");
  files.push({ path: `cfr-title-${t}/_source.yaml`, text: sourceYaml });
  return { files, sections: nodes.filter((n) => n.level === "section").length, nodes: nodes.length, effective, titleName, dates, candidates, records: nodes };
}
