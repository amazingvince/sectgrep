// Spec C.3 element schema: what every extractor produces, whatever the input format.
// `{doc_sha, page, seq, type, text, bbox, font_size, bold, table_grid?, flags[], confidence}`

export type ElementType = "heading" | "paragraph" | "list_item" | "table" | "caption" | "header" | "footer" | "figure" | "equation" | "other";

export interface Element {
  native_id?: string;
  heading_level?: number;
  parent_seq?: number;
  caption_of?: number;
  footnote_of?: number[];
  cells?: import("../document.generated.js").TableCell[];
  exclusion?: string;
  locator?: import("../knowledge.generated.js").Locator;
  doc_sha: string;
  /** 1-based page; 1 for formats without pages. */
  page: number;
  /** Reading order within the document, 0-based. */
  seq: number;
  type: ElementType;
  text: string;
  /** [x0, y0, x1, y1] in PDF points with a top-left origin; null when the format has no geometry. */
  bbox: [number, number, number, number] | null;
  font_size: number | null;
  bold: boolean;
  /** Rows of cell text for tables. */
  table_grid?: string[][];
  /** ocr_divergent, no_text_layer, stitched, hyphen_joined, native_id:<id>, ... */
  flags: string[];
  /** 1.0 for a text layer or exact parse; the transcribers' agreement for OCR. */
  confidence: number;
  /** The other transcriber's reading when the two disagree (OCR pages only). */
  alt_text?: string;
}

export interface PageInfo {
  page: number;
  width: number;
  height: number;
  /** Characters in the text layer; 0 on a scanned page. */
  chars: number;
  image?: string;
}

export interface ExtractReport {
  artifact_sha256?: Record<string, string>;
  input: string;
  doc_sha: string;
  format: "pdf" | "docx" | "html" | "xlsx" | "text" | "markdown" | "csv" | "tsv" | "json" | "xml" | "pptx";
  recipe_sha256?: string;
  pages: PageInfo[];
  elements: number;
  tables: number;
  scanned_pages: number[];
  ocr?: { primary: string; secondary: string; pages: number; divergent_lines: number; lines: number; unverified_pages: number[] };
  elapsed_ms: number;
  notes: string[];
}
