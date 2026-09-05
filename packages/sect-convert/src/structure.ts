import type { Element, ExtractReport } from "./elements/types.js";

const compact = (s: string) => s.replace(/\s+/g, " ").trim();
const outlineLabel =
  /^(?:[IVXLCDM]+\.|[A-Z]\.|\d+\.|[a-z]+\.|\([A-Za-z0-9]+\))\s/;

/** Recover layout metadata without changing source text, locators, or sequence identities.
 * Native levels always win. Heuristic structure is explicitly marked for inspection.
 */
export function recoverStructure(
  elements: Element[],
  report: ExtractReport,
): Element[] {
  const out = elements.map((e) => ({ ...e, flags: [...e.flags] }));
  if (report.format !== "pdf") return out;
  const pages = new Map(report.pages.map((p) => [p.page, p]));
  const margins = new Map<string, Set<number>>();
  const marginKey = (e: Element) => {
    const page = pages.get(e.page);
    if (
      !page ||
      !e.bbox ||
      !(e.bbox[1] < page.height * 0.12 || e.bbox[3] > page.height * 0.9)
    )
      return null;
    return `${e.bbox[1] < page.height * 0.12 ? "top" : "bottom"}:${compact(e.text).replace(/\b\d+\b/g, "#")}`;
  };
  for (const e of out) {
    if (e.heading_level) e.type = "heading";
    const key = marginKey(e);
    if (key) {
      const occurrences = margins.get(key) ?? new Set<number>();
      occurrences.add(e.page);
      margins.set(key, occurrences);
    }
  }
  for (const e of out) {
    const key = marginKey(e);
    if (key && (margins.get(key)?.size ?? 0) >= 3 && !e.heading_level) {
      e.exclusion ??= "repeated page furniture";
      e.flags.push("role:page_furniture", "exclusion:repeated_margin_position");
    }
    // A page number alone contributes no content; retain its source region.
    if (
      (e.type === "header" || e.type === "footer") &&
      /^\d+$/.test(e.text.trim())
    )
      e.exclusion ??= "page number";
    if (/\.{4,}\s*\d+\s*$/.test(e.text)) {
      e.exclusion ??= "table of contents entry";
      e.flags.push("role:navigation");
    }
  }
  const candidates = out.filter((e) => !e.exclusion && e.type === "heading");
  // A numbered legal/manual outline has multiple families. Scientific decimal numbering
  // is handled separately, so "1 Introduction" does not become a level-three section.
  const manual =
    candidates.some((e) => /^[IVX]+\.\s/.test(e.text)) &&
    candidates.some((e) => /^\([A-Z]\)\s/.test(e.text));
  const families: Array<[RegExp, number]> = [
    [/^[IVX]+\.\s/, 1],
    [/^[A-Z]\.\s/, 2],
    [/^\d+\.\s/, 3],
    [/^[ivx]+\.\s/, 5],
    [/^[a-z]\.\s/, 4],
    [/^\([A-Z]\)\s/, 6],
    [/^\(\d+\)\s/, 7],
    [/^\([ivx]+\)\s/, 9],
    [/^\([a-z]\)\s/, 8],
  ];
  const sizes = [
    ...new Set(
      candidates
        .filter((e) => e.font_size && !outlineLabel.test(e.text))
        .map((e) => Math.round(e.font_size! * 2) / 2),
    ),
  ].sort((a, b) => b - a);
  for (const e of out) {
    if (e.exclusion || e.heading_level) continue;
    const decimal = /^(\d+(?:\.\d+)*)(?:\.)?\s+[A-Z][^\n]+$/.exec(
      e.text.trim(),
    );
    if (
      !manual &&
      e.type !== "heading" &&
      e.type !== "list_item" &&
      decimal &&
      e.text.length < 120 &&
      !/[.;:]$/.test(e.text.trim())
    ) {
      e.type = "heading";
      e.flags.push("heading_inferred_from_numbering");
    }
    if (e.type !== "heading") continue;
    let level: number | undefined;
    if (manual) level = families.find(([pattern]) => pattern.test(e.text))?.[1];
    else if (decimal) level = decimal[1].split(".").length;
    if (level) {
      e.heading_level = level;
      e.flags.push("hierarchy_inferred_from_numbering");
      if (manual && /^(?:[IVXivx]\.|\([ivx]\))\s/.test(e.text))
        e.flags.push("ambiguous_roman_or_alphabetic_label");
    } else if (
      !manual &&
      sizes.length > 1 &&
      e.font_size &&
      e.text.length < 160
    ) {
      e.heading_level =
        sizes.indexOf(Math.round(e.font_size * 2) / 2) + 1 || undefined;
      e.flags.push("hierarchy_inferred_from_typography");
    }
    // Editorial annotations are source text, never a new section or a retirement decision.
    if (/^\[[\s\S]+\]$/.test(e.text.trim())) {
      e.type = "paragraph";
      delete e.heading_level;
      e.flags.push("role:editorial_annotation");
    }
  }
  return out;
}
