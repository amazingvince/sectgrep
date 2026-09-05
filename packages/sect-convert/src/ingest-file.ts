import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { extract, type ExtractOptions } from "./extract.js";
import { sha256 } from "./elements/work.js";
import type { Element } from "./elements/types.js";
import {
  parseKnowledge,
  type KnowledgeArtifact,
  type Profile,
} from "./knowledge.js";
import { splitFrontMatter } from "./validators/corpus.js";
import { parseDocument, type DocumentArtifact } from "./document.js";
import { parseSections, type SectionBundle } from "./sections.js";

export interface IngestFileOptions extends ExtractOptions {
  out: string;
  source: string;
  /** Stable document key supplied by the caller, independent of file path or revision bytes. */
  id: string;
  effective: string;
  /** Explicit canonical input contract. Existing source registries retain their mode. */
  inputMode?: "markdown" | "document";
  profile?: string;
  /** Shared pipeline service: extraction and organization already checked in staging. */
  prepared?: {
    report: import("./elements/types.js").ExtractReport;
    dir: string;
    document: DocumentArtifact;
  };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const markdown = (e: Element) => {
  if (!e.table_grid?.length) return e.text;
  const cells = e.table_grid.map(
    (row) =>
      `| ${row.map((c) => c.replaceAll("|", "\\|").replaceAll("\n", "<br>")).join(" | ")} |`,
  );
  if (
    e.cells?.length &&
    !e.cells
      .filter((c) => c.row === 0)
      .every((c) => c.role === "header" || c.role === "column_header")
  )
    return cells.join("\n");
  return [
    cells[0],
    `| ${e.table_grid[0].map(() => "---").join(" | ")} |`,
    ...cells.slice(1),
  ].join("\n");
};

/** Deterministic bridge from all extraction adapters into addressable, portable search units.
 * Semantic enrichment is a separate, schema-validated input; extraction never invents edges.
 */
export async function ingestFile(o: IngestFileOptions): Promise<{
  documents: number;
  held: number;
  source: string;
  artifact: string;
}> {
  if (!/^[a-zA-Z0-9_-]+$/.test(o.source) || !/^[a-zA-Z0-9_-]+$/.test(o.id))
    throw new Error(
      "source and id must be stable alphanumeric keys (hyphen/underscore allowed)",
    );
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(o.effective) ||
    !Number.isFinite(Date.parse(o.effective)) ||
    new Date(o.effective).toISOString().slice(0, 10) !== o.effective
  )
    throw new Error("effective must be a real YYYY-MM-DD date");
  const profilePath =
    o.profile && o.profile.endsWith(".json")
      ? path.resolve(o.profile)
      : new URL(
          `../../../profiles/${o.profile ?? "generic"}.json`,
          import.meta.url,
        );
  const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Profile;
  const { report, dir } = o.prepared ?? (await extract(o));
  const organized = o.prepared ? parseDocument(o.prepared.document) : null;
  const elements = readFileSync(path.join(dir, "elements.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Element);
  const blocked = elements.filter((e) =>
    e.flags.some((f) =>
      ["ocr_unverified", "ocr_divergent", "no_text_layer"].includes(f),
    ),
  );
  if (blocked.length)
    throw new Error(
      `${blocked.length} unverified extraction regions require review before publication`,
    );
  if (!elements.some((e) => e.text.trim()))
    throw new Error("extraction has no searchable text");
  const out = path.resolve(o.out);
  const prefix = `DOC:${o.source}:`;
  const rootId = `${prefix}${o.id}`;
  const raw = `assets/${report.doc_sha}${path.extname(o.input).toLowerCase()}`;
  mkdirSync(path.join(out, "assets"), { recursive: true });
  copyFileSync(o.input, path.join(out, raw));
  const artifacts = path.join(
    out,
    "artifacts",
    report.doc_sha,
    report.recipe_sha256 ?? "legacy",
  );
  mkdirSync(artifacts, { recursive: true });
  for (const file of [
    "elements.jsonl",
    "report.json",
    "structure.json",
    "terms_candidates.json",
    "xrefs_candidates.jsonl",
  ])
    if (existsSync(path.join(dir, file)))
      copyFileSync(path.join(dir, file), path.join(artifacts, file));
  const sourceDir = path.join(out, o.source);
  mkdirSync(sourceDir, { recursive: true });
  const source = {
    name: o.source,
    input_mode: o.inputMode ?? "markdown",
    kind: "base",
    title: o.source,
    publisher: "unspecified",
    precedence: 0,
    id_prefix: prefix,
    legal_status: "derived",
    version: o.effective,
    profile: `${profile.name}@${profile.version}`,
  };
  const registry = path.join(sourceDir, "_source.yaml");
  const existingSource = existsSync(registry)
    ? YAML.parse(readFileSync(registry, "utf8"))
    : null;
  const inputMode = existingSource?.input_mode ?? o.inputMode ?? "markdown";
  if (
    existingSource &&
    o.inputMode &&
    (existingSource.input_mode ?? "markdown") !== o.inputMode
  )
    throw new Error(
      "source input mode differs; migrate the whole source explicitly",
    );
  if (!["markdown", "document"].includes(inputMode))
    throw new Error("unknown source input mode");
  if (inputMode === "document" && !organized)
    throw new Error(
      "document mode requires the organized, identity-checked pipeline artifact",
    );
  if (inputMode === "document")
    mkdirSync(path.join(sourceDir, "exports"), { recursive: true });
  if (!existsSync(registry)) writeFileSync(registry, YAML.stringify(source));
  else if (YAML.parse(readFileSync(registry, "utf8")).id_prefix !== prefix)
    throw new Error("source registry prefix differs from requested source");
  const groups: Array<{
    title: string;
    elements: Element[];
    key: string;
    parent?: string | null;
  }> = [];
  const used = new Map<string, number>();
  if (organized) {
    if (
      organized.document !== rootId ||
      organized.raw_sha256 !== report.doc_sha
    )
      throw new Error("prepared document identity differs from input");
    const byOrder = new Map(elements.map((e) => [e.seq, e]));
    const regions = new Map(organized.regions.map((r) => [r.id, r]));
    for (const u of organized.units) {
      const key = u.id.slice(rootId.length + 1);
      if (!u.id.startsWith(rootId + "/") || !/^[a-zA-Z0-9_-]+$/.test(key))
        throw new Error("invalid prepared unit address");
      groups.push({
        title: u.title,
        key,
        parent: u.parent,
        elements: u.regions.map((id) => {
          const region = regions.get(id)!;
          const e = byOrder.get(region.order);
          if (!e || e.text !== region.text)
            throw new Error("unit text is not copied from parser artifact");
          return {
            ...e,
            type: region.kind as Element["type"],
            heading_level: region.heading_level ?? undefined,
          };
        }),
      });
    }
  } else
    for (const e of elements) {
      if (e.type === "heading" || !groups.length) {
        const title =
          e.type === "heading"
            ? e.text.replace(/^#+\s*/, "")
            : path.basename(o.input);
        const stem = `section-${(slug(title) || "untitled").slice(0, 80)}`;
        const count = (used.get(stem) ?? 0) + 1;
        used.set(stem, count);
        groups.push({
          title,
          elements: [],
          key: `${stem}${count > 1 ? `-${count}` : ""}`,
        });
      }
      groups.at(-1)!.elements.push(e);
    }
  let held = 0;
  let documents = 0;
  const outputs: Record<string, string> = {};
  const pending = new Map<string, string>();
  const bundleFile = path.join(sourceDir, `${o.id}.sections.json`);
  const bundle: SectionBundle = existsSync(bundleFile)
    ? parseSections(JSON.parse(readFileSync(bundleFile, "utf8")))
    : {
        schema_version: 1,
        recipe: "canonical-markdown-v1",
        document: rootId,
        artifacts: {},
        sections: {},
      };
  if (bundle.document !== rootId)
    throw new Error("section bundle document identity differs");
  const relative = (file: string) =>
    path.relative(out, file).replaceAll("\\", "/");
  const priorText = (file: string) =>
    inputMode === "document"
      ? (bundle.sections[relative(file)] ?? null)
      : existsSync(file)
        ? readFileSync(file, "utf8")
        : null;
  const inventoryFile = path.join(sourceDir, `${o.id}.inventory.json`);
  const inventory = existsSync(inventoryFile)
    ? (JSON.parse(readFileSync(inventoryFile, "utf8")) as {
        effective: string;
        raw_sha256: string;
        keys: string[];
        recipe: string;
      })
    : null;
  const keys = groups.map((g) => g.key).sort();
  if (
    !organized &&
    inventory &&
    JSON.stringify(inventory.keys) !== JSON.stringify(keys)
  )
    throw new Error(
      "unit topology changed; supply an explicit identity mapping before updating this document (use a new document id for a distinct document)",
    );
  if (inventory && inventory.effective > o.effective)
    throw new Error("cannot publish an older revision");
  if (
    inventory &&
    inventory.effective === o.effective &&
    (inventory.raw_sha256 !== report.doc_sha ||
      inventory.recipe !== report.recipe_sha256)
  )
    throw new Error(
      "revision is immutable; use a new effective date for changed input or extraction recipe",
    );
  if (organized && inventory)
    for (const retired of inventory.keys.filter((key) => !keys.includes(key))) {
      const file = path.join(sourceDir, o.id, `${retired}.md`);
      const text = priorText(file);
      if (!text) throw new Error("prior identity text is missing");
      const previous = splitFrontMatter(text);
      if (!previous) throw new Error("prior identity lacks front matter");
      pending.set(
        file,
        `---\n${YAML.stringify({ ...YAML.parse(previous.front), retired: o.effective }, { lineWidth: 0 })}---\n${previous.body}`,
      );
    }
  const write = (
    key: string,
    title: string,
    parent: string | null,
    body: string,
    selected: Element[],
    order: number,
  ) => {
    const id = key ? `${rootId}/${key}` : rootId;
    const file = path.join(sourceDir, o.id, `${key || "index"}.md`);
    const prior = priorText(file);
    const previous = prior ? splitFrontMatter(prior) : null;
    const prev = previous
      ? (YAML.parse(previous.front) as Record<string, unknown>)
      : null;
    const date = String(prev?.effective ?? "");
    if (date && date > o.effective)
      throw new Error(`refusing to replace ${id} with an older revision`);
    const flags = selected
      .flatMap((e) => e.flags)
      .filter((f) =>
        ["ocr_unverified", "ocr_divergent", "no_text_layer"].includes(f),
      );
    if (flags.length) {
      held++;
      return;
    }
    const front = {
      context_kind: "navigation",
      id,
      source: o.source,
      title,
      level: parent ? "section" : "title",
      kind: "base",
      parent,
      order,
      effective: o.effective,
      supersedes:
        date && date < o.effective
          ? `${id}@${date}`
          : (prev?.supersedes ?? null),
      superseded_by: null,
      amended_by: [],
      overrides: [],
      narrows: [],
      defines: [],
      context: `${o.source} > ${o.id} > ${title}`,
      provenance: {
        raw,
        raw_sha256: report.doc_sha,
        locator: {
          pages: [...new Set(selected.map((e) => e.page))],
          elements: selected.map((e) => e.seq),
          regions: selected.map(
            (e) =>
              e.locator ?? {
                type: "page",
                page: e.page,
                elements: [e.seq],
                bbox: e.bbox,
              },
          ),
          artifact: path.relative(out, artifacts).replaceAll("\\", "/"),
          recipe_sha256: report.recipe_sha256,
        },
        legal_status: "derived",
        ingest_run: `native:${report.recipe_sha256}`,
        confidence: 1,
        verified_by: [],
        checks: {
          extraction: "passed",
          source_alignment: "unchecked",
          semantic: "not_applicable",
        },
      },
    };
    if (inputMode === "markdown")
      mkdirSync(path.dirname(file), { recursive: true });
    if (date && date < o.effective && previous && prev) {
      pending.set(
        file.replace(/\.md$/, `@${date}.md`),
        `---\n${YAML.stringify({ ...prev, superseded_by: `${id}@${o.effective}` })}---\n${previous.body}`,
      );
    }
    const text = `---\n${YAML.stringify({ ...front, ...(!key ? { retrieval_role: "navigation" } : {}) }, { lineWidth: 0 })}---\n\n# ${title}\n\n${body}\n`;
    pending.set(file, text);
    outputs[path.relative(out, file).replaceAll("\\", "/")] = sha256(text);
    documents++;
  };
  for (const [i, g] of groups.entries())
    write(
      g.key,
      g.title,
      g.parent ?? rootId,
      g.elements
        .filter((e, i) => i > 0 || e.type !== "heading")
        .map(markdown)
        .join("\n\n"),
      g.elements,
      i + 1,
    );
  const visible = groups.filter(
    (g) =>
      !g.elements.some((e) =>
        e.flags.some((f) =>
          ["ocr_unverified", "ocr_divergent", "no_text_layer"].includes(f),
        ),
      ),
  );
  write(
    "",
    path.basename(o.input),
    null,
    visible.map((g) => `- [${g.title}](${rootId}/${g.key})`).join("\n"),
    [],
    0,
  );
  const knowledge: KnowledgeArtifact = {
    schema_version: 1,
    profile,
    concepts: [],
    mentions: [],
    relations: [],
    derivations: [
      {
        stage: "addressable_units",
        implementation: "sect-convert/2",
        recipe_sha256: sha256(
          JSON.stringify({
            extraction: report.recipe_sha256,
            profile,
            id: rootId,
          }),
        ),
        inputs: {
          [raw]: report.doc_sha,
          "elements.jsonl": sha256(
            readFileSync(path.join(dir, "elements.jsonl")),
          ),
          "profile.json": sha256(JSON.stringify(profile)),
        },
        outputs,
      },
    ],
  };
  const artifact = path.join(sourceDir, `${o.id}.knowledge.json`);
  pending.set(
    artifact,
    JSON.stringify(parseKnowledge(knowledge), null, 2) + "\n",
  );
  pending.set(
    inventoryFile,
    JSON.stringify(
      {
        effective: o.effective,
        raw_sha256: report.doc_sha,
        recipe: report.recipe_sha256,
        keys,
      },
      null,
      2,
    ) + "\n",
  );
  if (organized) {
    const file = path.join(sourceDir, `${o.id}.document.json`);
    if (existsSync(file)) {
      const previous = JSON.parse(
        readFileSync(file, "utf8"),
      ) as DocumentArtifact;
      if (previous.effective < organized.effective)
        pending.set(
          path.join(sourceDir, `${o.id}@${previous.effective}.document.json`),
          JSON.stringify(previous, null, 2) + "\n",
        );
    }
    pending.set(file, JSON.stringify(organized, null, 2) + "\n");
  }
  if (inputMode === "document") {
    for (const [file, text] of pending) {
      if (file.endsWith(".md")) {
        bundle.sections[relative(file)] = text;
        pending.delete(file);
      }
      if (file.endsWith(".document.json"))
        bundle.artifacts[relative(file)] = sha256(text);
    }
    // When the current artifact moves to its dated path, its prior binding is replaced above.
    pending.set(bundleFile, JSON.stringify(parseSections(bundle)) + "\n");
  }
  const prior = new Map<string, Buffer | null>();
  try {
    for (const [file, text] of pending) {
      prior.set(file, existsSync(file) ? readFileSync(file) : null);
      if (prior.get(file)?.equals(Buffer.from(text))) continue;
      writeFileSync(file, text);
    }
  } catch (error) {
    for (const [file, bytes] of [...prior].reverse()) {
      if (bytes) writeFileSync(file, bytes);
      else if (existsSync(file)) unlinkSync(file);
    }
    throw error;
  }
  return { documents, held, source: o.source, artifact };
}
