// Per-model presets: the documented prompts and the image scale each model expects. The
// scale is what the model's own pipeline renders at, taken from its source or docs:
//   olmOCR-2: pipeline.py renders the longer side to 1288 px (no anchor text for the v2 model);
//   that is 117 DPI on a letter page, so its floor sits at 100 DPI: the training resolution
//   wins over the born-digital floor because pixels beyond what the model saw in training
//   only cost tokens.
//   GLM-OCR and PaddleOCR-VL-1.5: their SDKs run a layout model on the page and send crops to
//   the VLM; for a whole page through the plain API we use 1540 px, which keeps 8-point print
//   above ~20 px x-height on a letter page while staying under the 3 MP budget.
// A hosted API gets the same page image as the local server; only the base URL and key differ.

import type { ScalePolicy } from "./render.js";
import type { TranscribeTask } from "./transcriber.js";

export interface ModelPreset {
  /** Hugging Face repo id, which is also the name vLLM serves it under. */
  model: string;
  license: string;
  prompts: Partial<Record<TranscribeTask, string>>;
  scale: ScalePolicy;
  maxTokens: number;
  /** Extra `vllm serve` flags the model needs. */
  vllmArgs: string[];
  /** Other names the same model is reached by (a gateway alias). */
  aliases?: string[];
  /** Fields merged into every chat request for this model (a reasoning switch, say). */
  requestExtras?: Record<string, unknown>;
}

const OLMOCR_PROMPT = "Attached is one page of a document that you must process. Just return the plain text representation of this document as if you were reading it naturally. Convert equations to LateX and tables to markdown.\nReturn your output as markdown, with a front matter section on top specifying values for the primary_language, is_rotation_valid, rotation_correction, is_table, and is_diagram parameters.";

export const PRESETS: Record<string, ModelPreset> = {
  "olmocr-2": {
    model: "allenai/olmOCR-2-7B-1025",
    license: "Apache-2.0",
    prompts: { page: OLMOCR_PROMPT, text: OLMOCR_PROMPT, table: OLMOCR_PROMPT },
    scale: { targetLongSide: 1288, minDpi: 100, maxPixels: 3_000_000 },
    maxTokens: 8000,
    vllmArgs: ["--max-model-len", "16384"],
  },
  "glm-ocr": {
    model: "zai-org/GLM-OCR",
    license: "MIT",
    prompts: { page: "Text Recognition:", text: "Text Recognition:", table: "Table Recognition:" },
    scale: { targetLongSide: 1540, minDpi: 150, maxPixels: 3_000_000 },
    maxTokens: 8192,
    vllmArgs: ["--allowed-local-media-path", "/", "--max-model-len", "16384"],
  },
  // The hosted general model as the second reader of a scanned page (decision #44): a different
  // family from the local olmOCR-2 primary, reached through the gateway with the ingest key.
  "glm-5.3-flash": {
    model: "z-ai/glm-5.3-flash",
    license: "MIT",
    prompts: {
      page: "Transcribe this page exactly as printed, in natural reading order, as Markdown. Keep every word, number and punctuation mark; do not summarize, translate, correct or comment. Render tables as HTML <table> blocks. Return only the transcription.",
      text: "Transcribe the text on this page exactly as printed, in reading order, as Markdown. Return only the transcription.",
      table: "Transcribe the table on this page as an HTML <table>, one cell per cell, exactly as printed. Return only the table.",
    },
    scale: { targetLongSide: 1540, minDpi: 150, maxPixels: 3_000_000 },
    // A reasoning model: with thinking on it spent the whole completion budget before writing a
    // word of a dense page (empty content at the cap, 4 minutes). Transcription needs no thinking.
    maxTokens: 16384,
    vllmArgs: [],
    aliases: ["~z-ai/glm-flash-latest", "z-ai/glm-flash-latest"],
    // OpenRouter refuses to disable reasoning on this endpoint; minimal effort is accepted and
    // measured at zero reasoning tokens.
    requestExtras: { reasoning: { effort: "minimal", exclude: true } },
  },
  "paddleocr-vl-1.5": {
    model: "PaddlePaddle/PaddleOCR-VL-1.5",
    license: "Apache-2.0",
    prompts: { page: "OCR:", text: "OCR:", table: "Table Recognition:" },
    scale: { targetLongSide: 1540, minDpi: 150, maxPixels: 3_000_000 },
    maxTokens: 8192,
    vllmArgs: ["--max-model-len", "16384"],
  },
};

/** The preset for a served model name, or a generic API preset for anything else. */
export function presetFor(model: string): ModelPreset {
  const hit = Object.values(PRESETS).find((p) => p.model === model || p.aliases?.includes(model));
  if (hit) return hit;
  return {
    model,
    license: "unknown",
    prompts: { page: OLMOCR_PROMPT.replace(/\nReturn your output.*$/s, " Return markdown."), text: "Transcribe the text on this page as markdown.", table: "Transcribe the table on this page as an HTML table." },
    scale: { targetLongSide: 1540, minDpi: 150, maxPixels: 3_000_000 },
    maxTokens: 8192,
    vllmArgs: [],
  };
}
