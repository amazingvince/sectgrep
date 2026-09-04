// `sect-convert extract`: one raw document (born-digital PDF, DOCX, HTML, XLSX, or a scanned
// PDF) into work/<raw_sha256>/ with elements.jsonl, report.json, page images, grids.jsonl, and
// the C.4 pass outputs. Cached by input hash. Scanned pages go through the primary and
// secondary transcribers over the transcriber boundary (a local vLLM server now, a hosted API
// in production; the code path is the same).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { docxElements, htmlElements, xlsxElements, xlsxGrids } from "./elements/office.js";
import { pdfElements, readPdfPages } from "./elements/pdf.js";
import type { Element, ExtractReport, PageInfo } from "./elements/types.js";
import { cached, renderPageImages, sha256, workDir, writeElements, writeJsonl } from "./elements/work.js";
import { transcribeDual } from "./ocr/dual.js";
import { presetFor } from "./ocr/presets.js";
import { renderPage } from "./ocr/render.js";
import { OpenAICompatibleTranscriber, type Transcriber } from "./ocr/transcriber.js";
import { runPasses, type SourcePattern } from "./passes.js";

export interface ExtractOptions {
  input: string;
  work: string;
  /** OpenAI-compatible base URL for the transcribers; none = scanned pages are flagged, not read. */
  ocrServer?: string;
  ocrPrimary?: string;
  ocrSecondary?: string;
  /** Base URL for the secondary when it is served elsewhere (two local vLLM processes); defaults to ocrServer. */
  ocrSecondaryServer?: string;
  apiKey?: string;
  /** Extra request fields for hosted transcribers (a retention preference). */
  extraBody?: Record<string, unknown>;
  /** Scanned pages in flight at once; a vLLM server batches concurrent requests (default 4). */
  ocrConcurrency?: number;
  /** The source's id_pattern/id_template for the native-id and reference passes. */
  pattern?: SourcePattern | null;
  homeTitle?: string;
  /** Render every page image, not only scanned ones. */
  images?: boolean;
  force?: boolean;
  /** Injected transcribers (tests). */
  transcribers?: { primary: Transcriber; secondary: Transcriber };
}

export function formatOf(file: string): ExtractReport["format"] {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (ext === ".xlsx" || ext === ".xlsm") return "xlsx";
  if (ext === ".html" || ext === ".htm") return "html";
  throw new Error(`unsupported input ${file}: pdf, docx, html, xlsx`);
}

export function readSourcePattern(sourceYaml: string): SourcePattern | null {
  if (!existsSync(sourceYaml)) return null;
  const text = readFileSync(sourceYaml, "utf-8");
  // A double-quoted YAML scalar escapes its backslashes (`\\b` is `\b`); a single-quoted one does not.
  const get = (k: string) => {
    const m = new RegExp(`^${k}:\\s*(.+)$`, "m").exec(text)?.[1]?.trim();
    if (!m) return undefined;
    if (m.startsWith('"') && m.endsWith('"')) return m.slice(1, -1).replace(/\\(["\\])/g, "$1");
    if (m.startsWith("'") && m.endsWith("'")) return m.slice(1, -1).replace(/''/g, "'");
    return m;
  };
  const id_pattern = get("id_pattern");
  const id_template = get("id_template");
  return id_pattern && id_template ? { id_pattern, id_template, anchor_template: get("anchor_template") } : null;
}

export async function extract(o: ExtractOptions): Promise<{ report: ExtractReport; dir: string; fromCache: boolean }> {
  const t0 = Date.now();
  const data = readFileSync(o.input);
  const sha = sha256(data);
  const dir = workDir(o.work, sha);
  const prior = o.force ? null : cached(o.work, sha);
  if (prior) return { report: prior, dir, fromCache: true };
  const format = formatOf(o.input);
  const notes: string[] = [];
  let elements: Element[] = [];
  let pages: PageInfo[] = [{ page: 1, width: 0, height: 0, chars: 0 }];
  let scanned: number[] = [];
  let ocr: ExtractReport["ocr"];

  if (format === "pdf") {
    const parsed = await readPdfPages(new Uint8Array(data));
    const r = pdfElements(parsed, sha);
    elements = r.elements;
    pages = r.info;
    scanned = r.scanned;
    const wantImages = o.images ? pages.map((p) => p.page) : scanned;
    if (wantImages.length) {
      const imgs = await renderPageImages(o.input, dir, wantImages);
      for (const p of pages) if (imgs.files[p.page]) p.image = imgs.files[p.page];
      if (imgs.note) notes.push(imgs.note);
    }
    if (scanned.length) {
      const pair = o.transcribers ?? (o.ocrServer ? transcribers(o) : null);
      if (!pair) {
        notes.push(`${scanned.length} scanned page(s) not transcribed: no --ocr-server`);
        for (const p of scanned) elements.push({ doc_sha: sha, page: p, seq: 0, type: "other", text: "", bbox: null, font_size: null, bold: false, flags: ["no_text_layer"], confidence: 0 });
      } else {
        let lines = 0;
        let divergent = 0;
        const unverified: number[] = [];
        // Pages go to the transcribers several at a time (both readers per page in parallel already);
        // results are folded back in page order.
        const preset = presetFor(pair.primary.name.replace(/^(local|api):/, ""));
        const results = new Map<number, Awaited<ReturnType<typeof transcribeDual>>>();
        let cursor = 0;
        const worker = async () => {
          while (cursor < scanned.length) {
            const p = scanned[cursor++];
            const nativeDpi = pages.find((x) => x.page === p)?.image ? 150 : undefined;
            const image = await renderPage(o.input, p, { ...preset.scale, nativeDpi });
            results.set(p, await transcribeDual(pair.primary, pair.secondary, image, sha, 0));
          }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(o.ocrConcurrency ?? 4, scanned.length)) }, worker));
        mkdirSync(path.join(dir, "ocr"), { recursive: true });
        for (const p of scanned) {
          const r = results.get(p)!;
          // Both raw readings, so a reviewer can see what each transcriber said about a flagged line.
          writeFileSync(path.join(dir, "ocr", `p${p}-primary.md`), r.primary.markdown);
          writeFileSync(path.join(dir, "ocr", `p${p}-secondary.md`), r.secondary.markdown);
          for (const e of r.elements) e.flags.push("ocr");
          elements.push(...r.elements);
          lines += r.lines;
          divergent += r.divergent;
          if (r.unverified) unverified.push(p);
        }
        if (unverified.length) notes.push(`secondary reading unusable on page(s) ${unverified.join(", ")}: lines flagged ocr_unverified`);
        ocr = { primary: pair.primary.name, secondary: pair.secondary.name, pages: scanned.length, divergent_lines: divergent, lines, unverified_pages: unverified };
      }
      elements.sort((a, b) => a.page - b.page || a.seq - b.seq);
      elements.forEach((e, i) => (e.seq = i));
    }
  } else if (format === "docx") {
    elements = await docxElements(data, sha);
  } else if (format === "html") {
    const r = htmlElements(data.toString("utf-8"), sha);
    elements = r.elements;
    if (r.title) notes.push(`title: ${r.title}`);
  } else {
    const grids = xlsxGrids(data);
    writeJsonl(path.join(dir, "grids.jsonl"), grids);
    elements = xlsxElements(grids, sha);
    pages = grids.map((g, i) => ({ page: i + 1, width: 0, height: 0, chars: g.rows.reduce((n, r) => n + r.join("").length, 0) }));
  }

  const heights: Record<number, number> = {};
  for (const p of pages) heights[p.page] = p.height;
  const passes = runPasses(elements, heights, o.pattern ?? null, o.homeTitle);
  notes.push(...passes.notes);
  writeJsonl(path.join(dir, "xrefs_candidates.jsonl"), passes.xrefs);
  writeFileSync(path.join(dir, "terms_candidates.json"), JSON.stringify(passes.terms, null, 2) + "\n");
  writeFileSync(path.join(dir, "structure.json"), JSON.stringify(passes.structure, null, 2) + "\n");
  const report: ExtractReport = {
    input: o.input, doc_sha: sha, format, pages, elements: passes.elements.length, tables: passes.elements.filter((e) => e.type === "table").length,
    scanned_pages: scanned, ocr, elapsed_ms: Date.now() - t0, notes,
  };
  writeElements(dir, passes.elements, report);
  return { report, dir, fromCache: false };
}

function transcribers(o: ExtractOptions): { primary: Transcriber; secondary: Transcriber } {
  const make = (model: string, baseUrl: string) => {
    const preset = presetFor(model);
    return new OpenAICompatibleTranscriber({ baseUrl, model, prompts: preset.prompts, maxTokens: preset.maxTokens, apiKey: o.apiKey, extraBody: o.extraBody, kind: /^https?:\/\/(127\.|localhost|0\.0\.0\.0|\[::1\])/.test(baseUrl) ? "local" : "api" });
  };
  return { primary: make(o.ocrPrimary ?? "allenai/olmOCR-2-7B-1025", o.ocrServer!), secondary: make(o.ocrSecondary ?? "zai-org/GLM-OCR", o.ocrSecondaryServer ?? o.ocrServer!) };
}
