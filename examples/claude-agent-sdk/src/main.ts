// Ask a question through the Claude Agent SDK with the sect MCP server registered. The SDK
// spawns `sect serve` itself. Without an API key it prints the registration and exits, so the
// example is runnable anywhere the binary is.
//
//   SECT_BIN=target/release/sect pnpm --filter @sectgrep/example-claude-agent-sdk start "What is the guardrail height?"

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sectOptions } from "./sect-mcp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const bin = process.env.SECT_BIN ?? path.join(root, "target", "release", process.platform === "win32" ? "sect.exe" : "sect");
const corpus = process.env.SECT_CORPUS ?? path.join(root, "fixtures", "corpus");
const question = process.argv[2] ?? "What is the minimum height of a guardrail top rail, and which section says so?";
const skill = readFileSync(path.join(root, "docs", "SKILL.md"), "utf-8");
const options = sectOptions({ bin, corpus }, skill);

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("ANTHROPIC_API_KEY is not set; this is the registration the SDK would use (no paid call made):");
  console.log(JSON.stringify({ mcpServers: options.mcpServers, allowedTools: options.allowedTools }, null, 2));
  process.exit(0);
}

for await (const message of query({ prompt: question, options })) {
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "tool_use") console.log(`-> ${block.name} ${JSON.stringify(block.input)}`);
    }
  } else if (message.type === "result") {
    console.log(message.subtype === "success" ? message.result : `stopped: ${message.subtype}`);
  }
}
