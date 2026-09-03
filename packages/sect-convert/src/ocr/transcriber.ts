// The transcriber boundary (spec C.3): the converter asks a Transcriber for the text of a page
// image and never cares whether the model runs on a local vLLM server or behind a hosted API.
// Both speak the OpenAI chat-completions protocol with an image part, so one backend covers
// olmOCR-2, GLM-OCR, and PaddleOCR-VL served by `vllm serve`, and any hosted provider that
// exposes the same protocol. Models transcribe only; judgment stays in WS3.

import type { PageImage } from "./render.js";

export type TranscribeTask = "page" | "table" | "text";

export interface Transcription {
  /** Markdown (or plain text) for the page as the model produced it. */
  markdown: string;
  /** Model identifier as served. */
  model: string;
  /** Where it ran: a local server or a hosted API. */
  kind: "local" | "api";
  /** The image geometry that was actually sent, for provenance. */
  image: { widthPx: number; heightPx: number; dpi: number };
  /** Tokens used when the server reports them. */
  usage?: { promptTokens?: number; completionTokens?: number };
  /** Wall-clock milliseconds for the request. */
  elapsedMs: number;
  /** True when the reply looked like a repetition loop even after the retry; the page needs
   * the other transcriber or a layout-driven crop rather than a whole-page prompt. */
  degenerate?: boolean;
  /** Number of requests made (2 when the first reply was degenerate). */
  attempts?: number;
}

/**
 * A VLM that loses the page repeats one cell or line until the token cap. Detect it so the
 * caller retries with a frequency penalty and a lower cap, and flags the page if it persists.
 */
export function looksDegenerate(text: string, completionTokens: number | undefined, maxTokens: number): boolean {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 20) {
    const counts = new Map<string, number>();
    for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
    const top = Math.max(...counts.values());
    if (top >= 8 && counts.size / lines.length < 0.5) return true;
  }
  const unique = new Set(lines).size;
  return completionTokens !== undefined && completionTokens >= maxTokens && unique < Math.max(3, Math.floor(lines.length / 4));
}

export interface Transcriber {
  readonly name: string;
  readonly kind: "local" | "api";
  transcribePage(image: PageImage, task?: TranscribeTask): Promise<Transcription>;
}

export interface OpenAICompatibleOptions {
  /** Base URL up to and including `/v1`, e.g. `http://127.0.0.1:8000/v1`. */
  baseUrl: string;
  /** The served model name (`vllm serve <model>` uses the repo id). */
  model: string;
  /** Prompt per task; the model presets in presets.ts carry the documented ones. */
  prompts: Partial<Record<TranscribeTask, string>>;
  /** Bearer token for hosted APIs; local servers need none. */
  apiKey?: string;
  kind?: "local" | "api";
  maxTokens?: number;
  temperature?: number;
  /** Request timeout in milliseconds (a 7B model on one page takes seconds, not minutes). */
  timeoutMs?: number;
  /** Extra headers for providers that want them. */
  headers?: Record<string, string>;
}

/** One backend for every OpenAI-compatible endpoint: vLLM locally today, a hosted API later. */
export class OpenAICompatibleTranscriber implements Transcriber {
  readonly name: string;
  readonly kind: "local" | "api";
  private readonly o: Required<Pick<OpenAICompatibleOptions, "baseUrl" | "model" | "prompts" | "maxTokens" | "temperature" | "timeoutMs">> & OpenAICompatibleOptions;

  constructor(options: OpenAICompatibleOptions) {
    this.o = { maxTokens: 8192, temperature: 0, timeoutMs: 300_000, ...options, baseUrl: options.baseUrl.replace(/\/+$/, "") };
    this.kind = options.kind ?? (isLoopback(this.o.baseUrl) ? "local" : "api");
    this.name = `${this.kind}:${options.model}`;
  }

  async transcribePage(image: PageImage, task: TranscribeTask = "page"): Promise<Transcription> {
    const prompt = this.o.prompts[task] ?? this.o.prompts.page;
    if (!prompt) throw new Error(`no prompt for task ${task} on ${this.o.model}`);
    const headers: Record<string, string> = { "content-type": "application/json", ...(this.o.headers ?? {}) };
    if (this.o.apiKey) headers.authorization = `Bearer ${this.o.apiKey}`;
    const t0 = Date.now();
    let markdown = "";
    let usage: Transcription["usage"];
    let degenerate = false;
    let attempts = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      attempts++;
      const maxTokens = attempt === 0 ? this.o.maxTokens : Math.min(this.o.maxTokens, 4096);
      const body: Record<string, unknown> = {
        model: this.o.model,
        temperature: this.o.temperature,
        max_tokens: maxTokens,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:image/png;base64,${image.png.toString("base64")}` } },
              { type: "text", text: prompt },
            ],
          },
        ],
      };
      if (attempt > 0) body.frequency_penalty = 0.5;
      const res = await fetch(`${this.o.baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.o.timeoutMs) });
      if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status} ${await res.text().catch(() => "")}`.slice(0, 500));
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string | Array<{ type: string; text?: string }> } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const content = data.choices?.[0]?.message?.content;
      markdown = (typeof content === "string" ? content : (content ?? []).map((c) => c.text ?? "").join("")).trim();
      usage = data.usage ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens } : undefined;
      degenerate = looksDegenerate(markdown, usage?.completionTokens, maxTokens);
      if (!degenerate) break;
    }
    return {
      markdown,
      model: this.o.model,
      kind: this.kind,
      image: { widthPx: image.widthPx, heightPx: image.heightPx, dpi: image.dpi },
      usage,
      elapsedMs: Date.now() - t0,
      degenerate,
      attempts,
    };
  }
}

function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}
