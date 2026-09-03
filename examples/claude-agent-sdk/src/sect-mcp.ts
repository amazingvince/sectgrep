// The sect MCP server as a Claude Agent SDK option set. The SDK spawns `sect serve` itself
// (`mcpServers`, stdio) and namespaces the tools `mcp__sect__<verb>`; nothing about the verbs
// changes between the CLI, Pi, and here. See docs/decisions.md #37 for the registration details.

import type { McpStdioServerConfig, Options } from "@anthropic-ai/claude-agent-sdk";

export const SECT_VERBS = ["sect_search", "sect_grep", "sect_read", "sect_refs", "sect_define", "sect_map", "sect_status"] as const;

export interface SectServerOptions {
  /** Path to the `sect` binary. */
  bin: string;
  /** Corpus root. */
  corpus: string;
  /** `seven` (default) or `full` (adds sect_index and sect_rebuild). */
  toolset?: "seven" | "full";
  env?: Record<string, string>;
}

/** The stdio server entry: the same command `sect install` writes for other clients. */
export function sectServer(o: SectServerOptions): McpStdioServerConfig {
  const args = ["serve", "--corpus", o.corpus];
  if (o.toolset === "full") args.push("--toolset", "full");
  return { type: "stdio", command: o.bin, args, env: o.env, alwaysLoad: true };
}

/** The SDK's names for the seven verbs: `mcp__<server>__<tool>`. */
export function sectToolNames(server = "sect"): string[] {
  return SECT_VERBS.map((v) => `mcp__${server}__${v}`);
}

/** Options for `query()`: the server, the seven tools pre-allowed, and the answering-agent skill. */
export function sectOptions(o: SectServerOptions, skill?: string): Options {
  return {
    mcpServers: { sect: sectServer(o) },
    allowedTools: sectToolNames(),
    ...(skill ? { systemPrompt: { type: "preset", preset: "claude_code", append: skill } } : {}),
    maxTurns: 12,
  };
}
