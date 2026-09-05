import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DocumentArtifact } from "@sectgrep/convert/document";
import { atomic, digest, hash, json, safePath, files } from "./io.js";
import { loadManifest } from "./pipeline.js";
import { ReviewStore, type ReviewItem } from "./review.js";

export interface BenchmarkTask {
  id: string;
  split: "tuning" | "heldout";
  domain: string;
  family: string;
  kind: "locate" | "define" | "relations" | "absence";
  query: string;
  relevant: string[];
  supporting: string[];
  answerable: boolean;
  reviewer: string;
  receipt_sha256: string;
}

/** Tasks are drafts; their source-derived wording is not an independent relevance label. */
export function prepareBenchmark(manifestFile: string) {
  const m = loadManifest(manifestFile);
  const store = new ReviewStore(m.run);
  try {
    const documents = m.sources.flatMap((source) => {
      const file = path.join(
        m.run,
        "documents",
        source.id,
        "identity/stage.json",
      );
      if (!existsSync(file)) return [];
      const receipt = json<{ status: string; output: string }>(file);
      if (receipt.status !== "complete") return [];
      const artifact = path.join(
        path.dirname(file),
        receipt.output,
        "result.json",
      );
      return [
        {
          source,
          document: json<{ document: DocumentArtifact }>(artifact).document,
          artifact,
        },
      ];
    });
    const sourceCatalog = documents.map(({ source, document }) => ({
      file: source.input,
      sha256: source.sha256,
      text: "",
      locator: document.regions[0]?.locator ?? {
        type: "text" as const,
        line_start: 1,
        line_end: 1,
      },
    }));
    const boundArtifacts = Object.fromEntries(
      documents.map((x) => [x.artifact, hash(readFileSync(x.artifact))]),
    );
    const created: string[] = [];
    for (const domain of ["lending", "ml", "biomedical"]) {
      const docs = documents
        .filter((d) => (d.source.discipline ?? d.source.domain) === domain)
        .sort((a, b) =>
          digest([m.seed, a.source.id]).localeCompare(
            digest([m.seed, b.source.id]),
          ),
        );
      if (docs.length < 3)
        throw new Error(
          `need at least three independent source documents for ${domain}`,
        );
      const regionCount = (d: (typeof docs)[number]) =>
        d.document.regions.filter(
          (r) =>
            r.text.length >= 100 &&
            !r.exclusion &&
            ["paragraph", "list_item", "table"].includes(r.kind),
        ).length;
      const largest = [...docs].sort(
        (a, b) => regionCount(b) - regionCount(a),
      )[0];
      const tuning = new Set<string>();
      let tuningRegions = 0;
      for (const d of docs.filter((d) => d !== largest)) {
        if (tuningRegions >= (domain === "lending" ? 50 : 25)) break;
        tuning.add(d.source.id);
        tuningRegions += regionCount(d);
      }
      for (const split of ["tuning", "heldout"] as const) {
        const count =
          domain === "lending"
            ? split === "tuning"
              ? 50
              : 100
            : split === "tuning"
              ? 25
              : 50;
        const candidates = docs
          .filter((d) => tuning.has(d.source.id) === (split === "tuning"))
          .flatMap((d) =>
            d.document.regions
              .filter(
                (r) =>
                  r.text.length >= 100 &&
                  !r.exclusion &&
                  ["paragraph", "list_item", "table"].includes(r.kind),
              )
              .flatMap((r) => {
                const u = d.document.units.find((u) =>
                  u.regions.includes(r.id),
                );
                return u ? [{ d, u, region: r }] : [];
              }),
          )
          .sort((a, b) =>
            digest([m.seed, a.region.id]).localeCompare(
              digest([m.seed, b.region.id]),
            ),
          );
        if (candidates.length < count)
          throw new Error(
            `not enough distinct source units for ${split}/${domain}; no duplicate tasks manufactured`,
          );
        for (let i = 0; i < count; i++) {
          const { d, u, region } = candidates[i];
          const family = `document:${d.source.id}`;
          const kind =
            i % 10 === 9
              ? "absence"
              : i % 4 === 0
                ? "define"
                : i % 4 === 1
                  ? "relations"
                  : "locate";
          const topic = `${u.title}: ${region.text.split(/\s+/).slice(0, 12).join(" ")}`;
          const query =
            kind === "define"
              ? `Find definitions and scope relevant to ${topic}.`
              : kind === "relations"
                ? `Find the source statements and related conditions, exceptions, citations or supporting context for ${topic}.`
                : kind === "absence"
                  ? `Does this corpus explicitly specify ${domain === "lending" ? "a 17-month lookback requirement" : "replication across seven independent cohorts"} for ${topic}?`
                  : `Locate the source evidence describing ${topic}.`;
          const proposal = {
            draft_query: query,
            task_kind: kind,
            instructions:
              "Correct the query when necessary and independently identify relevant revision IDs, supporting IDs and whether the corpus answers it. Review topic overlap before freezing splits.",
          };
          const value: Omit<ReviewItem, "id"> = {
            kind: "benchmark",
            document: d.source.id,
            domain,
            format: d.document.format,
            title: `${split} task ${i + 1}`,
            prompt:
              query +
              "\nSubmit a correction {query,kind,relevant:[revision IDs],supporting:[revision IDs],answerable:boolean}. Rewrite this source-derived draft as an independent information need. Browse the source corpus and add evidence the system missed. Empty lists require an explicit no-answer judgment.",
            source: sourceCatalog,
            bindings: boundArtifacts,
            proposal,
            batch: Math.floor(i / 10) + 1,
            split,
            family,
          };
          const item = { ...value, id: `benchmark:${digest(value)}` };
          store.put(item);
          created.push(item.id);
        }
      }
    }
    const plan = {
      schema_version: 1,
      seed: m.seed,
      items: created,
      tuning: 100,
      heldout: 200,
      label_origin: "unjudged_machine_drafted_tasks",
      split_unit:
        "whole source document; human topic-overlap review still required",
    };
    atomic(path.join(m.run, "benchmark-plan.json"), plan);
    return plan;
  } finally {
    store.close();
  }
}

export function exportBenchmark(
  run: string,
  split: "tuning" | "heldout",
): BenchmarkTask[] {
  const store = new ReviewStore(run);
  try {
    const expected = split === "tuning" ? 100 : 200;
    const items = store
      .items()
      .filter((i) => i.kind === "benchmark" && i.split === split);
    if (items.length !== expected)
      throw new Error(`expected ${expected} ${split} tasks`);
    return items.map((item) => {
      store.assertAccessible(item);
      store.assertFresh(item);
      const receipt = store.latest(item.id);
      const c = receipt?.correction as Partial<BenchmarkTask> | undefined;
      if (
        receipt?.decision !== "correct" ||
        !c?.query?.trim() ||
        !Array.isArray(c.relevant) ||
        !Array.isArray(c.supporting) ||
        typeof c.answerable !== "boolean" ||
        !c.kind ||
        !["locate", "define", "relations", "absence"].includes(c.kind) ||
        (c.answerable && !c.relevant.length)
      )
        throw new Error("independent benchmark judgments are incomplete");
      const known = new Set(
        item.source.flatMap((_, i) => {
          const d = store.sourceDocument(item, i);
          return d ? d.units.map((u) => `${u.id}@${d.effective}`) : [];
        }),
      );
      if (
        [...c.relevant, ...c.supporting].some((id) => !known.has(id)) ||
        new Set(c.relevant).size !== c.relevant.length ||
        new Set(c.supporting).size !== c.supporting.length ||
        (!c.answerable && (c.relevant.length || c.supporting.length))
      )
        throw new Error(
          "benchmark judgment has unknown, duplicate or inconsistent revision IDs",
        );
      return {
        id: item.id,
        split,
        domain: item.domain,
        family: item.family!,
        query: c.query,
        kind: c.kind,
        relevant: c.relevant,
        supporting: c.supporting,
        answerable: c.answerable,
        reviewer: receipt.reviewer,
        receipt_sha256: receipt.sha256,
      };
    });
  } finally {
    store.close();
  }
}

export function freezeBenchmark(
  manifestFile: string,
  recipes: string,
  topicReview: string,
) {
  const m = loadManifest(manifestFile);
  const store = new ReviewStore(m.run);
  try {
    const overlap = json<{
      reviewer: string;
      reason: string;
      no_topic_leakage: boolean;
    }>(topicReview);
    if (
      !overlap.reviewer?.trim() ||
      !overlap.reason?.trim() ||
      overlap.no_topic_leakage !== true
    )
      throw new Error(
        "human task-family/topic overlap review required before held-out access",
      );
    const tuning = exportBenchmark(m.run, "tuning");
    const held = store
      .items()
      .filter((i) => i.kind === "benchmark" && i.split === "heldout");
    const families = new Set(tuning.map((t) => t.family));
    if (held.some((i) => families.has(i.family!)))
      throw new Error("task-family leakage between splits");
    if (held.some((i) => i.receipt))
      throw new Error(
        "held-out judgments already exist; recipes had to be frozen before them",
      );
    const file = safePath(m.run, "benchmark-freeze.json");
    if (existsSync(file)) throw new Error("benchmark freeze is immutable");
    const freeze = {
      schema_version: 1,
      manifest: hash(readFileSync(manifestFile)),
      recipes_file: path.resolve(recipes),
      recipes_sha256: hash(readFileSync(recipes)),
      recipes: json(recipes),
      recipe_bindings: Object.fromEntries([
        ...[
          "crates",
          "packages/sect-harness/src/pipeline",
          "packages/sect-convert/src",
        ].flatMap((relative) =>
          Object.entries(files(path.join(m.root, relative))).map(
            ([file, sha]) => [path.join(m.root, relative, file), sha],
          ),
        ),
        ...[
          manifestFile,
          recipes,
          path.join(m.root, "eval/qualification.py"),
          ...m.sources.map((s) => s.profile),
        ].map((file) => [path.resolve(file), hash(readFileSync(file))]),
      ]),
      topic_review_sha256: hash(readFileSync(topicReview)),
      tuning_sha256: digest(tuning),
      heldout_items: held.map((i) => i.item_sha256),
      created: new Date().toISOString(),
    };
    writeFileSync(file, JSON.stringify(freeze, null, 2) + "\n", { flag: "wx" });
    return freeze;
  } finally {
    store.close();
  }
}

/** Wire the reviewed tasks into the existing five-variant qualification runner. */
export function benchmarkJsonLines(
  run: string,
  split: "tuning" | "heldout",
): string {
  return (
    exportBenchmark(run, split)
      .map((task) =>
        JSON.stringify({
          ...task,
          domain: task.domain === "lending" ? "lending" : "research",
          ...(task.domain !== "lending" ? { discipline: task.domain } : {}),
          no_answer: !task.answerable,
          labeler: task.reviewer,
          independent: true,
          label_origin: "human_review_receipt",
          task_family: task.family,
        }),
      )
      .join("\n") + "\n"
  );
}
