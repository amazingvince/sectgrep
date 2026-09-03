// work/<raw_sha256>/: elements.jsonl, report.json, page images, grids.jsonl, and the C.4 pass
// outputs, cached by input hash: an input already extracted is not extracted again.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Element, ExtractReport } from "./types.js";
import { hasPoppler, renderPagePdfjs } from "../ocr/render.js";

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function workDir(root: string, sha: string): string {
  const d = path.join(root, sha);
  mkdirSync(d, { recursive: true });
  return d;
}

export function cached(root: string, sha: string): ExtractReport | null {
  const p = path.join(root, sha, "report.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf-8")) as ExtractReport) : null;
}

export function writeJsonl(file: string, rows: unknown[]): void {
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

export function writeElements(dir: string, elements: Element[], report: ExtractReport): void {
  writeJsonl(path.join(dir, "elements.jsonl"), elements);
  writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2) + "\n");
}

/** Page images via poppler when it is installed, else pdfjs; the report notes a failure. */
export async function renderPageImages(pdf: string, dir: string, pages: number[], dpi = 150): Promise<{ files: Record<number, string>; note?: string }> {
  const files: Record<number, string> = {};
  const out = path.join(dir, "pages");
  mkdirSync(out, { recursive: true });
  for (const p of pages) {
    const prefix = path.join(out, `p${p}`);
    if (existsSync(`${prefix}.png`)) {
      files[p] = `pages/p${p}.png`;
      continue;
    }
    try {
      if (await hasPoppler()) execFileSync("pdftoppm", ["-r", String(dpi), "-f", String(p), "-l", String(p), "-png", "-singlefile", pdf, prefix], { stdio: "ignore" });
      else writeFileSync(`${prefix}.png`, await renderPagePdfjs(pdf, p, dpi));
      files[p] = `pages/p${p}.png`;
    } catch (e) {
      return { files, note: `page images skipped: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { files };
}
