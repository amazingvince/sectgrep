#!/usr/bin/env node
/**
 * sect-convert: `fetch` pulls eCFR bulk XML into raw/<source>/<date>/; `ecfr` converts one title
 * into the sect corpus contract under a corpus root.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { convertEcfr } from "./ecfr.js";
import { FR_SOURCE_YAML, convertFr } from "./fr.js";
import { extract, readSourcePattern } from "./extract.js";
import { formatReport, validateStaging } from "./validators/index.js";
import { alignCommand } from "./align.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { PRESETS, presetFor } from "./ocr/presets.js";
import { pageGeometry, pngSize, renderPage } from "./ocr/render.js";
import { OpenAICompatibleTranscriber } from "./ocr/transcriber.js";
import { loadDotEnv, modelConfig, providerExtras } from "./env.js";

// The nearest .env (gitignored) supplies keys and model choices; the shell wins over it.
loadDotEnv();
const hosted = modelConfig();

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
  // EFFDNOT and CROSSREF records (spec B.2) are candidates for WS3, not corpus files: they go
  // under the hidden .work/ directory, which the corpus walker skips.
  const workDir = join(out, ".work", `cfr-title-${title}`);
  mkdirSync(workDir, { recursive: true });
  const counts: Record<string, number> = { effdnot: 0, crossref: 0 };
  for (const kind of ["effdnot", "crossref"] as const) {
    const rows = r.candidates.filter((c) => c.kind === kind);
    counts[kind] = rows.length;
    writeFileSync(join(workDir, `${kind}.jsonl`), rows.map((c) => JSON.stringify(c)).join("\n") + (rows.length ? "\n" : ""), "utf8");
  }
  console.log(`converted Title ${title} (${r.titleName}): ${r.sections} sections, ${r.nodes} nodes, effective ${r.effective} -> ${out}/cfr-title-${title}/ (${r.files.length} files; ${counts.effdnot} effdnot, ${counts.crossref} crossref candidates -> ${workDir})`);
}

const cmd = process.argv[2];
if (cmd === "fetch") {
  fetchTitle(Number(arg("title")), arg("out", "raw")!).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (cmd === "ecfr") {
  convert();
} else if (cmd === "fr-fetch") {
  // Federal Register rules by document number, or the newest rules touching a CFR title/part,
  // into raw/fr/<year>/<docnum>.xml with a sidecar of the API metadata.
  const rawRoot = arg("out", "raw")!;
  (async () => {
    const nums = (arg("docnum") ?? "").split(",").filter(Boolean);
    const found: Array<{ document_number: string; publication_date: string; full_text_xml_url: string; title: string }> = [];
    if (nums.length) {
      for (const n of nums) {
        const meta = (await (await fetch(`https://www.federalregister.gov/api/v1/documents/${n}.json?fields[]=document_number&fields[]=publication_date&fields[]=full_text_xml_url&fields[]=title`)).json()) as (typeof found)[number];
        found.push(meta);
      }
    } else {
      const title = arg("title")!;
      const part = arg("part");
      const per = arg("count", "5")!;
      const url = `https://www.federalregister.gov/api/v1/documents.json?conditions[type][]=RULE&conditions[cfr][title]=${title}${part ? `&conditions[cfr][part]=${part}` : ""}&order=newest&per_page=${per}&fields[]=document_number&fields[]=publication_date&fields[]=full_text_xml_url&fields[]=title`;
      const res = (await (await fetch(url)).json()) as { results: typeof found };
      found.push(...res.results);
    }
    for (const d of found) {
      const year = d.publication_date.slice(0, 4);
      const dir = join(rawRoot, "fr", year);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${d.document_number}.xml`);
      if (!existsSync(file)) {
        const xml = await (await fetch(d.full_text_xml_url)).text();
        writeFileSync(file, xml);
      }
      writeFileSync(join(dir, `${d.document_number}.json`), JSON.stringify(d, null, 2) + "\n");
      console.log(`${d.document_number} ${d.publication_date} ${d.title.slice(0, 80)} -> ${file}`);
    }
  })().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
} else if (cmd === "fr") {
  // One rule XML (or every XML under a directory) into notice files under <out>/fr/<year>/.
  const input = arg("xml")!;
  const out = arg("out")!;
  const files = input.endsWith(".xml") ? [input] : readdirSync(input, { recursive: true }).map(String).filter((f) => f.endsWith(".xml")).map((f) => join(input, f));
  let total = 0;
  for (const file of files) {
    const xml = readFileSync(file, "utf-8");
    const metaFile = file.replace(/\.xml$/, ".json");
    const meta = existsSync(metaFile) ? (JSON.parse(readFileSync(metaFile, "utf-8")) as { document_number?: string; publication_date?: string }) : {};
    const rel = file.replace(/\\/g, "/").replace(/^.*?(raw\/)/, "$1");
    const n = convertFr(xml, { docnum: meta.document_number ?? arg("docnum"), published: meta.publication_date ?? arg("published"), raw: rel, rawSha256: createHash("sha256").update(xml).digest("hex") });
    const year = (n.published ?? n.effective).slice(0, 4);
    const dir = join(out, "fr", year);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${n.docnum}.md`), n.frontMatter + n.markdown);
    if (!existsSync(join(out, "fr", "_source.yaml"))) writeFileSync(join(out, "fr", "_source.yaml"), FR_SOURCE_YAML);
    total += n.actions.length;
    console.log(`${n.id} effective ${n.effective}: ${n.actions.length} action candidate(s) [${n.actions.map((a) => `${a.kind} ${a.target_id}${a.target_anchor ? "#" + a.target_anchor : ""}`).join("; ")}] -> ${join(dir, n.docnum + ".md")}`);
  }
  console.log(`${files.length} notice(s), ${total} action candidate(s)`);
} else if (cmd === "validate") {
  // The seven C.5 validators over a staging directory (or a corpus root), exit 1 on any error.
  const staging = process.argv[3];
  if (!staging || staging.startsWith("--")) {
    console.error("usage: sect-convert validate <staging> [--corpus ROOT] [--raw-root DIR] [--work DIR] [--sect BIN] [--skip-index] [--json]");
    process.exit(2);
  }
  const report = validateStaging({ staging, corpus: arg("corpus"), rawRoot: arg("raw-root", "."), work: arg("work", "work"), sectBin: arg("sect"), skipIndex: process.argv.includes("--skip-index") });
  console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report));
  process.exit(report.errors ? 1 : 0);
} else if (cmd === "align") {
  // Two versions of one source (dates fetch from the eCFR versioner; paths are local XML) to changes.json.
  const [source, oldArg, newArg] = process.argv.slice(3, 6);
  if (!source || !oldArg || !newArg || source.startsWith("--")) {
    console.error("usage: sect-convert align <cfr-title-N> <old date|xml> <new date|xml> [--out changes.json] [--raw-root raw]");
    process.exit(2);
  }
  alignCommand(source, oldArg, newArg, { out: arg("out", "changes.json"), rawRoot: arg("raw-root", "raw") })
    .then((r) => {
      const s = r.summary;
      console.log(`${r.source}: ${r.old.label} (${r.old.sections} sections, effective ${r.old.effective}) -> ${r.new.label} (${r.new.sections} sections, effective ${r.new.effective}): ${s.unchanged} unchanged, ${s.changed} changed, ${s.renumbered} renumbered, ${s.moved} moved, ${s.added} added, ${s.removed} removed -> ${arg("out", "changes.json")}`);
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
} else if (cmd === "extract") {
  // One raw document into work/<sha256>/ (elements, report, images, grids, C.4 pass outputs).
  const input = arg("input")!;
  const work = arg("work", "work")!;
  const sourceYaml = arg("source-yaml");
  extract({
    input, work,
    // Flags, then SECT_OCR_* from the environment; the hosted model is the secondary by default.
    ocrServer: arg("ocr-server") ?? process.env.SECT_OCR_SERVER,
    ocrSecondaryServer: arg("ocr-secondary-server") ?? process.env.SECT_OCR_SECONDARY_SERVER ?? (hosted.apiKey ? hosted.baseUrl : undefined),
    ocrPrimary: arg("ocr-primary") ?? process.env.SECT_OCR_PRIMARY,
    ocrSecondary: arg("ocr-secondary") ?? process.env.SECT_OCR_SECONDARY ?? (hosted.apiKey ? hosted.model : undefined),
    apiKey: process.env.SECT_OCR_API_KEY ?? hosted.apiKey, extraBody: providerExtras(hosted),
    pattern: sourceYaml ? readSourcePattern(sourceYaml) : null, homeTitle: arg("title"), images: process.argv.includes("--images"), force: process.argv.includes("--force"),
  })
    .then(({ report, dir, fromCache }) => {
      console.log(JSON.stringify({ ...report, dir, fromCache }));
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.stack ?? e.message : String(e));
      process.exit(1);
    });
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
    const record = { pdf, page, transcriber: t.name, kind: r.kind, image: r.image, usage: r.usage ?? null, elapsedMs: r.elapsedMs, attempts: r.attempts ?? 1, degenerate: r.degenerate ?? false, markdown: r.markdown };
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
  console.error("usage: sect-convert fetch --title N [--out raw] | sect-convert ecfr --xml <file> --title N --out <corpus root> | sect-convert fr-fetch (--docnum A,B | --title N [--part P] [--count K]) [--out raw] | sect-convert fr --xml <file or dir> --out <corpus root> | sect-convert validate <staging> [--corpus ROOT] [--raw-root DIR] [--work DIR] [--skip-index] [--json] | sect-convert align <cfr-title-N> <old> <new> [--out changes.json] | sect-convert extract --input F [--work DIR] [--source-yaml Y --title N] [--ocr-server URL/v1 --ocr-primary M --ocr-secondary M --ocr-secondary-server URL/v1] [--images] [--force] | sect-convert render --pdf F --page N [--model M] [--out png] | sect-convert ocr (--pdf F --page N | --png IMG) --server URL/v1 --model M [--task page|table|text] [--out json]");
  process.exit(2);
}
