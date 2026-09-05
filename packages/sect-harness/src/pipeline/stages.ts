import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomic, digest, exclusive, files, json, safePath } from "./io.js";

export const STAGES = [
  "inventory",
  "extract",
  "organize",
  "profile",
  "enrich",
  "identity",
  "verify",
  "sample",
  "publish",
] as const;
export type StageName = (typeof STAGES)[number];
export interface StageReceipt {
  schema_version: 1;
  document: string;
  stage: StageName;
  key: string;
  inputs: unknown;
  implementation: string;
  status: "running" | "complete" | "held" | "failed";
  started: string;
  finished?: string;
  output: string;
  hashes: Record<string, string>;
  reason?: string;
}
export class Held extends Error {}

/** Every attempt writes a new directory. The completion receipt is the only cache pointer. */
export async function stage<T>(
  run: string,
  document: string,
  name: StageName,
  inputs: unknown,
  implementation: string,
  task: (out: string) => Promise<T> | T,
): Promise<{ value: T; receipt: StageReceipt; reused: boolean }> {
  if (!/^[a-zA-Z0-9_-]+$/.test(document))
    throw new Error("invalid stage document key");
  const base = safePath(run, `documents/${document}/${name}`);
  const key = digest({ inputs, implementation });
  return exclusive(path.join(base, "mutex.sqlite"), async () => {
    const pointer = path.join(base, "stage.json");
    if (existsSync(pointer)) {
      const old = json<StageReceipt>(pointer);
      const out = safePath(base, old.output);
      if (
        old.status === "complete" &&
        old.key === key &&
        digest(old.hashes) === digest(files(out))
      )
        return {
          value: json<T>(path.join(out, "result.json")),
          receipt: old,
          reused: true,
        };
    }
    const output = `attempts/${randomUUID()}`;
    const out = safePath(base, output);
    mkdirSync(out, { recursive: true });
    const receipt: StageReceipt = {
      schema_version: 1,
      document,
      stage: name,
      key,
      inputs,
      implementation,
      status: "running",
      started: new Date().toISOString(),
      output,
      hashes: {},
    };
    atomic(pointer, receipt);
    try {
      const value = await task(out);
      atomic(path.join(out, "result.json"), value);
      Object.assign(receipt, {
        status: "complete",
        finished: new Date().toISOString(),
        hashes: files(out),
      });
      atomic(
        path.join(out, "../", `${path.basename(out)}.receipt.json`),
        receipt,
      );
      atomic(pointer, receipt);
      return { value, receipt, reused: false };
    } catch (error) {
      Object.assign(receipt, {
        status: error instanceof Held ? "held" : "failed",
        finished: new Date().toISOString(),
        hashes: files(out),
        reason: error instanceof Error ? error.message : String(error),
      });
      atomic(pointer, receipt);
      throw error;
    }
  });
}

export function stageStatus(run: string, documents: string[]): StageReceipt[] {
  return documents.flatMap((doc) =>
    STAGES.flatMap((name) => {
      const file = safePath(run, `documents/${doc}/${name}/stage.json`);
      if (!existsSync(file)) return [];
      const receipt = json<StageReceipt>(file);
      if (
        receipt.status === "complete" &&
        digest(receipt.hashes) !==
          digest(files(safePath(path.dirname(file), receipt.output)))
      )
        return [
          {
            ...receipt,
            status: "held" as const,
            reason: "output hashes changed; resume to rebuild",
          },
        ];
      return [receipt];
    }),
  );
}
