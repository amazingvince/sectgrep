// Clone a pinned diagnostic generation, migrate its sources, and retain exact projection bytes.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { packSource } from "../packages/sect-convert/dist/document-store.js";
const origin = path.resolve(process.argv[2] ?? "corpora/needle-retrieval-v5");
const destination = path.resolve(
  process.argv[3] ?? "corpora/needle-document-store-v1",
);
if (existsSync(destination))
  throw new Error("destination exists; choose a new isolated corpus");
const generation = readdirSync(path.join(origin, ".sect/published"))
  .filter((p) => p.endsWith(".ready"))
  .sort()
  .at(-1)
  .replace(".ready", "");
const snapshot = path.join(origin, ".sect/generations", generation, "corpus");
mkdirSync(destination, { recursive: true });
cpSync(snapshot, destination, { recursive: true });
const sources = readdirSync(destination).filter((p) =>
  existsSync(path.join(destination, p, "_source.yaml")),
);
const migrations = sources.map((s) => packSource(destination, s));
// Recipes and semantic provider are taken from the origin when indexing (see report script).
const manifest = JSON.parse(
  readFileSync(
    path.join(origin, ".sect/generations", generation, "manifest.json"),
    "utf8",
  ),
);
const report = {
  origin,
  generation,
  destination,
  migrations,
  embedding: manifest.embedding_spec,
  passage_policy: manifest.passage_policy,
  notice:
    "Same diagnostic input bytes. Old Markdown retained as ignored exports; no production corpus changed.",
};
mkdirSync("review/needle-retrieval", { recursive: true });
writeFileSync(
  "review/needle-retrieval/storage-migration.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
