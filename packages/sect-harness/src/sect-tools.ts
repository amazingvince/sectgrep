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
  /**
   * For an agent that carries the schemas on every call: one-sentence descriptions, only the
   * parameters an ingest turn uses, search limited to 5 hits, and results trimmed to the lines
   * that matched with one line of context each.
   */
  compact?: boolean;
}

/** What an ingest turn needs of each verb; the rest of the server's schema is left out. */
const COMPACT: Record<string, { params: string[]; description: string }> = {
  sect_search: { params: ["query", "limit", "scope", "source"], description: "Ranked search over the corpus; a citation in a source's own form is answered structurally. Returns ids, titles and the matching lines." },
  sect_read: { params: ["id", "as_of"], description: "One section by id (or id#anchor) with its structural context." },
  sect_map: { params: ["scope", "depth"], description: "Table of contents under a Work id." },
};

const PREAMBLE = /^(freshness|counts|search|grep|scope|map):/;
const HIT = /^\s*\d+\.\s+[A-Z][A-Z0-9]*:\S+/;

/**
 * A search or grep result trimmed for an agent: the preamble goes, each hit keeps its header
 * (id and title), a breadcrumb cut to its last two steps, and the lines holding a query term
 * with one line of context each; the whole is capped.
 */
export function trimResult(text: string, query: string, maxChars = 2500): string {
  const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.'-]*/gu) ?? []).filter((t) => t.length >= 3))];
  const lines = text.split("\n");
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (PREAMBLE.test(l)) continue;
    if (HIT.test(l)) {
      keep[i] = true;
      continue;
    }
    const low = l.toLowerCase();
    if (terms.some((t) => low.includes(t))) {
      keep[i] = true;
      if (i > 0 && !PREAMBLE.test(lines[i - 1])) keep[i - 1] = true;
      if (i + 1 < lines.length) keep[i + 1] = true;
    }
  }
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i] || PREAMBLE.test(lines[i])) continue;
    let l = lines[i];
    if (HIT.test(l)) l = l.replace(/\s+eff\s+\d{4}-\d{2}-\d{2}.*$/, "");
    else if (l.includes(" > ")) {
      const parts = l.split(" > ");
      l = `${l.match(/^\s*/)?.[0] ?? ""}... > ${parts.slice(-2).join(" > ").trim()}`;
    }
    out.push(l);
  }
  let s = out.join("\n");
  if (!s.trim()) s = lines.filter((l) => !PREAMBLE.test(l)).join("\n").slice(0, maxChars);
  if (s.length > maxChars) s = s.slice(0, maxChars) + "\n[trimmed]";
  return s;
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
  const agentTools: AgentTool[] = tools.map((t) => {
    const compact = opts.compact ? COMPACT[t.name] : undefined;
    const full = t.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    const parameters = compact
      ? { type: "object", properties: Object.fromEntries(Object.entries(full.properties ?? {}).filter(([k]) => compact.params.includes(k))), required: (full.required ?? []).filter((k) => compact.params.includes(k)), additionalProperties: false }
      : t.inputSchema;
    return {
      name: t.name,
      label: t.name,
      description: compact?.description ?? t.description ?? "",
      // The server's JSON schema is what Pi validates against; TypeBox schemas are JSON schemas.
      parameters: parameters as unknown as TSchema,
      executionMode: "parallel",
      async execute(_toolCallId, raw) {
        let params = raw as Record<string, unknown>;
        if (opts.compact && t.name === "sect_search") params = { ...params, limit: Math.min(Number(params.limit) || 3, 5) };
        const r = await client.callTool({ name: t.name, arguments: params });
        const blocks = (r.content as TextBlock[]).filter((c) => c.type === "text");
        let content = blocks.map((c) => ({ type: "text" as const, text: c.text ?? "" }));
        if (r.isError) throw new Error(content.map((c) => c.text).join("\n") || `${t.name} failed`);
        if (opts.compact) {
          const joined = content.map((c) => c.text).join("\n");
          const text = t.name === "sect_search" || t.name === "sect_grep" ? trimResult(joined, String(params.query ?? params.pattern ?? "")) : joined.length > 6000 ? joined.slice(0, 6000) + "\n[trimmed]" : joined;
          content = [{ type: "text", text }];
        }
        return { content, details: r.structuredContent };
      },
    };
  });
  return { tools: agentTools, close: () => client.close() };
}
