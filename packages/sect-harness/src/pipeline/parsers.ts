import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hash } from "./io.js";
import type { Locator } from "@sectgrep/convert/knowledge";

interface DoclingItem {
  self_ref: string;
  label: string;
  text?: string;
  orig?: string;
  level?: number;
  parent?: { $ref: string };
  children?: { $ref: string }[];
  prov?: {
    page_no: number;
    bbox: { l: number; t: number; r: number; b: number; coord_origin: string };
  }[];
  captions?: { $ref: string }[];
  footnotes?: { $ref: string }[];
  data?: {
    table_cells: {
      text: string;
      start_row_offset_idx: number;
      end_row_offset_idx: number;
      start_col_offset_idx: number;
      end_col_offset_idx: number;
      column_header: boolean;
      row_header: boolean;
    }[];
  };
}
/** Docling self_ref is a parser-local address, never a stable native source identifier. */
export function readDoclingArtifact(file: string, input: string, out: string) {
  const artifact = JSON.parse(readFileSync(file, "utf8")) as {
    sect_adapter: {
      version: string;
      raw_sha256: string;
      coverage: string;
      conversion_status: string;
      input_pages: number;
      converted_pages: number[];
      packages: Record<string, string>;
    };
    document: {
      body: DoclingItem;
      furniture?: DoclingItem;
      texts: DoclingItem[];
      tables: DoclingItem[];
      pictures: DoclingItem[];
      groups: DoclingItem[];
      pages: Record<string, { size: { width: number; height: number } }>;
    };
  };
  if (
    artifact.sect_adapter?.version !== "2" ||
    artifact.sect_adapter.raw_sha256 !== hash(readFileSync(input)) ||
    artifact.sect_adapter.packages.docling !== "2.126.0"
  )
    throw new Error("Docling adapter version/raw hash/package pin mismatch");
  const capture = artifact.sect_adapter;
  if (
    capture.coverage !== "complete" ||
    capture.conversion_status !== "success" ||
    !Number.isInteger(capture.input_pages) ||
    capture.input_pages < 1 ||
    !Array.isArray(capture.converted_pages) ||
    capture.converted_pages.length !== capture.input_pages ||
    capture.converted_pages.some((p, i) => p !== i + 1) ||
    Object.keys(artifact.document.pages).length !== capture.input_pages ||
    capture.converted_pages.some((p) => !artifact.document.pages[String(p)])
  )
    throw new Error(
      "partial Docling comparisons cannot replace a complete parser artifact",
    );
  const doc = artifact.document;
  const lookup = new Map(
    [
      doc.body,
      doc.furniture,
      ...doc.texts,
      ...doc.tables,
      ...doc.pictures,
      ...doc.groups,
    ]
      .filter((x): x is DoclingItem => !!x)
      .map((x) => [x.self_ref, x]),
  );
  const ordered: DoclingItem[] = [];
  const seen = new Set<string>();
  const walk = (item: DoclingItem) => {
    if (seen.has(item.self_ref)) return;
    seen.add(item.self_ref);
    if (
      item.text !== undefined ||
      item.orig !== undefined ||
      item.data ||
      item.label === "picture"
    )
      ordered.push(item);
    for (const ref of item.children ?? []) {
      const child = lookup.get(ref.$ref);
      if (!child) throw new Error("Docling child missing");
      walk(child);
    }
  };
  walk(doc.body);
  if (doc.furniture) walk(doc.furniture);
  // Preserve unlinked items too, with explicit uncertain reading order.
  const unlinked = new Set<string>();
  for (const item of lookup.values())
    if (!seen.has(item.self_ref)) {
      unlinked.add(item.self_ref);
      walk(item);
    }
  const seq = new Map(ordered.map((x, i) => [x.self_ref, i]));
  const elements = ordered.map((item, i) => {
    const prov = item.prov?.[0];
    const page = prov?.page_no ?? 1;
    const locations = (item.prov ?? []).map(p => {
      const size = doc.pages[String(p.page_no)]?.size;
      const b = p.bbox;
      if (!Number.isInteger(p.page_no) || !size || ![size.width, size.height].every(n => Number.isFinite(n) && n > 0) ||
          !b || !["BOTTOMLEFT", "TOPLEFT"].includes(b.coord_origin) || ![b.l, b.t, b.r, b.b].every(Number.isFinite))
        throw new Error("invalid Docling source location");
      const bbox: [number, number, number, number] = b.coord_origin === "BOTTOMLEFT"
        ? [b.l, size.height - b.t, b.r, size.height - b.b] : [b.l, b.t, b.r, b.b];
      if (bbox[0] > bbox[2] || bbox[1] > bbox[3]) throw new Error("invalid Docling source box");
      return { page: p.page_no, elements: [i], bbox };
    });
    const bbox = locations[0]?.bbox ?? null;
    const locator: Locator = locations.length > 1 ? { type: "pages", locations }
      : { type: "page", page, elements: [i], bbox };
    const cells = (item.data?.table_cells ?? []).map((c, n) => ({
      id: `${item.self_ref}:c${n}`,
      row: c.start_row_offset_idx,
      column: c.start_col_offset_idx,
      row_span: c.end_row_offset_idx - c.start_row_offset_idx,
      column_span: c.end_col_offset_idx - c.start_col_offset_idx,
      text: c.text,
      role: c.column_header
        ? "column_header"
        : c.row_header
          ? "row_header"
          : "data",
      headers: [] as string[],
    }));
    for (const cell of cells)
      if (cell.role === "data")
        cell.headers = cells
          .filter(
            (h) =>
              (h.role === "column_header" &&
                h.column <= cell.column &&
                h.column + h.column_span > cell.column &&
                h.row < cell.row) ||
              (h.role === "row_header" &&
                h.row <= cell.row &&
                h.row + h.row_span > cell.row &&
                h.column < cell.column),
          )
          .map((h) => h.id);
    const grid: string[][] = [];
    for (const c of cells) {
      grid[c.row] ??= [];
      grid[c.row][c.column] = c.text;
    }
    const type =
      item.label === "section_header" || item.label === "title"
        ? "heading"
        : item.label === "table"
          ? "table"
          : item.label === "formula"
            ? "equation"
            : item.label === "picture"
              ? "figure"
              : item.label === "caption"
                ? "caption"
                : item.label === "list_item"
                  ? "list_item"
                  : "paragraph";
    const parent = seq.get(item.parent?.$ref ?? "");
    return {
      doc_sha: artifact.sect_adapter.raw_sha256,
      page,
      seq: i,
      type,
      text: item.text?.trim()
        ? item.text
        : (item.orig ?? cells.map((c) => c.text).join(" | ")),
      bbox,
      font_size: null,
      bold: false,
      confidence: 1,
      flags: [
        ...(prov ? [] : ["native_locator_unavailable"]),
        ...(locations.length > 1 ? ["quote_spans_multiple_source_boxes", "per_box_text_alignment_unverified"] : []),
        ...(unlinked.has(item.self_ref) ? ["reading_order_unlinked"] : []),
        ...(cells.length ? ["header_associations_from_parser_roles"] : []),
        ...(item.label === "formula" ? ["mathematical_layout_unverified"] : []),
        ...(!item.text?.trim() && item.orig
          ? ["parser_original_text_fallback"]
          : []),
      ],
      heading_level: item.level,
      parent_seq: parent,
      locator,
      cells,
      ...(grid.length
        ? { table_grid: grid.map((r) => Array.from(r, (v) => v ?? "")) }
        : {}),
    };
  });
  for (const item of ordered) {
    const owner = seq.get(item.self_ref)!;
    for (const c of item.captions ?? []) {
      const idx = seq.get(c.$ref);
      if (idx !== undefined)
        Object.assign(elements[idx], { caption_of: owner });
    }
    for (const f of item.footnotes ?? []) {
      const idx = seq.get(f.$ref);
      if (idx !== undefined)
        Object.assign(elements[idx], { footnote_of: [owner] });
    }
  }
  const report = {
    input,
    doc_sha: artifact.sect_adapter.raw_sha256,
    format:
      path.extname(input) === ".pdf" ? ("pdf" as const) : ("html" as const),
    recipe_sha256: hash(readFileSync(file)),
    pages: Object.entries(doc.pages).map(([n, p]) => ({
      page: Number(n),
      width: p.size.width,
      height: p.size.height,
      chars: elements
        .filter((e) => e.page === Number(n))
        .reduce((s, e) => s + e.text.length, 0),
    })),
    elements: elements.length,
    tables: doc.tables.length,
    scanned_pages: [] as number[],
    elapsed_ms: 0,
    notes: [
      `Docling ${artifact.sect_adapter.packages.docling}; provenance and artifacts retained`,
    ],
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(
    path.join(out, "elements.jsonl"),
    elements.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(path.join(out, "docling.json"), readFileSync(file));
  return { report, dir: out };
}
