import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { canonical, digest, safePath } from "./io.js";

export interface Price {
  model: string;
  requested_model?: string;
  family: string;
  provider: string;
  endpoint: string;
  input_per_token: number;
  output_per_token: number;
  request: number;
  obtained: string;
  evidence_sha256: string;
}
export class Budget {
  private db: DatabaseSync;
  constructor(
    file: string,
    readonly cap = 100,
  ) {
    if (cap !== 100)
      throw new Error(
        "this campaign is authorized for exactly $100; top-ups are disabled",
      );
    safePath(path.dirname(file), path.basename(file));
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(
      "PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, binding TEXT NOT NULL, reserved REAL NOT NULL, actual REAL, response TEXT, created TEXT NOT NULL); CREATE TABLE IF NOT EXISTS campaign (id INTEGER PRIMARY KEY CHECK(id=1), cap REAL NOT NULL)",
    );
    this.db.prepare("INSERT OR IGNORE INTO campaign VALUES (1, ?)").run(cap);
    if (
      (this.db.prepare("SELECT cap FROM campaign").get() as { cap: number })
        .cap !== cap
    )
      throw new Error("campaign cap mismatch");
  }
  close() {
    this.db.close();
  }
  status() {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) AS committed, COALESCE(SUM(actual),0) AS charged, COUNT(*) AS calls, SUM(CASE WHEN actual IS NULL THEN 1 ELSE 0 END) AS unresolved FROM calls",
      )
      .get() as {
      committed: number;
      charged: number;
      calls: number;
      unresolved: number | null;
    };
    return {
      ...row,
      cap: this.cap,
      remaining: Math.max(0, this.cap - row.committed),
    };
  }
  reserve(
    id: string,
    binding: unknown,
    maximum: number,
  ): { cached?: unknown; fresh: boolean } {
    if (!Number.isFinite(maximum) || maximum < 0)
      throw new Error("unknown or invalid price; campaign paused");
    const bytes = digest(binding);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db.prepare("SELECT * FROM calls WHERE id=?").get(id) as
        | { binding: string; response: string | null }
        | undefined;
      if (old) {
        if (old.binding !== bytes)
          throw new Error("call identity reused for different input");
        if (!old.response)
          throw new Error(
            "ambiguous prior charge remains reserved; reconcile it before retrying",
          );
        this.db.exec("COMMIT");
        return { fresh: false, cached: JSON.parse(old.response) };
      }
      if (
        this.db
          .prepare("SELECT id FROM calls WHERE actual > reserved LIMIT 1")
          .get()
      )
        throw new Error(
          "campaign paused after a provider charge exceeded its reservation",
        );
      if (this.status().committed + maximum > this.cap)
        throw new Error("campaign budget exhausted; no call sent");
      this.db
        .prepare("INSERT INTO calls VALUES (?,?,?,NULL,NULL,?)")
        .run(id, bytes, maximum, new Date().toISOString());
      this.db.exec("COMMIT");
      return { fresh: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  reconcile(id: string, actual: number, response: unknown) {
    if (!Number.isFinite(actual) || actual < 0)
      throw new Error(
        "provider did not report a usable charge; reservation retained",
      );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db
        .prepare("SELECT reserved,actual,response FROM calls WHERE id=?")
        .get(id) as
        | { reserved: number; actual: number | null; response: string | null }
        | undefined;
      if (!old) throw new Error("missing call reservation");
      if (
        old.actual !== null &&
        (old.actual !== actual || old.response !== canonical(response))
      )
        throw new Error("charge receipt is immutable");
      this.db
        .prepare("UPDATE calls SET actual=?,response=? WHERE id=?")
        .run(actual, canonical(response), id);
      this.db.exec("COMMIT");
      if (actual > old.reserved)
        throw new Error(
          "provider exceeded reserved maximum; charge recorded, campaign must be investigated",
        );
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function maximumCharge(
  price: Price,
  prompt: string,
  outputTokens: number,
): number {
  const numbers = [
    price.input_per_token,
    price.output_per_token,
    price.request,
  ];
  if (
    numbers.some((n) => !Number.isFinite(n) || n < 0) ||
    !price.evidence_sha256 ||
    !price.model ||
    !Number.isInteger(outputTokens) ||
    outputTokens < 1
  )
    throw new Error("pinned price and output limit required");
  // One token per UTF-8 byte plus generous protocol overhead is a conservative input bound.
  return (
    (Buffer.byteLength(prompt) + 8192) * price.input_per_token +
    outputTokens * price.output_per_token +
    price.request
  );
}
