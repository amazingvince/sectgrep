// Two independent transcriptions per scanned page (spec C.3): lines that agree are accepted,
// lines that disagree are kept from the primary with the secondary's reading beside them and
// flagged `ocr_divergent`. Two transcribers rarely break a paragraph into the same lines, and on
// a multi-column page they may not even read the columns in the same order, so the comparison is
// order-independent: each primary line is matched to the secondary line that holds most of its
// words, then checked word by word against that line and its neighbours. Line-level alignment
// is kept for callers that want it.

import { distance } from "fastest-levenshtein";
import type { Element } from "../elements/types.js";
import type { PageImage } from "./render.js";
import type { Transcriber, Transcription } from "./transcriber.js";

export interface DualResult {
  elements: Element[];
  lines: number;
  divergent: number;
  /** The secondary reading was unusable (looping, or far from the primary's length): every line is `ocr_unverified`, none divergent. */
  unverified: boolean;
  primary: Transcription;
  secondary: Transcription;
}

const wordCount = (s: string) => s.split("\n").join(" ").split(" ").filter(Boolean).length;

/**
 * A secondary reading counts only when it is a reading of the same page: not flagged degenerate
 * by the transcriber's repetition guard, and within half to one-and-a-half times the primary's
 * word count. A looping model would otherwise turn every line into a disagreement.
 */
export function secondaryUsable(primary: Transcription, secondary: Transcription): boolean {
  if (secondary.degenerate) return false;
  const p = wordCount(primary.markdown);
  const q = wordCount(secondary.markdown);
  if (p < 20) return true;
  return q >= p * 0.5 && q <= p * 1.5;
}

const norm = (s: string) => s.normalize("NFKC").replace(/[*_`#>|.,;:!?"'()\[\]]/g, "").replace(/[‐-―−]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();

/** 1.0 for identical lines after normalization, 0 for unrelated. */
export function similarity(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x && !y) return 1;
  const d = distance(x, y);
  return 1 - d / Math.max(x.length, y.length, 1);
}

/**
 * Two readings agree when they are identical after normalization (punctuation, markdown, and
 * spacing dropped), or differ by one non-digit character on a line of twenty or more: a swapped
 * digit in legal text is a divergence however long the line.
 */
export function agrees(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  if (x.length < 20 || Math.abs(x.length - y.length) > 1 || distance(x, y) > 1) return false;
  const dx = x.replace(/\d/g, "");
  const dy = y.replace(/\d/g, "");
  return distance(dx, dy) === distance(x, y);
}

/**
 * Page text as trimmed, non-empty lines. A YAML front matter block and olmOCR-2's page metadata
 * (`primary_language: en` ... closed by `---`) are not page text and are dropped.
 */
export function splitLines(markdown: string): string[] {
  const raw = markdown.replace(/\r/g, "").split("\n");
  let start = 0;
  const closer = (from: number, limit: number) => raw.slice(from, from + limit).findIndex((l) => /^---\s*$/.test(l));
  if (/^---\s*$/.test(raw[0] ?? "")) {
    const end = closer(1, 40);
    if (end >= 0) start = end + 2;
  } else if (/^[a-z_]+:\s*\S/.test(raw[0] ?? "")) {
    const end = closer(0, 10);
    if (end >= 0) start = end + 1;
  }
  return raw
    .slice(start)
    .map((l) => l.trim())
    .filter((l) => l && !/^---$/.test(l));
}

/** LCS alignment of two line lists under a fuzzy match; returns index pairs (i, j) or one-sided (i, -1) / (-1, j). */
export function alignLines(a: string[], b: string[], threshold = 0.8): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const sim: number[][] = a.map((x) => b.map((y) => similarity(x, y)));
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = sim[i][j] >= threshold ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (sim[i][j] >= threshold) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pairs.push([i, -1]);
      i++;
    } else {
      pairs.push([-1, j]);
      j++;
    }
  }
  while (i < n) pairs.push([i++, -1]);
  while (j < m) pairs.push([-1, j++]);
  return pairs;
}

interface Tok {
  word: string;
  key: string;
}

const tokensOfLine = (line: string): Tok[] => line.split(/\s+/).map((word) => ({ word, key: norm(word) })).filter((t) => t.key);

/** Longest common subsequence of two key lists as index pairs, in order. */
function lcs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * Merge two transcriptions of one page into elements, one per primary line. A primary line is
 * matched to the secondary line that contains most of its words (ties by string similarity) and
 * compared word by word against that line and its two neighbours, so a paragraph broken into
 * different lines still compares. It agrees when every word is matched and nothing is inserted
 * between its first and last matched word; one substituted non-digit word within an edit of one
 * character is tolerated. A divergent line carries the secondary's words for the same span as
 * `alt_text`. Secondary lines the primary never used (under half their words matched) are kept,
 * flagged `secondary_only`, so a reviewer sees what the primary dropped.
 */
export function mergeTranscriptions(primary: string, secondary: string, docSha: string, page: number, seqStart: number): { elements: Element[]; lines: number; divergent: number } {
  const a = splitLines(primary);
  const b = splitLines(secondary);
  const at = a.map(tokensOfLine);
  const bt = b.map(tokensOfLine);
  const bcount = bt.map((ts) => {
    const m = new Map<string, number>();
    for (const t of ts) m.set(t.key, (m.get(t.key) ?? 0) + 1);
    return m;
  });
  const covered = bt.map((ts) => new Array<boolean>(ts.length).fill(false));
  const elements: Element[] = [];
  let seq = seqStart;
  let divergent = 0;
  for (let i = 0; i < a.length; i++) {
    const toks = at[i];
    if (!toks.length) {
      elements.push(element(docSha, page, seq++, a[i], [], 1));
      continue;
    }
    let bestJ = -1;
    let bestScore = 0;
    for (let j = 0; j < b.length; j++) {
      const seen = new Map<string, number>();
      let hit = 0;
      for (const t of toks) {
        const n = (seen.get(t.key) ?? 0) + 1;
        seen.set(t.key, n);
        if ((bcount[j].get(t.key) ?? 0) >= n) hit++;
      }
      const score = hit / toks.length;
      if (score > bestScore || (score === bestScore && score > 0 && similarity(a[i], b[j]) > similarity(a[i], b[bestJ]))) {
        bestScore = score;
        bestJ = j;
      }
    }
    if (bestJ < 0 || bestScore < 0.5) {
      divergent++;
      elements.push(element(docSha, page, seq++, a[i], ["ocr_divergent"], 0, ""));
      continue;
    }
    const win: Array<{ j: number; k: number }> = [];
    for (let j = Math.max(0, bestJ - 1); j <= Math.min(b.length - 1, bestJ + 1); j++) bt[j].forEach((_, k) => win.push({ j, k }));
    const wtok = (w: number) => bt[win[w].j][win[w].k];
    const pairs = lcs(toks.map((t) => t.key), win.map((_, w) => wtok(w).key));
    const matchedP = new Set(pairs.map((p) => p[0]));
    const matchedW = pairs.map((p) => p[1]);
    const removed = toks.filter((_, k) => !matchedP.has(k));
    const inserted: number[] = [];
    if (matchedW.length) {
      const mset = new Set(matchedW);
      for (let w = matchedW[0]; w <= matchedW[matchedW.length - 1]; w++) if (!mset.has(w)) inserted.push(w);
    }
    for (const w of matchedW) covered[win[w].j][win[w].k] = true;
    const substitution = removed.length === 1 && inserted.length === 1 && !/\d/.test(removed[0].word + wtok(inserted[0]).word) && distance(removed[0].key, wtok(inserted[0]).key) <= 1;
    if ((removed.length === 0 && inserted.length === 0) || substitution) {
      elements.push(element(docSha, page, seq++, a[i], [], 1));
      continue;
    }
    const alt = matchedW.length ? win.slice(matchedW[0], matchedW[matchedW.length - 1] + 1).map((_, k) => wtok(matchedW[0] + k).word).join(" ") : "";
    divergent++;
    elements.push(element(docSha, page, seq++, a[i], ["ocr_divergent"], alt ? similarity(a[i], alt) : 0, alt));
  }
  for (let j = 0; j < b.length; j++) {
    const ts = bt[j];
    if (ts.length < 3) continue;
    if (covered[j].filter(Boolean).length < ts.length / 2) {
      divergent++;
      elements.push(element(docSha, page, seq++, b[j], ["ocr_divergent", "secondary_only"], 0, ""));
    }
  }
  return { elements, lines: elements.length, divergent };
}

function element(docSha: string, page: number, seq: number, text: string, flags: string[], confidence: number, alt?: string): Element {
  const type: Element["type"] = /^#{1,6}\s/.test(text) ? "heading" : text.startsWith("|") ? "table" : /^(\(?[a-z0-9]{1,4}\)|[•\-*]|\d+\.)\s/.test(text) ? "list_item" : "paragraph";
  const e: Element = { doc_sha: docSha, page, seq, type, text: text.replace(/^#{1,6}\s+/, ""), bbox: null, font_size: null, bold: false, flags, confidence: Math.round(confidence * 1000) / 1000 };
  if (alt !== undefined) e.alt_text = alt;
  return e;
}

/** Transcribe one page with both transcribers and merge. */
export async function transcribeDual(primary: Transcriber, secondary: Transcriber, image: PageImage, docSha: string, seqStart: number): Promise<DualResult> {
  const [p, s] = await Promise.all([primary.transcribePage(image), secondary.transcribePage(image)]);
  if (!secondaryUsable(p, s)) {
    const elements = splitLines(p.markdown).map((line, i) => element(docSha, image.page, seqStart + i, line, ["ocr_unverified"], 0.5));
    return { elements, lines: elements.length, divergent: 0, unverified: true, primary: p, secondary: s };
  }
  const merged = mergeTranscriptions(p.markdown, s.markdown, docSha, image.page, seqStart);
  return { ...merged, unverified: false, primary: p, secondary: s };
}
