// The agent's model from the environment and the nearest .env (gitignored): provider, model id,
// base URL, and the provider's key. OpenRouter with a cheap vision-capable GLM model is the
// default (docs/decisions.md #41); a model not in Pi's generated registry is built by hand from
// the provider's OpenAI-compatible endpoint, so the id is a free choice.

import { getModel, type Model } from "@mariozechner/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const DEFAULTS = { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "z-ai/glm-5.3-flash" };
const KEY_VARS: Record<string, string> = { openrouter: "OPENROUTER_API_KEY", anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };

/** Load KEY=VALUE lines from the nearest .env at or above `from`, never overriding the shell. */
export function loadDotEnv(from = process.cwd()): string | null {
  let dir = path.resolve(from);
  for (;;) {
    const file = path.join(dir, ".env");
    if (existsSync(file)) {
      for (const raw of readFileSync(file, "utf-8").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        if (key && process.env[key] === undefined) process.env[key] = value;
      }
      return file;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface ModelChoice {
  provider: string;
  id: string;
  model: Model<"openai-completions"> | Model<"anthropic-messages"> | undefined;
  apiKey: string | undefined;
  /** OpenRouter routing preference when SECT_MODEL_NO_RETENTION is set. */
  noRetention: boolean;
}

/** The configured model, from Pi's registry when it knows the id, else built for the endpoint. */
export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): ModelChoice {
  const provider = env.SECT_MODEL_PROVIDER ?? DEFAULTS.provider;
  const id = env.SECT_MODEL ?? (provider === "anthropic" ? "claude-sonnet-4-5" : DEFAULTS.model);
  const apiKey = env.SECT_MODEL_API_KEY ?? (KEY_VARS[provider] ? env[KEY_VARS[provider]] : undefined);
  const noRetention = /^(1|true|yes)$/i.test(env.SECT_MODEL_NO_RETENTION ?? "");
  const known = getModel(provider as never, id as never) as ModelChoice["model"];
  if (known) return { provider, id, model: known, apiKey, noRetention };
  const baseUrl = env.SECT_MODEL_BASE_URL ?? (provider === "openrouter" ? DEFAULTS.baseUrl : undefined);
  if (!baseUrl) return { provider, id, model: undefined, apiKey, noRetention };
  const model: Model<"openai-completions"> = {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl,
    reasoning: false,
    input: ["text", "image"],
    // OpenRouter's listed price for z-ai/glm-5.3-flash; other ids are billed as the provider says.
    cost: { input: 0.075, output: 0.25, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  };
  return { provider, id, model, apiKey, noRetention };
}
