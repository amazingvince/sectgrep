// Per-section effective dates from the eCFR versioner (G-N2): the `versions` endpoint lists every
// amendment of every section of a title; the latest one per section is the date its current
// text took effect, which the bulk XML does not carry (its AMDDATE is the title's). Cached beside
// the title XML under raw/cfr-title-N/<date>/versions.json, so a conversion is reproducible offline.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface ContentVersion {
  identifier: string;
  part: string;
  date: string;
  amendment_date?: string;
  issue_date?: string;
  type: string;
  removed?: boolean;
  substantive?: boolean;
}

export interface VersionsJson {
  content_versions: ContentVersion[];
  meta?: { title?: string; latest_amendment_date?: string; latest_issue_date?: string; result_count?: string };
}

export interface SectionDates {
  title: number;
  /** The title's own date, an upper bound for every section's. */
  title_date: string | null;
  /** Section identifier ("21.8") to the date its current text took effect. */
  dates: Record<string, string>;
  fetched: string;
}

/** The latest non-removed version per section identifier, no later than `titleDate` when given. */
export function sectionDatesFrom(json: VersionsJson, titleDate?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of json.content_versions ?? []) {
    if (v.type !== "section" || v.removed) continue;
    if (titleDate && v.date > titleDate) continue;
    if (!out[v.identifier] || v.date > out[v.identifier]) out[v.identifier] = v.date;
  }
  return out;
}

export const versionsUrl = (title: number, page = 1): string => `https://www.ecfr.gov/api/versioner/v1/versions/title-${title}.json?issue_date%5Bgte%5D=1900-01-01&page=${page}`;

/** Read the cached versions file for a title XML's directory, if any. */
export function readSectionDates(cacheDir: string, title: number): SectionDates | null {
  const f = path.join(cacheDir, "versions.json");
  if (!existsSync(f)) return null;
  const json = JSON.parse(readFileSync(f, "utf-8")) as VersionsJson & { fetched?: string; title_date?: string | null };
  const titleDate = json.title_date ?? readTitleDate(cacheDir);
  return { title, title_date: titleDate, dates: sectionDatesFrom(json, titleDate), fetched: json.fetched ?? "" };
}

/** The title's up-to-date-as-of date from the versioner.json the fetch wrote beside the XML, else the directory name. */
export function readTitleDate(cacheDir: string): string | null {
  const f = path.join(cacheDir, "versioner.json");
  if (existsSync(f)) {
    const j = JSON.parse(readFileSync(f, "utf-8")) as { up_to_date_as_of?: string };
    if (j.up_to_date_as_of) return j.up_to_date_as_of;
  }
  const base = path.basename(cacheDir);
  return /^\d{4}-\d{2}-\d{2}$/.test(base) ? base : null;
}

/** Fetch the title's versions and cache them; the cache wins when present. */
export async function fetchSectionDates(title: number, cacheDir: string): Promise<SectionDates> {
  const cached = readSectionDates(cacheDir, title);
  if (cached) return cached;
  // The endpoint pages at a thousand versions; a large title runs to a dozen pages.
  const json: VersionsJson = { content_versions: [] };
  for (let page = 1, pages = 1; page <= pages; page++) {
    const res = await fetch(versionsUrl(title, page));
    if (!res.ok) throw new Error(`${versionsUrl(title, page)}: ${res.status}`);
    const part = (await res.json()) as VersionsJson & { meta?: { total_pages?: string | number } };
    json.content_versions.push(...(part.content_versions ?? []));
    json.meta = { ...part.meta, result_count: String(json.content_versions.length) };
    pages = Number(part.meta?.total_pages ?? 1) || 1;
  }
  const titleDate = readTitleDate(cacheDir) ?? json.meta?.latest_issue_date ?? null;
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(path.join(cacheDir, "versions.json"), JSON.stringify({ ...json, fetched: new Date().toISOString(), title_date: titleDate }, null, 1) + "\n", "utf-8");
  return { title, title_date: titleDate, dates: sectionDatesFrom(json, titleDate), fetched: new Date().toISOString() };
}
