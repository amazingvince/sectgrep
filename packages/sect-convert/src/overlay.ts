// An overlay source from an extracted document (C.1 elements): one item per heading the
// source's own id pattern recognizes, in the corpus contract, with `overrides` and `narrows`
// left empty for the ingest agent (spec D.2 step 8) and every citation left bare for the
// harness to resolve against the registry. Nothing here knows the base's shapes.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { compileIdPattern, fillTemplate } from "./registry.js";

export interface OverlayElement {
  page: number;
  seq: number;
  type: string;
  text: string;
  flags?: string[];
  confidence?: number;
  cells?: string[][];
}

export interface OverlayOptions {
  /** The extract work directory (`work/<sha>/`) holding elements.jsonl and report.json. */
  work: string;
  /** The overlay's `_source.yaml` (name, kind overlay, precedence, id_prefix, id_pattern, id_template ...). */
  sourceYaml: string;
  /** Path of the raw document as recorded in provenance. */
  rawPath: string;
  rawSha256: string;
  effective: string;
  ingestRun?: string;
  /** Item ids to keep (default all the pattern finds). */
  only?: string[];
}

export interface OverlayItem {
  id: string;
  title: string;
  pages: number[];
  body: string;
}

export interface OverlayResult {
  files: Array<{ path: string; text: string }>;
  items: OverlayItem[];
  skipped: Array<{ page: number; text: string; why: string }>;
}

const q = (s: unknown) => JSON.stringify(s ?? null);

/** Element rows as markdown: tables as GFM, headings as text, the rest as paragraphs. */
function render(e: OverlayElement): string {
  if (e.type === "table" && e.cells?.length) {
    const [head, ...rows] = e.cells;
    const line = (r: string[]) => `| ${r.map((c) => c.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim()).join(" | ")} |`;
    return [line(head), `|${head.map(() => "---").join("|")}|`, ...rows.map(line)].join("\n");
  }
  return e.text.replace(/\s+\n/g, "\n").trim();
}

/** Split an extracted document into overlay items at the headings the id pattern recognizes. */
export function convertOverlay(o: OverlayOptions): OverlayResult {
  const src = (YAML.parse(readFileSync(o.sourceYaml, "utf-8")) ?? {}) as Record<string, unknown>;
  const name = String(src.name ?? path.basename(path.dirname(o.sourceYaml)));
  const pattern = src.id_pattern ? compileIdPattern(String(src.id_pattern)) : null;
  const template = String(src.id_template ?? "");
  if (!pattern || !template) throw new Error(`${o.sourceYaml}: id_pattern and id_template are required to find the items`);
  const elements = readFileSync(path.join(o.work, "elements.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as OverlayElement);
  const items: Array<OverlayItem & { elements: OverlayElement[]; native?: string }> = [];
  const skipped: OverlayResult["skipped"] = [];
  let cur: (typeof items)[number] | null = null;
  for (const e of elements) {
    // A heading that carries an item id opens an item; any heading line may also be a paragraph
    // whose first words are the id (a scanned or flattened document).
    const probe = e.type === "heading" || e.type === "paragraph" ? e.text.trim() : "";
    const m = probe ? new RegExp(`^(?:${pattern.source})`, pattern.flags.replace("g", "")).exec(probe.slice(0, 200)) : null;
    if (m) {
      const id = fillTemplate(template, m.groups);
      if (!id.includes("{")) {
        if (o.only && !o.only.includes(id)) {
          cur = null;
          skipped.push({ page: e.page, text: probe.slice(0, 80), why: "not selected" });
          continue;
        }
        // A run-in heading: the title runs to the first period, the rest of the paragraph is body.
        const after = probe.slice(m[0].length).replace(/^[\s.:—–-]+/, "");
        const stop = e.type === "heading" ? -1 : after.search(/\.(?:\s|$)/);
        const title = (stop >= 0 ? after.slice(0, stop) : after).trim().slice(0, 160) || id;
        cur = { id, title, pages: [e.page], body: "", elements: [] };
        items.push(cur);
        const rest = stop >= 0 ? after.slice(stop + 1).trim() : "";
        if (rest) cur.elements.push({ ...e, type: "paragraph", text: rest });
        continue;
      }
    }
    if (!cur) {
      if (e.type !== "other") skipped.push({ page: e.page, text: e.text.slice(0, 80), why: "before the first item" });
      continue;
    }
    cur.elements.push(e);
    if (!cur.pages.includes(e.page)) cur.pages.push(e.page);
  }
  const files: OverlayResult["files"] = [];
  const dir = name;
  for (const it of items) {
    it.body = it.elements.map(render).filter(Boolean).join("\n\n");
    const flags = [...new Set(it.elements.flatMap((e) => e.flags ?? []))];
    const fm = [
      "---",
      `id: ${q(it.id)}`,
      "node: null",
      `source: ${q(name)}`,
      `title: ${q(it.title)}`,
      "level: section",
      "parent: null",
      `order: ${items.indexOf(it) + 1}`,
      `effective: ${o.effective}`,
      "supersedes: null",
      "superseded_by: null",
      "amended_by: []",
      "overrides: []",
      "narrows: []",
      "defines: []",
      `authority: ${q(src.authority ?? null)}`,
      `citation: ${q(src.citation ?? null)}`,
      `tags: ${JSON.stringify(flags.length ? ["overlay", ...flags.map((f) => f.split(":")[0])] : ["overlay"])}`,
      `context: ${q(`${it.title}: item ${it.id} of ${String(src.title ?? name)}, effective ${o.effective}, on pages ${it.pages.join(", ")} of the source document.`)}`,
      "provenance:",
      `  raw: ${q(o.rawPath)}`,
      `  raw_sha256: ${q(o.rawSha256)}`,
      `  locator: {pages: ${JSON.stringify(it.pages)}, bbox: null}`,
      `  legal_status: ${q(src.legal_status ?? "official")}`,
      `  ingest_run: ${q(o.ingestRun ?? "sect-convert overlay")}`,
      "  confidence: 1.0",
      "  verified_by: [sect-convert]",
      "---",
      "",
      `# ${it.id.replace(/^[A-Z][A-Z0-9]*:/, "")} ${it.title}`,
      "",
      it.body,
      "",
    ].join("\n");
    files.push({ path: `${dir}/${it.id.replace(/^[A-Z][A-Z0-9]*:/, "").replace(/[^A-Za-z0-9._-]+/g, "_")}.md`, text: fm });
  }
  files.push({ path: `${dir}/_source.yaml`, text: readFileSync(o.sourceYaml, "utf-8") });
  return { files, items: items.map(({ elements: _e, ...rest }) => rest), skipped };
}

/** The raw document's sha as the extract report recorded it. */
export function extractedSha(work: string): string | null {
  const f = path.join(work, "report.json");
  if (!existsSync(f)) return null;
  return String((JSON.parse(readFileSync(f, "utf-8")) as { doc_sha?: string }).doc_sha ?? "") || null;
}
