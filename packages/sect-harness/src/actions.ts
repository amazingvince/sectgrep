// Spec D.2 step 9, the deterministic half: a notice's Actions (amend, add, remove, redesignate,
// stay) applied to the current Expression's text give the new Expression. No model retypes rule
// text: the quoted paragraphs are placed by their labels, a word-level instruction is a string
// replacement, a redesignation relabels. What cannot be applied in code is returned as unapplied
// for a person, never guessed.

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
  /** Actions applied in part: the paragraphs that could not be placed. */
  partial?: Array<{ action_id: string; notes: string[] }>;
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

/** The lines [start, end) of a paragraph's own text: up to the next labeled paragraph at any depth. */
export function ownSpan(body: string, anchor: string): { start: number; end: number } | null {
  const anchors = paragraphAnchors(body);
  const i = anchors.findIndex((a) => a.anchor === anchor);
  if (i < 0) return null;
  const lines = body.split("\n");
  return { start: anchors[i].line - 1, end: anchors[i + 1] ? anchors[i + 1].line - 1 : lines.length };
}

const label = (anchor: string) => `(${anchor.split("-").join(")(")})`;
const tidy = (s: string) => s.replace(/\n{3,}/g, "\n\n");

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
    out.push({ from: m[1].replace(/[()]/g, "-").replace(/^-|-$/g, ""), to: m[2].replace(/[()]/g, "-").replace(/^-|-$/g, "") });
  }
  return out;
}

export interface QuotedParagraph {
  /** The full anchor path ("b-1") or null for unlabeled text. */
  anchor: string | null;
  text: string;
  /** Printed with asterisks: the unquoted part is not given. */
  partial: boolean;
}

const isNoise = (p: string) => /^#{1,6}\s/.test(p) || /^\*\s?\*\s?\*\s*$/.test(p) || /reads? as follows:?$/i.test(p.trim()) || /^(?:\*\*)?Authority:?(?:\*\*)?$/i.test(p.trim());

/** Depth of a label by its kind: (a) 1, (1) 2, (i) 3, (A) 4; a lone i, v or x is roman below a numbered paragraph. */
function depthOf(lbl: string, current: string[]): number {
  if (/^[ivx]+$/.test(lbl) && (current.length >= 2 || lbl.length > 1)) return 3;
  if (/^[a-z]$/.test(lbl)) return 1;
  if (/^\d+$/.test(lbl)) return 2;
  if (/^[ivx]+$/.test(lbl)) return 3;
  if (/^[A-Z]$/.test(lbl)) return 4;
  return current.length + 1;
}

/**
 * The paragraphs a notice quotes, with the full anchor of each from its leading labels and the
 * labels before it: "(b)" then "(1)" is b-1; "(b)(1)" is b-1 at once. `base` (the Action's own
 * anchor) is the parent of a first nested label that has none.
 */
export function quotedParagraphs(text: string, base: string | null): QuotedParagraph[] {
  const out: QuotedParagraph[] = [];
  let path: string[] = base ? base.split("-") : [];
  for (const raw of text.split(/\n{2,}/)) {
    const p = raw.trim();
    if (!p || isNoise(p)) continue;
    const m = /^\s*(?:\*{1,2})?((?:\([a-zA-Z0-9]{1,4}\))+)/.exec(p);
    if (!m) {
      out.push({ anchor: null, text: p, partial: /\*\s?\*\s?\*/.test(p) });
      continue;
    }
    const labels = m[1].replace(/[()]/g, " ").trim().split(/\s+/);
    let next = [...path];
    for (const l of labels) {
      const d = depthOf(l, next);
      next = [...next.slice(0, d - 1), l];
    }
    path = next;
    out.push({ anchor: path.join("-").toLowerCase(), text: p, partial: /\*\s?\*\s?\*/.test(p) });
    // "(e) Special rules. (1) Except ..." carries its first sub-paragraph inline: what follows
    // ("(i)", "(ii)", "(2)") sits under (e)(1) and (e).
    const inline = /[.:]\s+\((\d+)\)\s/.exec(p.slice(m[0].length));
    if (inline && path.length === 1) path = [...path, inline[1]];
  }
  return out;
}

const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export interface PlaceOptions {
  /** A paragraph the section lacks may be inserted (an addition or a redesignation), or not (a revision). */
  mayInsert: boolean;
  /** Anchors whose introductory text alone is revised: their sub-paragraphs stay. */
  introOnly: Set<string>;
}

/**
 * Place one quoted paragraph: a revised paragraph replaces its whole span (the printed text is the
 * whole new paragraph) unless only its introductory text is revised; a paragraph the section
 * lacks is inserted in order when the Action may add.
 */
export function placeParagraph(body: string, q: QuotedParagraph, o: PlaceOptions = { mayInsert: true, introOnly: new Set() }): { body: string; why?: string } {
  if (!q.anchor) return { body, why: "unlabeled text" };
  if (q.partial) return { body, why: `paragraph (${q.anchor}) is a partial revision marked with asterisks` };
  const target = q.anchor;
  const lines = body.split("\n");
  const span = o.introOnly.has(target) ? ownSpan(body, target) : paragraphSpan(body, target);
  if (span) return { body: tidy([...lines.slice(0, span.start), ...q.text.split("\n"), "", ...lines.slice(span.end)].join("\n")) };
  if (!o.mayInsert) return { body, why: `paragraph (${target}) not found` };
  const anchors = paragraphAnchors(body);
  const parts = target.split("-");
  const parent = parts.slice(0, -1).join("-");
  const siblings = anchors.filter((x) => x.anchor.split("-").length === parts.length && (parent ? x.anchor.startsWith(parent + "-") : !x.anchor.includes("-")));
  const before = siblings.filter((x) => cmp(x.anchor, target) < 0);
  let at = lines.length;
  if (before.length) at = paragraphSpan(body, before[before.length - 1].anchor)?.end ?? lines.length;
  else if (parent) {
    const span = ownSpan(body, parent);
    if (span) at = span.end;
    else {
      // The parent is inline in its own parent's text ("(e) ... (1) Except ..."): where its
      // sub-paragraphs go is not a matter of labels; a person places them.
      return { body, why: `paragraph (${parent}) is inline in its parent; (${target}) needs a person` };
    }
  } else if (siblings.length) at = paragraphSpan(body, siblings[0].anchor)?.start ?? lines.length;
  return { body: tidy([...lines.slice(0, at), "", ...q.text.split("\n"), "", ...lines.slice(at)].join("\n")) };
}

/** Apply one Action's word edits, removals and redesignations; its quoted paragraphs come back for placing. */
export function applyAction(body: string, a: Action): { body: string; why?: string; quoted?: QuotedParagraph[] } {
  const lines = body.split("\n");
  const anchor = a.target_anchor;
  const text = (a.text ?? "").trim();
  const ins = a.instruction ?? "";
  if (a.kind === "stay") return { body };
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
  const edit = wordEdit(ins);
  if (edit && !text) {
    const span = anchor ? paragraphSpan(body, anchor) : null;
    if (anchor && !span) return { body, why: `paragraph (${anchor}) not found` };
    const [s, e] = span ? [span.start, span.end] : [0, lines.length];
    const region = lines.slice(s, e).join("\n");
    if (!region.includes(edit.remove)) return { body, why: `the words "${edit.remove}" are not in ${anchor ? `paragraph (${anchor})` : "the section"}` };
    const replaced = edit.everywhere || !anchor ? region.split(edit.remove).join(edit.add ?? "") : region.replace(edit.remove, edit.add ?? "");
    return { body: [...lines.slice(0, s), ...replaced.split("\n"), ...lines.slice(e)].join("\n") };
  }
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
  let out = body;
  if (a.kind === "redesignate") {
    const moves = redesignation(ins);
    if (!moves.length && !text) return { body, why: "no redesignation stated" };
    // Later paragraphs first, so a chain (e to g, then f to e) does not collide.
    for (const mv of [...moves].reverse()) {
      const span = ownSpan(out, mv.from);
      if (!span) return { body, why: `paragraph (${mv.from}) not found` };
      const ls = out.split("\n");
      ls[span.start] = ls[span.start].replace(label(mv.from), label(mv.to));
      out = ls.join("\n");
    }
  }
  if (a.kind === "remove" && !text) {
    if (!anchor) return { body, why: "a removal names no paragraph and no words" };
    const span = paragraphSpan(out, anchor);
    if (!span) return { body, why: `paragraph (${anchor}) not found` };
    const ls = out.split("\n");
    return { body: tidy([...ls.slice(0, span.start), ...(/reserv/i.test(ins) ? [`${label(anchor)} [Reserved]`, ""] : []), ...ls.slice(span.end)].join("\n")) };
  }
  if (!text) return a.kind === "redesignate" ? { body: out } : { body, why: "no amendment text to apply" };
  const quoted = quotedParagraphs(text, anchor);
  // A whole section revised: unlabeled text replaces everything below the heading.
  if (quoted.length && quoted.every((q) => !q.anchor) && !anchor && a.kind === "amend") {
    const head = lines.findIndex((l) => /^#\s/.test(l));
    return { body: [...(head >= 0 ? lines.slice(0, head + 1) : []), "", ...quoted.map((q) => q.text).join("\n\n").split("\n"), ""].join("\n") };
  }
  return { body: out, quoted };
}

/**
 * Apply a notice's Actions to one Expression: word edits, removals and redesignations in order,
 * then every quoted paragraph placed by its label. A header instruction with nothing to apply is
 * neither applied nor unapplied.
 */
export function applyActions(body: string, actions: Action[]): Applied {
  let out = body;
  const applied: Action[] = [];
  const unapplied: Array<{ action: Action; why: string }> = [];
  const pending: Array<{ action: Action; q: QuotedParagraph }> = [];
  for (const a of actions) {
    const header = !a.text && !wordEdit(a.instruction ?? "") && !insertBetween(a.instruction ?? "") && !redesignation(a.instruction ?? "").length && !(a.kind === "remove" && a.target_anchor);
    if (header) continue;
    const r = applyAction(out, a);
    if (r.why) {
      unapplied.push({ action: a, why: r.why });
      continue;
    }
    if (r.body !== out) applied.push(a);
    out = r.body;
    for (const q of r.quoted ?? []) pending.push({ action: a, q });
  }
  const notes = new Map<Action, string[]>();
  for (const { action, q } of pending) {
    const introOnly = new Set<string>();
    for (const m of (action.instruction ?? "").matchAll(/((?:\([a-z0-9]{1,4}\))+)\s+introductory\s+text/gi)) introOnly.add(m[1].replace(/[()]/g, "-").replace(/^-|-$/g, "").toLowerCase());
    // A revision may not invent a paragraph, except one restated under a parent the same text replaces whole.
    const quotedTops = pending.filter((x) => x.action === action && x.q.anchor && !introOnly.has(x.q.anchor)).map((x) => x.q.anchor!);
    const underQuoted = !!q.anchor && quotedTops.some((a) => q.anchor!.startsWith(a + "-"));
    const r = placeParagraph(out, q, { mayInsert: action.kind !== "amend" || underQuoted, introOnly });
    if (r.why) notes.set(action, [...(notes.get(action) ?? []), r.why]);
    else {
      out = r.body;
      if (!applied.includes(action)) applied.push(action);
    }
  }
  for (const [action, whys] of notes) {
    if (!applied.includes(action) && !unapplied.some((u) => u.action === action)) unapplied.push({ action, why: whys.join("; ") });
  }
  const partial = [...notes].filter(([a]) => applied.includes(a)).map(([a, w]) => ({ action_id: a.action_id, notes: w }));
  return { body: out, applied, unapplied, ...(partial.length ? { partial } : {}) };
}
