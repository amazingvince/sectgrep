// Model provider configuration from the environment and the nearest `.env` file (gitignored):
// which OpenAI-compatible endpoint the transcriber boundary's API path and the ingest harness
// call, with which model and key. The key lives in `.env` or the shell, never in the repository.
// Defaults are OpenRouter with a cheap vision-capable model (human decision, 2026-09-03); the
// model is a knob so a provider that keeps no records can be chosen when that matters.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ModelConfig {
  /** openrouter | anthropic | local | any other name a caller maps to a base URL. */
  provider: string;
  /** Base URL up to and including `/v1`. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Ask the provider not to retain prompts (OpenRouter: route only to providers with data collection denied). */
  noRetention: boolean;
  /** For the verifier: the model to use when a judgment needs page images (unset for ingest). */
  visionModel?: string;
}

export const MODEL_DEFAULTS = {
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  /** What OpenRouter's alias `~z-ai/glm-flash-latest` resolves to today: text and image input. */
  model: "z-ai/glm-5.3-flash",
};

const BASE_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  local: "http://127.0.0.1:8000/v1",
  openai: "https://api.openai.com/v1",
};

const KEY_VARS: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

/**
 * Load `KEY=VALUE` lines from the nearest `.env` at or above `from` into `process.env`, never
 * overriding a variable the shell already set. Returns the file used, or null.
 */
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

export function modelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const provider = env.SECT_MODEL_PROVIDER ?? MODEL_DEFAULTS.provider;
  const baseUrl = env.SECT_MODEL_BASE_URL ?? BASE_URLS[provider] ?? MODEL_DEFAULTS.baseUrl;
  const apiKey = env.SECT_MODEL_API_KEY ?? (KEY_VARS[provider] ? env[KEY_VARS[provider]] : undefined);
  return { provider, baseUrl, model: env.SECT_MODEL ?? MODEL_DEFAULTS.model, apiKey, noRetention: /^(1|true|yes)$/i.test(env.SECT_MODEL_NO_RETENTION ?? "") };
}

/**
 * The verifier's model (spec D.3): answer-blind, on a different model family than ingest so its
 * second opinion is independent. Defaults to DeepSeek's flash model through the same gateway
 * (human decision, 2026-09-04); `SECT_VERIFIER_PROVIDER`, `SECT_VERIFIER_MODEL`,
 * `SECT_VERIFIER_BASE_URL` and `SECT_VERIFIER_API_KEY` override it.
 */
export function verifierConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const provider = env.SECT_VERIFIER_PROVIDER ?? env.SECT_MODEL_PROVIDER ?? MODEL_DEFAULTS.provider;
  const baseUrl = env.SECT_VERIFIER_BASE_URL ?? (provider === (env.SECT_MODEL_PROVIDER ?? MODEL_DEFAULTS.provider) ? env.SECT_MODEL_BASE_URL : undefined) ?? BASE_URLS[provider] ?? MODEL_DEFAULTS.baseUrl;
  const apiKey = env.SECT_VERIFIER_API_KEY ?? (KEY_VARS[provider] ? env[KEY_VARS[provider]] : undefined) ?? env.SECT_MODEL_API_KEY;
  // Dated ids, so a run is reproducible: the plain alias floats to whatever DeepSeek serves next.
  return { provider, baseUrl, model: env.SECT_VERIFIER_MODEL ?? VERIFIER_DEFAULTS.model, apiKey, noRetention: /^(1|true|yes)$/i.test(env.SECT_MODEL_NO_RETENTION ?? ""), visionModel: env.SECT_VERIFIER_VISION_MODEL ?? VERIFIER_DEFAULTS.visionModel };
}

export const VERIFIER_DEFAULTS = {
  /** Text-only; what the verifier reads today. */
  model: "deepseek/deepseek-v4-flash-0731",
  /** Text and image; for judgments that need the page (an overlay PDF's table, an OCR-divergent span). */
  visionModel: "deepseek/deepseek-v4-flash-vision-exp",
};

/** Request-body extras the provider needs for the configured retention policy. */
export function providerExtras(c: ModelConfig): Record<string, unknown> {
  if (c.noRetention && c.provider === "openrouter") return { provider: { data_collection: "deny" } };
  return {};
}
