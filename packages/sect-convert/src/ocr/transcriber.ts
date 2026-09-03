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
    const body = {
      model: this.o.model,
      temperature: this.o.temperature,
      max_tokens: this.o.maxTokens,
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
    const headers: Record<string, string> = { "content-type": "application/json", ...(this.o.headers ?? {}) };
    if (this.o.apiKey) headers.authorization = `Bearer ${this.o.apiKey}`;
    const t0 = Date.now();
    const res = await fetch(`${this.o.baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.o.timeoutMs) });
    if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status} ${await res.text().catch(() => "")}`.slice(0, 500));
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string | Array<{ type: string; text?: string }> } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const content = data.choices?.[0]?.message?.content;
    const markdown = typeof content === "string" ? content : (content ?? []).map((c) => c.text ?? "").join("");
    return {
      markdown: markdown.trim(),
      model: this.o.model,
      kind: this.kind,
      image: { widthPx: image.widthPx, heightPx: image.heightPx, dpi: image.dpi },
      usage: data.usage ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens } : undefined,
      elapsedMs: Date.now() - t0,
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
