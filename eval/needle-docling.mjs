// Isolated same-source parser comparison; no production parser selection or review receipts.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { readDoclingArtifact } from "../packages/sect-harness/dist/pipeline/parsers.js";
import {
  organizeDocument,
  reconcileIdentity,
} from "../packages/sect-convert/dist/document.js";
import { ingestFile } from "../packages/sect-convert/dist/ingest-file.js";

const input = path.resolve("review/needle-retrieval/inputs/attention-v7.pdf");
const artifact =
  process.argv[2] ?? "review/needle-retrieval/docling-attention-v2.json";
const output = path.resolve(
  process.argv[3] ?? "corpora/needle-docling-attention-v2",
);
const work = path.resolve(
  "review/needle-retrieval/docling-import-" + path.basename(output),
);
if (existsSync(output))
  throw new Error("destination exists; choose a new isolated corpus");
mkdirSync(work, { recursive: true });
const parsed = readDoclingArtifact(artifact, input, work);
const elements = readFileSync(path.join(parsed.dir, "elements.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const document = organizeDocument({
  document: "DOC:research:attention-v7",
  effective: "2026-09-04",
  raw: "assets/bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697.pdf",
  report: parsed.report,
  elements,
});
document.parser = "docling:2.126.0:" + parsed.report.recipe_sha256;
const identity = reconcileIdentity(document);
if (identity.conflicts.length) throw new Error("identity conflict");
await ingestFile({
  input,
  work,
  out: output,
  source: "research",
  id: "attention-v7",
  effective: "2026-09-04",
  profile: "research",
  prepared: { dir: work, report: parsed.report, document: identity.document },
});
writeFileSync(
  path.join(output, "research/attention-v7.identity.json"),
  JSON.stringify(identity.ledger, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      corpus: output,
      regions: document.regions.length,
      equations: document.regions
        .filter((r) => r.kind === "equation")
        .map((r) => ({
          text: r.text,
          locator: r.locator,
          uncertainty: r.uncertainty,
        })),
    },
    null,
    2,
  ),
);
