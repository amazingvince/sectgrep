// Born-digital PDF: the pdf.js text layer, grouped into lines, blocks, and columns with a
// deterministic reading order; font size and boldness from the text items; page geometry for
// bboxes. A page with no usable text layer is reported as scanned and left to the OCR path.

import type { Element, PageInfo } from "./types.js";

interface Item {
  str: string;
  x: number;
  y: number; // top-left origin
  w: number;
  h: number;
  size: number;
  bold: boolean;
}

interface Line {
  items: Item[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  size: number;
  bold: boolean;
  text: string;
  /** Set when the page was split at a gutter: 0 above the columns, 1 left, 2 right, 3 below. */
  column?: number;
}

export interface PdfPage {
  page: number;
  width: number;
  height: number;
  lines: Line[];
  chars: number;
}

export async function readPdfPages(data: Uint8Array): Promise<PdfPage[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const pages: PdfPage[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    // Font objects (and their names, "NewCenturySchlbk-Bold") are loaded by the operator list.
    await page.getOperatorList();
    const content = await page.getTextContent();
    const fontName = (key: string): string => {
      try {
        return page.commonObjs.has(key) ? ((page.commonObjs.get(key) as { name?: string })?.name ?? "") : "";
      } catch {
        return "";
      }
    };
    const items: Item[] = [];
    for (const it of content.items as Array<{ str: string; transform: number[]; width: number; height: number; fontName: string }>) {
      if (!("str" in it) || !it.str) continue;
      const [a, b, , d, e, f] = it.transform;
      const size = Math.round(Math.hypot(a, b) * 10) / 10 || Math.abs(d);
      const h = it.height || size;
      // Some producers emit every word space as its own zero-height item; it is the space
      // between words, so it is kept as one, not dropped and not re-guessed from the gap.
      if (!it.str.trim()) {
        if (/\s/.test(it.str) && it.width > 0) items.push({ str: " ", x: e, y: vp.height - f - h, w: it.width, h, size, bold: false });
        continue;
      }
      const style = (content.styles as Record<string, { fontFamily?: string }>)[it.fontName];
      const bold = /bold|black|heavy|semibold|demi/i.test(fontName(it.fontName) + " " + (style?.fontFamily ?? ""));
      items.push({ str: it.str, x: e, y: vp.height - f - h, w: it.width, h, size, bold });
    }
    const lines = groupLinesByColumn(items, vp.width);
    pages.push({ page: p, width: vp.width, height: vp.height, lines, chars: items.reduce((n, i) => n + i.str.length, 0) });
  }
  return pages;
}

function groupLines(items: Item[]): Line[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Line[] = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(it.y - last.y0) < Math.max(2, last.size * 0.45)) {
      last.items.push(it);
    } else {
      lines.push({ items: [it], x0: it.x, y0: it.y, x1: it.x + it.w, y1: it.y + it.h, size: it.size, bold: it.bold, text: "" });
    }
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    l.x0 = Math.min(...l.items.map((i) => i.x));
    l.x1 = Math.max(...l.items.map((i) => i.x + i.w));
    l.y0 = Math.min(...l.items.map((i) => i.y));
    l.y1 = Math.max(...l.items.map((i) => i.y + i.h));
    l.size = median(l.items.map((i) => i.size));
    l.bold = l.items.filter((i) => i.bold).length * 2 >= l.items.length;
    let text = "";
    let cursor = -Infinity;
    for (const i of l.items) {
      const gap = i.x - cursor;
      // A word gap in tight justified text is about a fifth of the size; kerned fragments sit under a tenth.
      if (text && gap > l.size * 0.15 && !text.endsWith(" ") && !i.str.startsWith(" ")) text += " ";
      text += i.str;
      cursor = i.x + i.w;
    }
    // GPO text layers map the section sign and dashes to U+FFFD; the context says which it was.
    l.text = text.replace(/\s+/g, " ").trim().replace(/\uFFFD(?=\s?\d{1,4}\.\d)/g, "\u00a7").replace(/(?<=\d)\uFFFD(?=\d)/g, "\u2013").replace(/\uFFFD/g, "\u2014");
  }
  return lines;
}

/**
 * Two text columns show as a vertical gutter that no body item crosses. Items are split at it
 * before lines are built, otherwise a line would splice the left column onto the right one.
 * Items that span the gutter (running heads, wide tables) keep the page order around the columns.
 */
function groupLinesByColumn(items: Item[], width: number): Line[] {
  const body = items.filter((i) => i.w < width * 0.6);
  if (body.length < 20) return groupLines(items);
  let best: { x: number; span: number } | null = null;
  let runStart = -1;
  const lo = Math.round(width * 0.35);
  const hi = Math.round(width * 0.65);
  const consider = (start: number, end: number) => {
    const span = end - start;
    if (span >= 6 && (!best || span > best.span)) best = { x: start + span / 2, span };
  };
  // A running head set across both columns crosses the gutter; up to 2% of body items may.
  const tolerance = Math.max(1, Math.floor(body.length * 0.02));
  for (let x = lo; x <= hi; x++) {
    const crossed = body.filter((i) => i.x < x - 1 && i.x + i.w > x + 1).length > tolerance;
    if (!crossed) {
      if (runStart < 0) runStart = x;
    } else if (runStart >= 0) {
      consider(runStart, x);
      runStart = -1;
    }
  }
  if (runStart >= 0) consider(runStart, hi);
  if (!best) return groupLines(items);
  const gutter = (best as { x: number }).x;
  const left = new Set(items.filter((i) => i.x + i.w <= gutter + 1));
  const right = new Set(items.filter((i) => !left.has(i) && i.x >= gutter - 1));
  const full = items.filter((i) => !left.has(i) && !right.has(i));
  if (left.size < body.length * 0.2 || right.size < body.length * 0.2) return groupLines(items);
  const l = groupLines([...left]).map((x) => ({ ...x, column: 1 }));
  const r = groupLines([...right]).map((x) => ({ ...x, column: 2 }));
  const colTop = Math.min(...[...l, ...r].map((x) => x.y0));
  const colBottom = Math.max(...[...l, ...r].map((x) => x.y1));
  const f = groupLines(full).map((x) => ({ ...x, column: x.y1 <= colTop + 1 ? 0 : x.y0 >= colBottom - 1 ? 3 : 1 }));
  return [...f, ...l, ...r];
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/** Column assignment: cluster line left edges; two clusters far apart on a wide page mean columns. */
function columnsOf(lines: Line[], width: number): number[] {
  const starts = lines.map((l) => l.x0);
  const cols: number[] = [];
  const centers: number[] = [];
  for (const x of starts) {
    let k = centers.findIndex((c) => Math.abs(c - x) < width * 0.12);
    if (k < 0) {
      centers.push(x);
      k = centers.length - 1;
    }
    cols.push(k);
  }
  // Keep only clusters that carry a real share of lines; merge the rest into the nearest.
  const counts = centers.map((_, k) => cols.filter((c) => c === k).length);
  const keep = centers.map((_, k) => counts[k] >= Math.max(3, lines.length * 0.15));
  const kept = centers.map((c, k) => (keep[k] ? c : null)).filter((c): c is number => c !== null).sort((a, b) => a - b);
  if (kept.length < 2) return lines.map(() => 0);
  return lines.map((l) => {
    let best = 0;
    for (let k = 1; k < kept.length; k++) if (Math.abs(kept[k] - l.x0) < Math.abs(kept[best] - l.x0)) best = k;
    return best;
  });
}

/** Lines of one page in reading order (column by column, top to bottom), grouped into blocks. */
export function pageBlocks(page: PdfPage): Array<{ lines: Line[]; column: number }> {
  const cols = page.lines.some((l) => l.column !== undefined) ? page.lines.map((l) => l.column ?? 0) : columnsOf(page.lines, page.width);
  const order = page.lines.map((l, i) => ({ l, c: cols[i] })).sort((a, b) => a.c - b.c || a.l.y0 - b.l.y0);
  const blocks: Array<{ lines: Line[]; column: number }> = [];
  for (const { l, c } of order) {
    const last = blocks[blocks.length - 1];
    const prev = last?.lines[last.lines.length - 1];
    const gap = prev ? l.y0 - prev.y1 : Infinity;
    const newPara = !last || last.column !== c || gap > l.size * 0.9 || (Math.abs(l.size - prev!.size) > 1.5 && gap > 2) || /^\(?[a-z0-9]{1,4}\)\s/.test(l.text) || prev!.bold !== l.bold;
    if (newPara) blocks.push({ lines: [l], column: c });
    else last.lines.push(l);
  }
  return blocks;
}

export function pdfElements(pages: PdfPage[], docSha: string): { elements: Element[]; info: PageInfo[]; scanned: number[] } {
  const elements: Element[] = [];
  const info: PageInfo[] = [];
  const scanned: number[] = [];
  const bodySize = median(pages.flatMap((p) => p.lines.map((l) => l.size)).filter((s) => s > 0)) || 10;
  let seq = 0;
  for (const p of pages) {
    info.push({ page: p.page, width: p.width, height: p.height, chars: p.chars });
    if (p.chars < 40) {
      scanned.push(p.page);
      continue;
    }
    for (const b of pageBlocks(p)) {
      const text = b.lines.map((l) => l.text).join("\n");
      const size = median(b.lines.map((l) => l.size));
      const bold = b.lines.every((l) => l.bold);
      const x0 = Math.min(...b.lines.map((l) => l.x0));
      const y0 = Math.min(...b.lines.map((l) => l.y0));
      const x1 = Math.max(...b.lines.map((l) => l.x1));
      const y1 = Math.max(...b.lines.map((l) => l.y1));
      let type: Element["type"] = "paragraph";
      if (y0 < p.height * 0.06 && b.lines.length <= 2) type = "header";
      else if (y1 > p.height * 0.94 && b.lines.length <= 2) type = "footer";
      else if ((size >= bodySize * 1.15 || bold) && b.lines.length <= 3 && text.length < 200) type = "heading";
      else if (/^(\(?[a-z0-9]{1,4}\)|[•\-*]|\d+\.)\s/.test(text)) type = "list_item";
      elements.push({ doc_sha: docSha, page: p.page, seq: seq++, type, text, bbox: [r(x0), r(y0), r(x1), r(y1)], font_size: size, bold, flags: [], confidence: 1.0 });
    }
  }
  return { elements, info, scanned };
}

const r = (x: number) => Math.round(x * 10) / 10;
