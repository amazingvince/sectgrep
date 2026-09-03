// Run a Pi agent with the seven sect verbs as its tools. Without an API key it lists the tools
// and exits, so the example is runnable anywhere the binary is.
//
//   SECT_BIN=target/release/sect pnpm --filter @sectgrep/example-pi start "What is the guardrail height?"

import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectSect } from "./sect-tools.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const bin = process.env.SECT_BIN ?? path.join(root, "target", "release", process.platform === "win32" ? "sect.exe" : "sect");
const corpus = process.env.SECT_CORPUS ?? path.join(root, "fixtures", "corpus");
const question = process.argv[2] ?? "What is the minimum height of a guardrail top rail, and which section says so?";

const sect = await connectSect({ bin, corpus });
console.log(`sect tools: ${sect.tools.map((t) => t.name).join(", ")}`);

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("ANTHROPIC_API_KEY is not set; listed the tools and stopped (no paid call made).");
  await sect.close();
  process.exit(0);
}

const skill = readFileSync(path.join(root, "docs", "SKILL.md"), "utf-8");
const agent = new Agent({
  initialState: {
    systemPrompt: skill,
    model: getModel("anthropic", "claude-sonnet-4-5"),
    tools: sect.tools,
  },
  // The verbs only read the corpus; a harness that also writes (WS3) gates writes here.
  beforeToolCall: async ({ toolCall }) => (toolCall.name.startsWith("sect_") ? undefined : { block: true, reason: "only sect verbs are allowed here" }),
});
agent.subscribe((event) => {
  if (event.type === "tool_execution_start") console.log(`-> ${event.toolName} ${JSON.stringify(event.args)}`);
});
await agent.prompt(question);
await agent.waitForIdle();
const last = agent.state.messages.at(-1);
if (last && last.role === "assistant") {
  for (const block of last.content) if (block.type === "text") console.log(block.text);
}
await sect.close();
