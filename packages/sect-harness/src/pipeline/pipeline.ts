import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { fileURLToPath } from "node:url";
import { extract, type ExtractOptions } from "@sectgrep/convert";
import { ingestFile } from "@sectgrep/convert/ingest-file";
import {
  organizeDocument,
  parseDocument,
  reconcileIdentity,
  type DocumentArtifact,
  type IdentityLedger,
} from "@sectgrep/convert/document";
import {
  parseKnowledge,
  type Profile,
  type KnowledgeArtifact,
} from "@sectgrep/convert/knowledge";
import { atomic, digest, files, hash, json, safePath } from "./io.js";
import { Held, stage, stageStatus } from "./stages.js";
import {
  ReviewStore,
  sampleRecords,
  lotPolicy,
  type ReviewItem,
} from "./review.js";
import { Budget } from "./budget.js";
import { modelJSON, pinModels, unwrapModel } from "./models.js";
import {
  adjudicateKnowledge,
  combineArtifacts,
  ENRICHMENT_PROMPT,
  PROFILE_PROMPT,
  normalizeProposal,
  verifyKnowledge,
  windows,
  type VerifiedRecord,
} from "./enrichment.js";
import { publishFiles } from "./publication.js";

export interface SourceInput {
  id: string;
  source: string;
  input: string;
  sha256: string;
  effective: string;
  input_mode?: "markdown" | "document";
  profile: string;
  domain: string;
  discipline?: string;
  license: string;
  url: string;
  parser?: "native" | "docling";
  docling_artifact?: string;
}
export interface PipelineManifest {
  schema_version: 1;
  name: string;
  root: string;
  run: string;
  corpus: string;
  campaign: string;
  seed: string;
  sources: SourceInput[];
  enrichment: "off" | "propose";
  discover_profiles: boolean;
  extraction_sample: { lending: number; ml: number; biomedical: number };
  sect_bin?: string;
}
export function loadManifest(file: string): PipelineManifest {
  const m = json<PipelineManifest>(file);
  if (
    m.schema_version !== 1 ||
    !m.name ||
    !m.seed ||
    !Array.isArray(m.sources) ||
    !["off", "propose"].includes(m.enrichment)
  )
    throw new Error("invalid pipeline manifest");
  m.root = path.resolve(path.dirname(file), m.root);
  for (const key of ["run", "corpus", "campaign"] as const)
    m[key] = safePath(m.root, m[key]);
  if (new Set(m.sources.map((s) => s.id)).size !== m.sources.length)
    throw new Error("duplicate document ids in manifest");
  for (const s of m.sources) {
    if (
      !/^[a-zA-Z0-9_-]+$/.test(s.id) ||
      !/^[a-zA-Z0-9_-]+$/.test(s.source) ||
      !/^[a-f0-9]{64}$/.test(s.sha256) ||
      !s.license ||
      !s.url ||
      !/^\d{4}-\d{2}-\d{2}$/.test(s.effective) ||
      new Date(s.effective).toISOString().slice(0, 10) !== s.effective
    )
      throw new Error(`invalid source identity/hash/license/date: ${s.id}`);
    s.input = safePath(m.root, s.input);
    s.profile = safePath(m.root, s.profile);
    if (s.docling_artifact)
      s.docling_artifact = safePath(m.root, s.docling_artifact);
  }
  return m;
}
const implementation = (relative: string) => {
  const file = fileURLToPath(new URL(relative, import.meta.url));
  return hash(
    readFileSync(existsSync(file) ? file : file.replace(/\.ts$/, ".js")),
  );
};
const extractImpl = () =>
  digest(
    files(fileURLToPath(new URL("../../../sect-convert/src", import.meta.url))),
  );
type Extracted = {
  report: Awaited<ReturnType<typeof extract>>["report"];
  dir: string;
};
interface Prepared {
  source: SourceInput;
  extracted: Extracted;
  document: DocumentArtifact;
  ledger: IdentityLedger;
  staging: string;
  compiledHashes: Record<string, string>;
  key: string;
}

/** Reopening an identical published revision is an address lookup, including repeated text. */
export function reusePublishedIdentity(
  candidate: DocumentArtifact,
  known: DocumentArtifact,
  ledger: IdentityLedger,
) {
  const byRegions = new Map(known.units.map((u) => [digest(u.regions), u.id]));
  const names = new Map(
    candidate.units.map((u) => [u.id, byRegions.get(digest(u.regions))]),
  );
  const units = candidate.units.map((u) => ({
    ...u,
    id: names.get(u.id),
    parent: u.parent ? names.get(u.parent) : null,
  }));
  if (
    digest({ ...candidate, units }) !== digest(known) ||
    digest(ledger.revisions[known.effective]) !== digest(known.units)
  )
    return null;
  return { document: known, ledger, conflicts: [] };
}

function sourceFor(
  document: DocumentArtifact,
  file: string,
  regionIds?: string[],
) {
  return document.regions
    .filter((r) => !regionIds || regionIds.includes(r.id))
    .map((r) => ({
      file,
      sha256: document.raw_sha256,
      locator: r.locator,
      text: r.text,
    }));
}
function bindings(prepared: Prepared): Record<string, string> {
  return {
    [prepared.source.input]: prepared.source.sha256,
    [prepared.source.profile]: hash(readFileSync(prepared.source.profile)),
    [path.join(
      prepared.staging,
      prepared.source.source,
      `${prepared.source.id}.document.json`,
    )]: hash(
      readFileSync(
        path.join(
          prepared.staging,
          prepared.source.source,
          `${prepared.source.id}.document.json`,
        ),
      ),
    ),
  };
}
function putReview(store: ReviewStore, value: Omit<ReviewItem, "id">): string {
  const item = { ...value, id: `${value.kind}:${digest(value)}` };
  store.put(item);
  return item.id;
}

export async function runPipeline(
  manifestFile: string,
  options: { publish?: boolean; log?: (message: string) => void } = {},
) {
  const m = loadManifest(manifestFile);
  const log = options.log ?? (() => {});
  mkdirSync(m.run, { recursive: true });
  mkdirSync(m.campaign, { recursive: true });
  const runIdentity = { name: m.name, corpus: m.corpus, campaign: m.campaign };
  if (
    existsSync(path.join(m.run, "identity.json")) &&
    digest(json(path.join(m.run, "identity.json"))) !== digest(runIdentity)
  )
    throw new Error("run identity/campaign cannot change on resume");
  atomic(path.join(m.run, "identity.json"), runIdentity);
  atomic(path.join(m.run, "manifest.json"), m);
  const review = new ReviewStore(m.run);
  const budget = new Budget(path.join(m.campaign, "budget.sqlite"));
  const prepared: Prepared[] = [];
  const failures: { document: string; reason: string }[] = [];
  const published: unknown[] = [];
  const publication: {
    document: string;
    outputs: Record<string, Buffer>;
    guard: () => void;
  }[] = [];
  try {
    for (const source of m.sources) {
      try {
        log(`${source.id}: inventory and extraction`);
        const inventory = await stage(
          m.run,
          source.id,
          "inventory",
          source,
          "inventory/1",
          (out) => {
            const bytes = readFileSync(source.input);
            if (hash(bytes) !== source.sha256)
              throw new Held("raw bytes differ from frozen acquisition hash");
            copyFileSync(
              source.input,
              path.join(out, `raw${path.extname(source.input)}`),
            );
            return {
              sha256: source.sha256,
              bytes: bytes.length,
              license: source.license,
              url: source.url,
            };
          },
        );
        // Always inspect the current raw bytes, including cache hits.
        if (hash(readFileSync(source.input)) !== source.sha256)
          throw new Held("source changed after inventory");
        const extraction = await stage<Extracted>(
          m.run,
          source.id,
          "extract",
          {
            raw: inventory.value,
            parser: source.parser ?? "native",
            docling: source.docling_artifact
              ? hash(readFileSync(source.docling_artifact))
              : null,
          },
          extractImpl(),
          async (out) => {
            let extracted: Extracted;
            if (source.parser === "docling") {
              if (!source.docling_artifact)
                throw new Held(
                  "Docling selection requires a pinned adapter artifact",
                );
              const { readDoclingArtifact } = await import("./parsers.js");
              extracted = readDoclingArtifact(
                source.docling_artifact,
                source.input,
                out,
              );
            } else
              extracted = await extract({
                input: source.input,
                work: path.join(m.campaign, "native"),
                pattern: null,
              } satisfies ExtractOptions);
            for (const name of [
              "elements.jsonl",
              "report.json",
              "structure.json",
            ])
              if (existsSync(path.join(extracted.dir, name)))
                copyFileSync(
                  path.join(extracted.dir, name),
                  path.join(out, name),
                );
            return { report: extracted.report, dir: out };
          },
        );
        const organization = await stage(
          m.run,
          source.id,
          "organize",
          {
            extract: extraction.receipt.key,
            outputs: extraction.receipt.hashes,
            effective: source.effective,
            structure_implementation: implementation(
              "../../../sect-convert/src/structure.ts",
            ),
          },
          implementation("../../../sect-convert/src/document.ts"),
          () => {
            const elements = readFileSync(
              path.join(extraction.value.dir, "elements.jsonl"),
              "utf8",
            )
              .split(/\r?\n/)
              .filter(Boolean)
              .map((s) => JSON.parse(s));
            return organizeDocument({
              document: `DOC:${source.source}:${source.id}`,
              effective: source.effective,
              raw: `assets/${source.sha256}${path.extname(source.input)}`,
              report: extraction.value.report,
              elements,
            });
          },
        );
        const priorFile = path.join(
          m.corpus,
          source.source,
          `${source.id}.identity.json`,
        );
        if (existsSync(path.join(m.corpus, ".sect/merge.lock")))
          throw new Held(
            "corpus publication in progress; resume after it completes",
          );
        let prior = existsSync(priorFile)
          ? json<IdentityLedger>(priorFile)
          : undefined;
        // Import addresses from a legacy inventory only when the exact raw revision is unchanged.
        const legacy = path.join(
          m.corpus,
          source.source,
          `${source.id}.inventory.json`,
        );
        if (!prior && existsSync(legacy)) {
          const old = json<{
            raw_sha256: string;
            effective: string;
            keys: string[];
          }>(legacy);
          if (old.raw_sha256 !== source.sha256)
            throw new Held(
              "legacy document changed: establish its prior identity ledger before updating",
            );
          const seen = new Map<string, number>();
          const units = structuredClone(organization.value.units);
          const renames = new Map<string, string>();
          for (const u of units) {
            const stem = `section-${(
              u.title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, "") || "untitled"
            ).slice(0, 80)}`;
            const n = (seen.get(stem) ?? 0) + 1;
            seen.set(stem, n);
            const key = stem + (n > 1 ? `-${n}` : "");
            if (!old.keys.includes(key))
              throw new Held(
                "legacy address is ambiguous; explicit mapping required",
              );
            renames.set(u.id, `${organization.value.document}/${key}`);
          }
          for (const u of units) {
            u.id = renames.get(u.id)!;
            u.parent = u.parent ? (renames.get(u.parent) ?? null) : null;
          }
          prior = {
            schema_version: 1,
            document: organization.value.document,
            next_id: 1,
            revisions: { [old.effective]: units },
            transitions: [],
          };
        }
        const identityBinding = {
          organized: digest(organization.value),
          prior: prior ? digest(prior) : null,
        };
        const identityItems = review
          .items()
          .filter(
            (i) =>
              i.kind === "identity" &&
              i.document === source.id &&
              (i.proposal as { binding?: string })?.binding ===
                digest(identityBinding),
          );
        const decisions = identityItems.flatMap((i) => {
          const r = review.latest(i.id);
          if (r?.decision !== "correct") return [];
          review.assertFresh(i);
          const c = r.correction as {
            from: string[];
            to: string[];
            mappings?: { from: string[]; to: string[] }[];
          };
          return (c.mappings ?? [c]).map((mapping) => ({
            ...mapping,
            receipt_sha256: r.sha256,
          }));
        });
        const identity = await stage(
          m.run,
          source.id,
          "identity",
          { ...identityBinding, decisions },
          implementation("../../../sect-convert/src/document.ts"),
          () => {
            const knownFile = path.join(
              m.corpus,
              source.source,
              `${source.id}.document.json`,
            );
            const known =
              prior && existsSync(knownFile)
                ? json<DocumentArtifact>(knownFile)
                : null;
            const result =
              (known && prior
                ? reusePublishedIdentity(organization.value, known, prior)
                : null) ??
              reconcileIdentity(organization.value, prior, decisions);
            if (result.conflicts.length) {
              putReview(review, {
                kind: "identity",
                document: source.id,
                domain: source.discipline ?? source.domain,
                format: organization.value.format,
                title: source.id,
                prompt:
                  "Resolve new units, identity matches, splits, merges and retirements. Supply {from:[old IDs],to:[candidate IDs]} as a correction.",
                source: sourceFor(organization.value, source.input),
                bindings: { [source.input]: source.sha256 },
                proposal: {
                  binding: digest(identityBinding),
                  conflicts: result.conflicts,
                  previous: prior,
                  document: organization.value,
                },
                batch: 1,
              });
              throw new Held(
                `${result.conflicts.length} identity decisions pending`,
              );
            }
            return result;
          },
        );
        const staging = path.join(
          m.run,
          "documents",
          source.id,
          "compiled",
          digest({
            doc: identity.value.document,
            profile: hash(readFileSync(source.profile)),
            compiler: extractImpl(),
            ledger: identity.value.ledger,
            input_mode:
              source.input_mode ??
              (existsSync(path.join(m.corpus, source.source, "_source.yaml"))
                ? YAML.parse(
                    readFileSync(
                      path.join(m.corpus, source.source, "_source.yaml"),
                      "utf8",
                    ),
                  ).input_mode
                : null) ??
              "markdown",
          }),
        );
        const compiledReceipt = staging + ".json";
        // Compilation uses the existing generic ingestion service; output remains staged.
        if (
          existsSync(compiledReceipt) &&
          digest(json(compiledReceipt)) !== digest(files(staging))
        )
          throw new Held(
            "compiled output changed; inspect the staged artifact before publication",
          );
        if (!existsSync(compiledReceipt)) {
          const priorSource = path.join(m.corpus, source.source);
          if (existsSync(priorSource))
            for (const name of readdirSync(priorSource)) {
              if (
                name === "_source.yaml" ||
                name === `${source.id}.sections.json` ||
                (name.startsWith(`${source.id}@`) &&
                  name.endsWith(".document.json"))
              ) {
                mkdirSync(path.join(staging, source.source), {
                  recursive: true,
                });
                copyFileSync(
                  path.join(priorSource, name),
                  path.join(staging, source.source, name),
                );
              }
            }
          const existing = path.join(m.corpus, source.source, source.id);
          for (const relative of Object.keys(files(existing))) {
            const destination = safePath(
              path.join(staging, source.source, source.id),
              relative,
            );
            mkdirSync(path.dirname(destination), { recursive: true });
            copyFileSync(safePath(existing, relative), destination);
          }
          const oldInventory = path.join(
            m.corpus,
            source.source,
            `${source.id}.inventory.json`,
          );
          if (existsSync(oldInventory)) {
            mkdirSync(path.join(staging, source.source), { recursive: true });
            copyFileSync(
              oldInventory,
              path.join(staging, source.source, `${source.id}.inventory.json`),
            );
          }
          const oldDocument = path.join(
            m.corpus,
            source.source,
            `${source.id}.document.json`,
          );
          if (existsSync(oldDocument))
            copyFileSync(
              oldDocument,
              path.join(staging, source.source, `${source.id}.document.json`),
            );
          await ingestFile({
            input: source.input,
            work: path.join(m.campaign, "native"),
            out: staging,
            source: source.source,
            id: source.id,
            effective: source.effective,
            profile: source.profile,
            inputMode: source.input_mode,
            prepared: {
              ...extraction.value,
              document: identity.value.document,
            },
          });
          atomic(
            path.join(staging, source.source, `${source.id}.identity.json`),
            identity.value.ledger,
          );
          atomic(compiledReceipt, files(staging));
        }
        prepared.push({
          source,
          extracted: extraction.value,
          document: identity.value.document,
          ledger: identity.value.ledger,
          staging,
          compiledHashes: json(compiledReceipt),
          key: digest(identity.value),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push({ document: source.id, reason });
        log(`${source.id}: held — ${reason}`);
      }
    }

    // Qualification samples are independent of model output, selected before any enrichment runs.
    const extractedRegions = prepared.flatMap((p) =>
      p.document.regions.map((r) => ({
        p,
        r,
        domain: p.source.discipline ?? p.source.domain,
      })),
    );
    for (const [domain, count] of Object.entries(m.extraction_sample)) {
      const sample = sampleRecords(
        extractedRegions.filter((x) => x.domain === domain),
        count,
        `${m.seed}:extraction:${domain}`,
        (x) =>
          `${x.p.document.format}:${x.r.kind}:${x.r.uncertainty.some((f) => /ocr|scan/.test(f)) ? "scan" : "native"}`,
        (x) => x.r.id,
      );
      for (const [i, { p, r }] of sample.entries())
        putReview(review, {
          kind: "extraction",
          document: p.source.id,
          domain,
          format: p.document.format,
          title: p.source.id,
          prompt:
            "Compare the original source with the extracted region. Check protected numbers, units, negation, conditions, reading order, hierarchy and table headers.",
          source: sourceFor(p.document, p.source.input, [r.id]),
          bindings: bindings(p),
          proposal: { region: r, parser: p.document.parser },
          batch: Math.floor(i / 10) + 1,
        });
    }
    for (const p of prepared) {
      try {
        const { source, document } = p;
        const profile = json<Profile>(source.profile);
        const digestProfileBytes = hash(readFileSync(source.profile));
        let enrichment: VerifiedRecord[] = [];
        let enrichReason: string | null = null;
        try {
          const pinned =
            m.enrichment === "propose" ? await pinModels(m.campaign) : null;
          await stage(
            m.run,
            source.id,
            "profile",
            {
              profile,
              discovery: m.discover_profiles,
              pin: pinned?.proposer,
              document: digest(document),
            },
            digest([PROFILE_PROMPT, implementation("./models.ts")]),
            async (out) => {
              if (!m.discover_profiles || !pinned)
                return { profile, proposal: null };
              const selected = sampleRecords(
                document.regions.filter(
                  (r) => r.text.trim() && !r.exclusion && r.text.length <= 3000,
                ),
                5,
                `${m.seed}:${source.id}:profile`,
                (r) => r.kind,
              );
              const prompt =
                PROFILE_PROMPT +
                "\n" +
                JSON.stringify({
                  profile,
                  regions: selected.map((r) => ({ id: r.id, text: r.text })),
                });
              const response = await modelJSON(
                budget,
                pinned.proposer,
                "proposer",
                prompt,
                digest(["profile", prompt, pinned.proposer]),
              );
              const proposal = unwrapModel(response) as {
                profile: Profile;
                changes: {
                  description: string;
                  search_examples: string[];
                  evidence: { region: string; quote: string }[];
                }[];
              };
              if (!Array.isArray(proposal.changes))
                throw new Held("invalid profile proposal");
              parseKnowledge({
                schema_version: 1,
                profile: proposal.profile,
                concepts: [],
                mentions: [],
                relations: [],
                derivations: [],
              });
              if (proposal.changes.length) {
                if (
                  proposal.profile.version === profile.version ||
                  proposal.changes.some(
                    (c) =>
                      !c.search_examples?.length ||
                      !c.evidence?.length ||
                      c.evidence.some(
                        (e) =>
                          !selected.some(
                            (r) =>
                              r.id === e.region &&
                              e.quote.trim() &&
                              r.text.includes(e.quote),
                          ),
                      ),
                  )
                )
                  throw new Held(
                    "profile changes lack a new version, search examples, or source evidence",
                  );
                atomic(path.join(out, "proposal.json"), proposal);
                putReview(review, {
                  kind: "profile",
                  document: source.id,
                  domain: source.discipline ?? source.domain,
                  format: document.format,
                  title: `${profile.name} profile proposal`,
                  prompt:
                    "Review vocabulary, scoped definitions and relation types. Acceptance permits a new profile version; the active profile stays pinned until explicitly selected in the manifest.",
                  source: sourceFor(
                    document,
                    source.input,
                    selected.map((r) => r.id),
                  ),
                  bindings: {
                    ...bindings(p),
                    [path.join(out, "proposal.json")]: hash(
                      readFileSync(path.join(out, "proposal.json")),
                    ),
                  },
                  proposal,
                  batch: 1,
                });
              }
              return { profile, proposal };
            },
          ).catch((error) =>
            log(
              `${source.id}: optional profile discovery held — ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
          const enriched = await stage(
            m.run,
            source.id,
            "enrich",
            {
              document: digest(document),
              profile,
              pinned,
              mode: m.enrichment,
              candidates: prepared.map((x) => [x.source.id, x.key]),
            },
            digest([
              implementation("./enrichment.ts"),
              implementation("./models.ts"),
              "adaptive-complete-region-windows/1",
            ]),
            async (out) => {
              if (!pinned)
                return {
                  proposer: combineArtifacts(profile, []),
                  verifier: combineArtifacts(profile, []),
                  coverage: {
                    regions: document.regions.length,
                    processed: 0,
                    reason: "enrichment disabled",
                  },
                };
              const proposer: KnowledgeArtifact[] = [];
              const verifier: KnowledgeArtifact[] = [];
              const queue = windows(document);
              for (const [index, regions] of queue.entries()) {
                if (regions.reduce((n, r) => n + r.text.length, 0) > 100000)
                  throw new Held(
                    "oversize source region needs a reviewed partition; no content silently truncated",
                  );
                const contained = new Set(regions.map((r) => r.id));
                const own = document.units.filter((u) =>
                  u.regions.some((r) => contained.has(r)),
                );
                const allCandidates = prepared
                  .flatMap((other) =>
                    other.document.units.map((u) => ({
                      revision: `${u.id}@${other.document.effective}`,
                      title: u.title,
                      document: other.document.document,
                    })),
                  )
                  .filter(
                    (c) =>
                      own.some(
                        (u) => c.revision === `${u.id}@${document.effective}`,
                      ) ||
                      regions.some(
                        (r) => c.title.length > 3 && r.text.includes(c.title),
                      ),
                  );
                const ownIds = new Set(
                  own.map((u) => `${u.id}@${document.effective}`),
                );
                if (ownIds.size > 200)
                  throw new Held(
                    "more than 200 own endpoints; window must be partitioned",
                  );
                const candidates = [
                  ...allCandidates.filter((c) => ownIds.has(c.revision)),
                  ...allCandidates.filter((c) => !ownIds.has(c.revision)),
                ].slice(0, 200);
                const prompt =
                  ENRICHMENT_PROMPT +
                  "\n" +
                  JSON.stringify({
                    profile,
                    candidates,
                    source: {
                      raw: document.raw,
                      raw_sha256: document.raw_sha256,
                      regions: regions.map((r) => ({
                        id: r.id,
                        text: r.text,
                        locator: r.locator,
                      })),
                    },
                  });
                const pair: KnowledgeArtifact[] = [];
                try {
                  for (const role of ["proposer", "verifier"] as const) {
                    const response = await modelJSON(
                      budget,
                      pinned[role],
                      role,
                      prompt,
                      digest([source.id, index, role, prompt, pinned[role]]),
                    );
                    atomic(path.join(out, `${index}-${role}.json`), response);
                    pair.push(
                      normalizeProposal(unwrapModel(response), profile),
                    );
                  }
                } catch (error) {
                  if (
                    error instanceof Error &&
                    error.message.includes("output truncated") &&
                    regions.length > 1
                  ) {
                    const middle = Math.ceil(regions.length / 2);
                    queue.splice(
                      index + 1,
                      0,
                      regions.slice(0, middle),
                      regions.slice(middle),
                    );
                    atomic(path.join(out, `${index}-partition.json`), {
                      reason: "output truncated",
                      regions: regions.map((r) => r.id),
                      split_at: middle,
                    });
                    log(
                      `${source.id}: partitioning truncated window at a source-region boundary`,
                    );
                    continue;
                  }
                  throw error;
                }
                proposer.push(pair[0]);
                verifier.push(pair[1]);
                log(`${source.id}: verified extraction window ${index + 1}`);
              }
              return {
                proposer: combineArtifacts(profile, proposer),
                verifier: combineArtifacts(profile, verifier),
                coverage: {
                  regions: document.regions.length,
                  processed: document.regions.filter((r) => !r.exclusion)
                    .length,
                  reason:
                    "complete windows; candidate endpoints bounded to 200 per window",
                },
              };
            },
          );
          enrichment = adjudicateKnowledge(
            verifyKnowledge(
              enriched.value.proposer,
              enriched.value.verifier,
              prepared.map((p) => p.document),
            ),
            review,
            source.id,
            profile,
            prepared.map((p) => p.document),
          );
        } catch (error) {
          enrichReason = error instanceof Error ? error.message : String(error);
          log(`${source.id}: enrichment held — ${enrichReason}`);
        }

        const extractionReviews = review
          .items()
          .filter(
            (i) =>
              i.kind === "extraction" &&
              i.document === source.id &&
              i.source[0]?.sha256 === source.sha256 &&
              document.regions.some(
                (r) =>
                  digest(r) ===
                  digest((i.proposal as { region: unknown }).region),
              ),
          );
        const checkExtractionReviews = () => {
          for (const item of extractionReviews) {
            review.assertFresh(item);
            const decision = review.latest(item.id);
            if (
              decision &&
              (["reject", "correct"].includes(decision.decision) ||
                Object.values(decision.checks).includes("failed"))
            )
              throw new Held(
                "human extraction error remains; select a corrected parser artifact and rerun",
              );
          }
        };
        const verification = await stage(
          m.run,
          source.id,
          "verify",
          {
            document: digest(document),
            enrichment,
            enrichReason,
            raw: source.sha256,
            extraction_reviews: extractionReviews.map(
              (i) => i.receipt?.sha256 ?? null,
            ),
          },
          implementation("./enrichment.ts"),
          () => {
            parseDocument(document);
            checkExtractionReviews();
            if (hash(readFileSync(source.input)) !== source.sha256)
              throw new Held("raw bytes changed during run");
            if (
              document.regions.some((r) =>
                r.uncertainty.some((f) =>
                  ["ocr_unverified", "ocr_divergent", "no_text_layer"].includes(
                    f,
                  ),
                ),
              )
            )
              throw new Held("unverified extraction regions remain");
            return {
              text: {
                deterministic: "passed",
                source_alignment: "requires_human_sample",
                regions: document.regions.length,
                excluded: document.regions.filter((r) => r.exclusion).length,
              },
              enrichment,
              withheld: enrichReason,
            };
          },
        );
        const verified = enrichment.filter(
          (r) =>
            r.deterministic &&
            r.human_adjudication !== "rejected" &&
            (r.model_agreement || r.human_adjudication === "accepted"),
        );
        const conflicts = enrichment.filter((r) => !verified.includes(r));
        const lot = digest({ source: source.id, verified });
        const history = review
          .items()
          .filter((i) => i.lot && i.document === source.id)
          .reduce((map, i) => {
            const entry = map.get(i.lot!) ?? [];
            entry.push(i);
            map.set(i.lot!, entry);
            return map;
          }, new Map<string, ReturnType<ReviewStore["items"]>>());
        const completed = [...history.entries()]
          .filter(
            ([id, items]) =>
              id !== lot &&
              (items.some((i) =>
                ["reject", "correct"].includes(i.receipt?.decision ?? ""),
              ) ||
                items.every(
                  (i) => i.receipt && i.receipt.decision !== "defer",
                )),
          )
          .map(([, items]) => ({
            accepted: items.every((i) => i.receipt?.decision === "accept"),
          }));
        const policy = lotPolicy(completed);
        const selected = sampleRecords(
          verified,
          policy.n,
          `${m.seed}:${lot}`,
          (r) => `${r.kind}:${document.format}`,
        );
        const samples = selected.map((r, i) =>
          putReview(review, {
            kind: "knowledge",
            document: source.id,
            domain: source.discipline ?? source.domain,
            format: document.format,
            title: `${r.kind} review`,
            prompt:
              "Review this agreed claim against source evidence. Any error holds the whole enrichment lot.",
            source: sourceFor(
              document,
              source.input,
              document.regions
                .filter((x) =>
                  r.record.evidence.some(
                    (e) => e.quote && x.text.includes(e.quote),
                  ),
                )
                .map((x) => x.id),
            ),
            bindings: bindings(p),
            proposal: r,
            batch: Math.floor(i / 10) + 1,
            lot,
          }),
        );
        for (const [i, r] of conflicts.entries())
          putReview(review, {
            kind: "knowledge",
            document: source.id,
            domain: source.discipline ?? source.domain,
            format: document.format,
            title: `${r.kind} conflict`,
            prompt:
              "Independent readers disagreed or deterministic evidence checks failed. Adjudicate or correct the claim; it remains withheld until a subsequent verified run.",
            source: sourceFor(
              document,
              source.input,
              document.regions
                .filter((x) =>
                  r.record.evidence.some(
                    (e) => e.quote && x.text.includes(e.quote),
                  ),
                )
                .map((x) => x.id),
            ),
            bindings: bindings(p),
            proposal: r,
            batch: Math.floor(i / 10) + 1,
          });
        const accepted =
          samples.length > 0 && samples.every((id) => review.accepted(id));
        const sampleStage = await stage(
          m.run,
          source.id,
          "sample",
          {
            lot,
            policy,
            samples,
            receipts: samples.map((id) => review.latest(id)?.sha256 ?? null),
          },
          "sampling/1",
          () => ({
            lot,
            n: samples.length,
            accepted,
            withheld: conflicts.length + (accepted ? 0 : verified.length),
            inspection: policy.level,
          }),
        );
        const artifact: KnowledgeArtifact = {
          schema_version: 1,
          profile,
          concepts: [],
          mentions: [],
          relations: [],
          derivations: [],
        };
        if (accepted)
          for (const item of verified) {
            const r = structuredClone(item.record);
            r.verification = {
              state: "passed",
              method: `deterministic+${item.model_agreement ? "blind_model_agreement" : "human_adjudication"}+human_lot`,
              reason: `sample lot ${lot}`,
            };
            r.evidence.forEach((e) => (e.verification = { ...r.verification }));
            if ("from" in r) artifact.relations.push(r);
            else if ("at" in r) artifact.mentions.push(r);
            else artifact.concepts.push(r);
          }
        // A mention cannot publish without its accepted concept.
        artifact.mentions = artifact.mentions.filter((m) =>
          artifact.concepts.some((c) => c.id === m.concept),
        );
        parseKnowledge(artifact);
        const coverage = {
          schema_version: 1,
          run: m.name,
          source: source.id,
          text: verification.value.text,
          enrichment: {
            mode: m.enrichment,
            proposed: enrichment.length,
            model_agreed: verified.length,
            published:
              artifact.concepts.length +
              artifact.mentions.length +
              artifact.relations.length,
            withheld: sampleStage.value.withheld,
            reason: enrichReason,
          },
          sample: sampleStage.value,
        };
        atomic(
          path.join(m.run, "documents", source.id, "coverage.json"),
          coverage,
        );
        if (options.publish) {
          const outputs: Record<string, Buffer> = {};
          for (const relative of Object.keys(files(p.staging)))
            outputs[relative] = readFileSync(safePath(p.staging, relative));
          outputs[`${source.source}/${source.id}.knowledge.json`] = Buffer.from(
            JSON.stringify(artifact, null, 2) + "\n",
          );
          outputs[`${source.source}/${source.id}.coverage.json`] = Buffer.from(
            JSON.stringify(coverage, null, 2) + "\n",
          );
          publication.push({
            document: source.id,
            outputs,
            guard: () => {
              checkExtractionReviews();
              if (digest(files(p.staging)) !== digest(p.compiledHashes))
                throw new Held("compiled output changed before publication");
              if (hash(readFileSync(source.input)) !== source.sha256)
                throw new Held("raw changed before publication");
              if (hash(readFileSync(source.profile)) !== digestProfileBytes)
                throw new Held("profile changed before publication");
              if (accepted && !samples.every((id) => review.accepted(id)))
                throw new Held("enrichment sample no longer accepted");
            },
          });
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push({ document: p.source.id, reason });
        log(`${p.source.id}: held — ${reason}`);
      }
    }
    // Publish all eligible documents together so verified cross-document endpoints exist in one generation.
    if (publication.length) {
      const outputs: Record<string, Buffer> = {};
      for (const entry of publication)
        for (const [relative, original] of Object.entries(entry.outputs)) {
          let bytes = original;
          if (relative.endsWith("/_source.yaml")) {
            const existing = path.join(m.corpus, relative);
            if (existsSync(existing)) bytes = readFileSync(existing);
            else {
              const registry = YAML.parse(bytes.toString("utf8"));
              // Effective dates and profiles belong to document revisions in a mixed collection.
              delete registry.version;
              delete registry.profile;
              bytes = Buffer.from(YAML.stringify(registry));
            }
            entry.outputs[relative] = bytes;
          }
          if (outputs[relative] && !outputs[relative].equals(bytes))
            throw new Held(`publication output conflict: ${relative}`);
          outputs[relative] = bytes;
        }
      const result = await publishFiles(
        m.corpus,
        outputs,
        m.sect_bin ?? process.env.SECT_BIN ?? "sect",
        () => publication.forEach((p) => p.guard()),
      );
      for (const entry of publication) {
        const publishedStage = await stage(
          m.run,
          entry.document,
          "publish",
          {
            generation: result.generation,
            outputs: Object.fromEntries(
              Object.entries(entry.outputs).map(([k, v]) => [k, hash(v)]),
            ),
          },
          implementation("./publication.ts"),
          () => result,
        );
        published.push({ document: entry.document, ...publishedStage.value });
      }
    }
    const result = {
      run: m.run,
      prepared: prepared.length,
      failures,
      published,
      budget: budget.status(),
      pending_review: review
        .items()
        .filter((i) => !i.receipt || i.receipt.decision === "defer").length,
      qualification: "unqualified_pending_independent_human_judgments",
      stages: stageStatus(
        m.run,
        m.sources.map((s) => s.id),
      ),
    };
    atomic(path.join(m.run, "status.json"), result);
    return result;
  } finally {
    review.close();
    budget.close();
  }
}
