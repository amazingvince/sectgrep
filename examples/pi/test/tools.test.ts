// Exercises all seven verbs through the Pi tool wrappers against the fixture corpus. Needs the
// `sect` binary: SECT_BIN, or target/debug/sect from `cargo build`. Skips loudly otherwise.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectSect, type SectConnection } from "../src/sect-tools.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const bin = process.env.SECT_BIN ?? path.join(root, "target", "debug", process.platform === "win32" ? "sect.exe" : "sect");
const corpus = path.join(root, "fixtures", "corpus");
const haveBinary = existsSync(bin);
if (!haveBinary) console.warn(`sect binary not found at ${bin}; set SECT_BIN or run cargo build. Skipping the Pi example test.`);

const CALLS: Array<[string, Record<string, unknown>, string]> = [
  ["sect_status", {}, "freshness:"],
  ["sect_search", { query: "99 CFR 2.8", limit: 3 }, "CFR:99-2.8"],
  ["sect_grep", { pattern: "cage", ignore_case: true, count_only: true }, "count"],
  ["sect_read", { id: "CFR:99-2.7", as_of: "2025-06-01" }, "§ 2.7"],
  ["sect_refs", { id: "CFR:99-2.8", direction: "in" }, "CFR:99-2.4"],
  ["sect_define", { term: "qualified person" }, "CFR:99-1.2"],
  ["sect_map", { scope: "CFR:99-2.13#c", complete: true }, "c-1"],
];

describe.skipIf(!haveBinary)("the seven verbs as Pi AgentTools", () => {
  let conn: SectConnection;
  beforeAll(async () => {
    conn = await connectSect({ bin, corpus });
  }, 120_000);
  afterAll(async () => {
    await conn?.close();
  });

  it("advertises exactly the seven verbs by default", () => {
    expect(conn.tools.map((t) => t.name).sort()).toEqual(["sect_define", "sect_grep", "sect_map", "sect_read", "sect_refs", "sect_search", "sect_status"]);
    for (const t of conn.tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect((t.parameters as { type?: string }).type).toBe("object");
    }
  });

  it.each(CALLS)("%s answers with a freshness line first", async (name, args, needle) => {
    const tool = conn.tools.find((t) => t.name === name)!;
    const r = await tool.execute("call-1", args);
    const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(text.startsWith("freshness:")).toBe(true);
    expect(text).toContain(needle);
  }, 60_000);

  it("turns a verb error into a thrown error", async () => {
    const read = conn.tools.find((t) => t.name === "sect_read")!;
    await expect(read.execute("call-2", { id: "CFR:99-9.99" })).rejects.toThrow();
  });

  it("adds the admin verbs only with the full toolset", async () => {
    const full = await connectSect({ bin, corpus, toolset: "full" });
    try {
      expect(full.tools.map((t) => t.name)).toContain("sect_index");
      expect(full.tools).toHaveLength(9);
    } finally {
      await full.close();
    }
  }, 60_000);
});
