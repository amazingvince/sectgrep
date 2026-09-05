import {
  modelConfig,
  verifierConfig,
  providerExtras,
  type ModelConfig,
} from "@sectgrep/convert";
import { existsSync } from "node:fs";
import path from "node:path";
import { Budget, maximumCharge, type Price } from "./budget.js";
import { atomic, digest, json } from "./io.js";
import { Held } from "./stages.js";

export interface PinnedModels {
  proposer: Price;
  verifier: Price;
}
export async function pinModels(campaign: string): Promise<PinnedModels> {
  const file = path.join(campaign, "models.json");
  if (existsSync(file)) {
    const pins = json<PinnedModels>(file);
    if (pins.proposer.family === pins.verifier.family)
      throw new Held("proposer and verifier must use different model families");
    for (const price of [pins.proposer, pins.verifier]) {
      const catalog = json<{
        id: string;
        canonical_slug: string;
        pricing: { prompt: string; completion: string };
      }>(path.join(campaign, `catalog-${price.evidence_sha256}.json`));
      if (
        digest(catalog) !== price.evidence_sha256 ||
        catalog.canonical_slug !== price.model ||
        catalog.id !== price.requested_model ||
        price.input_per_token !== Number(catalog.pricing.prompt) ||
        price.output_per_token !== Number(catalog.pricing.completion) ||
        price.request !== 0 ||
        price.family !== catalog.id.split("/")[0]
      )
        throw new Held("campaign model pin differs from its catalog evidence");
    }
    return pins;
  }
  const resolve = async (config: ModelConfig): Promise<Price> => {
    if (config.provider !== "openrouter")
      throw new Held(
        "automatic price discovery is available for OpenRouter; configure an audited price adapter for this provider before spending",
      );
    if (!config.apiKey) throw new Held("model credentials are unavailable");
    if (/latest|^~/.test(config.model))
      throw new Held("a resolved, non-floating model identity is required");
    const response = await fetch(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Held(`model catalog unavailable (${response.status})`);
    const catalog = (await response.json()) as {
      data: {
        id: string;
        canonical_slug?: string;
        pricing: Record<string, string>;
      }[];
    };
    const model = catalog.data.find((x) => x.id === config.model);
    if (
      !model?.canonical_slug ||
      ["prompt", "completion"].some(
        (k) =>
          model.pricing[k] === undefined ||
          !Number.isFinite(Number(model.pricing[k])),
      )
    )
      throw new Held("model identity or price is unknown; no call sent");
    atomic(path.join(campaign, `catalog-${digest(model)}.json`), model);
    // Per-request fees are forbidden by the explicit provider.max_price.request=0 constraint.
    // This is a routing ceiling, not a guessed price for a missing catalog field.
    return {
      provider: config.provider,
      endpoint: config.baseUrl,
      model: model.canonical_slug,
      requested_model: model.id,
      family: model.id.split("/")[0],
      input_per_token: Number(model.pricing.prompt),
      output_per_token: Number(model.pricing.completion),
      request: 0,
      obtained: new Date().toISOString(),
      evidence_sha256: digest(model),
    };
  };
  const proposer = await resolve(modelConfig());
  const verifier = await resolve(verifierConfig());
  if (proposer.family === verifier.family)
    throw new Held("proposer and verifier must use different model families");
  const pinned = { proposer, verifier };
  atomic(file, pinned);
  return pinned;
}

export async function modelJSON(
  budget: Budget,
  price: Price,
  role: "proposer" | "verifier",
  prompt: string,
  callId: string,
): Promise<unknown> {
  const config = role === "proposer" ? modelConfig() : verifierConfig();
  if (
    config.provider !== price.provider ||
    config.model !== (price.requested_model ?? price.model) ||
    config.baseUrl !== price.endpoint
  )
    throw new Held(
      "model configuration differs from the campaign pin; model swaps are disabled",
    );
  if (!config.apiKey) throw new Held("model credential unavailable");
  const maxTokens = 8192;
  callId = digest({ callId, prompt, price, role, maxTokens, reasoning: "low" });
  const reservation = budget.reserve(
    callId,
    { prompt, price, role, maxTokens },
    maximumCharge(price, prompt, maxTokens),
  );
  const check = (value: unknown) => {
    const envelope = value as {
      result: { model: string; choices?: { finish_reason: string }[] };
    };
    if (![price.model, price.requested_model].includes(envelope.result.model))
      throw new Held("model identity changed; output withheld");
    if (envelope.result.choices?.[0]?.finish_reason === "length")
      throw new Held("model output truncated; output withheld");
    if (envelope.result.choices?.[0]?.finish_reason !== "stop")
      throw new Held("model output incomplete; output withheld");
    return value;
  };
  if (!reservation.fresh) return check(reservation.cached);
  const extras = providerExtras(config);
  const response = await fetch(`${price.endpoint}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify({
      model: price.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      reasoning: { effort: "low" },
      ...extras,
      provider: {
        ...((extras.provider as object) ?? {}),
        allow_fallbacks: false,
        max_price: {
          prompt: price.input_per_token * 1e6,
          completion: price.output_per_token * 1e6,
          request: 0,
        },
      },
    }),
  });
  // A transport/HTTP failure might still have incurred a charge. Never release its reservation by assumption.
  if (!response.ok)
    throw new Held(
      `model call failed (${response.status}); reservation retained for reconciliation`,
    );
  const result = (await response.json()) as {
    model: string;
    usage?: { cost?: number };
    choices?: { message: { content: string }; finish_reason: string }[];
  };
  const choice = result.choices?.[0];
  // Record the actual charge even when output is malformed or truncated.
  const envelope = { result, output: choice?.message.content ?? "" };
  budget.reconcile(callId, result.usage?.cost ?? Number.NaN, envelope);
  return check(envelope);
}

export function unwrapModel(value: unknown): unknown {
  const envelope = value as { output?: string; result?: { model?: string } };
  if (typeof envelope.output !== "string")
    throw new Error("missing model response envelope");
  return JSON.parse(envelope.output.replace(/^```(?:json)?\s*|\s*```$/g, ""));
}
