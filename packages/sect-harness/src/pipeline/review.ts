import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { canonical, digest, hash, safePath, json } from "./io.js";
import type { Locator } from "@sectgrep/convert/knowledge";
import type { DocumentArtifact } from "@sectgrep/convert/document";

export type ReviewKind =
  | "extraction"
  | "profile"
  | "knowledge"
  | "identity"
  | "benchmark";
export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  document: string;
  domain: string;
  format: string;
  title: string;
  prompt: string;
  source: { file: string; sha256: string; locator: Locator; text: string }[];
  bindings: Record<string, string>;
  proposal?: unknown;
  batch: number;
  lot?: string;
  split?: "tuning" | "heldout";
  family?: string;
}
export interface Decision {
  item: string;
  item_sha256: string;
  reviewer: string;
  decision: "accept" | "reject" | "correct" | "defer";
  reason: string;
  checks: Record<string, "passed" | "failed" | "not_applicable">;
  correction?: unknown;
  evidence?: {
    file: string;
    sha256: string;
    locator: Locator;
    quote: string;
  }[];
}
export interface Receipt extends Decision {
  sequence: number;
  created: string;
  previous: string | null;
  sha256: string;
}

/** Review is an append-only event log. All import, CLI and browser writes use this service. */
export class ReviewStore {
  private db: DatabaseSync;
  private documents = new Map<string, DocumentArtifact | null>();
  constructor(readonly run: string) {
    const file = safePath(run, "review.sqlite");
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, hash TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (sequence INTEGER PRIMARY KEY, item TEXT NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS immutable_receipt_update BEFORE UPDATE ON receipts BEGIN SELECT RAISE(ABORT,'receipts are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_receipt_delete BEFORE DELETE ON receipts BEGIN SELECT RAISE(ABORT,'receipts are immutable'); END;`);
  }
  close() {
    this.db.close();
  }
  put(item: ReviewItem): string {
    const bytes = canonical(item);
    const id = digest(item);
    const prior = this.db
      .prepare("SELECT hash FROM items WHERE id=?")
      .get(item.id) as { hash: string } | undefined;
    if (prior && prior.hash !== id)
      throw new Error("review item is immutable; use a new content-bound id");
    this.db
      .prepare("INSERT OR IGNORE INTO items VALUES (?,?,?)")
      .run(item.id, id, bytes);
    return id;
  }
  get(id: string): ReviewItem {
    const row = this.db.prepare("SELECT body FROM items WHERE id=?").get(id) as
      | { body: string }
      | undefined;
    if (!row) throw new Error("unknown review item");
    return JSON.parse(row.body);
  }
  items(): Array<
    ReviewItem & { item_sha256: string; receipt: Receipt | null }
  > {
    return (
      this.db.prepare("SELECT body,hash FROM items ORDER BY rowid").all() as {
        body: string;
        hash: string;
      }[]
    ).map((row) => {
      const item = JSON.parse(row.body) as ReviewItem;
      return { ...item, item_sha256: row.hash, receipt: this.latest(item.id) };
    });
  }
  latest(item: string): Receipt | null {
    const row = this.db
      .prepare(
        "SELECT body FROM receipts WHERE item=? ORDER BY sequence DESC LIMIT 1",
      )
      .get(item) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : null;
  }
  assertFresh(item: ReviewItem) {
    for (const [file, expected] of Object.entries(item.bindings))
      if (
        hash(
          readFileSync(safePath(path.dirname(file), path.basename(file))),
        ) !== expected
      )
        throw new Error(
          "source/proposal changed; stale review decision rejected",
        );
    for (const s of item.source)
      if (
        hash(
          readFileSync(safePath(path.dirname(s.file), path.basename(s.file))),
        ) !== s.sha256
      )
        throw new Error("source bytes changed; stale review decision rejected");
  }
  assertAccessible(item: ReviewItem) {
    if (item.kind !== "benchmark" || item.split !== "heldout") return;
    const file = path.join(this.run, "benchmark-freeze.json");
    if (!existsSync(file))
      throw new Error(
        "held-out review is locked until tuning, topic-overlap review and recipe freeze are complete",
      );
    const freeze = json<{
      heldout_items: string[];
      recipes_sha256: string;
      recipes_file: string;
      recipe_bindings?: Record<string, string>;
    }>(file);
    if (
      !freeze.heldout_items.includes(digest(item)) ||
      !freeze.recipes_file ||
      hash(readFileSync(freeze.recipes_file)) !== freeze.recipes_sha256
    )
      throw new Error("held-out recipe or task binding changed; access locked");
    for (const [file, expected] of Object.entries(freeze.recipe_bindings ?? {}))
      if (hash(readFileSync(file)) !== expected)
        throw new Error(
          "held-out implementation binding changed; access locked",
        );
  }
  sourceDocument(
    item: ReviewItem,
    index: number,
  ): DocumentArtifact | undefined {
    const source = item.source[index];
    if (!source) return;
    for (const file of Object.keys(item.bindings)) {
      if (!file.endsWith(".json")) continue;
      const key = `${file}:${item.bindings[file]}`;
      if (!this.documents.has(key)) {
        const value = json<DocumentArtifact | { document: DocumentArtifact }>(
          file,
        );
        const doc =
          typeof value.document === "object"
            ? value.document
            : (value as DocumentArtifact);
        this.documents.set(
          key,
          Array.isArray(doc.regions) && Array.isArray(doc.units) ? doc : null,
        );
      }
      const doc = this.documents.get(key);
      if (doc?.raw_sha256 === source.sha256) return doc;
    }
  }
  decide(input: Decision): Receipt {
    const item = this.get(input.item);
    this.assertAccessible(item);
    if (
      digest(item) !== input.item_sha256 ||
      !input.reviewer?.trim() ||
      !input.reason?.trim() ||
      !["accept", "reject", "correct", "defer"].includes(input.decision)
    )
      throw new Error(
        "decision requires exact item hash, reviewer, choice and reason",
      );
    if (
      !input.checks ||
      Object.values(input.checks).some(
        (v) => !["passed", "failed", "not_applicable"].includes(v),
      )
    )
      throw new Error("invalid checklist");
    if (input.decision === "correct" && input.correction === undefined)
      throw new Error("correction payload required");
    if (
      input.decision === "accept" &&
      Object.values(input.checks).includes("failed")
    )
      throw new Error("failed checks cannot be accepted");
    if (
      input.decision === "accept" &&
      item.kind === "extraction" &&
      [
        "text_fidelity",
        "reading_order",
        "structure",
        "table_associations",
      ].some((k) => !input.checks[k])
    )
      throw new Error("complete the extraction checklist");
    this.assertFresh(item);
    if (item.kind === "benchmark" && input.decision === "correct") {
      const c = input.correction as {
        query?: string;
        kind?: string;
        answerable?: boolean;
        relevant?: string[];
        supporting?: string[];
      };
      if (
        !c?.query?.trim() ||
        !["locate", "define", "relations", "absence"].includes(c.kind ?? "") ||
        typeof c.answerable !== "boolean" ||
        !Array.isArray(c.relevant) ||
        !Array.isArray(c.supporting)
      )
        throw new Error("complete the independent benchmark judgment");
      const known = new Set(
        item.source.flatMap((_, i) => {
          const doc = this.sourceDocument(item, i);
          return doc ? doc.units.map((u) => `${u.id}@${doc.effective}`) : [];
        }),
      );
      if (
        [...c.relevant, ...c.supporting].some((id) => !known.has(id)) ||
        new Set(c.relevant).size !== c.relevant.length ||
        new Set(c.supporting).size !== c.supporting.length ||
        (c.answerable && !c.relevant.length) ||
        (!c.answerable && (c.relevant.length || c.supporting.length))
      )
        throw new Error(
          "use existing source revision IDs with consistent answerability; remove duplicate IDs",
        );
    }
    for (const e of input.evidence ?? []) {
      const index = item.source.findIndex(
        (s) => s.file === e.file && s.sha256 === e.sha256,
      );
      if (index < 0 || !e.quote?.trim())
        throw new Error(
          "additional evidence must come from a registered source",
        );
      const regions =
        this.sourceDocument(item, index)?.regions ??
        item.source.map((s) => ({ locator: s.locator, text: s.text }));
      if (
        !regions.some(
          (r) =>
            canonical(r.locator) === canonical(e.locator) &&
            r.text.includes(e.quote),
        )
      )
        throw new Error(
          "additional evidence quote does not match its source locator",
        );
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          "SELECT sequence,hash FROM receipts ORDER BY sequence DESC LIMIT 1",
        )
        .get() as { sequence: number; hash: string } | undefined;
      const data = {
        ...input,
        sequence: (row?.sequence ?? 0) + 1,
        created: new Date().toISOString(),
        previous: row?.hash ?? null,
      };
      const receipt: Receipt = { ...data, sha256: digest(data) };
      this.db
        .prepare("INSERT INTO receipts VALUES (?,?,?,?)")
        .run(receipt.sequence, item.id, canonical(receipt), receipt.sha256);
      this.db.exec("COMMIT");
      return receipt;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  accepted(id: string): Receipt | null {
    const item = this.get(id);
    this.assertFresh(item);
    const receipt = this.latest(id);
    return receipt?.decision === "accept" &&
      receipt.item_sha256 === digest(item)
      ? receipt
      : null;
  }
  export() {
    const items = this.items().filter((item) => {
      try {
        this.assertAccessible(item);
        return true;
      } catch {
        return false;
      }
    });
    const visible = new Set(items.map((i) => i.id));
    return {
      schema_version: 1,
      decisions: items.flatMap(({ receipt }) => {
        if (!receipt) return [];
        const { sequence, created, previous, sha256, ...decision } = receipt;
        return [decision];
      }),
      items: items.map(({ receipt, item_sha256, ...item }) => ({
        item,
        item_sha256,
      })),
      receipts: (
        this.db
          .prepare("SELECT body FROM receipts ORDER BY sequence")
          .all() as { body: string }[]
      )
        .map((r) => JSON.parse(r.body) as Receipt)
        .filter((r) => visible.has(r.item)),
    };
  }
  import(input: { decisions: Decision[] }) {
    if (!Array.isArray(input.decisions))
      throw new Error("expected decisions array");
    return input.decisions.map((d) => this.decide(d));
  }
  approvedProfile(id: string): unknown {
    const item = this.get(id);
    if (item.kind !== "profile" || !this.accepted(id))
      throw new Error(
        "profile export requires a fresh explicit acceptance receipt",
      );
    return (item.proposal as { profile: unknown }).profile;
  }
}

/** Seeded random ordering within strata, plus randomized stratum order. No ID-prefix sample bias. */
export function sampleRecords<T>(
  records: T[],
  count: number,
  seed: string,
  stratum: (item: T) => string,
  identity: (item: T) => unknown = (item) => item,
): T[] {
  if (!Number.isInteger(count) || count < 0)
    throw new Error("sample count must be a nonnegative integer");
  const groups = new Map<string, T[]>();
  const ranks = new Map<T, string>();
  for (const item of records) {
    const key = stratum(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
    ranks.set(item, digest([seed, identity(item)]));
  }
  const order = [...groups.keys()].sort((a, b) =>
    digest([seed, a]).localeCompare(digest([seed, b])),
  );
  for (const [key, values] of groups)
    groups.set(
      key,
      values.sort((a, b) => ranks.get(a)!.localeCompare(ranks.get(b)!)),
    );
  const result: T[] = [];
  for (let i = 0; result.length < Math.min(count, records.length); i++)
    for (const key of order) {
      const item = groups.get(key)![i];
      if (item !== undefined && result.length < count) result.push(item);
    }
  return result;
}

export function lotPolicy(history: Array<{ accepted: boolean }>): {
  n: 20 | 32;
  level: string;
} {
  let lastFailure = -1;
  history.forEach((x, i) => {
    if (!x.accepted) lastFailure = i;
  });
  return lastFailure >= 0 && history.length - lastFailure - 1 < 5
    ? { n: 32, level: "tightened" }
    : { n: 20, level: "normal" };
}
