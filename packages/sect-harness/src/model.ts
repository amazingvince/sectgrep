// Legacy agent adapter. Unknown model prices are never filled with another model's rates.
// Budgeted corpus creation resolves audited catalog identities in pipeline/models.ts.
import { getModel, type Model } from "@mariozechner/pi-ai";
import {
  modelConfig,
  verifierConfig,
  type ModelConfig,
} from "@sectgrep/convert";

export interface ModelChoice {
  config: ModelConfig;
  model: Model<"openai-completions"> | Model<"anthropic-messages"> | undefined;
}
function knownChoice(config: ModelConfig): ModelChoice {
  const model = getModel(
    config.provider as never,
    config.model as never,
  ) as ModelChoice["model"];
  if (!model)
    throw new Error(
      `No audited legacy model entry for ${config.provider}/${config.model}; use the budgeted pipeline with catalog-pinned models or supply an explicit model adapter`,
    );
  return { config, model };
}
export function modelFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ModelChoice {
  return knownChoice(modelConfig(env));
}
export function verifierModelFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ModelChoice {
  return knownChoice(verifierConfig(env));
}
