// Spec D.3: merge is staging to corpus/, `sect index`, git commit; rollback is git revert. Only
// the auto tier moves; conflicts stay in staging with the review file. Every merged section's
// provenance records both runs. This is the one path that writes to the corpus.

import { splitFrontMatter } from "@sectgrep/convert";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { VerifyReport } from "./verifier.js";

export interface MergeOptions {
  runDir: string;
  source: string;
  corpus: string;
  review?: string;
  sectBin?: string;
  /** Commit the merge in the corpus's repository. */
  commit?: boolean;
  log?: (line: string) => void;
}

export interface MergeResult {
  run_id: string;
  merged: number;
  held: number;
  /** Auto-tier sections held because they link to a held section of the same run. */
  blocked: number;
  commit: string | null;
  indexed: boolean;
  corpus: string;
  /** Auto-tier sections already in the corpus with the same content (a re-merge after a resolution). */
  unchanged: number;
}

/** Ids already in the corpus, from every front matter under it. */
function corpusIds(corpus: string): Set<string> {
  const ids = new Set<string>();
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const n of readdirSync(d)) {
      if (n.startsWith(".")) continue;
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".md")) {
        const m = /^id:\s*"?([^"\n]+?)"?\s*$/m.exec(readFileSync(p, "utf-8").slice(0, 400));
        if (m) ids.add(m[1].trim());
      }
    }
  };
  walk(corpus);
  return ids;
}

const linkTargets = (body: string): string[] => [...body.matchAll(/\]\(([A-Z][A-Z0-9]*:[^)\s#]+)(?:#[a-z0-9-]+)?\)/g)].map((m) => m[1]);

/** A listing line whose target is held becomes plain text with a marker: the listing is derived, not rule text. */
function delinkHeld(body: string, held: Map<string, string>): { body: string; delinked: string[] } {
  const delinked: string[] = [];
  // Link text may hold one level of brackets ("[Rule 2]").
  const out = body.replace(/^(\s*[-*]\s*)\[((?:[^\[\]]|\[[^\]]*\])*)\]\(([A-Z][A-Z0-9]*:[^)\s#]+)(?:#[a-z0-9-]+)?\)\s*$/gm, (m, bullet: string, text: string, id: string) => {
    if (!held.has(id)) return m;
    delinked.push(id);
    return `${bullet}${text} (held for review)`;
  });
  return { body: out, delinked };
}

/** git with an identity of last resort: a container or a CI runner has none configured. */
function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const identity = ["-c", "user.name=sect-harness", "-c", "user.email=sect-harness@localhost"];
  const configured = spawnSync("git", ["config", "user.email"], { cwd, encoding: "utf-8" }).status === 0;
  const r = spawnSync("git", [...(configured ? [] : identity), ...args], { cwd, encoding: "utf-8" });
  return { ok: r.status === 0, out: (r.stdout + r.stderr).trim() };
}

export function mergeRun(o: MergeOptions): MergeResult {
  const log = o.log ?? ((l: string) => console.log(l));
  const runDir = path.resolve(o.runDir);
  const runId = path.basename(runDir);
  const verifyFile = path.join(runDir, "verify.json");
  if (!existsSync(verifyFile)) throw new Error(`${o.runDir} has no verify.json; verify first`);
  if (!existsSync(path.join(runDir, "submit.json"))) throw new Error(`${o.runDir} was not submitted`);
  const report = JSON.parse(readFileSync(verifyFile, "utf-8")) as VerifyReport;
  const corpus = path.resolve(o.corpus);
  const srcDir = path.join(runDir, o.source);
  const dstDir = path.join(corpus, o.source);
  mkdirSync(dstDir, { recursive: true });
  const y = path.join(srcDir, "_source.yaml");
  if (existsSync(y)) writeFileSync(path.join(dstDir, "_source.yaml"), readFileSync(y), "utf-8");
  // A section that links to a held section of this run would leave a dangling link in the
  // corpus; it is held too, until the conflict is resolved. Links to ids already in the corpus
  // are fine. Repeated until nothing more is held.
  const known = corpusIds(corpus);
  const held = new Map<string, string>();
  for (const s of report.sections) if (s.tier !== "auto") held.set(s.id, "conflict");
  const bodies = new Map<string, string>();
  // A node other nodes name as their parent is structural: its listing is derived.
  const parents = new Set<string>();
  for (const s of report.sections) {
    const from = path.join(runDir, s.path);
    if (!existsSync(from)) continue;
    const split = splitFrontMatter(readFileSync(from, "utf-8"));
    bodies.set(s.id, split?.body ?? "");
    const parent = ((YAML.parse(split?.front ?? "") ?? {}) as { parent?: unknown }).parent;
    if (parent && typeof parent === "string") parents.add(parent);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of report.sections) {
      // A structural node's listing is derived: its held entries are de-linked at merge, not blocking.
      if (held.has(s.id) || parents.has(s.id)) continue;
      const blocker = linkTargets(bodies.get(s.id) ?? "").find((t) => held.has(t) && !known.has(t));
      if (blocker) {
        held.set(s.id, `links to ${blocker}, which is held`);
        changed = true;
      }
    }
  }
  const blocked = [...held].filter(([, why]) => why !== "conflict");
  let merged = 0;
  let unchanged = 0;
  for (const s of report.sections) {
    if (held.has(s.id)) continue;
    const from = path.join(runDir, s.path);
    if (!existsSync(from)) continue;
    const text = readFileSync(from, "utf-8");
    const split = splitFrontMatter(text);
    if (!split) continue;
    const front = (YAML.parse(split.front) ?? {}) as Record<string, unknown>;
    const prov = (front.provenance ?? {}) as Record<string, unknown>;
    const verified = Array.isArray(prov.verified_by) ? (prov.verified_by as unknown[]).map(String) : [];
    for (const tag of [`ingest:${runId}`, `verifier:${runId}`]) if (!verified.includes(tag)) verified.push(tag);
    prov.verified_by = verified;
    front.provenance = prov;
    const rel = path.relative(path.join(runDir, o.source), from);
    const to = path.join(dstDir, rel);
    mkdirSync(path.dirname(to), { recursive: true });
    const { body, delinked } = delinkHeld(split.body, held);
    if (delinked.length) log(`${s.id}: ${delinked.length} listing entr${delinked.length === 1 ? "y" : "ies"} de-linked (held: ${delinked.join(", ")})`);
    const out = `---\n${YAML.stringify(front, { lineWidth: 0 }).trimEnd()}\n---\n${body.startsWith("\n") ? "" : "\n"}${body}`;
    if (existsSync(to) && readFileSync(to, "utf-8") === out) {
      unchanged++;
      continue;
    }
    writeFileSync(to, out, "utf-8");
    merged++;
  }
  let indexed = false;
  const bin = o.sectBin ?? process.env.SECT_BIN;
  if (bin) {
    const r = spawnSync(bin.includes("/") || bin.includes("\\") ? path.resolve(bin) : bin, ["index", corpus], { encoding: "utf-8" });
    indexed = r.status === 0;
    if (!indexed) log(`sect index failed: ${(r.stderr || r.stdout).slice(0, 200)}`);
  } else log("no sect binary (SECT_BIN); the corpus index is not refreshed");
  let commit: string | null = null;
  if (o.commit) {
    const top = git(corpus, ["rev-parse", "--show-toplevel"]);
    if (!top.ok) throw new Error(`${corpus} is not inside a git repository: ${top.out}`);
    const root = top.out.replace(/\\/g, "/");
    const rel = path.relative(root, dstDir).replace(/\\/g, "/");
    git(root, ["add", "--", rel]);
    const msg = `merge ${runId}: ${merged} section(s) of ${o.source}${held.size ? ` (${held.size} held for review, ${blocked.length} of them blocked by links to held sections)` : ""}\n\nVerifier ${report.verifier.provider} ${report.verifier.model}; agreement ${(100 * report.agreement_rate).toFixed(1)}% on ${report.counts.judgments} judgment fields.`;
    const c = git(root, ["commit", "-q", "-m", msg, "--", rel]);
    if (!c.ok && !/nothing to commit/.test(c.out)) throw new Error(`git commit failed: ${c.out}`);
    commit = git(root, ["rev-parse", "HEAD"]).out;
  }
  const review = path.resolve(o.review ?? "review");
  mkdirSync(review, { recursive: true });
  if (blocked.length) {
    const reviewFile = path.join(review, `${runId}.md`);
    const note = ["", "## Blocked by conflicts", "", "Auto-tier sections held because they link to a held section of this run; they merge when the conflict is resolved.", "", ...blocked.map(([id, why]) => `- ${id}: ${why}`), ""].join("\n");
    if (existsSync(reviewFile) && !readFileSync(reviewFile, "utf-8").includes("## Blocked by conflicts")) appendFileSync(reviewFile, note, "utf-8");
  }
  appendFileSync(path.join(review, "merges.jsonl"), JSON.stringify({ run_id: runId, source: o.source, merged, unchanged, held: held.size, blocked: blocked.length, commit, indexed, date: new Date().toISOString() }) + "\n", "utf-8");
  return { run_id: runId, merged, held: held.size, blocked: blocked.length, commit, indexed, corpus, unchanged };
}

/** Rollback: `git revert` of a merge commit, then the index. */
export function rollback(commit: string, corpus: string, sectBin?: string): { reverted: string; indexed: boolean } {
  const top = git(path.resolve(corpus), ["rev-parse", "--show-toplevel"]);
  if (!top.ok) throw new Error(`${corpus} is not inside a git repository`);
  const r = git(top.out, ["revert", "--no-edit", commit]);
  if (!r.ok) throw new Error(`git revert failed: ${r.out}`);
  const bin = sectBin ?? process.env.SECT_BIN;
  let indexed = false;
  if (bin) indexed = spawnSync(bin.includes("/") || bin.includes("\\") ? path.resolve(bin) : bin, ["index", path.resolve(corpus)], { encoding: "utf-8" }).status === 0;
  return { reverted: git(top.out, ["rev-parse", "HEAD"]).out, indexed };
}
