// The agent's model from the shared configuration (packages/sect-convert/src/env.ts): provider,
// id, base URL, key. OpenRouter with a cheap vision-capable GLM model is the default (decisions
// #41). An id Pi's generated registry does not list is built by hand for the provider's
// OpenAI-compatible endpoint, so the model is a free choice in .env.

import { getModel, type Model } from "@mariozechner/pi-ai";
import { modelConfig, type ModelConfig } from "@sectgrep/convert";

export interface ModelChoice {
  config: ModelConfig;
  model: Model<"openai-completions"> | Model<"anthropic-messages"> | undefined;
}

export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): ModelChoice {
  const config = modelConfig(env);
  const known = getModel(config.provider as never, config.model as never) as ModelChoice["model"];
  if (known) return { config, model: known };
  if (config.provider === "anthropic") return { config, model: undefined };
  const model: Model<"openai-completions"> = {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ["text", "image"],
    // OpenRouter's listed price for z-ai/glm-5.3-flash; another id is billed as its provider says.
    cost: { input: 0.075, output: 0.25, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  };
  return { config, model };
}
