// The seven sect verbs as Pi `AgentTool`s (spec D.1): one MCP client to `sect serve`, one
// AgentTool per advertised tool, parameters taken from the server's schema unchanged. The same
// server feeds the Claude Agent SDK example, so the verbs are defined once, in `sect-verbs`.

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { TSchema } from "typebox";

export interface SectOptions {
  /** Path to the `sect` binary. */
  bin: string;
  /** Corpus root (the directory holding the sources and `.sect/`). */
  corpus: string;
  /** `seven` (default) or `full` (adds sect_index and sect_rebuild). */
  toolset?: "seven" | "full";
  /** Extra environment for the server process (HF_HOME for the model cache, for instance). */
  env?: Record<string, string>;
}

export interface SectConnection {
  tools: AgentTool[];
  close(): Promise<void>;
}

interface TextBlock {
  type: string;
  text?: string;
}

/** Start `sect serve` over stdio and wrap every tool it advertises as a Pi AgentTool. */
export async function connectSect(opts: SectOptions): Promise<SectConnection> {
  const args = ["serve", "--corpus", opts.corpus];
  if (opts.toolset === "full") args.push("--toolset", "full");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, opts.env ?? {});
  const transport = new StdioClientTransport({ command: opts.bin, args, env, stderr: "pipe" });
  const client = new Client({ name: "sect-harness", version: "0.1.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const agentTools: AgentTool[] = tools.map((t) => ({
    name: t.name,
    label: t.name,
    description: t.description ?? "",
    // The server's JSON schema is what Pi validates against; TypeBox schemas are JSON schemas.
    parameters: t.inputSchema as unknown as TSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const r = await client.callTool({ name: t.name, arguments: params as Record<string, unknown> });
      const blocks = (r.content as TextBlock[]).filter((c) => c.type === "text");
      const content = blocks.map((c) => ({ type: "text" as const, text: c.text ?? "" }));
      if (r.isError) throw new Error(content.map((c) => c.text).join("\n") || `${t.name} failed`);
      return { content, details: r.structuredContent };
    },
  }));
  return { tools: agentTools, close: () => client.close() };
}
