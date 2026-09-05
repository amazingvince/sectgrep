// Spec D.3: merge is staging to corpus/, `sect index`, git commit; rollback is git revert. Only
// the auto tier moves; conflicts stay in staging with the review file. Every merged section's
// provenance records both runs. This is the one path that writes to the corpus.

import { splitFrontMatter } from "@sectgrep/convert";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { assertBinding, bindVerification, within } from "./binding.js";
import path from "node:path";
import YAML from "yaml";
import type { VerifyReport } from "./verifier.js";
import { publishFilesSync } from "./pipeline/publication.js";

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
  assertBinding(runDir, report.binding);
  const corpus = path.resolve(o.corpus);
  const bin = o.sectBin ?? process.env.SECT_BIN ?? "sect";
  const executable = bin.includes("/") || bin.includes("\\") ? path.resolve(bin) : bin;
  const probe = spawnSync(executable, ["--version"], { encoding: "utf-8" });
  if (probe.status !== 0) throw new Error("merge requires a working sect binary; set SECT_BIN");
  const before = new Map<string, Buffer | null>();
  const pending = new Map<string, string | Buffer>();
  const put = (file: string, data: string | Buffer) => {
    within(corpus, path.relative(corpus, file));
    if (!before.has(file)) before.set(file, existsSync(file) ? readFileSync(file) : null);
    mkdirSync(path.dirname(file), { recursive: true });
    pending.set(path.relative(corpus,file).replaceAll("\\","/"), data);
  };
  mkdirSync(path.join(corpus, ".sect"), { recursive: true });
  let published = false;
  try {
  // A run may hold several source directories: the notice's own and the base sources whose
  // Expressions it amended. Each travels with its registry entry.
  const sourceDirs = readdirSync(runDir).filter((n) => !n.startsWith(".") && existsSync(path.join(runDir, n, "_source.yaml")));
  if (!sourceDirs.includes(o.source)) sourceDirs.push(o.source);
  for (const n of sourceDirs) {
    const y = path.join(runDir, n, "_source.yaml");
    mkdirSync(path.join(corpus, n), { recursive: true });
    if (existsSync(y) && !existsSync(path.join(corpus, n, "_source.yaml"))) put(path.join(corpus, n, "_source.yaml"), readFileSync(y));
  }
  const dstDir = path.join(corpus, o.source);
  // A section that links to a held section of this run would leave a dangling link in the
  // corpus; it is held too, until the conflict is resolved. Links to ids already in the corpus
  // are fine. Repeated until nothing more is held.
  const known = corpusIds(corpus);
  const held = new Map<string, string>();
  for (const s of report.sections) if (s.tier !== "auto") held.set(s.id, "conflict");
  const bodies = new Map<string, string>();
  const amendedBy = new Map<string, string[]>();
  // A node other nodes name as their parent is structural: its listing is derived.
  const parents = new Set<string>();
  for (const s of report.sections) {
    const from = within(runDir, s.path);
    if (!existsSync(from)) continue;
    const split = splitFrontMatter(readFileSync(from, "utf-8"));
    bodies.set(s.id, split?.body ?? "");
    const fm = (YAML.parse(split?.front ?? "") ?? {}) as { parent?: unknown; amended_by?: unknown };
    if (fm.parent && typeof fm.parent === "string") parents.add(fm.parent);
    if (Array.isArray(fm.amended_by)) amendedBy.set(s.id, fm.amended_by.map(String));
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
        continue;
      }
      // An amended Expression travels with its notice: without the notice its Actions do not exist.
      const notice = (amendedBy.get(s.id) ?? []).map((r) => r.split("#")[0]).find((n) => held.has(n) && !known.has(n));
      if (notice) {
        held.set(s.id, `amended by ${notice}, which is held`);
        changed = true;
      }
    }
  }
  const blocked = [...held].filter(([, why]) => why !== "conflict");
  let merged = 0;
  let unchanged = 0;
  let priors = 0;
  const mergedPaths = new Set<string>();
  for (const s of report.sections) {
    if (held.has(s.id)) continue;
    const from = within(runDir, s.path);
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
    const to = within(corpus, s.path);
    mkdirSync(path.dirname(to), { recursive: true });
    const { body, delinked } = delinkHeld(split.body, held);
    if (delinked.length) log(`${s.id}: ${delinked.length} listing entr${delinked.length === 1 ? "y" : "ies"} de-linked (held: ${delinked.join(", ")})`);
    const out = `---\n${YAML.stringify(front, { lineWidth: 0 }).trimEnd()}\n---\n${body.startsWith("\n") ? "" : "\n"}${body}`;
    if (existsSync(to) && readFileSync(to, "utf-8") === out) {
      unchanged++;
      continue;
    }
    put(to, out);
    merged++;
    mergedPaths.add(s.path.replace(/\\/g, "/"));
  }
  // The prior Expression of every merged Work travels with it, under its dated name.
  const walkPriors = (d: string) => {
    if (!existsSync(d)) return;
    for (const n of readdirSync(d)) {
      if (n.startsWith(".")) continue;
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walkPriors(p);
      else if (/@\d{4}-\d{2}-\d{2}\.md$/.test(n)) {
        const rel = path.relative(runDir, p).replace(/\\/g, "/");
        const work = rel.replace(/@\d{4}-\d{2}-\d{2}\.md$/, ".md");
        if (!mergedPaths.has(work)) continue;
        const to = path.join(corpus, rel);
        const text = readFileSync(p, "utf-8");
        if (existsSync(to) && readFileSync(to, "utf-8") === text) continue;
        mkdirSync(path.dirname(to), { recursive: true });
        put(to, text);
        priors++;
      }
    }
  };
  for (const n of sourceDirs) walkPriors(path.join(runDir, n));
  let indexed = false;
  if (bin) {
    publishFilesSync(corpus, Object.fromEntries(pending), executable, phase => assertBinding(runDir, phase==="before"?report.binding:{...report.binding!,dependencies:report.binding!.dependencies.filter(d=>path.resolve(d.root)!==corpus)}));
    indexed = true;
  } else log("no sect binary (SECT_BIN); the corpus index is not refreshed");
  published = true;
  let commit: string | null = null;
  if (o.commit) {
    const top = git(corpus, ["rev-parse", "--show-toplevel"]);
    if (!top.ok) throw new Error(`${corpus} is not inside a git repository: ${top.out}`);
    const root = top.out.replace(/\\/g, "/");
    const rels = [...before.keys()].map((file) => path.relative(root, file).replace(/\\/g, "/"));
    if (!rels.length) return { run_id: runId, merged, held: held.size, blocked: blocked.length, commit: null, indexed, corpus, unchanged };
    git(root, ["add", "--", ...rels]);
    const msg = `merge ${runId}: ${merged} section(s) of ${o.source}${priors ? ` and ${priors} superseded prior Expression(s)` : ""}${held.size ? ` (${held.size} held for review, ${blocked.length} of them blocked by links to held sections)` : ""}\n\nVerifier ${report.verifier.provider} ${report.verifier.model}; agreement ${(100 * report.agreement_rate).toFixed(1)}% on ${report.counts.judgments} judgment fields.`;
    const c = git(root, ["commit", "-q", "-m", msg, "--", ...rels]);
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
  void dstDir;
  report.binding = bindVerification(runDir, report.binding!.dependencies.map((d) => d.root));
  writeFileSync(verifyFile, JSON.stringify(report, null, 2) + "\n");
  return { run_id: runId, merged, held: held.size, blocked: blocked.length, commit, indexed, corpus, unchanged };
  } catch (error) {
    if (!published) for (const [file, bytes] of [...before].reverse()) {
      if (bytes === null) { if (existsSync(file)) unlinkSync(file); }
      else writeFileSync(file, bytes);
    }
    throw error;
  }
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
