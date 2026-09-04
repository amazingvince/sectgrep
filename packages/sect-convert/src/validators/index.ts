// Spec C.5: the seven validators WS3 runs on staging before submit, and CI runs on the fixture.
// Each is a function over one document and a context (the staging plus the corpus it will join);
// `validateStaging` runs them all and returns issues. Nothing here uses a model.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { paragraphAnchors } from "../anchors.js";
import { attr, parseXml, type Elem } from "../xml.js";
import { dateOf, loadCorpus, splitExpr, type Corpus, type Doc, type SourceInfo } from "./corpus.js";
import { containsRun, jaccard, spanMatch, tokens } from "./text.js";

export interface Issue {
  validator: number;
  level: "error" | "warning";
  path: string;
  message: string;
}

export interface ValidateOptions {
  staging: string;
  /** The corpus the staging will join; link targets resolve against both. */
  corpus?: string;
  /** Directory that `provenance.raw` paths are relative to (default: cwd). */
  rawRoot?: string;
  /** Work directory holding `<raw_sha256>/elements.jsonl` for PDF/DOCX/HTML/XLSX provenance. */
  work?: string;
  /** The sect binary for validator 1 (default: $SECT_BIN, then `sect` on PATH). */
  sectBin?: string;
  skipIndex?: boolean;
  roundTrip?: number;
  contextMax?: number;
}

export interface ValidatorSummary {
  n: number;
  name: string;
  checked: number;
  errors: number;
  warnings: number;
  skipped?: string;
}

export interface ValidateReport {
  staging: string;
  corpus: string | null;
  issues: Issue[];
  errors: number;
  warnings: number;
  validators: ValidatorSummary[];
  documents: number;
}

export const VALIDATOR_NAMES: Record<number, string> = {
  1: "validate-only index",
  2: "round-trip text",
  3: "table cells",
  4: "xref precision",
  5: "provenance completeness",
  6: "precedence sanity",
  7: "action integrity",
};

/** A source of truth for a document: its raw text as tokens, and its table cells. */
export interface SourceText {
  kind: "elements" | "xml";
  tokens: string[];
  cells: Set<string>;
  where: string;
}

export interface Context {
  staging: Corpus;
  all: Doc[];
  byId: Map<string, Doc[]>;
  sources: SourceInfo[];
  rawRoot: string;
  work: string;
  roundTrip: number;
  contextMax: number;
  /** Source text per document; null when the raw is not available, with the reason. */
  sourceOf(doc: Doc): { text: SourceText | null; reason?: string };
  /** sha256 of a raw file, computed once per path (a title is tens of megabytes shared by thousands of sections). */
  hashOf(file: string): string;
}

/** Cells compare without whitespace or emphasis: a footnote marker set off by a space, a subscript's break, are not differences. */
const cellKey = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s*_]+/g, "");

export function buildContext(o: ValidateOptions): Context {
  const staging = loadCorpus(o.staging);
  const corpus = o.corpus && path.resolve(o.corpus) !== staging.root ? loadCorpus(o.corpus) : null;
  const all = [...staging.docs, ...(corpus?.docs ?? [])];
  const byId = new Map<string, Doc[]>();
  for (const d of all) {
    if (!d.front.id) continue;
    byId.set(d.front.id, [...(byId.get(d.front.id) ?? []), d]);
  }
  const sources = [...staging.sources.values(), ...(corpus?.sources.values() ?? [])];
  const rawRoot = path.resolve(o.rawRoot ?? ".");
  const work = path.resolve(o.work ?? "work");
  const cache = new Map<string, { text: SourceText | null; reason?: string }>();
  const xmlCache = new Map<string, Document>();
  const sourceOf = (doc: Doc) => {
    const prov = (doc.front.provenance ?? null) as Record<string, unknown> | null;
    const raw = prov?.raw ? String(prov.raw) : "";
    const sha = prov?.raw_sha256 ? String(prov.raw_sha256) : "";
    const locator = (prov?.locator ?? {}) as Record<string, unknown>;
    const key = `${raw}|${sha}|${JSON.stringify(locator)}`;
    const hit = cache.get(key);
    if (hit) return hit;
    let out: { text: SourceText | null; reason?: string };
    const elements = sha ? path.join(work, sha, "elements.jsonl") : "";
    const rawPath = raw ? (path.isAbsolute(raw) ? raw : path.join(rawRoot, raw)) : "";
    if (!raw) out = { text: null, reason: "no provenance.raw" };
    else if (elements && existsSync(elements)) out = { text: elementsText(elements, path.join(work, sha), locator) };
    else if (rawPath && existsSync(rawPath) && /\.xml$/i.test(rawPath)) {
      let dom = xmlCache.get(rawPath);
      if (!dom) {
        dom = parseXml(readFileSync(rawPath, "utf-8"));
        xmlCache.set(rawPath, dom);
      }
      const el = locate(dom, String(locator.xpath ?? ""));
      out = el ? { text: xmlText(el, rawPath) } : { text: null, reason: `locator ${String(locator.xpath ?? "(none)")} not found in ${raw}` };
    } else if (rawPath && existsSync(rawPath)) out = { text: null, reason: `no elements for ${raw} under ${path.relative(process.cwd(), work) || "work"}/${sha.slice(0, 12)}...` };
    else out = { text: null, reason: `raw ${raw} not available` };
    cache.set(key, out);
    return out;
  };
  const hashes = new Map<string, string>();
  const hashOf = (file: string) => {
    let h = hashes.get(file);
    if (!h) {
      h = createHash("sha256").update(readFileSync(file)).digest("hex");
      hashes.set(file, h);
    }
    return h;
  };
  return { staging, all, byId, sources, rawRoot, work, roundTrip: o.roundTrip ?? 0.92, contextMax: o.contextMax ?? 0.8, sourceOf, hashOf };
}

/** The element text of a work directory, restricted to the locator's pages when it names them. */
function elementsText(file: string, dir: string, locator: Record<string, unknown>): SourceText {
  const pages = Array.isArray(locator.pages) ? new Set((locator.pages as unknown[]).map(Number)) : null;
  // An item cut from a page (an overlay item among others) names its elements; the page alone
  // would make every item's body a fraction of its source.
  const seqs = Array.isArray(locator.elements) ? new Set((locator.elements as unknown[]).map(Number)) : null;
  const toks: string[] = [];
  const cells = new Set<string>();
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as { page: number; seq?: number; type: string; text: string; table_grid?: string[][] };
    if (pages && !pages.has(e.page)) continue;
    if (seqs && !seqs.has(Number(e.seq))) continue;
    // Running heads stay in: tokens outside the matched span cost nothing, and a page title
    // typed as a header would otherwise be missing from its own section.
    toks.push(...tokens(e.text));
    for (const row of e.table_grid ?? []) for (const c of row) cells.add(cellKey(c));
  }
  const grids = path.join(dir, "grids.jsonl");
  if (existsSync(grids)) {
    for (const line of readFileSync(grids, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      const g = JSON.parse(line) as { rows: unknown[][] };
      for (const row of g.rows) for (const c of row) cells.add(cellKey(String(c ?? "")));
    }
  }
  return { kind: "elements", tokens: toks, cells, where: file };
}

/**
 * The subset of XPath the converters write: `//TAG[@ATTR='value']` (TAG may be `DIV*`) and
 * `//TAG[CHILD[contains(., 'value')]]`.
 */
const attrIndex = new WeakMap<Document, Map<string, Elem[]>>();

/** Every element by `ATTR=value`, built once per document (a title has hundreds of thousands of elements). */
function byAttr(dom: Document, name: string, value: string): Elem[] {
  let index = attrIndex.get(dom);
  if (!index) {
    index = new Map();
    attrIndex.set(dom, index);
  }
  const key = `${name}=${value}`;
  if (!index.has(`#${name}`)) {
    for (const e of Array.from(dom.getElementsByTagName("*")) as unknown as Elem[]) {
      const v = attr(e, name);
      if (v) index.set(`${name}=${v}`, [...(index.get(`${name}=${v}`) ?? []), e]);
    }
    index.set(`#${name}`, []);
  }
  return index.get(key) ?? [];
}

export function locate(dom: Document, xpath: string): Elem | null {
  let m = /^\/\/(\w+|DIV\*|\*)\[@(\w+)='([^']*)'\]$/.exec(xpath);
  if (m) {
    const [, tag, name, value] = m;
    return byAttr(dom, name, value).find((e) => tagMatches(e.tagName, tag)) ?? null;
  }
  const every = Array.from(dom.getElementsByTagName("*")) as unknown as Elem[];
  m = /^\/\/(\w+)\[(\w+)\[contains\(\.,\s*'([^']*)'\)\]\]$/.exec(xpath);
  if (m) {
    const [, tag, childTag, value] = m;
    return every.find((e) => e.tagName === tag && Array.from((e as unknown as Element).getElementsByTagName(childTag)).some((c) => (c.textContent ?? "").includes(value))) ?? null;
  }
  return null;
}

const tagMatches = (tagName: string, pattern: string) => pattern === "*" || (pattern === "DIV*" ? /^DIV\d$/.test(tagName) : tagName === pattern);

/**
 * Text with a space at every element boundary, so adjacent cells and paragraphs do not run
 * together. Nested DIV elements are skipped: a part or title node's own text is its heading and
 * front matter, not the sections beneath it (a title holds millions of tokens).
 */
/**
 * XML elements that are never body text: the ones the converter maps to front-matter fields
 * (authority, citation) and the bulk XML's own tables of contents (a title's CHAPTI entries).
 */
const FRONT_MATTER_ELEMENTS = new Set(["AUTH", "SOURCE", "CITA", "CFRTOC", "CHAPTI", "PTHD", "PG", "TOC", "CONTENTS", "SECTNO", "SUBJECT", "SECHD"]);

/** The rules one child of a node falls under: skipped, or included with a space around it. */
const skipChild = (c: Node) => c.nodeType === 1 && (FRONT_MATTER_ELEMENTS.has((c as Element).tagName) || /^DIV\d$/.test((c as Element).tagName));

function spacedText(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  let out = "";
  for (const c of Array.from(node.childNodes)) {
    if (c.nodeType === 3) out += c.nodeValue ?? "";
    else if (skipChild(c)) continue;
    else out += ` ${spacedText(c)} `;
  }
  return out;
}

/**
 * The node's text without its own HEAD: the body is compared below its heading line, and the
 * heading is the converter's label for the HEAD, so the two are set aside together.
 */
function xmlText(el: Elem, where: string): SourceText {
  const cells = new Set<string>();
  for (const ent of Array.from((el as unknown as Element).getElementsByTagName("ENT"))) cells.add(cellKey(ent.textContent ?? ""));
  let text = "";
  for (const c of Array.from((el as unknown as Node).childNodes)) {
    if (c.nodeType === 1 && (c as Element).tagName === "HEAD") continue;
    if (skipChild(c)) continue;
    text += ` ${spacedText(c)} `;
  }
  return { kind: "xml", tokens: tokens(text), cells, where };
}

const issue = (validator: number, level: Issue["level"], doc: Doc, message: string): Issue => ({ validator, level, path: doc.rel, message });

/** `Walking-working surface` -> `walking-working-surface`: lowercase, runs of non-alphanumerics to one hyphen. */
export const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ---- 1. sect index --validate-only

export function validateIndex(staging: string, sectBin?: string): { issues: Issue[]; skipped?: string } {
  const given = sectBin ?? process.env.SECT_BIN ?? "sect";
  // A relative path is taken from the working directory; a bare name is looked up on PATH.
  const bin = given.includes("/") || given.includes("\\") ? path.resolve(given) : given;
  const r = spawnSync(bin, ["index", "--validate-only", "--json", staging], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { issues: [], skipped: `sect binary not found (${bin}): ${r.error.message}; set SECT_BIN` };
  const issues: Issue[] = [];
  try {
    const j = JSON.parse(r.stdout) as { issues?: Array<{ level: string; path: string; message: string }> };
    for (const i of j.issues ?? []) issues.push({ validator: 1, level: i.level === "error" ? "error" : "warning", path: i.path, message: i.message });
  } catch {
    const lines = (r.stdout + r.stderr).split("\n").filter((l) => /^(error|warning): /.test(l));
    for (const l of lines) {
      const m = /^(error|warning): ([^:]+): (.*)$/.exec(l);
      if (m) issues.push({ validator: 1, level: m[1] as Issue["level"], path: m[2], message: m[3] });
    }
    if (!lines.length && r.status !== 0) issues.push({ validator: 1, level: "error", path: staging, message: `sect index --validate-only exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 300)}` });
  }
  return { issues };
}

// ---- 2. round-trip text

/**
 * The body as rule text: below its first heading (the converter's label, number and title), and
 * without list items that are only a link (a parent's listing of its children is derived, not text).
 */
export function bodyBelowHeading(body: string): string {
  return body
    .replace(/^\s*#{1,6}[^\n]*\n?/, "")
    .replace(/^\s*[-*]\s*\[(?:[^\[\]]|\[[^\]]*\])*\]\([^)]*\)\s*$/gm, "")
    // A listing entry whose link was dropped at merge or in a subset run is still a listing entry.
    .replace(/^\s*[-*]\s+[^\n]*\((?:not in this corpus|held for review)\)\s*$/gm, "");
}

export function roundTrip(doc: Doc, cx: Context): Issue[] {
  const out: Issue[] = [];
  if (doc.front.kind === "note" || doc.source?.kind === "note") return out;
  const body = tokens(bodyBelowHeading(doc.body));
  const ctx = tokens(String(doc.front.context ?? ""));
  if (ctx.length && body.length) {
    const j = jaccard(ctx, body);
    if (j >= cx.contextMax) out.push(issue(2, "error", doc, `context block paraphrases the body (token Jaccard ${j.toFixed(2)} >= ${cx.contextMax})`));
  }
  // An Expression composed from a prior one and a notice's Actions (provenance.derived_from,
  // legal_status derived) has no single raw file: its source is the prior Expression's body
  // with the applied Actions' quoted text (spec-changes #33).
  const derivedFrom = (doc.front.provenance as { derived_from?: unknown } | undefined)?.derived_from;
  let text: { tokens: string[]; kind: string } | null = null;
  let reason: string | undefined;
  if (derivedFrom) {
    const [pid, pdate] = String(derivedFrom).split("@");
    const prior = (cx.byId.get(pid) ?? []).find((d) => dateOf(d.front) === pdate);
    if (!prior) reason = `prior Expression ${String(derivedFrom)} not found`;
    else {
      const actionTexts: string[] = [];
      for (const ref of (doc.front.amended_by ?? []).map(String)) {
        const notice = (cx.byId.get(ref.split("#")[0]) ?? []).find((n) => (n.front.actions?.length ?? 0) > 0);
        const a = notice?.front.actions?.find((x) => x.action_id === ref);
        if (a?.text) actionTexts.push(String(a.text));
      }
      text = { tokens: [...tokens(prior.body), ...tokens(actionTexts.join("\n"))], kind: "derived" };
    }
  } else ({ text, reason } = cx.sourceOf(doc));
  if (!text) {
    out.push(issue(2, "warning", doc, `round-trip not checked: ${reason ?? "source unavailable"}`));
    return out;
  }
  if (text.kind === "derived" && body.length) {
    // The amended paragraph sits out of order with the prior text, so no single span holds the
    // body: every body token must instead come from the prior Expression or the Actions' text.
    const bag = new Map<string, number>();
    for (const t of text.tokens) bag.set(t, (bag.get(t) ?? 0) + 1);
    let hit = 0;
    for (const t of body) {
      const n = bag.get(t) ?? 0;
      if (n > 0) {
        hit++;
        bag.set(t, n - 1);
      }
    }
    const score = hit / body.length;
    if (score < cx.roundTrip) out.push(issue(2, "error", doc, `body tokens found in the prior Expression and the Actions' text: ${score.toFixed(3)} (< ${cx.roundTrip}; ${hit} of ${body.length})`));
    return out;
  }
  if (!body.length) {
    // Nothing below the heading is right when the source node is nothing but its heading
    // (a reserved chapter, a part that only lists its sections).
    if (text.tokens.length > 12) out.push(issue(2, "error", doc, `empty body; the ${text.kind} source holds ${text.tokens.length} tokens`));
    return out;
  }
  if (body.length < 8) {
    // A stub ("§ 11.6 [Reserved]", then "[Reserved]") is too short for a ratio to mean anything:
    // every distinct token of the body must be in the source or in the stub's own heading.
    const have = new Set([...text.tokens, ...tokens(doc.body.split("\n").find((l) => l.trim()) ?? "")]);
    const missing = [...new Set(body)].filter((t) => !have.has(t));
    if (missing.length) out.push(issue(2, "error", doc, `body token(s) not in its ${text.kind} source: ${missing.join(", ")}`));
    return out;
  }
  const s = spanMatch(body, text.tokens, cx.roundTrip);
  if (s.score < cx.roundTrip) out.push(issue(2, "error", doc, `body matches its ${text.kind} source at ${s.score.toFixed(3)} (< ${cx.roundTrip}; ${s.lcs} of ${body.length} tokens in a span of ${s.end - s.start + 1}${s.capped ? "; diff cut off" : ""})`));
  return out;
}

// ---- 3. table cells

export function tableCells(doc: Doc, cx: Context): Issue[] {
  const out: Issue[] = [];
  const rows: string[][] = [];
  for (const line of doc.body.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    if (/^\|?\s*:?-{3,}/.test(t)) continue;
    rows.push(t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
  }
  if (!rows.length) return out;
  const { text, reason } = cx.sourceOf(doc);
  if (!text) {
    out.push(issue(3, "warning", doc, `table cells not checked: ${reason ?? "source unavailable"}`));
    return out;
  }
  const missing: string[] = [];
  for (const row of rows) {
    for (const cell of row) {
      const key = cellKey(cell.replace(/[*_`]/g, ""));
      if (!key) continue;
      const numeric = /\d/.test(key);
      const enumerated = /^\(?[a-z0-9]{1,4}\)?$/.test(key);
      if (!numeric && !enumerated) continue;
      if (text.cells.has(key)) continue;
      if (containsRun(text.tokens, tokens(cell))) continue;
      missing.push(cell);
    }
  }
  if (missing.length) out.push(issue(3, "error", doc, `table cell(s) not in the source: ${[...new Set(missing)].slice(0, 8).map((c) => `"${c}"`).join(", ")}${missing.length > 8 ? ` and ${missing.length - 8} more` : ""}`));
  return out;
}

// ---- 4. xref precision

export interface LinkRef {
  id: string;
  anchor: string | null;
  where: string;
}

export function linksOf(doc: Doc): LinkRef[] {
  const refs: LinkRef[] = [];
  // An id may carry balanced parentheses ("CFR:29-2584.8477(e)-1"), as the Rust side allows.
  for (const m of doc.body.matchAll(/\]\(([A-Z][A-Z0-9]*:(?:[^\s#()]|\([^()\s]*\))+)(?:#([a-z0-9-]+))?\)/g)) refs.push({ id: m[1], anchor: m[2] ?? null, where: "body" });
  // overrides/narrows entries are ids, or {id, anchor} objects when they name a paragraph.
  for (const field of ["overrides", "narrows"] as const) {
    for (const t of (doc.front[field] ?? []) as unknown[]) {
      if (t && typeof t === "object") {
        const o = t as { id?: unknown; anchor?: unknown };
        if (o.id) refs.push({ id: splitExpr(String(o.id)).id, anchor: o.anchor ? String(o.anchor) : null, where: field });
      } else refs.push({ id: splitExpr(String(t)).id, anchor: null, where: field });
    }
  }
  for (const field of ["supersedes", "superseded_by", "parent"] as const) {
    const t = doc.front[field];
    if (t) refs.push({ id: splitExpr(String(t)).id, anchor: null, where: field });
  }
  return refs;
}

/** Whether some Expression of `id` is active at date D: effective <= D and not superseded on or before D. */
export function activeAt(cx: Context, id: string, date: string | null): boolean {
  const exprs = cx.byId.get(id) ?? [];
  if (!exprs.length) return false;
  if (!date) return true;
  return exprs.some((e) => {
    const eff = dateOf(e.front);
    if (!eff || eff > date) return false;
    const sup = e.front.superseded_by ? splitExpr(String(e.front.superseded_by)).date : null;
    return !(sup && sup <= date);
  });
}

const latestBySource = new WeakMap<Context, Map<string, string>>();

/** The latest Expression date of a source across the staging and the corpus, at least `floor`. */
export function latestOf(cx: Context, source: string | undefined, floor: string): string {
  let m = latestBySource.get(cx);
  if (!m) {
    m = new Map();
    for (const docs of cx.byId.values()) {
      for (const d of docs) {
        const k = d.source?.name ?? "";
        const dt = dateOf(d.front) ?? "";
        if (dt > (m.get(k) ?? "")) m.set(k, dt);
      }
    }
    latestBySource.set(cx, m);
  }
  const l = m.get(source ?? "") ?? "";
  return l > floor ? l : floor;
}

export function xrefPrecision(doc: Doc, cx: Context): Issue[] {
  const out: Issue[] = [];
  const notice = doc.front.kind === "notice" || doc.source?.kind === "notice";
  const date = dateOf(doc.front);
  const seen = new Set<string>();
  for (const ref of linksOf(doc)) {
    const key = `${ref.id}#${ref.anchor ?? ""}@${ref.where}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const targets = cx.byId.get(ref.id);
    if (!targets?.length) {
      const known = cx.sources.some((s) => s.id_prefix && ref.id.startsWith(s.id_prefix));
      if (!known) out.push(issue(4, "warning", doc, `${ref.where}: link target ${ref.id} is outside this corpus's sources`));
      else out.push(issue(4, notice ? "warning" : "error", doc, `${ref.where}: link target ${ref.id} does not resolve`));
      continue;
    }
    if (ref.where === "superseded_by" || ref.where === "supersedes") continue;
    // A section is read as of its source's latest Expression (per-section dates, spec-changes #32):
    // a 2012 section may cite one amended in 2024.
    if (!notice && date && !activeAt(cx, ref.id, date) && !activeAt(cx, ref.id, latestOf(cx, doc.source?.name, date))) out.push(issue(4, "error", doc, `${ref.where}: link target ${ref.id} is not active at ${date} nor at the source's latest date ${latestOf(cx, doc.source?.name, date)}`));
    if (ref.anchor) {
      const current = [...targets].sort((a, b) => (dateOf(b.front) ?? "").localeCompare(dateOf(a.front) ?? ""))[0];
      // Paragraph anchors plus one slug per defined term, as the Rust side derives them (spec B.2).
      const anchors = new Set([...paragraphAnchors(current.body).map((a) => a.anchor), ...(current.front.defines ?? []).map((t) => slug(String(t)))]);
      if (!anchors.has(ref.anchor)) out.push(issue(4, "error", doc, `${ref.where}: anchor ${ref.id}#${ref.anchor} not found (anchors: ${[...anchors].slice(0, 12).join(", ")})`));
    }
  }
  return out;
}

// ---- 5. provenance completeness

const LEGAL_STATUS = new Set(["official", "unofficial-xml", "derived"]);

export function provenanceComplete(doc: Doc, cx: Context): Issue[] {
  const out: Issue[] = [];
  const note = doc.front.kind === "note" || doc.source?.kind === "note";
  if (note) {
    const sources = doc.front.sources ?? [];
    if (!sources.length || sources.some((s) => !s?.id || !s?.hash)) out.push(issue(5, "error", doc, "note without sources [{id, hash}]"));
    return out;
  }
  const prov = (doc.front.provenance ?? null) as Record<string, unknown> | null;
  if (!prov) {
    out.push(issue(5, "error", doc, "no provenance block"));
    return out;
  }
  const missing: string[] = [];
  const raw = prov.raw ? String(prov.raw) : "";
  const sha = prov.raw_sha256 ? String(prov.raw_sha256) : "";
  if (!raw) missing.push("raw");
  if (!/^[0-9a-f]{64}$/.test(sha)) missing.push("raw_sha256 (64 hex)");
  const locator = prov.locator;
  if (!locator || typeof locator !== "object" || !Object.keys(locator as object).length) missing.push("locator");
  if (!prov.legal_status || !LEGAL_STATUS.has(String(prov.legal_status))) missing.push("legal_status (official | unofficial-xml | derived)");
  if (!prov.ingest_run) missing.push("ingest_run");
  if (missing.length) out.push(issue(5, "error", doc, `provenance missing ${missing.join(", ")}`));
  if (raw && /^[0-9a-f]{64}$/.test(sha)) {
    const rawPath = path.isAbsolute(raw) ? raw : path.join(cx.rawRoot, raw);
    if (existsSync(rawPath)) {
      const actual = cx.hashOf(rawPath);
      if (actual !== sha) out.push(issue(5, "error", doc, `raw_sha256 does not match ${raw} (${actual.slice(0, 12)}...)`));
    } else out.push(issue(5, "warning", doc, `raw ${raw} not available; hash not verified`));
  }
  return out;
}

// ---- 6. precedence sanity

export function precedenceSanity(doc: Doc, cx: Context): Issue[] {
  const out: Issue[] = [];
  const idOf = (t: unknown) => (t && typeof t === "object" ? String((t as { id?: unknown }).id ?? "") : String(t));
  const refs = [...((doc.front.overrides ?? []) as unknown[]).map((t) => ({ t: idOf(t), f: "overrides" })), ...((doc.front.narrows ?? []) as unknown[]).map((t) => ({ t: idOf(t), f: "narrows" }))].filter((r) => r.t);
  if (!refs.length) return out;
  if (doc.source && doc.source.kind !== "overlay") out.push(issue(6, "warning", doc, `${refs[0].f} from a ${doc.source.kind} source (expected overlay)`));
  for (const { t, f } of refs) {
    const { id } = splitExpr(t);
    const target = cx.byId.get(id)?.[0];
    if (!target) continue; // validator 4 reports resolution
    if (!target.source) {
      out.push(issue(6, "error", doc, `${f} ${id}: target has no _source.yaml`));
      continue;
    }
    if (target.source.kind !== "base") out.push(issue(6, "error", doc, `${f} ${id}: target source ${target.source.name} is ${target.source.kind}, not base`));
    if (doc.source && !(target.source.precedence < doc.source.precedence)) out.push(issue(6, "error", doc, `${f} ${id}: target precedence ${target.source.precedence} is not below ${doc.source.precedence}`));
  }
  return out;
}

// ---- 7. action integrity

export function actionIntegrity(doc: Doc, cx: Context): Issue[] {
  const out: Issue[] = [];
  const amended = (doc.front.amended_by ?? []).map(String);
  if (!amended.length) return out;
  if (!doc.front.supersedes) out.push(issue(7, "warning", doc, "amended_by set but supersedes is null"));
  const body = tokens(doc.body);
  for (const ref of amended) {
    const hash = ref.indexOf("#");
    const noticeId = hash > 0 ? ref.slice(0, hash) : ref;
    const notices = (cx.byId.get(noticeId) ?? []).filter((d) => d.front.kind === "notice" || d.source?.kind === "notice" || (d.front.actions?.length ?? 0) > 0);
    if (!notices.length) {
      out.push(issue(7, "error", doc, `amended_by ${ref}: notice ${noticeId} not found`));
      continue;
    }
    const action = notices.flatMap((n) => n.front.actions ?? []).find((a) => a.action_id === ref);
    if (!action) {
      out.push(issue(7, "error", doc, `amended_by ${ref}: no such Action in ${noticeId}`));
      continue;
    }
    // The target is this section, or a container above it for a part-wide word change.
    const ancestors = new Set<string>();
    for (let p = doc.front.parent ? String(doc.front.parent) : null, n = 0; p && n < 12; n++) {
      ancestors.add(p);
      p = (cx.byId.get(p) ?? [])[0]?.front.parent ? String((cx.byId.get(p) ?? [])[0].front.parent) : null;
    }
    if (action.target_id !== doc.front.id && !ancestors.has(action.target_id)) out.push(issue(7, "error", doc, `amended_by ${ref}: Action target ${action.target_id} is not this section nor a container above it`));
    const quoted = tokens(String(action.text ?? ""));
    if (String(action.kind ?? "") === "remove") continue;
    // The quoted paragraphs need not sit together in the Expression (one may be placed between
    // two others); each is looked for on its own, and one printed with asterisks is not given whole.
    const paras = String(action.text ?? "").split(/\n{2,}/).map((p) => p.trim()).filter((p) => p && !/^#{1,6}\s/.test(p) && !/^\*\s?\*\s?\*\s*$/.test(p) && !/reads? as follows:?$/i.test(p) && !/\*\s?\*\s?\*/.test(p));
    const bodyTokens = tokens(doc.body);
    let missing = 0;
    for (const p of paras) {
      const pt = tokens(p);
      if (pt.length < 4) continue;
      if (spanMatch(pt, bodyTokens, cx.roundTrip).score < cx.roundTrip) missing++;
    }
    if (paras.length && missing) out.push(issue(7, "error", doc, `amended_by ${ref}: ${missing} of ${paras.length} quoted paragraph(s) not present in this Expression`));
    if (paras.length) continue;
    if (!quoted.length) out.push(issue(7, "warning", doc, `amended_by ${ref}: Action carries no text to check`));
    else {
      const s = spanMatch(quoted, body);
      if (s.score < cx.roundTrip) out.push(issue(7, "error", doc, `amended_by ${ref}: the Action's text is not present in this Expression (${s.score.toFixed(3)} < ${cx.roundTrip})`));
    }
  }
  return out;
}

// ---- all seven

export const VALIDATORS: Array<{ n: number; run: (doc: Doc, cx: Context) => Issue[] }> = [
  { n: 2, run: roundTrip },
  { n: 3, run: tableCells },
  { n: 4, run: xrefPrecision },
  { n: 5, run: provenanceComplete },
  { n: 6, run: precedenceSanity },
  { n: 7, run: actionIntegrity },
];

export function validateStaging(o: ValidateOptions): ValidateReport {
  const cx = buildContext(o);
  const issues: Issue[] = [];
  const summaries: ValidatorSummary[] = [];
  const staging = cx.staging.root;
  if (o.skipIndex) summaries.push({ n: 1, name: VALIDATOR_NAMES[1], checked: 0, errors: 0, warnings: 0, skipped: "skipped by option" });
  else {
    const r = validateIndex(staging, o.sectBin);
    // The index validator sees the staging alone; a target the corpus already holds resolves at merge.
    for (const i of r.issues) {
      const t = /link target `([^`]+)` does not resolve/.exec(i.message)?.[1] ?? /(?:parent|supersedes|superseded_by) `([^`]+)` (?:does not resolve|is not a known)/.exec(i.message)?.[1];
      if (t && i.level === "error" && cx.byId.has(t.split("@")[0])) {
        i.level = "warning";
        i.message += " in the staging (it resolves in the corpus)";
      }
    }
    issues.push(...r.issues);
    summaries.push({ n: 1, name: VALIDATOR_NAMES[1], checked: r.skipped ? 0 : cx.staging.docs.length, errors: r.issues.filter((i) => i.level === "error").length, warnings: r.issues.filter((i) => i.level === "warning").length, skipped: r.skipped });
  }
  for (const v of VALIDATORS) {
    const found: Issue[] = [];
    for (const doc of cx.staging.docs) found.push(...v.run(doc, cx));
    issues.push(...found);
    summaries.push({ n: v.n, name: VALIDATOR_NAMES[v.n], checked: cx.staging.docs.length, errors: found.filter((i) => i.level === "error").length, warnings: found.filter((i) => i.level === "warning").length });
  }
  return { staging, corpus: o.corpus ? path.resolve(o.corpus) : null, issues, errors: issues.filter((i) => i.level === "error").length, warnings: issues.filter((i) => i.level === "warning").length, validators: summaries, documents: cx.staging.docs.length };
}

export function formatReport(r: ValidateReport): string {
  const lines: string[] = [];
  for (const i of r.issues) lines.push(`${i.level}: [${i.validator}] ${i.path}: ${i.message}`);
  lines.push("");
  for (const v of r.validators) lines.push(`validator ${v.n} ${v.name}: ${v.skipped ? `skipped (${v.skipped})` : `${v.checked} document(s), ${v.errors} error(s), ${v.warnings} warning(s)`}`);
  lines.push(`validated ${r.documents} document(s) in ${r.staging}: ${r.errors} error(s), ${r.warnings} warning(s)`);
  return lines.join("\n");
}
