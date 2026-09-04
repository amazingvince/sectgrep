// Spec D.2 step 9, the deterministic half: an Action from a notice (amend, add, remove,
// redesignate, stay) applied to the current Expression's text gives the new Expression. No
// model retypes rule text: the quoted amendment text is inserted verbatim, a word-level
// instruction is a string replacement, a redesignation relabels. What cannot be applied in
// code is returned as unapplied for a person, never guessed.

import { paragraphAnchors } from "@sectgrep/convert";

export interface Action {
  action_id: string;
  notice: string;
  target_id: string;
  target_anchor: string | null;
  kind: "amend" | "add" | "remove" | "redesignate" | "stay";
  effective: string;
  text: string;
  instruction?: string;
  anchors?: string[];
}

export interface Applied {
  body: string;
  applied: Action[];
  unapplied: Array<{ action: Action; why: string }>;
}

/** The lines [start, end) of the paragraph an anchor names, with its sub-paragraphs. */
export function paragraphSpan(body: string, anchor: string): { start: number; end: number } | null {
  const anchors = paragraphAnchors(body);
  const i = anchors.findIndex((a) => a.anchor === anchor);
  if (i < 0) return null;
  const lines = body.split("\n");
  const next = anchors.slice(i + 1).find((a) => !a.anchor.startsWith(anchor + "-"));
  // Anchor lines are one-based; a paragraph's trailing blank lines stay with it.
  return { start: anchors[i].line - 1, end: next ? next.line - 1 : lines.length };
}

const label = (anchor: string) => `(${anchor.split("-").join(")(")})`;

/** A word-level instruction: what to remove and what to add in its place, when the instruction says so. */
export function wordEdit(instruction: string): { remove: string; add: string | null; everywhere: boolean } | null {
  const rm = /remov(?:e|es|ing)\s+(?:the\s+)?(?:words?|phrase|term|figure)s?\s+[“"]([^”"]+)[”"]/i.exec(instruction);
  if (!rm) return null;
  const add = /add(?:s|ing)?(?:\s+in\s+(?:its|their)\s+place)?\s+(?:the\s+)?(?:(?:words?|phrase|term|figure)s?\s+)?[“"]([^”"]+)[”"]/i.exec(instruction);
  return { remove: rm[1], add: add?.[1] ?? null, everywhere: /wherever|each place|everywhere|throughout/i.test(instruction) };
}

/** "Remove ... Add ..." table text: the phrases to replace, in order. */
export function phraseTable(text: string, instruction: string): Array<{ remove: string; add: string }> {
  if (!/\btable\b|left column|right column/i.test(instruction)) return [];
  const q = [...text.matchAll(/[“"]([^”"]+)[”"]/g)].map((m) => m[1]);
  const out: Array<{ remove: string; add: string }> = [];
  for (let i = 0; i + 1 < q.length; i += 2) out.push({ remove: q[i], add: q[i + 1] });
  return out;
}

/** "adding the words “X” between the words “Y” and “Z”": what to insert and where. */
export function insertBetween(instruction: string): { insert: string; before: string; after: string } | null {
  const m = /add(?:s|ing)?\s+(?:the\s+)?(?:words?|phrase)\s+[“"]([^”"]+)[”"]\s+between\s+(?:the\s+)?(?:words?|phrase)\s+[“"]([^”"]+)[”"]\s+and\s+[“"]([^”"]+)[”"]/i.exec(instruction);
  return m ? { insert: m[1], before: m[2], after: m[3] } : null;
}

/** The redesignation an instruction states: paragraph (x) becomes (y). */
export function redesignation(instruction: string): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (const m of instruction.matchAll(/redesignat\w*\s+paragraphs?\s+((?:\([a-z0-9]{1,4}\))+)\s+(?:as|to)\s+(?:paragraphs?\s+)?((?:\([a-z0-9]{1,4}\))+)/gi)) {
    const from = m[1].replace(/[()]/g, "-").replace(/^-|-$/g, "");
    const to = m[2].replace(/[()]/g, "-").replace(/^-|-$/g, "");
    out.push({ from, to });
  }
  return out;
}

const splitParas = (text: string) => text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

/** The top-level anchor of a quoted paragraph's leading label, "(b)" or "(b)(1)". */
const leadingAnchor = (para: string): string | null => {
  const m = /^\s*(?:\*{1,2})?((?:\([a-z0-9]{1,4}\))+)/i.exec(para);
  return m ? m[1].replace(/[()]/g, "-").replace(/^-|-$/g, "").toLowerCase() : null;
};

/** Apply one Action to a body. */
export function applyAction(body: string, a: Action): { body: string; why?: string } {
  const lines = body.split("\n");
  const anchor = a.target_anchor;
  const text = (a.text ?? "").trim();
  const ins = a.instruction ?? "";
  const edit = wordEdit(ins);
  if (a.kind === "stay") return { body };
  // A table of phrases to replace throughout.
  const table = phraseTable(text, ins);
  if (table.length) {
    let out = body;
    let hits = 0;
    for (const { remove, add } of table) {
      if (out.includes(remove)) {
        hits++;
        out = out.split(remove).join(add);
      }
    }
    return hits ? { body: out } : { body, why: "none of the table's phrases occur here" };
  }
  // Words inserted between two others.
  const between = insertBetween(ins);
  if (between && !text) {
    const span = anchor ? paragraphSpan(body, anchor) : null;
    if (anchor && !span) return { body, why: `paragraph (${anchor}) not found` };
    const [s, e] = span ? [span.start, span.end] : [0, lines.length];
    const region = lines.slice(s, e).join("\n");
    const seam = `${between.before} ${between.after}`;
    if (!region.includes(seam)) return { body, why: `the words "${between.before}" and "${between.after}" are not adjacent in ${anchor ? `paragraph (${anchor})` : "the section"}` };
    return { body: [...lines.slice(0, s), ...region.replace(seam, `${between.before} ${between.insert} ${between.after}`).split("\n"), ...lines.slice(e)].join("\n") };
  }
  // A revision printed with asterisks keeps unquoted text in place: a person splices it.
  if (text && /(?:^|\n)\s*\*\s?\*\s?\*/.test(text)) return { body, why: "a partial revision marked with asterisks; the unquoted text is not given" };
  // A word-level instruction, in the named paragraph or everywhere.
  if (edit && (a.kind === "remove" || a.kind === "amend") && !text) {
    const span = anchor ? paragraphSpan(body, anchor) : null;
    if (anchor && !span) return { body, why: `paragraph (${anchor}) not found` };
    const [s, e] = span ? [span.start, span.end] : [0, lines.length];
    const region = lines.slice(s, e).join("\n");
    if (!region.includes(edit.remove)) return { body, why: `the words "${edit.remove}" are not in ${anchor ? `paragraph (${anchor})` : "the section"}` };
    const replaced = edit.everywhere || !anchor ? region.split(edit.remove).join(edit.add ?? "") : region.replace(edit.remove, edit.add ?? "");
    return { body: [...lines.slice(0, s), ...replaced.split("\n"), ...lines.slice(e)].join("\n") };
  }
  if (a.kind === "redesignate") {
    const moves = redesignation(ins);
    if (!moves.length) return { body, why: "no redesignation stated" };
    let out = body;
    // Later paragraphs first, so a chain (e to g, then f to e) does not collide.
    for (const mv of [...moves].reverse()) {
      const span = paragraphSpan(out, mv.from);
      if (!span) return { body, why: `paragraph (${mv.from}) not found` };
      const ls = out.split("\n");
      ls[span.start] = ls[span.start].replace(label(mv.from), label(mv.to));
      out = ls.join("\n");
    }
    // The instruction may also add paragraphs, with their text quoted.
    if (text) {
      const r = applyAction(out, { ...a, kind: "add", instruction: "" });
      return r.why ? { body: out } : r;
    }
    return { body: out };
  }
  if (a.kind === "remove") {
    if (!anchor) return { body, why: "a removal names no paragraph and no words" };
    const span = paragraphSpan(body, anchor);
    if (!span) return { body, why: `paragraph (${anchor}) not found` };
    const reserve = /reserv/i.test(ins);
    return { body: [...lines.slice(0, span.start), ...(reserve ? [`${label(anchor)} [Reserved]`, ""] : []), ...lines.slice(span.end)].join("\n").replace(/\n{3,}/g, "\n\n") };
  }
  if (!text) return { body, why: "no amendment text to apply" };
  const paras = splitParas(text);
  if (a.kind === "amend") {
    // Several top-level labeled paragraphs quoted at once ("revising (a), (b) introductory text,
    // (b)(1) and (2)"): each replaces its own paragraph, nested ones travel with their parent.
    const groups: Array<{ anchor: string | null; paras: string[] }> = [];
    // A quoted "(1)" under a "(b)" is relative: only a lettered label opens a new group.
    for (const p of paras) {
      const an = leadingAnchor(p);
      if (an && /^[a-z]$/.test(an)) groups.push({ anchor: an, paras: [p] });
      else if (groups.length) groups[groups.length - 1].paras.push(p);
      else groups.push({ anchor: an, paras: [p] });
    }
    if (groups.length > 1 && groups.every((g) => g.anchor)) {
      let out = body;
      for (const g of groups) {
        const span = paragraphSpan(out, g.anchor!);
        if (!span) {
          // A paragraph the section lacks is added in order.
          const r = applyAction(out, { ...a, kind: "add", target_anchor: g.anchor, text: g.paras.join("\n\n") });
          if (r.why) return { body, why: r.why };
          out = r.body;
          continue;
        }
        const ls = out.split("\n");
        // A quoted introductory text keeps the nested paragraphs it does not restate.
        const nested = g.paras.slice(1).some((p) => leadingAnchor(p)?.includes("-"));
        const end = nested ? span.end : (paragraphAnchors(out).find((x) => x.anchor.startsWith(g.anchor + "-"))?.line ?? span.end + 1) - 1;
        out = [...ls.slice(0, span.start), ...g.paras.join("\n\n").split("\n"), "", ...ls.slice(Math.max(end, span.start + 1))].join("\n").replace(/\n{3,}/g, "\n\n");
      }
      return { body: out };
    }
    if (anchor) {
      const span = paragraphSpan(body, anchor);
      if (!span) return { body, why: `paragraph (${anchor}) not found` };
      return { body: [...lines.slice(0, span.start), ...paras.join("\n\n").split("\n"), "", ...lines.slice(span.end)].join("\n").replace(/\n{3,}/g, "\n\n") };
    }
    // The whole section revised: keep the heading, replace the rest.
    const head = lines.findIndex((l) => /^#\s/.test(l));
    return { body: [...(head >= 0 ? lines.slice(0, head + 1) : []), "", ...paras.join("\n\n").split("\n"), ""].join("\n") };
  }
  if (a.kind === "add") {
    // Each quoted paragraph goes after the last existing paragraph that sorts before it at its depth.
    let out = body;
    for (const p of paras) {
      // One quoted paragraph goes where the Action says; several carry their own labels.
      const an = paras.length === 1 && a.target_anchor ? a.target_anchor : leadingAnchor(p);
      const anchors = paragraphAnchors(out);
      const depth = an ? an.split("-").length : 1;
      const parentPrefix = an && depth > 1 ? an.split("-").slice(0, -1).join("-") : "";
      const siblings = anchors.filter((x) => x.anchor.split("-").length === depth && (parentPrefix ? x.anchor.startsWith(parentPrefix + "-") : true));
      const before = an ? siblings.filter((x) => x.anchor.localeCompare(an, undefined, { numeric: true }) < 0) : siblings;
      const ls = out.split("\n");
      let at = ls.length;
      if (before.length) {
        const last = before[before.length - 1];
        const span = paragraphSpan(out, last.anchor);
        at = span ? span.end : ls.length;
      } else if (parentPrefix) {
        const span = paragraphSpan(out, parentPrefix);
        at = span ? span.start + 1 : ls.length;
      }
      out = [...ls.slice(0, at), "", ...p.split("\n"), "", ...ls.slice(at)].join("\n").replace(/\n{3,}/g, "\n\n");
    }
    return { body: out };
  }
  return { body, why: `unknown kind ${String(a.kind)}` };
}

/** Apply a notice's Actions to one Expression, in order; a header instruction with nothing to apply is neither applied nor unapplied. */
export function applyActions(body: string, actions: Action[]): Applied {
  let out = body;
  const applied: Action[] = [];
  const unapplied: Array<{ action: Action; why: string }> = [];
  for (const a of actions) {
    const header = !a.text && !a.target_anchor && !wordEdit(a.instruction ?? "") && !insertBetween(a.instruction ?? "") && !redesignation(a.instruction ?? "").length && a.kind !== "remove";
    if (header) continue;
    const r = applyAction(out, a);
    if (r.why) unapplied.push({ action: a, why: r.why });
    else {
      out = r.body;
      applied.push(a);
    }
  }
  return { body: out, applied, unapplied };
}
