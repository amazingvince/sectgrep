#!/usr/bin/env node
// sect-harness ingest --input DIR --source NAME --corpus ROOT [--staging DIR] [--sect BIN]
//   [--raw-root DIR] [--work DIR] [--concurrency N] [--limit N] [--dry-run] [--skill PATH] [--json]
// One ingest run over WS2's output for one source, into staging/<run_id>/ (spec D.2).
import { ingest, resubmit } from "./ingest.js";
import { mergeRun, rollback } from "./merge.js";
import { resolveConflict } from "./resolve.js";
import { drawSample, grade, readState, sampleMarkdown, writeState } from "./sampling.js";
import { verifyRun, type VerifyReport } from "./verifier.js";
import { loadDotEnv } from "@sectgrep/convert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { proposeKnowledge, reviewKnowledge } from "./knowledge.js";
import { runPipeline, loadManifest } from "./pipeline/pipeline.js";
import { stageStatus } from "./pipeline/stages.js";
import { ReviewStore } from "./pipeline/review.js";
import { startReviewServer } from "./pipeline/server.js";
import { Budget } from "./pipeline/budget.js";
import { prepareBenchmark, freezeBenchmark, benchmarkJsonLines } from "./pipeline/benchmark.js";

// The nearest .env supplies the keys and model choices for every command; the shell wins over it.
loadDotEnv();

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const cmd = process.argv[2];
const review = arg("review", "review")!;
if (cmd === "pipeline" || cmd === "review") {
  try {
    if (cmd === "review") {
      const run=arg("run"); if(!run)throw new Error("usage: sect-harness review --run DIRECTORY [--import decisions.json | --export output.json | --port N]");
      if(arg("import")||arg("export")||arg("profile-item")) {
        const store=new ReviewStore(path.resolve(run));try {
          if(arg("import"))console.log(JSON.stringify(store.import(JSON.parse(readFileSync(arg("import")!,"utf8"))),null,2));
          if(arg("export"))writeFileSync(arg("export")!,JSON.stringify(store.export(),null,2)+"\n",{flag:"wx"});
          if(arg("profile-item")){if(!arg("out"))throw new Error("profile export requires --out NEW_PROFILE.json");writeFileSync(arg("out")!,JSON.stringify(store.approvedProfile(arg("profile-item")!),null,2)+"\n",{flag:"wx"});}
        }finally{store.close();}
      }else{const server=await startReviewServer(run,Number(arg("port","0")));console.log(server.url);}
    }else{
      const action=process.argv[3];const file=arg("manifest");if(!file||!["run","resume","status","publish","benchmark","freeze","gold"].includes(action))throw new Error("usage: sect-harness pipeline run|resume|status|publish|benchmark|freeze|gold --manifest FILE");
      if(action==="benchmark")console.log(JSON.stringify(prepareBenchmark(file)));
      else if(action==="freeze"){if(!arg("recipes")||!arg("topic-review"))throw new Error("freeze requires --recipes FILE --topic-review FILE");console.log(JSON.stringify(freezeBenchmark(file,arg("recipes")!,arg("topic-review")!)));}
      else if(action==="gold"){if(!arg("out"))throw new Error("gold requires --out NEW_FILE.jsonl");const m=loadManifest(file);writeFileSync(arg("out")!,benchmarkJsonLines(m.run,arg("split")==="heldout"?"heldout":"tuning"),{flag:"wx"});}
      else if(action==="status"){
        const m=loadManifest(file);const budget=new Budget(path.join(m.campaign,"budget.sqlite"));try{console.log(JSON.stringify({run:m.run,budget:budget.status(),stages:stageStatus(m.run,m.sources.map(s=>s.id))},null,2));}finally{budget.close();}
      }else{
        const result=await runPipeline(file,{publish:action==="publish",log:line=>console.error(line)});
        console.log(JSON.stringify({...result,stages:undefined},null,2));
      }
    }
  }catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
} else if (cmd === "knowledge-propose" || cmd === "knowledge-review") {
  try {
    if (cmd === "knowledge-propose") {
      if (!arg("candidate") || !arg("corpus") || !arg("run")) throw new Error("usage: knowledge-propose --candidate artifact.json --corpus CORPUS --run NEW_DIRECTORY");
      console.log(JSON.stringify(proposeKnowledge(arg("candidate")!, arg("corpus")!, arg("run")!), null, 2));
    } else {
      if (!arg("run") || !arg("decisions") || !arg("out")) throw new Error("usage: knowledge-review --run DIRECTORY --decisions REVIEW.json --out NEW.knowledge.json");
      const artifact = reviewKnowledge(arg("run")!, arg("decisions")!, arg("out")!);
      console.log(JSON.stringify({ output: arg("out"), concepts: artifact.concepts.length, relations: artifact.relations.length }));
    }
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
} else if (cmd === "verify") {
  // sect-harness verify --run DIR --input DIR --source NAME --corpus ROOT [--review DIR] [--concurrency N] [--limit N]
  if (!arg("run") || !arg("input") || !arg("source") || !arg("corpus")) {
    console.error("usage: sect-harness verify --run staging/<run_id> --input DIR --source NAME --corpus ROOT [--staging staging] [--review review] [--work work] [--concurrency 8] [--limit N] [--json]");
    process.exit(2);
  }
  const level = readState(review, arg("source")!).level;
  verifyRun({ runDir: arg("run")!, input: arg("input")!, source: arg("source")!, corpus: arg("corpus")!, staging: arg("staging", "staging")!, review, work: arg("work"), sectBin: arg("sect"), concurrency: arg("concurrency") ? Number(arg("concurrency")) : process.env.SECT_VERIFIER_CONCURRENCY ? Number(process.env.SECT_VERIFIER_CONCURRENCY) : undefined, limit: arg("limit") ? Number(arg("limit")) : undefined, level, log: process.argv.includes("--json") ? (l) => console.error(l) : undefined })
    .then((r) => {
      if (process.argv.includes("--json")) console.log(JSON.stringify({ ...r, sections: undefined }, null, 2));
      else console.log(`${r.run_id}: ${r.counts.auto} auto, ${r.counts.conflict} conflict of ${r.counts.sections} sections; agreement ${(100 * r.agreement_rate).toFixed(1)}% on ${r.counts.judgments} judgment fields (${r.counts.deterministic} deterministic); ${r.counts.evidence_fails} evidence failure(s); verifier ${r.verifier.model}, ${r.usage.calls} call(s), $${r.usage.cost.toFixed(4)} -> ${review}/${r.run_id}.md`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
} else if (cmd === "merge") {
  // sect-harness merge --run DIR --source NAME --corpus ROOT [--commit] [--sect BIN] [--review DIR]
  if (!arg("run") || !arg("source") || !arg("corpus")) {
    console.error("usage: sect-harness merge --run staging/<run_id> --source NAME --corpus corpus [--commit] [--sect BIN] [--review review]");
    process.exit(2);
  }
  try {
    const r = mergeRun({ runDir: arg("run")!, source: arg("source")!, corpus: arg("corpus")!, review, sectBin: arg("sect"), commit: process.argv.includes("--commit") });
    console.log(`${r.run_id}: ${r.merged} section(s) merged into ${r.corpus} (${r.unchanged} already there unchanged), ${r.held} held for review (${r.blocked} blocked by links to held sections); index ${r.indexed ? "refreshed" : "not refreshed"}; ${r.commit ? `commit ${r.commit.slice(0, 10)}` : "not committed (pass --commit)"}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
} else if (cmd === "rollback") {
  // sect-harness rollback --commit SHA --corpus ROOT [--sect BIN]
  if (!arg("commit") || !arg("corpus")) {
    console.error("usage: sect-harness rollback --commit SHA --corpus corpus [--sect BIN]");
    process.exit(2);
  }
  try {
    const r = rollback(arg("commit")!, arg("corpus")!, arg("sect"));
    console.log(`reverted: HEAD is ${r.reverted.slice(0, 10)}; index ${r.indexed ? "refreshed" : "not refreshed"}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
} else if (cmd === "sample") {
  // sect-harness sample --run DIR --source NAME [--review DIR]
  if (!arg("run") || !arg("source")) {
    console.error("usage: sect-harness sample --run staging/<run_id> --source NAME [--review review]");
    process.exit(2);
  }
  const runDir = path.resolve(arg("run")!);
  const report = JSON.parse(readFileSync(path.join(runDir, "verify.json"), "utf-8")) as VerifyReport;
  const state = readState(review, arg("source")!);
  const sample = drawSample(report, arg("source")!, state.level);
  writeFileSync(path.join(runDir, "sample.json"), JSON.stringify(sample, null, 2) + "\n", "utf-8");
  mkdirSync(review, { recursive: true });
  writeFileSync(path.join(review, `${sample.run_id}-sample.md`), sampleMarkdown(sample), "utf-8");
  writeState(review, state);
  console.log(`${sample.run_id}: ${sample.items.length} item(s) drawn at ${sample.level} inspection (plan n=${sample.plan.n}, accept ${sample.plan.accept}) -> ${review}/${sample.run_id}-sample.md`);
} else if (cmd === "grade") {
  // sect-harness grade --run DIR --id ID --ok|--error [--note TEXT] [--review DIR]
  if (!arg("run") || !arg("id") || !(process.argv.includes("--ok") || process.argv.includes("--error"))) {
    console.error("usage: sect-harness grade --run staging/<run_id> --id <section id> --ok|--error [--note TEXT] [--review review]");
    process.exit(2);
  }
  const r = grade(path.resolve(arg("run")!), review, arg("id")!, process.argv.includes("--ok"), arg("note"));
  console.log(`${arg("id")}: ${process.argv.includes("--ok") ? "ok" : "error"}; lot ${r.lot?.graded}/${r.lot?.n} graded, ${r.lot?.errors} error(s), ${r.lot?.accepted === null ? "open" : r.lot?.accepted ? "accepted" : "rejected"}; inspection level for ${r.sample.source} is now ${r.level}`);
} else if (cmd === "resolve") {
  // sect-harness resolve --run <run_id|DIR> --id ID --pick ingest|verifier|none|<id> --input DIR --source NAME --corpus ROOT
  //   [--text "<reference>"] [--why "<sentence>"] [--staging DIR] [--review DIR] [--sect BIN] [--skill PATH] [--commit] [--no-merge]
  if (!arg("run") || !arg("id") || !arg("pick") || !arg("input") || !arg("source") || !arg("corpus")) {
    console.error('usage: sect-harness resolve --run <run_id> --id <section id> --pick ingest|verifier|none|<id> --input DIR --source NAME --corpus corpus [--text "<reference>"] [--why "<sentence>"] [--staging staging] [--review review] [--sect BIN] [--skill docs/SKILL-ingest.md] [--commit] [--no-merge]');
    process.exit(2);
  }
  const given = arg("run")!;
  const runDir = existsSync(given) ? given : path.join(arg("staging", "staging")!, given);
  try {
    const r = resolveConflict({ runDir, id: arg("id")!, pick: arg("pick")!, text: arg("text"), why: arg("why"), input: arg("input")!, source: arg("source")!, corpus: arg("corpus")!, review, sectBin: arg("sect"), rawRoot: arg("raw-root"), work: arg("work"), skillPath: arg("skill"), commit: process.argv.includes("--commit"), noMerge: process.argv.includes("--no-merge") });
    console.log(`${r.id}: ${r.applied.length} decision(s) applied, tier ${r.tier}${r.remaining ? ` (${r.remaining} still open)` : ""}${r.merge ? `; merged ${r.merge.merged} section(s) (${r.merge.unchanged} unchanged, ${r.merge.held} held)${r.merge.commit ? `, commit ${r.merge.commit.slice(0, 10)}` : ""}` : ""}`);
    process.exit(0);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
} else if (cmd === "resubmit") {
  // sect-harness resubmit --run DIR --input DIR --source NAME --corpus ROOT [--staging DIR] [--sect BIN]
  if (!arg("run") || !arg("input") || !arg("source") || !arg("corpus")) {
    console.error("usage: sect-harness resubmit --run staging/<run_id> --input DIR --source NAME --corpus ROOT [--staging staging] [--sect BIN] [--raw-root .] [--work work]");
    process.exit(2);
  }
  const r = resubmit({ runDir: arg("run")!, input: arg("input")!, source: arg("source")!, corpus: arg("corpus")!, staging: arg("staging", "staging")!, sectBin: arg("sect"), rawRoot: arg("raw-root"), work: arg("work"), only: arg("only") });
  console.log(`${r.runId}: ${r.staged} section(s) re-staged, ${r.strays.length} stray file(s) removed; ${r.summary ? `submitted: ${r.summary.xrefs_resolved} reference(s), ${r.summary.low_confidence.length} low-confidence, ${r.summary.flags.length} flag(s)` : `not submitted: ${r.errors} validator error(s)`}`);
  process.exit(r.summary ? 0 : 1);
} else if (cmd !== "ingest" || !arg("input") || !arg("source") || !arg("corpus")) {
  console.error("usage: sect-harness ingest --input DIR --source NAME --corpus ROOT [--staging staging] [--sect BIN] [--raw-root .] [--work work] [--concurrency 4] [--limit N] [--dry-run] [--skill docs/SKILL-ingest.md] [--json]");
  process.exit(2);
} else {
ingest({
  input: arg("input")!,
  source: arg("source")!,
  corpus: arg("corpus")!,
  staging: arg("staging", "staging")!,
  sectBin: arg("sect"),
  rawRoot: arg("raw-root"),
  work: arg("work"),
  concurrency: arg("concurrency") ? Number(arg("concurrency")) : process.env.SECT_INGEST_CONCURRENCY ? Number(process.env.SECT_INGEST_CONCURRENCY) : undefined,
  limit: arg("limit") ? Number(arg("limit")) : undefined,
  only: arg("only"),
  resume: process.argv.includes("--resume"),
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
}
