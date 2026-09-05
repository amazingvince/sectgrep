// DOCX (mammoth -> HTML), HTML (Readability + DOM), XLSX (SheetJS grids): the C.3 rows for
// formats without page geometry. Elements carry page 1 and no bbox; tables carry their grid.

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import type { Element } from "./types.js";
import { nativeTable } from "./table.js";
import { mapDocxLocators } from "./docx-locators.js";

function domElements(html: string, docSha: string, originalHtml = false): Element[] {
  const dom = new JSDOM(html);
  const body = dom.window.document.body;
  const main = originalHtml ? body.querySelector("main, [role=main]") : null;
  // Prefer the article containing the page heading when there is one. Its XPath remains
  // in the untouched source DOM; sidebars and footer divs inside <main> stay as excluded regions.
  const article = originalHtml ? (main ?? body).querySelector("h1")?.closest("article") : null;
  const content = article ?? main;
  const out: Element[] = [];
  let seq = 0;
  const push = (type: Element["type"], text: string, extra: Partial<Element> = {}) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (!t && !extra.table_grid) return;
    out.push({ doc_sha: docSha, page: 1, seq: seq++, type, text: t, bbox: null, font_size: null, bold: false, flags: [], confidence: 1.0, ...extra });
  };
  const locate = (node: globalThis.Element): string => {
    const names: string[]=[];
    for(let current:globalThis.Element|null=node;current;current=current.parentElement){const siblings=current.parentElement?Array.from(current.parentElement.children).filter(e=>e.tagName===current!.tagName):[current];names.unshift(`${current.tagName.toLowerCase()}[${siblings.indexOf(current)+1}]`);}
    return "/"+names.join("/");
  };
  const walk = (node: globalThis.Element, excluded = false) => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName.toLowerCase();
      if(["script","style","noscript","template"].includes(tag)) continue;
      const chrome=excluded||!!(content&&!content.contains(child)&&!child.contains(content))||["nav","header","footer"].includes(tag)||["navigation","contentinfo","banner"].includes(child.getAttribute("role")??"")||child.getAttribute("aria-hidden")==="true"||child.hasAttribute("hidden");
      const start=out.length;
      if (/^h[1-6]$/.test(tag)) push("heading", child.textContent ?? "", { font_size: 20 - 2 * Number(tag[1]), bold: true, heading_level:Number(tag[1]), native_id:child.id||undefined,flags: [`level:${tag[1]}`] });
      else if (tag === "p") push(/^(\(?[a-z0-9]{1,4}\)|[•\-*]|\d+\.)\s/.test(child.textContent?.trim() ?? "") ? "list_item" : "paragraph", child.textContent ?? "");
      else if (tag === "li") push("list_item", child.textContent ?? "");
      else if (tag === "table") {
        const table=nativeTable(child,`table-${seq}`);
        const tableSeq=seq;
        push("table", table.grid.map((r) => r.join(" | ")).join("\n"), { table_grid: table.grid, cells:table.cells, flags:table.flags });
        const caption=child.querySelector(":scope > caption");
        if(caption)push("caption",caption.textContent??"",{caption_of:tableSeq,...(originalHtml?{locator:{type:"xml" as const,xpath:locate(caption)}}:{})});
      } else if (tag === "figure") {const figureSeq=seq;push("figure",child.getAttribute("aria-label")??child.querySelector("img")?.getAttribute("alt")??"",{flags:["figure"]});const caption=child.querySelector("figcaption");if(caption)push("caption",caption.textContent??"",{caption_of:out.some(e=>e.seq===figureSeq&&e.type==="figure")?figureSeq:undefined});}
      else if (tag === "img") push("figure", child.getAttribute("alt") ?? "");
      else if (tag === "pre") {
        // A preformatted document (govinfo's Federal Register HTML is one <pre>) is paragraphs
        // separated by blank lines; a paragraph's line breaks are spaces.
        for (const para of (child.textContent ?? "").split(/\n[ \t]*\n/)) push("paragraph", para.replace(/[ \t]*\n[ \t]*/g, " ").trim());
      } else if (tag === "blockquote") push("paragraph", child.textContent ?? "");
      else if(!child.children.length)push("other",child.textContent??"");
      else {walk(child,chrome);continue;}
      for(const e of out.slice(start)){if(originalHtml&&!e.locator)e.locator={type:"xml",xpath:locate(child)};if(chrome)e.exclusion="document chrome or hidden content";}
    }
  };
  walk(body);
  return out;
}

export async function docxElements(buffer: Buffer, docSha: string): Promise<Element[]> {
  const { value } = await mammoth.convertToHtml({ buffer });
  return mapDocxLocators(buffer, domElements(value, docSha));
}

export function htmlElements(html: string, docSha: string, url = "https://example.invalid/"): { elements: Element[]; title: string | null } {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document.cloneNode(true) as unknown as Document).parse();
  // Readability supplies the title. Source regions and locators come from the original DOM.
  return { elements: domElements(html, docSha, true), title: article?.title ?? dom.window.document.title ?? null };
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
  return grids.map((g, i) => ({ doc_sha: docSha, page: i + 1, seq: i, type: "table" as const, text: g.rows.map((r) => r.join(" | ")).join("\n"), bbox: null, font_size: null, bold: false, table_grid: g.rows,
    locator:{type:"sheet" as const,sheet:g.sheet,range:XLSX.utils.encode_range({s:{r:0,c:0},e:{r:Math.max(0,g.rows.length-1),c:g.rows.reduce((n,row)=>Math.max(n,row.length-1),0)}})},
    cells:g.rows.flatMap((row,r)=>row.flatMap((text,c)=>{
      const merge = g.merges.find(m => r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1);
      if(merge && (r !== merge.r0 || c !== merge.c0)) return [];
      return [{id:`sheet-${i}-r${r}-c${c}`,row:r,column:c,row_span:merge?merge.r1-merge.r0+1:1,column_span:merge?merge.c1-merge.c0+1:1,text,role:"unknown",headers:[]}];
    })),
    flags: [`sheet:${g.sheet}`, "table_header_associations_unknown", ...(g.merges.length ? ["merged_cells"] : [])], confidence: 1.0 }));
}
