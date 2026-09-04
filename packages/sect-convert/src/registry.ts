// The source registry as code reads it (spec B.2 `_source.yaml`): a source's `id_pattern` names
// the citation forms that point into it, `id_template` and `anchor_template` build the id and
// the anchor from the pattern's captures. Everything outside a converter that resolves a
// citation goes through these, so no source's forms are written into code.

/** Compile a registry pattern (Rust/Python syntax: `(?P<name>...)`, a leading `(?i)`) for JavaScript. */
export function compileIdPattern(pattern: string, extraFlags = ""): RegExp | null {
  let p = pattern.trim();
  let flags = "";
  const inline = /^\(\?([a-z]+)\)/.exec(p);
  if (inline) {
    if (inline[1].includes("i")) flags += "i";
    p = p.slice(inline[0].length);
  }
  p = p.replace(/\(\?P</g, "(?<");
  try {
    return new RegExp(p, [...new Set((flags + extraFlags).split(""))].join(""));
  } catch {
    return null;
  }
}

/** Fill `{name}` placeholders from a match's named groups; a missing group is empty. */
export function fillTemplate(template: string, groups: Record<string, string | undefined> | undefined): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k: string) => groups?.[k] ?? "");
}

/** An anchor from its template: empty parts drop, so `{p1}-{p2}` with no p2 is `p1`. */
export function fillAnchor(template: string | undefined, groups: Record<string, string | undefined> | undefined): string | null {
  if (!template) return null;
  const a = fillTemplate(template, groups).split("-").map((s) => s.trim().toLowerCase()).filter(Boolean).join("-");
  return a || null;
}

/** The id and anchor a source's pattern builds from a citation, when the whole text is one citation. */
export function idFromCitation(source: { id_pattern?: string; id_template?: string; anchor_template?: string }, text: string): { id: string; anchor: string | null } | null {
  if (!source.id_pattern || !source.id_template) return null;
  const re = compileIdPattern(source.id_pattern);
  if (!re) return null;
  const whole = new RegExp(`^(?:${re.source})$`, re.flags.replace("g", ""));
  const m = whole.exec(text.trim());
  if (!m) return null;
  const id = fillTemplate(source.id_template, m.groups);
  return id.includes("{") ? null : { id, anchor: fillAnchor(source.anchor_template, m.groups) };
}
