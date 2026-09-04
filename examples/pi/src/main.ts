// Run a Pi agent with the seven sect verbs as its tools. The model comes from .env (OpenRouter by
// default, docs/decisions.md #41); without a key it lists the tools and exits, so the example is
// runnable anywhere the binary is.
//
//   SECT_BIN=target/release/sect pnpm --filter @sectgrep/example-pi start "What is the guardrail height?"

import { Agent } from "@mariozechner/pi-agent-core";
import { loadDotEnv, modelFromEnv } from "./model.js";
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

loadDotEnv(root);
const choice = modelFromEnv();
if (!choice.apiKey || !choice.model) {
  console.log(`no key for provider ${choice.provider} (model ${choice.id}); listed the tools and stopped (no paid call made). Copy .env.example to .env.`);
  await sect.close();
  process.exit(0);
}
console.log(`model: ${choice.provider} ${choice.id}${choice.noRetention ? " (no-retention routing)" : ""}`);

const skill = readFileSync(path.join(root, "docs", "SKILL.md"), "utf-8");
const agent = new Agent({
  initialState: {
    systemPrompt: skill,
    model: choice.model,
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
