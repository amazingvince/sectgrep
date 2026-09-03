// Page rendering with an explicit scaling policy. A VLM sees pixels, not points: too few and
// small print blurs, too many and the vision encoder tiles the page into more tokens than it
// can use well. The policy renders each page so its longer side lands on the model's target,
// never below a floor DPI for born-digital text, and never above a pixel budget; scanned pages
// are not upsampled past their native resolution, which adds nothing but tokens.

import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface PageImage {
  png: Buffer;
  page: number;
  widthPx: number;
  heightPx: number;
  /** The DPI the page was rendered at. */
  dpi: number;
}

export interface ScalePolicy {
  /** Pixels on the longer side the model was trained or evaluated with. */
  targetLongSide: number;
  /** Floor for born-digital pages: below this, 8-point footnotes lose their shapes. */
  minDpi: number;
  /** Ceiling on total pixels; a page beyond it is rendered smaller. */
  maxPixels: number;
  /** For scanned pages: the native scan DPI, so we never upsample past it. */
  nativeDpi?: number;
}

export const DEFAULT_POLICY: ScalePolicy = { targetLongSide: 1540, minDpi: 120, maxPixels: 3_000_000 };

/** The DPI to render a page of `widthPt` x `heightPt` points so that the policy holds. */
export function chooseDpi(widthPt: number, heightPt: number, policy: ScalePolicy): number {
  const longPt = Math.max(widthPt, heightPt);
  let dpi = (policy.targetLongSide / longPt) * 72;
  if (policy.nativeDpi !== undefined) dpi = Math.min(dpi, policy.nativeDpi);
  else dpi = Math.max(dpi, policy.minDpi);
  const pixels = (widthPt / 72) * dpi * ((heightPt / 72) * dpi);
  if (pixels > policy.maxPixels) dpi = dpi * Math.sqrt(policy.maxPixels / pixels);
  return Math.round(dpi);
}

export interface PageGeometry {
  page: number;
  widthPt: number;
  heightPt: number;
}

/** Page sizes from `pdfinfo -f 1 -l N` (poppler). */
export async function pageGeometry(pdf: string): Promise<PageGeometry[]> {
  const { stdout } = await run("pdfinfo", ["-f", "1", "-l", "100000", pdf]);
  const out: PageGeometry[] = [];
  for (const m of stdout.matchAll(/Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)/g)) {
    out.push({ page: Number(m[1]), widthPt: Number(m[2]), heightPt: Number(m[3]) });
  }
  return out;
}

/** Render one page to PNG with `pdftoppm` at the policy's DPI. */
export async function renderPage(pdf: string, page: number, policy: ScalePolicy = DEFAULT_POLICY, geometry?: PageGeometry): Promise<PageImage> {
  const geo = geometry ?? (await pageGeometry(pdf)).find((g) => g.page === page);
  if (!geo) throw new Error(`${pdf}: no page ${page}`);
  const dpi = chooseDpi(geo.widthPt, geo.heightPt, policy);
  const prefix = path.join(tmpdir(), `sect-page-${process.pid}-${page}-${Date.now()}`);
  await run("pdftoppm", ["-r", String(dpi), "-f", String(page), "-l", String(page), "-png", "-singlefile", pdf, prefix]);
  const file = `${prefix}.png`;
  const png = await readFile(file);
  await rm(file, { force: true });
  const { width, height } = pngSize(png);
  return { png, page, widthPx: width, heightPx: height, dpi };
}

/** Width and height from the PNG header (IHDR). */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.toString("ascii", 1, 4) !== "PNG") throw new Error("not a PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
