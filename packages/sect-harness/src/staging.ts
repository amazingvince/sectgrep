// Staging: where an ingest run writes and nothing else does (spec D.1). One directory per run,
// `staging/<run_id>/`, in the B.2 layout, so the validators and `sect index` read it as a corpus.
// Runs are idempotent per raw hash (a ledger remembers submitted runs) and serialized per source
// (a lock directory per source). The path guard here is what `beforeToolCall` enforces.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface RunEntry {
  run_id: string;
  source: string;
  raw_sha256: string;
  input: string;
  started: string;
  finished?: string;
  status: "running" | "submitted" | "failed";
  summary?: Record<string, unknown>;
}

export interface Ledger {
  runs: Record<string, RunEntry>;
}

/** `cfr-title-4-3f1a...`: the source and the first twelve hex digits of the raw document's hash. */
export function runIdFor(source: string, rawSha256: string): string {
  const safe = source.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${safe}-${rawSha256.slice(0, 12)}`;
}

export function runDir(stagingRoot: string, runId: string): string {
  return path.resolve(stagingRoot, runId);
}

/**
 * Whether `candidate` (relative to the run directory, or absolute) stays inside it. Rejects
 * absolute paths elsewhere, `..` escapes, and the run's own bookkeeping files.
 */
export function insideRun(runDirAbs: string, candidate: string): boolean {
  if (!candidate || candidate.includes("\0")) return false;
  const base = path.resolve(runDirAbs);
  const target = path.resolve(base, candidate);
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const top = rel.split(/[\\/]/)[0];
  return top !== ".ingest" && top !== "submit.json" && top !== "usage.json";
}

const ledgerPath = (stagingRoot: string) => path.join(stagingRoot, ".runs.json");

export function readLedger(stagingRoot: string): Ledger {
  const p = ledgerPath(stagingRoot);
  if (!existsSync(p)) return { runs: {} };
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Ledger;
  } catch {
    return { runs: {} };
  }
}

export function writeLedger(stagingRoot: string, ledger: Ledger): void {
  mkdirSync(stagingRoot, { recursive: true });
  writeFileSync(ledgerPath(stagingRoot), JSON.stringify(ledger, null, 2) + "\n", "utf-8");
}

/**
 * Claim a run for a raw hash. A run already submitted for the same source and hash is returned
 * as `existing` and nothing is written: the same document ingests once.
 */
export function claimRun(stagingRoot: string, entry: Omit<RunEntry, "started" | "status">): { existing?: RunEntry; entry: RunEntry } {
  const ledger = readLedger(stagingRoot);
  const prior = ledger.runs[entry.run_id];
  if (prior && prior.status === "submitted") return { existing: prior, entry: prior };
  const fresh: RunEntry = { ...entry, started: new Date().toISOString(), status: "running" };
  ledger.runs[entry.run_id] = fresh;
  writeLedger(stagingRoot, ledger);
  return { entry: fresh };
}

export function finishRun(stagingRoot: string, runId: string, status: RunEntry["status"], summary?: Record<string, unknown>): void {
  const ledger = readLedger(stagingRoot);
  const e = ledger.runs[runId];
  if (!e) return;
  e.status = status;
  e.finished = new Date().toISOString();
  if (summary) e.summary = summary;
  writeLedger(stagingRoot, ledger);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * One run per source at a time: a lock directory named after the source, holding the owner's
 * pid. A lock whose owner is gone is stale and taken over. Returns a release function.
 */
export function lockSource(stagingRoot: string, source: string, pid = process.pid): () => void {
  const dir = path.join(stagingRoot, ".locks");
  mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, source.replace(/[^A-Za-z0-9._-]+/g, "-"));
  const pidFile = path.join(lock, "pid");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
      writeFileSync(pidFile, String(pid), "utf-8");
      return () => rmSync(lock, { recursive: true, force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const owner = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf-8").trim()) : NaN;
      if (owner && owner !== pid && alive(owner)) throw new Error(`source ${source} is locked by run in process ${owner}; runs are serialized per source`);
      rmSync(lock, { recursive: true, force: true });
    }
  }
  throw new Error(`could not lock source ${source}`);
}
