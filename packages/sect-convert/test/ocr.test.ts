import { describe, expect, it } from "vitest";
import { PRESETS, presetFor } from "../src/ocr/presets.js";
import { chooseDpi, pngSize, DEFAULT_POLICY } from "../src/ocr/render.js";
import { OpenAICompatibleTranscriber } from "../src/ocr/transcriber.js";

describe("page scaling policy", () => {
  it("lands a letter page's long side on the model's target", () => {
    const dpi = chooseDpi(612, 792, PRESETS["olmocr-2"].scale);
    const longSide = Math.round((792 / 72) * dpi);
    expect(longSide).toBeGreaterThanOrEqual(1270);
    expect(longSide).toBeLessThanOrEqual(1300);
  });
  it("never renders born-digital text below the floor DPI", () => {
    // A tiny target on a large page would go under 150 DPI; the floor wins.
    const dpi = chooseDpi(612, 792, { targetLongSide: 600, minDpi: 150, maxPixels: 3_000_000 });
    expect(dpi).toBe(150);
  });
  it("caps total pixels on oversized pages", () => {
    const dpi = chooseDpi(2000, 3000, { targetLongSide: 4000, minDpi: 150, maxPixels: 3_000_000 });
    const pixels = (2000 / 72) * dpi * ((3000 / 72) * dpi);
    expect(pixels).toBeLessThanOrEqual(3_000_000 * 1.02);
  });
  it("does not upsample a scan past its native resolution", () => {
    // A 100 DPI scan of a 608 x 779 pt page: rendering at more than 100 DPI only adds tokens.
    const dpi = chooseDpi(607.85, 779.2, { targetLongSide: 1540, minDpi: 150, maxPixels: 3_000_000, nativeDpi: 100 });
    expect(dpi).toBe(100);
  });
  it("uses the default policy for a letter page", () => {
    expect(chooseDpi(612, 792, DEFAULT_POLICY)).toBeGreaterThan(100);
  });
});

describe("presets", () => {
  it("carry the documented prompts and permissive licenses", () => {
    expect(PRESETS["glm-ocr"].prompts.table).toBe("Table Recognition:");
    expect(PRESETS["paddleocr-vl-1.5"].prompts.page).toBe("OCR:");
    expect(PRESETS["olmocr-2"].scale.targetLongSide).toBe(1288);
    for (const p of Object.values(PRESETS)) expect(["Apache-2.0", "MIT"]).toContain(p.license);
    expect(presetFor("some-hosted/model").license).toBe("unknown");
  });
});

describe("OpenAI-compatible transcriber", () => {
  it("names local and hosted backends by their base URL", () => {
    const local = new OpenAICompatibleTranscriber({ baseUrl: "http://127.0.0.1:8000/v1", model: "m", prompts: { page: "p" } });
    const api = new OpenAICompatibleTranscriber({ baseUrl: "https://api.example.com/v1/", model: "m", prompts: { page: "p" }, apiKey: "k" });
    expect(local.kind).toBe("local");
    expect(api.kind).toBe("api");
    expect(api.name).toBe("api:m");
  });
  it("posts the image and prompt and reads the reply", async () => {
    const calls: Array<{ url: string; body: string; auth?: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body), auth: (init.headers as Record<string, string>).authorization });
      return new Response(JSON.stringify({ choices: [{ message: { content: "# Page\n\ntext" } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }), { status: 200 });
    }) as typeof fetch;
    try {
      const t = new OpenAICompatibleTranscriber({ baseUrl: "https://api.example.com/v1", model: "vendor/model", prompts: { page: "Transcribe." }, apiKey: "secret" });
      const png = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n\x1a\n", "ascii"), Buffer.alloc(16)]);
      png.writeUInt32BE(640, 16);
      png.writeUInt32BE(480, 20);
      const r = await t.transcribePage({ png, page: 1, widthPx: 640, heightPx: 480, dpi: 150 });
      expect(r.markdown).toBe("# Page\n\ntext");
      expect(r.usage?.completionTokens).toBe(3);
      expect(r.image).toEqual({ widthPx: 640, heightPx: 480, dpi: 150 });
      expect(calls[0].url).toBe("https://api.example.com/v1/chat/completions");
      expect(calls[0].auth).toBe("Bearer secret");
      const body = JSON.parse(calls[0].body);
      expect(body.model).toBe("vendor/model");
      expect(body.messages[0].content[0].image_url.url.startsWith("data:image/png;base64,")).toBe(true);
      expect(body.messages[0].content[1].text).toBe("Transcribe.");
      expect(pngSize(png)).toEqual({ width: 640, height: 480 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
