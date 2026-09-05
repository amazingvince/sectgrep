import { nativeTable } from "./table.js";
import JSZip from "jszip";
import { parseXml } from "../xml.js";
import type { Element as Extracted } from "./types.js";

const base = (sha: string, seq: number, text: string, extra: Partial<Extracted> = {}): Extracted => ({ doc_sha: sha, page: 1, seq, type: "paragraph", text, bbox: null, font_size: null, bold: false, flags: [], confidence: 1, ...extra });

export function textElements(text: string, sha: string): Extracted[] {
  const out: Extracted[] = [];
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let start = 0;
  for (let i = 0; i <= lines.length; i++) {
    if (i < lines.length && lines[i].trim()) continue;
    if (i > start) {
      const text = lines.slice(start, i).join("\n");
      const heading = /^#{1,6}\s+([^\n]+)$/.exec(text);
      out.push(base(sha, out.length, text, { type: heading ? "heading" : "paragraph", locator: { type: "text", line_start: start + 1, line_end: i } }));
    }
    start = i + 1;
  }
  return out;
}

export function jsonElements(text: string, sha: string): Extracted[] {
  // JSON numbers may exceed binary64 precision/range. Preserve the parser's original
  // token, including exponent spelling and negative zero, before walking records.
  class SourceNumber {
    constructor(readonly text: string) {}
  }
  const parsed: unknown = JSON.parse(text, (_key, value, context?: { source?: string }) => {
    if (typeof value !== "number") return value;
    if (!context?.source) throw new Error("JSON numeric source context is unavailable; use the supported Node.js runtime");
    return new SourceNumber(context.source);
  });
  const out: Extracted[] = [];
  const walk = (value: unknown, pointer: string, record = "") => {
    if (value && typeof value === "object" && !(value instanceof SourceNumber)) {
      const entries = Object.entries(value);
      if (!entries.length) out.push(base(sha, out.length, `${pointer || "/"}: ${JSON.stringify(value)}`, { locator: { type: "record", pointer }, flags: [`record_scope:${record}`] }));
      for (const [key, child] of entries) {
        const childPointer = `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
        walk(child, childPointer, Array.isArray(value) ? childPointer : record);
      }
    } else out.push(base(sha, out.length, `${pointer || "/"}: ${value instanceof SourceNumber ? value.text : JSON.stringify(value)}`, { locator: { type: "record", pointer }, flags: [`record_scope:${record}`, ...(value instanceof SourceNumber ? ["json_numeric_source_preserved"] : [])] }));
  };
  walk(parsed, "");
  return out;
}

export function xmlElements(text: string, sha: string): Extracted[] {
  const dom = parseXml(text);
  const out: Extracted[] = [];
  const nodes = new Map<globalThis.Element,Extracted>();
  const walk = (el: globalThis.Element, xpath: string) => {
    const tag = el.localName ?? el.tagName;
    const children = Array.from(el.childNodes).filter((n) => n.nodeType === 1) as globalThis.Element[];
    if (["title", "article-title", "p", "ref", "caption", "fn", "table", "HEAD", "P", "GPOTABLE"].includes(tag) || !children.length) {
      const t = el.textContent?.trim() ?? "";
      if (!t) return;
      const table = tag === "table" || tag === "GPOTABLE";
      const rows = table ? Array.from(el.getElementsByTagName(tag === "GPOTABLE" ? "ROW" : "tr")).map((r) => Array.from(r.childNodes).filter((c) => c.nodeType === 1).map((c) => c.textContent?.trim() ?? "")) : undefined;
      const heading=/title|HEAD/.test(tag);
      let level=1;
      for(let p=el.parentNode;p&&p.nodeType===1;p=p.parentNode)if(["sec","DIV1","DIV2","DIV3","DIV4","DIV5","DIV6","DIV7","DIV8"].includes((p as globalThis.Element).tagName))level++;
      const nativeId=el.getAttribute("id")||(heading?(el.parentNode as globalThis.Element)?.getAttribute?.("id"):null)||undefined;
      const extracted=base(sha, out.length, rows?.length ? rows.map((r) => r.join(" | ")).join("\n") : t, { type: table ? "table" : heading ? "heading" : tag==="caption"?"caption":"paragraph",native_id:nativeId,...(heading?{heading_level:level}:{}), ...(rows?.length ? { table_grid: rows } : {}), locator: { type: "xml", xpath } });
      if(table && tag!=="GPOTABLE") {
        const parsed=nativeTable(el,`table-${extracted.seq}`);
        extracted.cells=parsed.cells;extracted.table_grid=parsed.grid;
        extracted.text=parsed.grid.map(row=>row.join(" | ")).join("\n");
        extracted.flags.push(...parsed.flags);
      }
      out.push(extracted);nodes.set(el,extracted);
      return;
    }
    const counts = new Map<string, number>();
    for (const child of children) {
      const n = (counts.get(child.tagName) ?? 0) + 1;
      counts.set(child.tagName, n);
      walk(child, `${xpath}/${child.tagName}[${n}]`);
    }
  };
  if (dom.documentElement) walk(dom.documentElement as unknown as globalThis.Element, `/${dom.documentElement.tagName}[1]`);
  for(const [el,region]of nodes){
    for(let p=el.parentNode;p&&p.nodeType===1;p=p.parentNode){const ancestor=p as globalThis.Element;const title=Array.from(ancestor.childNodes).find(n=>n.nodeType===1&&["title","HEAD"].includes((n as globalThis.Element).tagName)) as globalThis.Element|undefined;const parent=title?nodes.get(title):undefined;if(parent&&parent.seq!==region.seq){region.parent_seq=parent.seq;break;}}
    if(region.type==="caption"){for(let p=el.parentNode;p&&p.nodeType===1;p=p.parentNode){const ancestor=p as globalThis.Element;if(["table-wrap","fig"].includes(ancestor.tagName)){const target=Array.from(ancestor.getElementsByTagName("table")).map(n=>nodes.get(n)).find(Boolean);if(target)region.caption_of=target.seq;break;}}}
  }
  const ids=new Map([...nodes].filter(([el])=>el.getAttribute("id")).map(([el,r])=>[el.getAttribute("id"),r]));
  for(const xref of Array.from(dom.getElementsByTagName("xref"))){if(xref.getAttribute("ref-type")!=="fn")continue;const note=ids.get(xref.getAttribute("rid"));if(!note)continue;for(let p=xref.parentNode;p&&p.nodeType===1;p=p.parentNode){const owner=nodes.get(p as globalThis.Element);if(owner){note.footnote_of=[...new Set([...(note.footnote_of??[]),owner.seq])];break;}}}
  return out;
}

export async function pptxElements(data: Buffer, sha: string): Promise<Extracted[]> {
  const zip = await JSZip.loadAsync(data);
  const rels = parseXml(await zip.file("ppt/_rels/presentation.xml.rels")!.async("string"));
  const paths = new Map(Array.from(rels.getElementsByTagName("Relationship")).map((r) => [r.getAttribute("Id"), r.getAttribute("Target") ?? ""]));
  const presentation = parseXml(await zip.file("ppt/presentation.xml")!.async("string"));
  const out: Extracted[] = [];
  let page = 0;
  for (const id of Array.from(presentation.getElementsByTagName("p:sldId"))) {
    page++;
    const target = paths.get(id.getAttribute("r:id"));
    const file = target?.startsWith("/") ? target.slice(1) : `ppt/${target}`;
    const entry = zip.file(file);
    if (!entry) throw new Error(`missing presentation slide ${file}`);
    const dom = parseXml(await entry.async("string"));
    for (const shape of Array.from(dom.getElementsByTagName("p:sp"))) {
      const paragraphs = Array.from(shape.getElementsByTagName("a:p")).map((p) => Array.from(p.getElementsByTagName("a:t")).map((t) => t.textContent ?? "").join("")).filter(Boolean);
      if (!paragraphs.length) continue;
      const sid = shape.getElementsByTagName("p:cNvPr")[0]?.getAttribute("id") ?? null;
      const title = Array.from(shape.getElementsByTagName("p:ph")).some((p) => ["title", "ctrTitle"].includes(p.getAttribute("type") ?? ""));
      out.push(base(sha, out.length, paragraphs.join("\n"), { page, type: title ? "heading" : "paragraph", locator: { type: "slide", slide: page, shape: sid } }));
    }
    for (const table of Array.from(dom.getElementsByTagName("a:tbl"))) {
      const rows = Array.from(table.getElementsByTagName("a:tr")).map((r) => Array.from(r.getElementsByTagName("a:tc")).map((c) => Array.from(c.getElementsByTagName("a:t")).map((t) => t.textContent ?? "").join(" ")));
      out.push(base(sha, out.length, rows.map((r) => r.join(" | ")).join("\n"), { page, type: "table", table_grid: rows, locator: { type: "slide", slide: page, shape: null } }));
    }
  }
  return out;
}
