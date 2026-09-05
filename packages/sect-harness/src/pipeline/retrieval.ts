import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
  DocumentArtifact,
  AddressableUnit,
} from "@sectgrep/convert/document";
import { renderPage } from "@sectgrep/convert/render";
import { json, safePath, hash } from "./io.js";

interface Configuration {
  purpose: "diagnostic";
  corpus: string;
  generation: string;
  sect_bin: string;
  before?: string;
  queries: string[];
}
interface Span {
  expr: string;
  byte_start: number;
  byte_end: number;
  passage_start: number;
  passage_end: number;
  body_sha256: string;
}
interface Passage {
  chunk_id: string;
  body: string;
  spans: Span[];
  navigation: boolean;
  token_count: number;
  budget_unit: string;
  recipe: string;
  breadcrumb: string;
}
const execute = promisify(execFile);

/** Opt-in diagnostic inspector, separate from the blind benchmark review workflow. It reads
 * one frozen generation and exposes no routes in ordinary review runs.
 */
export class RetrievalInspector {
  readonly config: Configuration;
  readonly generation: string;
  private passages?: Map<string, Passage>;
  private units?: Map<
    string,
    { document: DocumentArtifact; unit: AddressableUnit }
  >;
  constructor(readonly run: string) {
    this.config = json<Configuration>(safePath(run, "retrieval.json"));
    if (
      this.config.purpose !== "diagnostic" ||
      !/^\d{20}$/.test(this.config.generation)
    )
      throw new Error("inspector requires an explicit diagnostic generation");
    this.generation = safePath(
      this.config.corpus,
      `.sect/generations/${this.config.generation}`,
    );
  }
  metadata() {
    return {
      generation: this.config.generation,
      queries: this.config.queries,
      purpose: "diagnostic",
      manifest: json(safePath(this.generation, "manifest.json")),
    };
  }
  private load() {
    if (this.units) return;
    const regions = json<{ documents: Record<string, DocumentArtifact> }>(
      safePath(this.generation, "regions.json"),
    );
    this.units = new Map();
    for (const document of Object.values(regions.documents))
      for (const unit of document.units)
        this.units.set(`${unit.id}@${document.effective}`, { document, unit });
    this.passages = new Map(
      readFileSync(safePath(this.generation, "chunks.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const c = JSON.parse(line) as Passage;
          return [c.chunk_id, c];
        }),
    );
  }
  private selected(expr: string) {
    this.load();
    const selected = this.units!.get(expr);
    if (!selected)
      throw new Error("expression is not in the diagnostic source corpus");
    return selected;
  }
  passage(id: string) {
    this.load();
    const passage = this.passages!.get(id);
    if (!passage) throw new Error("unknown passage");
    const sections = passage.spans.map((span) => {
      const { document, unit } = this.selected(span.expr);
      const regions = new Map(document.regions.map((r) => [r.id, r]));
      const units = new Map(document.units.map((u) => [u.id, u]));
      const ancestry = [];
      let parent = unit.parent;
      const visited = new Set<string>();
      while (parent && !visited.has(parent)) {
        visited.add(parent);
        const u = units.get(parent);
        if (!u) break;
        ancestry.unshift({ id: u.id, title: u.title });
        parent = u.parent;
      }
      return {
        expr: span.expr,
        title: unit.title,
        ancestry,
        format: document.format,
        raw_sha256: document.raw_sha256,
        regions: unit.regions.map((id) => regions.get(id)),
        source_url: `/api/retrieval/source?expr=${encodeURIComponent(span.expr)}`,
      };
    });
    return { generation: this.config.generation, passage, sections };
  }
  async search(query: string) {
    if (!query.trim() || query.length > 4000)
      throw new Error("query must contain 1–4000 characters");
    const latest = readdirSync(safePath(this.config.corpus, ".sect/published"))
      .filter((n) => n.endsWith(".ready"))
      .sort()
      .at(-1)
      ?.slice(0, -6);
    if (latest !== this.config.generation)
      throw new Error(
        "corpus generation changed; create a new diagnostic binding",
      );
    const started = performance.now();
    const { stdout } = await execute(
      this.config.sect_bin,
      [
        "--corpus",
        this.config.corpus,
        "search",
        query,
        "--limit",
        "5",
        "--json",
        "--no-refresh",
      ],
      { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
    );
    const current = JSON.parse(stdout);
    const before = this.config.before
      ? json<unknown>(this.config.before)
      : null;
    return {
      generation: this.config.generation,
      elapsed_ms: performance.now() - started,
      current,
      before,
      comparison_notice:
        "Diagnostic examples; independent relevance judgments and matched-corpus benchmarks remain separate.",
    };
  }
  async source(expr: string, page?: number) {
    const { document, unit } = this.selected(expr);
    const file = safePath(safePath(this.generation, "corpus"), document.raw);
    const raw = readFileSync(file);
    if (hash(raw) !== document.raw_sha256)
      throw new Error("source hash changed");
    const regionIds = new Set(unit.regions);
    const regions = document.regions.filter((r) => regionIds.has(r.id));
    const pages = regions.flatMap((r) =>
      r.locator.type === "page" ? [r.locator.page] : r.locator.type === "pages" ? r.locator.locations.map(l => l.page) : [],
    );
    if (document.format === "pdf" && pages.length) {
      page ??= pages[0];
      if (!pages.includes(page))
        throw new Error("page is outside the selected source section");
      const cache = safePath(
        this.run,
        `page-images/${document.raw_sha256}-${page}.png`,
      );
      if (!existsSync(cache)) {
        const rendered = await renderPage(file, page);
        mkdirSync(path.dirname(cache), { recursive: true });
        writeFileSync(cache, rendered.png);
      }
      return { mime: "image/png", bytes: readFileSync(cache) };
    }
    // Raw markup is displayed as text, never executed as document scripts.
    return {
      mime: "application/json",
      bytes: Buffer.from(
        JSON.stringify({
          format: document.format,
          raw_sha256: document.raw_sha256,
          raw: ["html", "xml", "json", "txt", "md", "csv", "jats"].includes(
            document.format,
          )
            ? raw.toString("utf8").slice(0, 300_000)
            : null,
          source_view: ["docx", "xlsx", "pptx"].includes(document.format)
            ? "Extracted source regions and native locators; original Office rendering is not available in this inspector."
            : "Original source markup, capped at 300,000 characters.",
          regions,
        }),
      ),
    };
  }
}
