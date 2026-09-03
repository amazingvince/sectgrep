// DOCX (mammoth -> HTML), HTML (Readability + DOM), XLSX (SheetJS grids): the C.3 rows for
// formats without page geometry. Elements carry page 1 and no bbox; tables carry their grid.

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import type { Element } from "./types.js";

function domElements(html: string, docSha: string): Element[] {
  const dom = new JSDOM(html);
  const body = dom.window.document.body;
  const out: Element[] = [];
  let seq = 0;
  const push = (type: Element["type"], text: string, extra: Partial<Element> = {}) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (!t && !extra.table_grid) return;
    out.push({ doc_sha: docSha, page: 1, seq: seq++, type, text: t, bbox: null, font_size: null, bold: false, flags: [], confidence: 1.0, ...extra });
  };
  const walk = (node: globalThis.Element) => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) push("heading", child.textContent ?? "", { font_size: 20 - 2 * Number(tag[1]), bold: true, flags: [`level:${tag[1]}`] });
      else if (tag === "p") push(/^(\(?[a-z0-9]{1,4}\)|[•\-*]|\d+\.)\s/.test(child.textContent?.trim() ?? "") ? "list_item" : "paragraph", child.textContent ?? "");
      else if (tag === "li") push("list_item", child.textContent ?? "");
      else if (tag === "table") {
        const grid = Array.from(child.querySelectorAll("tr")).map((tr) => Array.from(tr.querySelectorAll("td,th")).map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim()));
        push("table", grid.map((r) => r.join(" | ")).join("\n"), { table_grid: grid });
      } else if (tag === "figure" || tag === "img") push("figure", child.getAttribute("alt") ?? child.textContent ?? "");
      else if (tag === "pre") {
        // A preformatted document (govinfo's Federal Register HTML is one <pre>) is paragraphs
        // separated by blank lines; a paragraph's line breaks are spaces.
        for (const para of (child.textContent ?? "").split(/\n[ \t]*\n/)) push("paragraph", para.replace(/[ \t]*\n[ \t]*/g, " ").trim());
      } else if (tag === "blockquote") push("paragraph", child.textContent ?? "");
      else walk(child);
    }
  };
  walk(body);
  return out;
}

export async function docxElements(buffer: Buffer, docSha: string): Promise<Element[]> {
  const { value } = await mammoth.convertToHtml({ buffer });
  return domElements(value, docSha);
}

export function htmlElements(html: string, docSha: string, url = "https://example.invalid/"): { elements: Element[]; title: string | null } {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document.cloneNode(true) as unknown as Document).parse();
  // Readability keeps the article's body and drops chrome; headings come from the same DOM.
  const content = article?.content ?? html;
  return { elements: domElements(content, docSha), title: article?.title ?? dom.window.document.title ?? null };
}

export interface Grid {
  sheet: string;
  rows: string[][];
  merges: Array<{ r0: number; c0: number; r1: number; c1: number }>;
  footnotes: Array<{ r: number; c: number; text: string }>;
}

export function xlsxGrids(buffer: Buffer): Grid[] {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const grids: Grid[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const rows: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" }) as string[][];
    const merges = (ws["!merges"] ?? []).map((m) => ({ r0: m.s.r, c0: m.s.c, r1: m.e.r, c1: m.e.c }));
    const footnotes: Grid["footnotes"] = [];
    rows.forEach((row, r) => row.forEach((cell, c) => {
      if (/^(\*+|\d\)|[a-z]\)|note:?)\s*\S/i.test(String(cell)) && String(cell).length > 12) footnotes.push({ r, c, text: String(cell) });
    }));
    grids.push({ sheet: name, rows: rows.map((r) => r.map((c) => String(c ?? ""))), merges, footnotes });
  }
  return grids;
}

export function xlsxElements(grids: Grid[], docSha: string): Element[] {
  return grids.map((g, i) => ({ doc_sha: docSha, page: i + 1, seq: i, type: "table" as const, text: g.rows.map((r) => r.join(" | ")).join("\n"), bbox: null, font_size: null, bold: false, table_grid: g.rows, flags: [`sheet:${g.sheet}`, ...(g.merges.length ? ["merged_cells"] : [])], confidence: 1.0 }));
}
