// Reproduce native ingestion of the frozen public-source smoke collection.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ingestFile } from "../packages/sect-convert/dist/ingest-file.js";
const lock = JSON.parse(readFileSync("eval/corpora/sources.lock.json", "utf8"));
for (const source of lock.sources) {
  const hash = createHash("sha256").update(readFileSync(source.file)).digest("hex");
  if (hash !== source.sha256) throw new Error(`frozen raw source changed: ${source.id}`);
  const result = await ingestFile({ input: source.file, work: "work/qualification", out: process.argv[2] ?? "corpora/qualification-smoke", source: source.domain, id: source.id, effective: source.effective, profile: source.domain });
  console.log(JSON.stringify({ source: source.id, ...result }));
}
