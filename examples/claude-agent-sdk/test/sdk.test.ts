// The registration the SDK example hands to `query()` is exercised without an LLM: the same
// command and arguments are started over MCP stdio, the advertised tools must be exactly the
// seven names the example pre-allows, and every verb is called once. Needs the `sect` binary
// (SECT_BIN or target/debug/sect); skips loudly otherwise.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SECT_VERBS, sectOptions, sectServer, sectToolNames } from "../src/sect-mcp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const bin = process.env.SECT_BIN ?? path.join(root, "target", "debug", process.platform === "win32" ? "sect.exe" : "sect");
const corpus = path.join(root, "fixtures", "corpus");
const haveBinary = existsSync(bin);
if (!haveBinary) console.warn(`sect binary not found at ${bin}; set SECT_BIN or run cargo build. Skipping the Claude Agent SDK example test.`);

const CALLS: Array<[string, Record<string, unknown>, string]> = [
  ["sect_status", {}, "freshness:"],
  ["sect_search", { query: "99 CFR 2.8", limit: 3 }, "CFR:99-2.8"],
  ["sect_grep", { pattern: "cage", ignore_case: true, count_only: true }, "count"],
  ["sect_read", { id: "CFR:99-2.7", as_of: "2025-06-01" }, "§ 2.7"],
  ["sect_refs", { id: "CFR:99-2.8", direction: "in" }, "CFR:99-2.4"],
  ["sect_define", { term: "qualified person" }, "CFR:99-1.2"],
  ["sect_map", { scope: "CFR:99-2.13#c", complete: true }, "c-1"],
];

describe("the registration handed to the Claude Agent SDK", () => {
  it("names the server, the command, and the seven namespaced tools", () => {
    const opts = sectOptions({ bin, corpus });
    const server = opts.mcpServers!.sect as { command: string; args: string[]; type?: string };
    expect(server.type).toBe("stdio");
    expect(server.command).toBe(bin);
    expect(server.args.slice(0, 3)).toEqual(["serve", "--corpus", corpus]);
    expect(opts.allowedTools).toEqual(SECT_VERBS.map((v) => `mcp__sect__${v}`));
    expect(sectToolNames("other")[0]).toBe("mcp__other__sect_search");
    expect(sectServer({ bin, corpus, toolset: "full" }).args).toContain("--toolset");
  });
});

describe.skipIf(!haveBinary)("the same server, started the way the SDK starts it", () => {
  const client = new Client({ name: "sect-sdk-example-test", version: "0.1.0" });
  beforeAll(async () => {
    const server = sectServer({ bin, corpus });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env, stderr: "pipe" }));
  }, 120_000);
  afterAll(async () => {
    await client.close();
  });

  it("advertises exactly the seven verbs the example pre-allows", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...SECT_VERBS].sort());
  });

  it.each(CALLS)("%s answers unchanged", async (name, args, needle) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    expect(r.isError ?? false).toBe(false);
    expect(text.startsWith("freshness:")).toBe(true);
    expect(text).toContain(needle);
  }, 60_000);
});
