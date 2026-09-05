import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { exclusive, digest, hash } from "../src/pipeline/io.js";
import {
  ReviewStore,
  sampleRecords,
  type ReviewItem,
} from "../src/pipeline/review.js";
import { Budget } from "../src/pipeline/budget.js";
import {
  normalizeProposal,
  verifyKnowledge,
  combineArtifacts,
} from "../src/pipeline/enrichment.js";
import { startReviewServer } from "../src/pipeline/server.js";
import type { DocumentArtifact } from "@sectgrep/convert/document";
import type { Profile } from "@sectgrep/convert/knowledge";
const dir = () => mkdtempSync(path.join(tmpdir(), "sect-failure-"));

it("releases a process-owned writer lock after a killed worker", async () => {
  const root = dir(),
    file = path.join(root, "lock.sqlite");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync(${JSON.stringify(file)});db.exec('CREATE TABLE mutex(id);BEGIN IMMEDIATE');console.log('locked');setInterval(()=>{},1000);`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
  });
  await expect(exclusive(file, () => 1)).rejects.toThrow();
  const died = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill();
  await died;
  expect(await exclusive(file, () => 42)).toBe(42);
});

it("halts subsequent spend after an over-reservation provider charge", () => {
  const b = new Budget(path.join(dir(), "budget.sqlite"));
  try {
    b.reserve("one", {}, 1);
    expect(() => b.reconcile("one", 2, {})).toThrow();
    expect(() => b.reserve("two", {}, 1)).toThrow("paused");
    expect(b.status().charged).toBe(2);
  } finally {
    b.close();
  }
});

it("withholds complete typed claims when scope, qualifiers or omissions differ", () => {
  const profile: Profile = {
    name: "generic",
    version: "1",
    unit_types: [],
    concept_types: [],
    metadata_fields: [],
    relation_types: [
      {
        name: "requires",
        description: "requires",
        direction: "out",
        weight: 1,
        required_context: true,
      },
    ],
  };
  const raw = "A requires B when the value does not exceed 43%.",
    sha = hash(raw),
    locator = { type: "text" as const, line_start: 1, line_end: 1 };
  const proposal = {
    concepts: [],
    mentions: [],
    relations: [
      {
        id: "r",
        from: { revision: "D:a@2026-01-01", anchor: null },
        to: { revision: "D:b@2026-01-01", anchor: null },
        kind: "requires",
        scope: "D:a",
        qualifiers: { maximum: "43%" },
        evidence: [{ raw: "raw.txt", raw_sha256: sha, locator, quote: raw }],
      },
    ],
  };
  const a = normalizeProposal(proposal, profile);
  const doc = {
    document: "D:manual",
    effective: "2026-01-01",
    raw: "raw.txt",
    raw_sha256: sha,
    units: [{ id: "D:a" }, { id: "D:b" }],
    regions: [{ text: raw, locator }],
  } as DocumentArtifact;
  expect(verifyKnowledge(a, a, [doc])[0]).toMatchObject({
    deterministic: true,
    model_agreement: true,
  });
  const altered = structuredClone(proposal);
  altered.relations[0].qualifiers.maximum = "45%";
  expect(
    verifyKnowledge(a, normalizeProposal(altered, profile), [doc]).every(
      (r) => !r.model_agreement,
    ),
  ).toBe(true);
  altered.relations[0].qualifiers.maximum = "43%";
  altered.relations[0].scope = "D:b";
  expect(
    verifyKnowledge(a, normalizeProposal(altered, profile), [doc]),
  ).toHaveLength(2);
  expect(
    verifyKnowledge(combineArtifacts(profile, []), a, [doc])[0].model_agreement,
  ).toBe(false);
  const repeated = structuredClone(a);
  repeated.relations[0].qualifiers.maximum = "46%";
  expect(() => combineArtifacts(profile, [a, repeated])).toThrow(
    "no claim overwritten",
  );
});

it("locks held-out export, source access and decisions until a byte-bound freeze", async () => {
  const run = dir(),
    file = path.join(run, "raw.txt");
  writeFileSync(file, "original source");
  const store = new ReviewStore(run);
  const item: ReviewItem = {
    id: "held",
    kind: "benchmark",
    document: "doc",
    domain: "ml",
    format: "text",
    title: "held task",
    prompt: "secret draft query",
    source: [
      {
        file,
        sha256: hash(readFileSync(file)),
        text: "original source",
        locator: { type: "text", line_start: 1, line_end: 1 },
      },
    ],
    bindings: {},
    batch: 1,
    split: "heldout",
    family: "doc",
  };
  store.put(item);
  expect(store.export().items).toHaveLength(0);
  const review = await startReviewServer(run);
  const url = new URL(review.url),
    headers = { "x-sect-token": url.hash.slice(1) };
  try {
    expect(
      (await fetch(`${url.origin}/api/source?item=held`, { headers })).status,
    ).toBe(400);
    const items = (await (
      await fetch(`${url.origin}/api/items`, { headers })
    ).json()) as {
      items: { prompt: string; source: unknown[]; locked: boolean }[];
    };
    expect(items.items[0].prompt).not.toContain("secret");
    expect(items.items[0].source).toEqual([]);
    const recipes = path.join(run, "recipes.json");
    writeFileSync(recipes, "{}");
    writeFileSync(
      path.join(run, "benchmark-freeze.json"),
      JSON.stringify({
        heldout_items: [digest(item)],
        recipes_file: recipes,
        recipes_sha256: hash("{}"),
      }),
    );
    expect(
      (await fetch(`${url.origin}/api/source?item=held`, { headers })).status,
    ).toBe(200);
    writeFileSync(recipes, '{"changed":true}');
    expect(() => store.assertAccessible(item)).toThrow("binding changed");
  } finally {
    await new Promise<void>((resolve) => review.server.close(() => resolve()));
    store.close();
  }
});

it("rejects invalid random sample bounds", () => {
  for (const n of [-1, NaN, Infinity, 1.5])
    expect(() => sampleRecords([1, 2], n, "seed", () => "all")).toThrow();
});
