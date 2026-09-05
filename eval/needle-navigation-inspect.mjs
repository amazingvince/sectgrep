// Diagnostic source-navigation fixtures. This creates no decisions or relevance labels.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ReviewStore } from "../packages/sect-harness/dist/pipeline/review.js";
import { startReviewServer } from "../packages/sect-harness/dist/pipeline/server.js";
import { hash, digest } from "../packages/sect-harness/dist/pipeline/io.js";

const run = path.resolve("review/needle-retrieval/navigation-inspector");
mkdirSync(run, { recursive: true });
const store = new ReviewStore(run);
for (const [corpus, file, title, choose] of [
  ["corpora/needle-docling-attention-v3", "research/attention-v7.document.json", "Attention: all source boxes", r => r.locator.type === "pages" && new Set(r.locator.locations.map(l => l.page)).size > 1],
  ["corpora/needle-native-office-v1", "fixtures/laboratory-archive.document.json", "Word: original paragraph XML", r => r.kind === "paragraph" && r.locator.type === "office"],
]) {
  const documentFile = path.resolve(corpus, file);
  const document = JSON.parse(readFileSync(documentFile, "utf8"));
  const region = document.regions.find(choose);
  if (!region) throw new Error(`source-navigation fixture absent: ${file}`);
  const input = path.resolve(corpus, document.raw);
  if (hash(readFileSync(input)) !== document.raw_sha256) throw new Error("raw source binding changed");
  const item = { kind: "extraction", document: document.document, domain: "diagnostic", format: document.format,
    title, prompt: "Inspect source navigation. This is a diagnostic fixture, not an independent relevance judgment.",
    source: [{ file: input, sha256: document.raw_sha256, locator: region.locator, text: region.text }],
    bindings: { [documentFile]: hash(readFileSync(documentFile)), [input]: document.raw_sha256 }, batch: 1 };
  store.put({ ...item, id: `diagnostic:${digest(item)}` });
}
store.close();
const { url } = await startReviewServer(run, Number(process.argv[2] ?? 4180));
writeFileSync(path.join(run, "session-url.txt"), url);
console.log(url);
