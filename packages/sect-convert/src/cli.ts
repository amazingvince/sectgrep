#!/usr/bin/env node
/**
 * sect-convert: `fetch` pulls eCFR bulk XML into raw/<source>/<date>/; `ecfr` converts one title
 * into the sect corpus contract under a corpus root.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { convertEcfr } from "./ecfr.js";

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
} else {
  console.error("usage: sect-convert fetch --title N [--out raw] | sect-convert ecfr --xml <file> --title N --out <corpus root>");
  process.exit(2);
}
