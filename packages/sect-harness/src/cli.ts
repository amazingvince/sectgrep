#!/usr/bin/env node
// sect-harness ingest --input DIR --source NAME --corpus ROOT [--staging DIR] [--sect BIN]
//   [--raw-root DIR] [--work DIR] [--concurrency N] [--limit N] [--dry-run] [--skill PATH] [--json]
// One ingest run over WS2's output for one source, into staging/<run_id>/ (spec D.2).
import { ingest } from "./ingest.js";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const cmd = process.argv[2];
if (cmd !== "ingest" || !arg("input") || !arg("source") || !arg("corpus")) {
  console.error("usage: sect-harness ingest --input DIR --source NAME --corpus ROOT [--staging staging] [--sect BIN] [--raw-root .] [--work work] [--concurrency 4] [--limit N] [--dry-run] [--skill docs/SKILL-ingest.md] [--json]");
  process.exit(2);
}
ingest({
  input: arg("input")!,
  source: arg("source")!,
  corpus: arg("corpus")!,
  staging: arg("staging", "staging")!,
  sectBin: arg("sect"),
  rawRoot: arg("raw-root"),
  work: arg("work"),
  concurrency: arg("concurrency") ? Number(arg("concurrency")) : undefined,
  limit: arg("limit") ? Number(arg("limit")) : undefined,
  dryRun: process.argv.includes("--dry-run"),
  skillPath: arg("skill"),
  log: process.argv.includes("--json") ? (l) => console.error(l) : undefined,
})
  .then((r) => {
    if (process.argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
    else {
      const s = r.summary;
      console.log(`run ${r.runId}${r.reused ? " (reused)" : ""}: ${r.staged}/${r.sections} section(s) staged, ${r.failed.length} failed, ${r.fixRounds} fix round(s); ${s ? `submitted: ${s.xrefs_resolved} reference(s) resolved (${s.low_confidence.length} low-confidence), ${s.flags.length} flag(s), ${s.warnings} warning(s)` : `not submitted: ${r.errors} validator error(s)`}; ${r.usage.calls} model call(s), ${r.usage.input + r.usage.output} tokens, $${r.usage.cost.toFixed(4)} -> ${r.runDir}`);
    }
    process.exit(r.summary ? 0 : 1);
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
