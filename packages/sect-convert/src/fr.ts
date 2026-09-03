/**
 * Federal Register rule XML -> notice file with Action candidates (spec C.3, B.2 Actions,
 * spec-changes #4). The preamble gives agency, subject, summary and the effective date; each
 * REGTEXT block carries amendatory instructions (AMDPAR) followed by the regulatory text they
 * introduce. Every instruction becomes one Action candidate with a target id derived from the
 * instruction's section or part, a paragraph anchor when the instruction names one, a kind
 * (amend, add, remove, redesignate, stay), the effective date, and the text that follows.
 * Interpretation beyond that is WS3's judgment; this pass is deterministic.
 */

import { createHash } from "node:crypto";
import { attr, child, children, parseXml, textOf, type Elem } from "./xml.js";

export interface ActionCandidate {
  action_id: string;
  notice: string;
  target_id: string;
  target_anchor: string | null;
  kind: "amend" | "add" | "remove" | "redesignate" | "stay";
  effective: string;
  text: string;
  /** Every paragraph the instruction names, as anchors, when it names more than one. */
  anchors?: string[];
  instruction: string;
}

export interface FrNotice {
  id: string;
  docnum: string;
  title: string;
  agency: string;
  effective: string;
  published: string | null;
  parts_affected: string[];
  citation: string;
  actions: ActionCandidate[];
  markdown: string;
  frontMatter: string;
}

export interface FrOptions {
  /** Document number when the XML does not carry it (the API's document_number). */
  docnum?: string;
  /** Publication date YYYY-MM-DD (from the fetch), for `published` and the citation volume. */
  published?: string;
  raw?: string;
  rawSha256?: string;
  sourceName?: string;
}

const MONTHS: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

/** "January 15, 2026" -> 2026-01-15 */
export function parseLongDate(s: string): string | null {
  const m = /([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** Paragraph designators "(j)(2)(i)" -> anchor "j-2-i", the eCFR converter's scheme. */
export function anchorOf(desig: string): string {
  return desig.replace(/\s+/g, "").split(/[()]+/).filter(Boolean).join("-");
}

const KINDS: Array<[RegExp, ActionCandidate["kind"]]> = [
  [/redesignat/i, "redesignate"],
  [/remov|delet/i, "remove"],
  [/^add/i, "add"],
  [/stay|suspend/i, "stay"],
  [/revis|amend|correct|republish/i, "amend"],
];

/** The instruction's verb decides: "Add § Y" adds, "Amend § X by adding paragraph (k)" adds,
 * "Amend § X by revising paragraph (b)" amends, "Remove § Z" removes. */
export function kindOf(instruction: string): ActionCandidate["kind"] {
  const s = instruction.replace(/^\s*\d+[a-z]?\.\s*/, "");
  const first = /^(?:(?:section|§+)\s*[\d.]+\s+is\s+)?(\w+)/i.exec(s)?.[1]?.toLowerCase() ?? "";
  for (const [re, kind] of KINDS) if (re.test(first) && kind !== "amend") return kind;
  const by = /\bby\s+(\w+)/i.exec(s)?.[1]?.toLowerCase() ?? "";
  for (const [re, kind] of KINDS) if (re.test(by)) return kind;
  for (const [re, kind] of KINDS) if (re.test(s)) return kind;
  return "amend";
}

/** All "(a)(2)(i)"-style designators an instruction names, in order, as anchors. */
export function designators(instruction: string): string[] {
  const out: string[] = [];
  const re = /paragraphs?\s+((?:\([a-z0-9]{1,4}\))+(?:\s*(?:,|and|through|to)\s*(?:paragraphs?\s+)?(?:\([a-z0-9]{1,4}\))+)*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(instruction))) {
    for (const d of m[1].match(/(?:\([a-z0-9]{1,4}\))+/g) ?? []) out.push(anchorOf(d));
  }
  return [...new Set(out)];
}

/** Section number in "§ 1910.1200" or "Section 1910.1200"; null when the instruction targets a part. */
export function sectionOf(instruction: string): string | null {
  const m = /(?:§+|Section|Sec\.)\s*(\d+\.\d+[a-z]?(?:-\d+)?)/i.exec(instruction);
  return m ? m[1] : null;
}

const sq = (s: string) => s.replace(/\s+/g, " ").trim();

/** Block children of `e` rendered to markdown paragraphs. */
function paragraphs(e: Elem | undefined, skip: string[] = []): string[] {
  if (!e) return [];
  const out: string[] = [];
  for (const c of children(e)) {
    const tag = c.tagName;
    if (skip.includes(tag)) continue;
    if (tag === "HD") out.push(`**${sq(textOf(c))}**`);
    else if (tag === "P" || tag === "FP" || tag === "PSPACE") {
      const t = sq(textOf(c));
      if (t) out.push(t);
    } else if (tag === "SECTNO") out.push(`### ${sq(textOf(c))} ${sq(textOf(child(e, "SUBJECT")))}`);
    else if (tag === "SUBJECT") continue;
    else if (tag === "STARS") out.push("* * * * *");
    else if (tag === "PRTPAGE" || tag === "FTNT") continue;
    else if (children(c).length) out.push(...paragraphs(c));
    else {
      const t = sq(textOf(c));
      if (t) out.push(t);
    }
  }
  return out;
}

/**
 * Bare "Part 42" and "§ 1910.27(a)" mentions in the preamble become explicit links when the rule's
 * CFR line names exactly one title; a rule that touches several titles keeps them bare, because
 * the title is then a judgment the converter must not make.
 */
export function linkProse(text: string, cfrLine: string): string {
  const titles = new Set((cfrLine.match(/\b(\d+)\s+CFR\b/gi) ?? []).map((m) => /\d+/.exec(m)![0]));
  if (titles.size !== 1) return text;
  const t = [...titles][0];
  return text
    .replace(/(?<!CFR\s)(?<!\[)\b(Parts?\s+)(\d{1,4})\b(?!\.\d)/g, (_m, w: string, p: string) => `[${w}${p}](CFR:${t}-${p})`)
    .replace(/(?<!\[)(§+\s*)(\d+\.\d+[a-z]?(?:-\d+)?)((?:\([a-z0-9]{1,4}\))*)/g, (_m, sign: string, sec: string, paras: string) => {
      const anchor = paras ? "#" + paras.replace(/\s+/g, "").split(/[()]+/).filter(Boolean).join("-") : "";
      return `[${sign}${sec}${paras}](CFR:${t}-${sec}${anchor})`;
    });
}

export function convertFr(xml: string, opts: FrOptions = {}): FrNotice {
  const doc = parseXml(xml);
  const root = doc.documentElement as unknown as Elem;
  const rule = root.tagName === "RULE" ? root : (child(root, "RULE") ?? root);
  const preamb = child(rule, "PREAMB") ?? rule;
  const frdoc = textOf(child(rule, "FRDOC") ?? child(preamb, "FRDOC"));
  const docnum = opts.docnum ?? /FR Doc\.\s*([\w-]+)/.exec(frdoc)?.[1] ?? "unknown";
  const id = `FR:${docnum}`;
  const subject = sq(textOf(child(preamb, "SUBJECT")));
  const agency = sq(textOf(child(preamb, "AGENCY")));
  const dates = sq(textOf(child(preamb, "EFFDATE") ?? child(preamb, "DATES")));
  const eff = /effective[^.]*?([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i.exec(dates)?.[1];
  const effective = (eff && parseLongDate(eff)) ?? parseLongDate(dates) ?? opts.published ?? "1970-01-01";
  // A rule that touches several titles carries one CFR line per title ("26 CFR Part 54",
  // "29 CFR Part 2590", ...): all of them, so parts_affected is complete and prose linking sees
  // every title.
  const cfr = children(preamb).filter((c) => c.tagName === "CFR").map((c) => sq(textOf(c))).join("; ");
  const title = /(\d+)\s+CFR/.exec(cfr)?.[1] ?? "";
  const parts_affected: string[] = [];
  for (const m of cfr.matchAll(/(\d+)\s+CFR\s+parts?\s+([\d,\s]+(?:and\s+\d+)?)/gi)) {
    for (const p of m[2].match(/\d+/g) ?? []) parts_affected.push(`CFR:${m[1]}-${p}`);
  }
  const firstPage = /<PRTPAGE P="(\d+)"/.exec(xml)?.[1];
  const year = Number((opts.published ?? effective).slice(0, 4));
  const citation = firstPage ? `${year - 1935} FR ${firstPage}` : "";

  const actions: ActionCandidate[] = [];
  let n = 0;
  // REGTEXT blocks sit inside SUPLINF (often under a PART wrapper), not at the top level.
  const regtexts = Array.from((rule as unknown as Element).getElementsByTagName("REGTEXT")) as unknown as Elem[];
  for (const reg of regtexts) {
    const rTitle = attr(reg, "TITLE") || title;
    const rPart = attr(reg, "PART");
    let pending: { instruction: string; texts: string[] } | null = null;
    const flush = () => {
      if (!pending) return;
      n++;
      const ins = pending.instruction;
      const sec = sectionOf(ins);
      const subpart = /subpart\s+([A-Z]{1,2})\b/i.exec(ins)?.[1];
      const part = /part\s+(\d+)/i.exec(ins)?.[1] ?? rPart;
      const target_id = sec ? `CFR:${rTitle}-${sec}` : subpart ? `CFR:${rTitle}-${part}-${subpart}` : `CFR:${rTitle}-${part}`;
      const anchors = designators(ins);
      actions.push({
        action_id: `${id}#instr-${n}`, notice: id, target_id, target_anchor: anchors[0] ?? null, kind: kindOf(ins), effective,
        text: pending.texts.join("\n\n").trim(), ...(anchors.length > 1 ? { anchors } : {}), instruction: ins,
      });
      pending = null;
    };
    const before = n;
    for (const c of children(reg)) {
      if (c.tagName === "AMDPAR") {
        flush();
        pending = { instruction: sq(textOf(c)), texts: [] };
      } else if (pending) {
        pending.texts.push(...paragraphsOf(c));
      }
    }
    flush();
    if (n === before && rPart) {
      // A whole part removed carries no AMDPAR: the heading reads "PART 42—[REMOVED AND RESERVED]"
      // and the REGTEXT is one sentence, "the Department removes and reserves 29 CFR Part 42".
      const txt = sq(children(reg).flatMap((c) => paragraphsOf(c)).join(" "));
      if (/\b(remov(?:es?|ed)|rescind(?:s|ed)?)\b/i.test(txt)) {
        n++;
        actions.push({ action_id: `${id}#instr-${n}`, notice: id, target_id: `CFR:${rTitle}-${rPart}`, target_anchor: null, kind: "remove", effective, text: "", instruction: txt });
      }
    }
  }

  const summary = paragraphs(child(preamb, "SUM"), ["HD"]).join("\n\n");
  const suplinf = linkProse(paragraphs(child(rule, "SUPLINF") ?? child(preamb, "SUPLINF"), ["REGTEXT", "PART", "SIG", "LSTSUB", "FRDOC", "BILCOD"]).join("\n\n"), cfr);
  const regtext = regtexts.map((r) => paragraphs(r).join("\n\n")).join("\n\n");
  const parts = [`# ${subject}`, agency ? `*${agency}*` : "", summary ? `## Summary\n\n${summary}` : "", suplinf ? `## Supplementary information\n\n${suplinf}` : "", regtext ? `## Regulatory text\n\n${regtext}` : ""].filter(Boolean);
  const md = parts.join("\n\n") + "\n";
  const q = (s: string) => JSON.stringify(s);
  const action = sq(textOf(child(preamb, "ACT"))).replace(/^ACTION:\s*/i, "");
  const context = `Federal Register ${action || "rule"} by ${agency || "an agency"} on ${subject}, effective ${effective}, affecting ${parts_affected.join(", ") || "the parts named in the text"}. ${actions.length} amendatory instruction(s): ${actions.map((a) => `${a.kind} ${a.target_id}${a.target_anchor ? "#" + a.target_anchor : ""}`).join("; ")}. Summary: ${summary.slice(0, 400).replace(/\s+/g, " ")}`;
  const authority = sq(textOf(child(rule, "AUTH") ?? child(child(rule, "REGTEXT") ?? rule, "AUTH"))).replace(/^Authority:\s*/i, "").slice(0, 300);
  const fm = [
    "---", `id: ${id}`, "node: null", `source: ${opts.sourceName ?? "fr"}`, "kind: notice", `title: ${q(subject)}`, "level: notice", "parent: null", "order: 1",
    `effective: ${effective}`, `published: ${opts.published ?? "null"}`, "supersedes: null", "superseded_by: null", "amended_by: []", "overrides: []", "narrows: []", "defines: []",
    `authority: ${q(authority)}`, `citation: ${q(citation)}`, "tags: [notice, rule]", `parts_affected: [${parts_affected.join(", ")}]`,
    "actions:",
    ...actions.flatMap((a) => [
      `  - action_id: ${a.action_id}`, `    notice: ${a.notice}`, `    target_id: ${a.target_id}`, `    target_anchor: ${a.target_anchor ?? "null"}`, `    kind: ${a.kind}`, `    effective: ${a.effective}`,
      ...(a.anchors ? [`    anchors: [${a.anchors.join(", ")}]`] : []),
      `    instruction: ${q(a.instruction)}`, `    text: ${q(a.text)}`,
    ]),
    `context: ${q(context)}`,
    "provenance:", `  raw: ${q(opts.raw ?? `raw/fr/${year}/${docnum}.xml`)}`, `  raw_sha256: ${q(opts.rawSha256 ?? createHash("sha256").update(xml).digest("hex"))}`,
    `  locator: {xpath: ${q(`//RULE[FRDOC[contains(., '${docnum}')]]`)}}`, "  legal_status: official", `  ingest_run: ${q(new Date().toISOString().slice(0, 16) + "Z/sect-convert fr")}`, "  confidence: 1.0", "  verified_by: [sect-convert]", "---", "",
  ].join("\n");
  return { id, docnum, title: subject, agency, effective, published: opts.published ?? null, parts_affected, citation, actions, markdown: md, frontMatter: fm };
}

/** Markdown paragraphs of one block element (a SECTION, AUTH, EXTRACT, P ...). */
function paragraphsOf(c: Elem): string[] {
  const tag = c.tagName;
  if (tag === "P" || tag === "FP" || tag === "PSPACE") {
    const t = sq(textOf(c));
    return t ? [t] : [];
  }
  if (tag === "HD") return [`**${sq(textOf(c))}**`];
  if (tag === "STARS") return ["* * * * *"];
  if (tag === "PRTPAGE" || tag === "FTNT") return [];
  return paragraphs(c);
}

export const FR_SOURCE_YAML = `name: fr
kind: notice
title: "Federal Register rule documents (converted from federalregister.gov XML)"
publisher: "Office of the Federal Register, National Archives and Records Administration"
precedence: 100
id_prefix: "FR:"
id_pattern: '(?i)\\b(?:FR:|FR\\s+Doc\\.?\\s+)?(?P<doc>(?:C\\d-)?20\\d{2}-\\d{5})\\b'
id_template: "FR:{doc}"
legal_status: official
version: "rolling"
acquire: "https://www.federalregister.gov/api/v1/documents/<docnum>.json -> full_text_xml_url (sect-convert fr-fetch)"
`;
