// Attach a native package/paragraph address only when a unique original block has
// the same text. Repeated boilerplate and unsupported conversions stay uncertain.
import JSZip from "jszip";
import { JSDOM } from "jsdom";
import type { Element } from "./types.js";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const W14 = "http://schemas.microsoft.com/office/word/2010/wordml";
const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

function xpath(node: globalThis.Element): string {
  const positions: number[] = [];
  for (let at: globalThis.Element | null = node; at; at = at.parentElement)
    positions.unshift(at.parentElement ? Array.from(at.parentElement.children).indexOf(at) + 1 : 1);
  // Positional element steps avoid relying on the producer's namespace prefixes.
  return positions.map(n => `/*[${n}]`).join("");
}

function paragraphText(node: globalThis.Element): string | undefined {
  // Revision alternatives, fields, math and drawings require their own source maps.
  if (Array.from(node.getElementsByTagName("*")).some(n =>
    n.namespaceURI !== W || ["del", "ins", "instrText", "fldChar", "drawing", "object", "sym"].includes(n.localName))) return;
  return normalize(Array.from(node.getElementsByTagName("*")).map(n =>
    n.localName === "t" ? n.textContent ?? "" : ["tab", "br", "cr"].includes(n.localName) ? " " : "").join(""));
}

export async function mapDocxLocators(buffer: Buffer, elements: Element[]): Promise<Element[]> {
  const zip = await JSZip.loadAsync(buffer);
  type Candidate = { part: string; xpath: string; native_id?: string };
  const candidates = new Map<string, Candidate[]>();
  for (const part of ["word/document.xml", "word/footnotes.xml", "word/endnotes.xml"]) {
    const entry = zip.file(part);
    if (!entry) continue;
    const dom = new JSDOM(await entry.async("string"), { contentType: "application/xml" });
    try {
      const doc = dom.window.document;
      const ids = new Map<string, number>();
      for (const p of Array.from(doc.getElementsByTagNameNS(W, "p"))) {
        const id = p.getAttributeNS(W14, "paraId");
        if (id) ids.set(id, (ids.get(id) ?? 0) + 1);
      }
      const add = (node: globalThis.Element, text: string | undefined, kind: string) => {
        if (!text) return;
        const key = `${kind}:${text}`;
        const paraId = node.getAttributeNS(W14, "paraId");
        const candidate = { part, xpath: xpath(node), ...(paraId && ids.get(paraId) === 1 ? { native_id: `${part}#${paraId}` } : {}) };
        candidates.set(key, [...(candidates.get(key) ?? []), candidate]);
      };
      for (const p of Array.from(doc.getElementsByTagNameNS(W, "p"))) add(p, paragraphText(p), "paragraph");
      for (const table of Array.from(doc.getElementsByTagNameNS(W, "tbl"))) {
        if (table.getElementsByTagNameNS(W, "tbl").length) continue;
        const rows = Array.from(table.children).filter(n => n.namespaceURI === W && n.localName === "tr");
        let supported = true;
        const text = rows.map(row => Array.from(row.children).filter(n => n.namespaceURI === W && n.localName === "tc").map(cell => {
          // Merged cells use a richer table mapping; do not infer their projection here.
          if (cell.getElementsByTagNameNS(W, "gridSpan").length || cell.getElementsByTagNameNS(W, "vMerge").length) supported = false;
          return Array.from(cell.getElementsByTagNameNS(W, "p")).map(p => {
            const value = paragraphText(p);
            if (value === undefined) supported = false;
            return value ?? "";
          }).join("");
        }).join(" | ")).join("\n");
        if (supported) add(table, normalize(text), "table");
      }
    } finally { dom.window.close(); }
  }
  const uses = new Map<string, number>();
  const key = (e: Element) => `${e.type === "table" ? "table" : "paragraph"}:${normalize(e.text)}`;
  for (const e of elements) uses.set(key(e), (uses.get(key(e)) ?? 0) + 1);
  return elements.map(e => {
    const matches = ["heading", "paragraph", "list_item", "table", "caption"].includes(e.type) ? candidates.get(key(e)) ?? [] : [];
    if (matches.length !== 1 || uses.get(key(e)) !== 1)
      return { ...e, flags: [...e.flags, "native_office_locator_unavailable", "locator_is_conversion_sequence", matches.length > 1 ? "native_office_match_ambiguous" : "native_office_match_unresolved"] };
    const match = matches[0];
    return { ...e, locator: { type: "office", part: match.part, xpath: match.xpath },
      ...(match.native_id ? { native_id: match.native_id } : {}),
      flags: [...e.flags, "native_office_unique_text_match", "source_xml_whitespace_normalized"] };
  });
}
