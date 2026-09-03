/**
 * Small DOM helpers over @xmldom/xmldom for the GPO eCFR bulk XML (mixed content everywhere).
 */
import { DOMParser } from "@xmldom/xmldom";

export type Elem = Element;

export function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, "text/xml") as unknown as Document;
}

export function children(el: Node): Elem[] {
  const out: Elem[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) out.push(n as Elem);
  }
  return out;
}

export function child(el: Node, tag: string): Elem | undefined {
  return children(el).find((c) => c.tagName === tag);
}

export function attr(el: Elem, name: string): string {
  return el.getAttribute(name) ?? "";
}

/** Collapse whitespace the way the eCFR XML needs (newlines inside elements are layout, not content). */
export function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Plain text of an element (inline markup dropped). */
export function textOf(el: Node | undefined): string {
  if (!el) return "";
  let s = "";
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3) s += n.nodeValue ?? "";
    else if (n.nodeType === 1) s += textOf(n);
  }
  return squash(s);
}

/**
 * Inline markdown of an element: <I> and <E T="03"> italic, <E T="04"> bold (small caps in print),
 * <SU> superscript kept as plain text, <FTREF> footnote references as [n].
 */
export function inlineMd(el: Node): string {
  let s = "";
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3) {
      s += (n.nodeValue ?? "").replace(/\s+/g, " ");
    } else if (n.nodeType === 1) {
      const e = n as Elem;
      const inner = inlineMd(e);
      switch (e.tagName) {
        case "I":
          s += inner.trim() ? `*${inner.trim()}*` : "";
          break;
        case "E": {
          const t = attr(e, "T");
          const body = inner.trim();
          if (!body) break;
          s += t === "04" ? `**${body}**` : t === "51" || t === "52" ? body : `*${body}*`;
          break;
        }
        case "SU":
          s += inner.trim();
          break;
        case "FTREF":
          s += `[${inner.trim()}]`;
          break;
        default:
          s += inner;
      }
    }
  }
  return s;
}
