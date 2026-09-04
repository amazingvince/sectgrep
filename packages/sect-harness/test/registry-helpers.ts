// Registry entries for tests. The CFR shape lives here and in the converters, not in the harness.
import type { SourceInfo } from "@sectgrep/convert";

/** The registry entry the eCFR converter writes for a title. */
export function cfrSource(t: number): SourceInfo {
  return {
    dir: "",
    name: `cfr-title-${t}`,
    kind: "base",
    precedence: 100,
    id_prefix: `CFR:${t}-`,
    id_pattern: `(?i)(?:\\b${t}\\s*C\\.?F\\.?R\\.?\\s*(?:§\\s*)?|§\\s*|\\bsection\\s+)(?P<part>\\d{1,4})\\.(?P<section>\\d{1,4}[a-z]?(?:-\\d+)?)(?:\\s*\\((?P<p1>[a-z]|\\d{1,2}|[ivx]{1,4})\\))?(?:\\s*\\((?P<p2>[a-z]|\\d{1,2}|[ivx]{1,4})\\))?`,
    id_template: `CFR:${t}-{part}.{section}`,
    anchor_template: "{p1}-{p2}",
  };
}

/** A municipal-code style source: "Sec. 12-34(a)" under "Chapter 12". */
export function ordinanceSource(): SourceInfo {
  return {
    dir: "",
    name: "city-code",
    kind: "base",
    precedence: 100,
    id_prefix: "ORD:",
    id_pattern: "(?i)\\b(?:sec\\.|section)\\s*(?P<ch>\\d{1,3})-(?P<sec>\\d{1,4})(?:\\s*\\((?P<p1>[a-z]|\\d{1,2})\\))?",
    id_template: "ORD:{ch}-{sec}",
    anchor_template: "{p1}",
  };
}
