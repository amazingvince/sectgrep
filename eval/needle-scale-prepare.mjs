/** Convert complete pinned titles with the existing native adapter in an isolated corpus. */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { convertEcfr } from "../packages/sect-convert/dist/ecfr.js";

const lockFile = "eval/corpora/needle-scale.lock.json";
const lockBytes = readFileSync(lockFile);
const lock = JSON.parse(lockBytes);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const corpus = resolve(process.argv[2] ?? "corpora/needle-scale-real-v3");
const only = process.argv[3];
if (!only) {
  if (existsSync(corpus)) throw new Error("destination exists; choose a new isolated corpus");
  mkdirSync(corpus, { recursive: true });
  const started = new Date().toISOString();
  const sources = [];
  for (const source of lock.sources) {
    const child = spawnSync(process.execPath, ["--max-old-space-size=12288", fileURLToPath(import.meta.url), corpus, String(source.title)], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.status !== 0) throw new Error(`Title ${source.title} conversion failed: ${child.stdout}`);
    const report = JSON.parse(child.stdout);
    sources.push(report);
    console.log(JSON.stringify(report));
  }
  const report = { schema_version: 1, purpose: "real native-XML scale diagnostic; no relevance labels", corpus, started,
    acquisition_sha256: sha(lockBytes), converter_sha256: sha(readFileSync("packages/sect-convert/dist/ecfr.js")),
    xml_helpers_sha256: sha(readFileSync("packages/sect-convert/dist/xml.js")), sources };
  mkdirSync(join(corpus, ".work"), { recursive: true });
  writeFileSync(join(corpus, ".work/scale-preparation.json"), JSON.stringify(report, null, 2) + "\n");
} else {
  const source = lock.sources.find((s) => s.title === Number(only));
  if (!source) throw new Error("title absent from frozen selection");
  const bytes = readFileSync(source.file);
  if (sha(bytes) !== source.sha256) throw new Error("frozen raw bytes changed");
  const root = join(corpus, `cfr-title-${source.title}`);
  if (existsSync(root)) throw new Error("source already exists");
  const raw = `cfr-title-${source.title}/raw.xml`;
  const start = performance.now();
  // These are simultaneously acquired current snapshots, not reconstructed legal
  // histories. A first-volume AMDDATE cannot date a complete multi-volume title.
  const observedDate = source.acquired_at.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(observedDate) || lock.sources.some((s) => s.acquired_at.slice(0, 10) !== observedDate)) {
    throw new Error("this workload requires one recorded observation day for all sources");
  }
  const result = convertEcfr(bytes.toString("utf8"), { title: source.title, rawPath: raw, effective: observedDate, ingestRun: "needle-scale-observed-snapshot" });
  const outputs = new Set(result.files.map((file) => file.path.toLowerCase()));
  if (outputs.size !== result.files.length) throw new Error("case-insensitive output paths collide");
  const markdown = result.files.filter((file) => file.path.endsWith(".md"));
  if (markdown.length !== result.nodes) throw new Error("canonical node output coverage mismatch");
  const ids = new Set(result.records.map((record) => record.id));
  if (ids.size !== result.nodes || result.records.some((record) => record.parent && !ids.has(record.parent))) {
    throw new Error("canonical identities or parent resolution failed");
  }
  for (const file of result.files) {
    const target = join(corpus, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.text, { flag: "wx" });
  }
  for (const file of result.files) {
    if (readFileSync(join(corpus, file.path), "utf8") !== file.text) throw new Error(`output readback mismatch: ${file.path}`);
  }
  copyFileSync(source.file, join(corpus, raw));
  const work = join(corpus, ".work", `cfr-title-${source.title}`);
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "candidates.jsonl"), result.candidates.map((c) => JSON.stringify(c)).join("\n") + "\n");
  console.log(JSON.stringify({ title: source.title, raw_sha256: source.sha256, raw_bytes: source.bytes,
    native_xml: source.xml_counts, sections: result.sections, nodes: result.nodes, files: result.files.length,
    navigation_nodes: markdown.filter((file) => /^retrieval_role: navigation$/m.test(file.text)).length,
    output_checks: { case_folded_unique_paths: outputs.size, canonical_ids: ids.size, parents_resolve: true, all_outputs_read_back: true },
    effective: result.effective, date_policy: "effective identifies the recorded acquisition-day snapshot, not legal commencement; per-section versioner dates not fetched; no historical qualification",
    conversion_ms: performance.now() - start, process_max_rss_kib: process.resourceUsage().maxRSS }));
}
