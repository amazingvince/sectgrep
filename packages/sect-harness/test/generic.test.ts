import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bareReferences, candidatesFor, hasChildren, knownFromNodes, preResolve } from "../src/refs.js";
import { consensus, type VerifierAnswer } from "../src/verifier.js";
import { ordinanceSource } from "./registry-helpers.js";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

describe("references are registry-driven: a municipal code that is nothing like the CFR", () => {
  const known = knownFromNodes(
    [
      { id: "ORD", title: "City Code", level: "code", parent: null, source: "city-code" },
      { id: "ORD:12", title: "Building", level: "chapter", parent: "ORD", source: "city-code" },
      { id: "ORD:13", title: "Fire", level: "chapter", parent: "ORD", source: "city-code" },
      { id: "ORD:12-34", title: "Permits", level: "section", parent: "ORD:12", source: "city-code" },
      { id: "ORD:12-35", title: "Fees", level: "section", parent: "ORD:12", source: "city-code" },
      { id: "ORD:13-1", title: "Scope", level: "section", parent: "ORD:13", source: "city-code" },
      { id: "CITY:AM-2", title: "Amendment 2", level: "section", parent: null, source: "city-amendments" },
    ],
    [ordinanceSource(), { dir: "", name: "city-amendments", kind: "overlay", precedence: 200, id_prefix: "CITY:", id_pattern: "(?i)\\b(?:city\\s+amendment\\s+|CITY:)?(?P<num>AM-\\d{1,3})\\b", id_template: "CITY:{num}" }],
  );
  const anchors = new Map([["ORD:12-34", new Set(["a", "b"])], ["ORD:12-35", new Set(["a"])]]);

  it("finds the registry's citation form, containers by the corpus's own level names, paragraphs and ancestors", () => {
    const body = "# Sec. 12-34 Permits\n\nFees are in Sec. 12-35(a) and Chapter 13 applies; see paragraph (b) of this section, this chapter and city amendment AM-2. Section 99-1 is nowhere.";
    const refs = bareReferences(body, known, "ORD:12-34");
    expect([...refs].sort()).toEqual(["Sec. 12-35(a)", "Chapter 13", "paragraph (b) of this section", "this chapter", "city amendment AM-2", "Section 99-1"].sort());
    expect(candidatesFor("Sec. 12-35(a)", "ORD:12-34", known)).toEqual([{ id: "ORD:12-35", title: "Fees", anchor: "a", via: "pattern", source: "city-code" }]);
    expect(candidatesFor("Chapter 13", "ORD:12-34", known)).toEqual([{ id: "ORD:13", title: "Fire", via: "container", source: "city-code" }]);
    expect(candidatesFor("this chapter", "ORD:12-34", known)[0]).toMatchObject({ id: "ORD:12", via: "self" });
    expect(candidatesFor("city amendment AM-2", "ORD:12-34", known)[0]).toMatchObject({ id: "CITY:AM-2", via: "pattern" });
    expect(candidatesFor("Section 99-1", "ORD:12-34", known)).toEqual([]);
    expect(hasChildren(known, "ORD:12")).toBe(true);
    expect(hasChildren(known, "ORD:12-34")).toBe(false);
  });

  it("links them in code and leaves the unknown one to the agent, then consensus treats them as deterministic", () => {
    const body = "Fees are in Sec. 12-35(a) and Chapter 13 applies; see paragraph (b) of this section, this chapter and city amendment AM-2. Section 99-1 is nowhere.";
    const r = preResolve(body, "ORD:12-34", known, anchors);
    expect(Object.fromEntries(r.resolved.map((x) => [x.text, `${x.id}${x.anchor ? "#" + x.anchor : ""}`]))).toEqual({
      "Sec. 12-35(a)": "ORD:12-35#a",
      "Chapter 13": "ORD:13",
      "paragraph (b) of this section": "ORD:12-34#b",
      "this chapter": "ORD:12",
      "city amendment AM-2": "CITY:AM-2",
    });
    expect(r.remaining).toEqual(["Section 99-1"]);
    const record = { id: "ORD:12-34", input: "x.md", path: "city-code/x.md", context: "", defines: [], flags: [], body_tokens: 10, xrefs: r.resolved };
    const refs = [...r.resolved.map((x) => x.text), ...r.remaining];
    const candidates = new Map(refs.map((t) => [t, candidatesFor(t, "ORD:12-34", known)]));
    const answer: VerifierAnswer = { xrefs: refs.map((t) => ({ text: t, id: null, confidence: 0 })), defines: [] };
    const j = consensus(record, answer, refs, candidates, "normal", {});
    expect(j.filter((x) => x.field === "xref").every((x) => !x.agree)).toBe(true); // An explicit contradictory judgment must hold even a deterministic citation.
  });
});

describe("no publisher's shapes in the harness", () => {
  it("has no CFR citation form, id shape or hierarchy name outside converters, fixtures and tests", () => {
    const src = path.resolve(here, "../src");
    const offenders: string[] = [];
    for (const f of readdirSync(src).filter((n) => n.endsWith(".ts"))) {
      const code = readFileSync(path.join(src, f), "utf-8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      for (const re of [/CFR:/, /§/, /\bsubchapter\b/i, /\bsubjectgroup\b/i, /\d\s*CFR\b/]) if (re.test(code)) offenders.push(`${f}: ${re}`);
    }
    expect(offenders).toEqual([]);
  });
});
