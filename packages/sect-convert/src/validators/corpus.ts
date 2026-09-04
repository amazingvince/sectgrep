// A staging directory or corpus root in the B.2 layout, read for the C.5 validators: every
// markdown file's front matter and body, and the nearest `_source.yaml` above each file.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";

export interface Action {
  action_id: string;
  notice?: string;
  target_id: string;
  target_anchor?: string | null;
  kind: string;
  effective?: string;
  text?: string;
}

export interface Front {
  id: string;
  node?: string | null;
  source?: string;
  kind?: string;
  title?: string;
  level?: string;
  parent?: string | null;
  effective?: string | null;
  supersedes?: string | null;
  superseded_by?: string | null;
  amended_by?: string[];
  overrides?: string[];
  narrows?: string[];
  defines?: string[];
  context?: string;
  provenance?: Record<string, unknown> | null;
  actions?: Action[];
  sources?: Array<{ id?: string; hash?: string }>;
  [k: string]: unknown;
}

export interface SourceInfo {
  dir: string;
  name: string;
  kind: string;
  precedence: number;
  id_prefix: string;
  legal_status?: string;
}

export interface Doc {
  /** Absolute path. */
  path: string;
  /** Path relative to the root it was read from. */
  rel: string;
  front: Front;
  body: string;
  source: SourceInfo | null;
}

export interface Corpus {
  root: string;
  docs: Doc[];
  sources: Map<string, SourceInfo>;
}

/** Markdown files under a root, skipping hidden directories (`.sect`, `.work`). */
export function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue;
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".md")) out.push(p);
    }
  };
  walk(root);
  return out;
}

export function splitFrontMatter(text: string): { front: string; body: string } | null {
  const t = text.replace(/^﻿/, "");
  if (!t.startsWith("---")) return null;
  const end = t.indexOf("\n---", 3);
  if (end < 0) return null;
  const after = t.indexOf("\n", end + 1);
  return { front: t.slice(4, end), body: after < 0 ? "" : t.slice(after + 1) };
}

export function parseDoc(root: string, file: string, sources: Map<string, SourceInfo>): Doc {
  const text = readFileSync(file, "utf-8");
  const split = splitFrontMatter(text);
  if (!split) throw new Error(`${file}: no front matter`);
  const front = (YAML.parse(split.front) ?? {}) as Front;
  return { path: file, rel: path.relative(root, file).replace(/\\/g, "/"), front, body: split.body, source: sourceFor(root, file, sources) };
}

/** The nearest `_source.yaml` above the file, within the root. */
function sourceFor(root: string, file: string, sources: Map<string, SourceInfo>): SourceInfo | null {
  let dir = path.dirname(file);
  while (dir.startsWith(root)) {
    const s = sources.get(dir);
    if (s) return s;
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return null;
}

export function loadSources(root: string): Map<string, SourceInfo> {
  const out = new Map<string, SourceInfo>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue;
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === "_source.yaml") {
        const y = (YAML.parse(readFileSync(p, "utf-8")) ?? {}) as Record<string, unknown>;
        out.set(dir, { dir, name: String(y.name ?? path.basename(dir)), kind: String(y.kind ?? "base"), precedence: Number(y.precedence ?? 0), id_prefix: String(y.id_prefix ?? ""), legal_status: y.legal_status ? String(y.legal_status) : undefined });
      }
    }
  };
  walk(root);
  return out;
}

export function loadCorpus(root: string): Corpus {
  const abs = path.resolve(root);
  if (!existsSync(abs)) throw new Error(`${root}: not found`);
  const sources = loadSources(abs);
  const docs = walkMarkdown(abs).map((f) => parseDoc(abs, f, sources));
  return { root: abs, docs, sources };
}

/** `CFR:99-2.7@2026-01-01` -> id and date. */
export function splitExpr(ref: string): { id: string; date: string | null } {
  const at = ref.lastIndexOf("@");
  return at > 0 ? { id: ref.slice(0, at), date: ref.slice(at + 1) } : { id: ref, date: null };
}

export function dateOf(front: Front): string | null {
  const d = front.effective;
  return d ? String(d).slice(0, 10) : null;
}
