#!/usr/bin/env node
/**
 * sect-convert: `fetch` pulls eCFR bulk XML into raw/<source>/<date>/; `ecfr` converts one title
 * into the sect corpus contract under a corpus root.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { convertEcfr } from "./ecfr.js";
import { PRESETS, presetFor } from "./ocr/presets.js";
import { pageGeometry, pngSize, renderPage } from "./ocr/render.js";
import { OpenAICompatibleTranscriber } from "./ocr/transcriber.js";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function fetchTitle(title: number, rawRoot: string): Promise<void> {
  const meta = (await (await fetch("https://www.ecfr.gov/api/versioner/v1/titles.json")).json()) as { titles: { number: number; up_to_date_as_of: string; latest_amended_on: string }[] };
  const t = meta.titles.find((x) => x.number === title);
  if (!t) throw new Error(`title ${title} not in the versioner list`);
  const url = `https://www.govinfo.gov/bulkdata/ECFR/title-${title}/ECFR-title${title}.xml`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const xml = await res.text();
  const dir = join(rawRoot, `cfr-title-${title}`, t.up_to_date_as_of);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `ECFR-title${title}.xml`);
  writeFileSync(file, xml, "utf8");
  writeFileSync(join(dir, "versioner.json"), JSON.stringify(t, null, 2) + "\n", "utf8");
  console.log(`fetched title ${title} (latest amended ${t.latest_amended_on}, up to date as of ${t.up_to_date_as_of}) -> ${file} (${xml.length} bytes)`);
}

function convert(): void {
  const xmlPath = arg("xml");
  const out = arg("out");
  const title = Number(arg("title"));
  if (!xmlPath || !out || !title) {
    console.error("usage: sect-convert ecfr --xml <ECFR-titleN.xml> --title N --out <corpus root> [--raw <provenance path>] [--effective YYYY-MM-DD]");
    process.exit(2);
  }
  const xml = readFileSync(xmlPath, "utf8");
  const r = convertEcfr(xml, { title, rawPath: arg("raw") ?? xmlPath.replace(/\\/g, "/"), effective: arg("effective") });
  for (const f of r.files) {
    const p = join(out, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.text, "utf8");
  }
  console.log(`converted Title ${title} (${r.titleName}): ${r.sections} sections, ${r.nodes} nodes, effective ${r.effective} -> ${out}/cfr-title-${title}/ (${r.files.length} files)`);
}

const cmd = process.argv[2];
if (cmd === "fetch") {
  fetchTitle(Number(arg("title")), arg("out", "raw")!).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (cmd === "ecfr") {
  convert();
} else if (cmd === "render") {
  // Render one page at the scale a model expects; prints the geometry and writes the PNG.
  const pdf = arg("pdf")!;
  const page = Number(arg("page", "1"));
  const preset = presetFor(arg("model", PRESETS["olmocr-2"].model)!);
  const nativeDpi = arg("native-dpi");
  const policy = nativeDpi ? { ...preset.scale, nativeDpi: Number(nativeDpi) } : preset.scale;
  renderPage(pdf, page, policy)
    .then((img) => {
      const out = arg("out");
      if (out) {
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, img.png);
      }
      console.log(JSON.stringify({ page: img.page, widthPx: img.widthPx, heightPx: img.heightPx, dpi: img.dpi, policy, out: out ?? null }));
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
} else if (cmd === "ocr") {
  // Transcribe one page through the transcriber boundary: a local vLLM server or a hosted API,
  // whichever --server names; the model's preset supplies the prompt and the scale.
  const pdf = arg("pdf") ?? "";
  const page = Number(arg("page", "1"));
  const model = arg("model", PRESETS["olmocr-2"].model)!;
  const preset = presetFor(model);
  const task = (arg("task", "page") ?? "page") as "page" | "table" | "text";
  const nativeDpi = arg("native-dpi");
  const policy = nativeDpi ? { ...preset.scale, nativeDpi: Number(nativeDpi) } : preset.scale;
  const longSide = arg("long-side");
  if (longSide) policy.targetLongSide = Number(longSide);
  const t = new OpenAICompatibleTranscriber({ baseUrl: arg("server", "http://127.0.0.1:8000/v1")!, model, prompts: preset.prompts, maxTokens: preset.maxTokens, apiKey: process.env.SECT_OCR_API_KEY });
  (async () => {
    // --png transcribes a page image rendered elsewhere (no poppler needed on this machine).
    const pngPath = arg("png");
    let img;
    if (pngPath) {
      const png = readFileSync(pngPath);
      const { width, height } = pngSize(png);
      img = { png, page, widthPx: width, heightPx: height, dpi: Number(arg("dpi", "0")) };
    } else {
      const geo = (await pageGeometry(pdf)).find((g) => g.page === page);
      img = await renderPage(pdf, page, policy, geo);
    }
    const r = await t.transcribePage(img, task);
    const out = arg("out");
    const record = { pdf, page, transcriber: t.name, kind: r.kind, image: r.image, usage: r.usage ?? null, elapsedMs: r.elapsedMs, markdown: r.markdown };
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
      console.log(JSON.stringify({ ...record, markdown: undefined, out }));
    } else {
      console.log(JSON.stringify(record));
    }
  })().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
} else {
  console.error("usage: sect-convert fetch --title N [--out raw] | sect-convert ecfr --xml <file> --title N --out <corpus root> | sect-convert render --pdf F --page N [--model M] [--out png] | sect-convert ocr (--pdf F --page N | --png IMG) --server URL/v1 --model M [--task page|table|text] [--out json]");
  process.exit(2);
}
