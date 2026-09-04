// Spec C.6: `sect-convert align <source> <old> <new>` matches the nodes of two versions of one
// source by node id, then by id, then by title, then by text, and writes changes.json. For eCFR
// the two versions are point-in-time titles from the versioner API, fetched by date.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { convertEcfr, type NodeRec } from "./ecfr.js";
import { plain, spanMatch, tokens } from "./validators/text.js";

export type ChangeKind = "unchanged" | "changed" | "renumbered" | "moved" | "added" | "removed";

export interface Change {
  kind: ChangeKind;
  id: string;
  level: string;
  title: string;
  node?: string;
  old_id?: string;
  new_id?: string;
  old_title?: string;
  /** Token-level similarity of the two bodies (LCS over the longer), for changed/moved. */
  similarity?: number;
  /** Lines present in one version only, after markdown links are flattened. */
  diff?: { added: string[]; removed: string[] };
}

export interface AlignResult {
  source: string;
  old: { label: string; effective: string; nodes: number; sections: number };
  new: { label: string; effective: string; nodes: number; sections: number };
  summary: Record<ChangeKind, number>;
  changes: Change[];
}

const normText = (s: string) => plain(s).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const normTitle = (s: string) => normText(s).replace(/^§+\s*[\d.a-z-]+\s*/, "");

function similarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.length && !y.length) return 1;
  if (!x.length || !y.length) return 0;
  return spanMatch(x, y).lcs / Math.max(x.length, y.length);
}

function lineDiff(a: string, b: string): { added: string[]; removed: string[] } {
  const la = new Set(plain(a).split("\n").map((l) => l.trim()).filter(Boolean));
  const lb = new Set(plain(b).split("\n").map((l) => l.trim()).filter(Boolean));
  return { added: [...lb].filter((l) => !la.has(l)), removed: [...la].filter((l) => !lb.has(l)) };
}

/** Match old records to new ones: node, id, title, text; the rest are removed or added. */
export function alignNodes(oldRecs: NodeRec[], newRecs: NodeRec[], textFloor = 0.9): { summary: Record<ChangeKind, number>; changes: Change[] } {
  const byNode = new Map(newRecs.filter((r) => r.node).map((r) => [r.node, r]));
  const byIdNew = new Map(newRecs.map((r) => [r.id, r]));
  const used = new Set<NodeRec>();
  const changes: Change[] = [];
  const pending: NodeRec[] = [];
  const compare = (o: NodeRec, n: NodeRec, matchedBy: "node" | "id" | "title" | "text") => {
    used.add(n);
    const same = normText(o.body) === normText(n.body) && normTitle(o.title) === normTitle(n.title);
    let kind: ChangeKind = same ? "unchanged" : "changed";
    if (matchedBy === "text") kind = "moved";
    else if (o.id !== n.id) kind = "renumbered";
    const c: Change = { kind, id: n.id, level: n.level, title: n.title, node: n.node || undefined };
    if (o.id !== n.id) {
      c.old_id = o.id;
      c.new_id = n.id;
    }
    if (normTitle(o.title) !== normTitle(n.title)) c.old_title = o.title;
    if (!same) {
      c.similarity = Math.round(similarity(o.body, n.body) * 1000) / 1000;
      c.diff = lineDiff(o.body, n.body);
    }
    changes.push(c);
  };
  for (const o of oldRecs) {
    const n = (o.node && byNode.get(o.node)) || byIdNew.get(o.id);
    if (n && !used.has(n)) compare(o, n, o.node && byNode.get(o.node) === n ? "node" : "id");
    else pending.push(o);
  }
  // Title, then text, among what is left on both sides.
  let left = newRecs.filter((r) => !used.has(r));
  const byTitle = new Map<string, NodeRec[]>();
  for (const r of left) byTitle.set(normTitle(r.title), [...(byTitle.get(normTitle(r.title)) ?? []), r]);
  const still: NodeRec[] = [];
  for (const o of pending) {
    const cands = (byTitle.get(normTitle(o.title)) ?? []).filter((r) => !used.has(r) && r.level === o.level);
    if (cands.length && normTitle(o.title)) compare(o, cands[0], "title");
    else still.push(o);
  }
  left = newRecs.filter((r) => !used.has(r));
  for (const o of still) {
    let best: NodeRec | null = null;
    let bestSim = 0;
    const ot = tokens(o.body);
    if (ot.length >= 5) {
      for (const n of left) {
        if (used.has(n) || n.level !== o.level) continue;
        const nt = tokens(n.body);
        if (Math.abs(nt.length - ot.length) > Math.max(ot.length, nt.length) * (1 - textFloor)) continue;
        const sim = spanMatch(ot, nt).lcs / Math.max(ot.length, nt.length);
        if (sim > bestSim) {
          bestSim = sim;
          best = n;
        }
      }
    }
    if (best && bestSim >= textFloor) compare(o, best, "text");
    else changes.push({ kind: "removed", id: o.id, level: o.level, title: o.title, node: o.node || undefined });
  }
  for (const n of newRecs) if (!used.has(n)) changes.push({ kind: "added", id: n.id, level: n.level, title: n.title, node: n.node || undefined });
  const summary: Record<ChangeKind, number> = { unchanged: 0, changed: 0, renumbered: 0, moved: 0, added: 0, removed: 0 };
  for (const c of changes) summary[c.kind]++;
  return { summary, changes };
}

export function alignEcfr(oldXml: string, newXml: string, title: number, labels: { old: string; new: string }): AlignResult {
  const a = convertEcfr(oldXml, { title, rawPath: labels.old });
  const b = convertEcfr(newXml, { title, rawPath: labels.new });
  const { summary, changes } = alignNodes(a.records, b.records);
  return {
    source: `cfr-title-${title}`,
    old: { label: labels.old, effective: a.effective, nodes: a.nodes, sections: a.sections },
    new: { label: labels.new, effective: b.effective, nodes: b.nodes, sections: b.sections },
    summary,
    changes: changes.filter((c) => c.kind !== "unchanged"),
  };
}

/** The point-in-time title from the versioner API, cached under raw/cfr-title-N/<date>/. */
export async function fetchVersionerTitle(title: number, date: string, rawRoot = "raw"): Promise<string> {
  const file = path.join(rawRoot, `cfr-title-${title}`, date, `ECFR-title${title}.xml`);
  if (existsSync(file)) return file;
  const url = `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-${title}.xml`;
  const res = await fetch(url, { headers: { "Accept-Encoding": "gzip, deflate, br" } });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const xml = await res.text();
  if (!xml.includes("<ECFR")) throw new Error(`${url}: not an ECFR document (${xml.slice(0, 120)})`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, xml, "utf-8");
  return file;
}

/** Resolve a version argument: a date fetches from the versioner, anything else is a local XML path. */
export async function resolveVersion(title: number, arg: string, rawRoot: string): Promise<{ file: string; label: string }> {
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) return { file: await fetchVersionerTitle(title, arg, rawRoot), label: arg };
  if (!existsSync(arg)) throw new Error(`${arg}: not a date (YYYY-MM-DD) and not a file`);
  return { file: arg, label: arg.replace(/\\/g, "/") };
}

export async function alignCommand(source: string, oldArg: string, newArg: string, o: { out?: string; rawRoot?: string }): Promise<AlignResult> {
  const title = Number(source.replace(/^cfr-title-/, ""));
  if (!title) throw new Error(`align: source must be cfr-title-N (got ${source})`);
  const rawRoot = o.rawRoot ?? "raw";
  const oldV = await resolveVersion(title, oldArg, rawRoot);
  const newV = await resolveVersion(title, newArg, rawRoot);
  const result = alignEcfr(readFileSync(oldV.file, "utf-8"), readFileSync(newV.file, "utf-8"), title, { old: oldV.label, new: newV.label });
  const out = o.out ?? "changes.json";
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n", "utf-8");
  return result;
}
