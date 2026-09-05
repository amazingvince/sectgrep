// Token-level text comparison for the validators: markdown-stripped word tokens, a span match
// (how well a body matches one contiguous run of its source), and a token-set Jaccard for the
// context-paraphrase rule. Short inputs get an exact LCS table with traceback; long ones get a
// Myers diff that stops as soon as the differences exceed what the threshold could absorb, with
// the span read off eight-token anchors, so a thirty-thousand-token section costs seconds, not
// a squared table.

/** Markdown to plain words: link text kept, targets dropped; emphasis, headings, table pipes removed. */
export function plain(markdown: string): string {
  return markdown
    .replace(/\[((?:[^\[\]]|\[[^\]]*\])*)\]\([^)]*\)/g, "$1")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, " ")
    .replace(/[|*_`]/g, " ");
}

/** Lowercased word tokens; numbers keep their internal separators ("16,131", "2.8", "7.3"). */
export function tokens(text: string): string[] {
  const out = plain(text).normalize("NFKC").replace(/[−–]/g, "-").toLowerCase().match(/[+-]?\d+(?:[.,]\d+)*|[\p{L}\p{N}]+(?:[.,][\p{L}\p{N}]+)*|[<>≤≥=%]/gu);
  return out ?? [];
}

export interface Span {
  /** Similarity ratio 2·LCS / (body length + matched span length): 1 when the body is a verbatim span. */
  score: number;
  lcs: number;
  start: number;
  end: number;
  /** Set when the diff was cut off: the score is an upper bound and is below the threshold. */
  capped?: boolean;
}

const EXACT_CELLS = 4_000_000;
const ANCHOR = 8;

/**
 * How well `body` matches a contiguous span of `source`: the longest common subsequence, then the
 * span of the source between the first and last matched token. A body copied from the source
 * scores 1; a body with words changed, dropped, or pulled from far apart scores lower. `floor`
 * is the score the caller will accept, which bounds the work on long inputs.
 */
export function spanMatch(body: string[], source: string[], floor = 0.92): Span {
  const n = body.length;
  const m = source.length;
  if (!n || !m) return { score: n === 0 && m === 0 ? 1 : 0, lcs: 0, start: 0, end: -1 };
  if (n * m <= EXACT_CELLS) return exactSpan(body, source);
  // A long source (a whole document's elements) is narrowed to the window where the body's
  // tokens cluster before the diff runs.
  let offset = 0;
  let window = source;
  if (m > 3 * n) {
    offset = bestWindow(body, source);
    window = source.slice(offset, offset + 3 * n);
  }
  const { start, end } = anchoredSpan(body, window);
  const span = end >= start ? end - start + 1 : window.length;
  // lcs = (n + w - D) / 2 must reach floor * max(n, span); beyond that many differences the
  // answer is already "no", so the diff stops there (and at a fixed ceiling).
  const w = window.length;
  // ratio = 2·lcs / (n + span) with lcs = (n + w - D) / 2 must reach floor; beyond that many
  // differences the answer is already "no", so the diff stops there (and at a fixed ceiling).
  const dMax = Math.min(Math.max(0, Math.floor(n + w - floor * (n + span))) + 2, Math.max(4000, Math.floor((n + w) * 0.12)));
  const d = myersDistance(body, window, dMax);
  if (d < 0) {
    const bound = (n + w - dMax) / (n + span);
    return { score: Math.min(bound, floor - 0.001), lcs: 0, start: start + offset, end: end + offset, capped: true };
  }
  const lcs = (n + w - d) / 2;
  return { score: (2 * lcs) / (n + span), lcs, start: start + offset, end: end + offset };
}

function exactSpan(body: string[], source: string[]): Span {
  const n = body.length;
  const m = source.length;
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const bi = body[i];
    const row = i * w;
    const next = row + w;
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] = bi === source[j] ? dp[next + j + 1] + 1 : Math.max(dp[next + j], dp[row + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let first = -1;
  let last = -1;
  while (i < n && j < m) {
    if (body[i] === source[j]) {
      if (first < 0) first = j;
      last = j;
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  const lcs = dp[0];
  if (first < 0) return { score: 0, lcs: 0, start: 0, end: -1 };
  const span = last - first + 1;
  return { score: (2 * lcs) / (n + span), lcs, start: first, end: last };
}

/** Start of the 3n-wide window of `source` holding the most of the body's tokens. */
function bestWindow(body: string[], source: string[]): number {
  const n = body.length;
  const want = new Set(body);
  const bin = Math.max(1, Math.floor(n / 2));
  const bins = new Int32Array(Math.ceil(source.length / bin) + 1);
  for (let j = 0; j < source.length; j++) if (want.has(source[j])) bins[Math.floor(j / bin)]++;
  let best = 0;
  let bestSum = -1;
  const per = Math.ceil((3 * n) / bin);
  let sum = 0;
  for (let b = 0; b < bins.length; b++) {
    sum += bins[b];
    if (b >= per) sum -= bins[b - per];
    if (sum > bestSum) {
      bestSum = sum;
      best = Math.max(0, b - per + 1);
    }
  }
  return best * bin;
}

/** The source span between the first and last eight-token run of the body found in the source. */
function anchoredSpan(body: string[], source: string[]): { start: number; end: number } {
  const k = Math.min(ANCHOR, body.length);
  const index = new Map<string, number>();
  for (let j = 0; j + k <= source.length; j++) {
    const key = source.slice(j, j + k).join("");
    if (!index.has(key)) index.set(key, j);
  }
  let start = -1;
  let end = -1;
  for (let i = 0; i + k <= body.length; i++) {
    const j = index.get(body.slice(i, i + k).join(""));
    if (j === undefined) continue;
    if (start < 0) start = j;
    end = Math.max(end, j + k - 1);
  }
  return { start, end };
}

/** Myers edit distance (insertions + deletions) between two token lists, or -1 once it exceeds `dMax`. */
function myersDistance(a: string[], b: string[], dMax: number): number {
  const n = a.length;
  const m = b.length;
  const max = Math.min(dMax, n + m);
  const size = 2 * max + 3;
  const v = new Int32Array(size);
  const at = (k: number) => k + max + 1;
  v[at(1)] = 0;
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[at(k - 1)] < v[at(k + 1)]) ? v[at(k + 1)] : v[at(k - 1)] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[at(k)] = x;
      if (x >= n && y >= m) return d;
    }
  }
  return -1;
}

/** Whether `needle` occurs as a contiguous token run inside `hay`. */
export function containsRun(hay: string[], needle: string[]): boolean {
  if (!needle.length) return true;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}

export function jaccard(a: string[], b: string[]): number {
  const x = new Set(a);
  const y = new Set(b);
  if (!x.size && !y.size) return 1;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}
