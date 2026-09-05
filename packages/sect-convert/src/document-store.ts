import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { contentHash, parseDocument } from "./document.js";
import { parseSections, type SectionBundle } from "./sections.js";
import { splitFrontMatter } from "./validators/corpus.js";

function sourcePaths(corpus: string, source: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(source))
    throw new Error("invalid source directory");
  const root = path.resolve(corpus),
    dir = path.join(root, source),
    registry = path.join(dir, "_source.yaml");
  const text = readFileSync(registry, "utf8");
  return {
    root,
    dir,
    registry,
    text,
    config: YAML.parse(text) as Record<string, unknown>,
  };
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      if (e.name.startsWith(".") || e.name === "exports" || e.isSymbolicLink())
        return [];
      const p = path.join(dir, e.name);
      return e.isDirectory() ? files(p) : e.isFile() ? [p] : [];
    })
    .sort();
}

/** Reversible migration: retain old Markdown exports, activate bundles only after all are written. */
export function packSource(corpus: string, source: string) {
  const { root, dir, registry, text, config } = sourcePaths(corpus, source);
  if ((config.input_mode ?? "markdown") !== "markdown")
    throw new Error(
      "pack-source requires a Markdown source; document mode is already active",
    );
  const bundles = new Map<string, SectionBundle>();
  const owners = new Map<string, string>();
  const relative = (p: string) => path.relative(root, p).replaceAll("\\", "/");
  const inputs = files(dir);
  for (const file of inputs.filter((p) => p.endsWith(".document.json"))) {
    const bytes = readFileSync(file),
      doc = parseDocument(JSON.parse(bytes.toString("utf8")));
    const bundle = bundles.get(doc.document) ?? {
      schema_version: 1,
      recipe: "canonical-markdown-v1",
      document: doc.document,
      artifacts: {},
      sections: {},
    };
    bundle.artifacts[relative(file)] = contentHash(bytes);
    bundles.set(doc.document, bundle);
    for (const id of [doc.document, ...doc.units.map((u) => u.id)]) {
      if (owners.has(id) && owners.get(id) !== doc.document)
        throw new Error(
          `section identity belongs to multiple documents: ${id}`,
        );
      owners.set(id, doc.document);
    }
  }
  if (!bundles.size)
    throw new Error(
      "source has no organized document artifacts; legacy Markdown remains supported without migration",
    );
  let sections = 0;
  for (const file of inputs.filter((p) => p.endsWith(".md"))) {
    const contents = readFileSync(file, "utf8"),
      split = splitFrontMatter(contents);
    if (!split) throw new Error(`section lacks front matter: ${file}`);
    const front = YAML.parse(split.front),
      owner = owners.get(front.id);
    if (!owner || front.source !== config.name)
      throw new Error(`section has no matching organized document: ${file}`);
    bundles.get(owner)!.sections[relative(file)] = contents;
    sections++;
  }
  const pending = new Map<string, string>();
  for (const bundle of bundles.values()) {
    const key = bundle.document.split(":").at(-1)!;
    if (!/^[a-zA-Z0-9_-]+$/.test(key))
      throw new Error(`unsupported document key: ${key}`);
    pending.set(
      path.join(dir, `${key}.sections.json`),
      JSON.stringify(parseSections(bundle)) + "\n",
    );
  }
  if (readFileSync(registry, "utf8") !== text)
    throw new Error("source registry changed during migration");
  pending.set(registry, YAML.stringify({ ...config, input_mode: "document" }));
  mkdirSync(path.join(dir, "exports"), { recursive: true });
  const prior = new Map<string, Buffer | null>();
  try {
    for (const [p, value] of pending) {
      prior.set(p, existsSync(p) ? readFileSync(p) : null);
      writeFileSync(p, value);
    }
  } catch (error) {
    for (const [p, bytes] of [...prior].reverse()) {
      if (bytes) writeFileSync(p, bytes);
      else if (existsSync(p)) unlinkSync(p);
    }
    throw error;
  }
  return {
    source,
    documents: bundles.size,
    sections,
    input_mode: "document",
    retained_markdown_is_authoritative: false,
  };
}

/** Inspectable exports have a fixed location excluded from the document input contract. */
export function exportSource(corpus: string, source: string) {
  const { dir, config } = sourcePaths(corpus, source);
  if (config.input_mode !== "document")
    throw new Error("export-source requires document input mode");
  let sections = 0;
  for (const file of files(dir).filter((p) => p.endsWith(".sections.json"))) {
    const bundle = parseSections(JSON.parse(readFileSync(file, "utf8")));
    for (const [rel, text] of Object.entries(bundle.sections)) {
      if (!rel.startsWith(`${source}/`) || rel.startsWith(`${source}/exports/`))
        throw new Error("virtual section is outside source");
      const out = path.join(dir, "exports", rel.slice(source.length + 1));
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, text);
      sections++;
    }
  }
  return { source, sections, directory: path.join(dir, "exports") };
}
