// Spec D.3 layer 4: acceptance sampling. After a merge, N items per source per run are drawn
// (stratified by part) for a person to grade; the observed error rate moves the thresholds the
// next run's consensus uses. The procedure follows ANSI/ASQ Z1.4 attribute sampling: a lot is the
// run's merged items, inspection is normal, tightened, or reduced, the switching rules are the
// standard's (tightened after 2 of 5 consecutive lots rejected, back to normal after 5 accepted
// in a row, reduced after 10 accepted in a row with the error rate under 2 percent, back to
// normal on any rejection), and the acceptance number is zero. Sample sizes are the spec's
// default of 20 at normal inspection, with the standard's neighbouring sizes 32 and 8 for
// tightened and reduced (decisions #43).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SamplingLevel, VerifyReport } from "./verifier.js";

export interface Plan {
  level: SamplingLevel;
  n: number;
  accept: number;
}

export interface Lot {
  run_id: string;
  date: string;
  n: number;
  graded: number;
  errors: number;
  accepted: boolean | null;
}

export interface SamplingState {
  source: string;
  level: SamplingLevel;
  lots: Lot[];
}

export interface SampleItem {
  id: string;
  path: string;
  stratum: string;
  fields: string[];
  grade: "ok" | "error" | null;
  note?: string;
}

export interface Sample {
  run_id: string;
  source: string;
  level: SamplingLevel;
  plan: Plan;
  items: SampleItem[];
}

export function plan(level: SamplingLevel): Plan {
  return { level, n: level === "tightened" ? 32 : level === "reduced" ? 8 : 20, accept: 0 };
}

const stateFile = (review: string, source: string) => path.join(review, "sampling", `${source.replace(/[^A-Za-z0-9._-]+/g, "-")}.json`);

export function readState(review: string, source: string): SamplingState {
  const f = stateFile(review, source);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf-8")) as SamplingState) : { source, level: "normal", lots: [] };
}

export function writeState(review: string, state: SamplingState): void {
  const f = stateFile(review, state.source);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/** Z1.4 switching over the graded lots. */
export function nextLevel(state: SamplingState): SamplingLevel {
  const graded = state.lots.filter((l) => l.accepted !== null);
  const last = (k: number) => graded.slice(-k);
  const rate = graded.reduce((n, l) => n + l.errors, 0) / Math.max(1, graded.reduce((n, l) => n + l.graded, 0));
  if (state.level === "tightened") return last(5).length === 5 && last(5).every((l) => l.accepted) ? "normal" : "tightened";
  if (state.level === "reduced") return graded.length && !graded[graded.length - 1].accepted ? "normal" : "reduced";
  if (last(5).filter((l) => !l.accepted).length >= 2) return "tightened";
  if (last(10).length === 10 && last(10).every((l) => l.accepted) && rate < 0.02) return "reduced";
  return "normal";
}

/** A deterministic stratified draw from the auto tier: round-robin over parts, ordered by id. */
export function drawSample(report: VerifyReport, source: string, level: SamplingLevel): Sample {
  const p = plan(level);
  // Judged sections first (they are what a grade can catch); the rest of the auto tier follows.
  const auto = [...report.sections.filter((s) => s.tier === "auto" && s.judgments.length), ...report.sections.filter((s) => s.tier === "auto" && !s.judgments.length)];
  const strata = new Map<string, typeof auto>();
  for (const s of auto) {
    const parts = s.path.split("/");
    const stratum = parts.length > 2 ? parts.slice(1, -2).join("/") || parts[1] : parts[0];
    strata.set(stratum, [...(strata.get(stratum) ?? []), s]);
  }
  for (const list of strata.values()) list.sort((a, b) => Number(!!b.judgments.length) - Number(!!a.judgments.length) || a.id.localeCompare(b.id));
  const keys = [...strata.keys()].sort();
  const items: SampleItem[] = [];
  const cursors = new Map(keys.map((k) => [k, 0]));
  while (items.length < p.n) {
    let progressed = false;
    for (const k of keys) {
      const list = strata.get(k)!;
      const i = cursors.get(k)!;
      if (i >= list.length) continue;
      cursors.set(k, i + 1);
      const s = list[i];
      items.push({ id: s.id, path: s.path, stratum: k, fields: s.judgments.map((j) => `${j.field}${j.text ? ` "${j.text}"` : ""}: ${j.ingest}`), grade: null });
      progressed = true;
      if (items.length >= p.n) break;
    }
    if (!progressed) break;
  }
  return { run_id: report.run_id, source, level, plan: p, items };
}

/** The grading template a person fills in. */
export function sampleMarkdown(s: Sample): string {
  const md = [`# Sample to grade: ${s.run_id}`, "", `${s.items.length} merged items of ${s.source}, drawn stratified by part at ${s.level} inspection (plan n=${s.plan.n}, accept ${s.plan.accept}). Grade each item ok or error with \`sect-harness grade --run <dir> --id <id> --ok|--error [--note ...]\`; the lot is accepted when errors do not exceed ${s.plan.accept}. Every error graded becomes a schema example or a validator rule.`, ""];
  for (const it of s.items) {
    md.push(`## ${it.id}`, "", `\`${it.path}\` (stratum ${it.stratum})`, "");
    for (const f of it.fields) md.push(`- ${f}`);
    md.push("", `Grade: ${it.grade ?? "[ ] ok  [ ] error"}${it.note ? ` — ${it.note}` : ""}`, "");
  }
  return md.join("\n") + "\n";
}

/** Record one grade; when the lot is fully graded, decide it and move the source's level. */
export function grade(runDir: string, review: string, id: string, ok: boolean, note?: string): { sample: Sample; lot: Lot | null; level: SamplingLevel } {
  const f = path.join(runDir, "sample.json");
  const sample = JSON.parse(readFileSync(f, "utf-8")) as Sample;
  const item = sample.items.find((i) => i.id === id);
  if (!item) throw new Error(`${id} is not in the sample`);
  item.grade = ok ? "ok" : "error";
  if (note) item.note = note;
  writeFileSync(f, JSON.stringify(sample, null, 2) + "\n", "utf-8");
  writeFileSync(path.join(review, `${sample.run_id}-sample.md`), sampleMarkdown(sample), "utf-8");
  const state = readState(review, sample.source);
  const graded = sample.items.filter((i) => i.grade).length;
  const errors = sample.items.filter((i) => i.grade === "error").length;
  let lot = state.lots.find((l) => l.run_id === sample.run_id) ?? null;
  if (!lot) {
    lot = { run_id: sample.run_id, date: new Date().toISOString().slice(0, 10), n: sample.items.length, graded: 0, errors: 0, accepted: null };
    state.lots.push(lot);
  }
  lot.graded = graded;
  lot.errors = errors;
  lot.accepted = graded === sample.items.length ? errors <= sample.plan.accept : null;
  state.level = nextLevel(state);
  writeState(review, state);
  return { sample, lot, level: state.level };
}
