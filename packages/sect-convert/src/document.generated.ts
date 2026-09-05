/* Generated from the Rust-owned docs/document.schema.json. Do not edit. */

export type Locator =
  | {
      page: number;
      elements: number[];
      /**
       * @minItems 4
       * @maxItems 4
       */
      bbox?: [number, number, number, number] | null;
      type: "page";
    }
  | {
      locations: PageLocation[];
      type: "pages";
    }
  | {
      xpath: string;
      type: "xml";
    }
  | {
      part: string;
      xpath: string;
      type: "office";
    }
  | {
      line_start: number;
      line_end: number;
      type: "text";
    }
  | {
      sheet: string;
      range: string;
      type: "sheet";
    }
  | {
      slide: number;
      shape?: string | null;
      type: "slide";
    }
  | {
      pointer: string;
      type: "record";
    };

export interface DocumentArtifact {
  schema_version: number;
  document: string;
  effective: string;
  raw: string;
  raw_sha256: string;
  format: string;
  parser: string;
  regions: Region[];
  units: AddressableUnit[];
  derivations: Derivation[];
}
export interface Region {
  id: string;
  native_id?: string | null;
  kind: string;
  text: string;
  locator: Locator;
  order: number;
  parent?: string | null;
  heading_level?: number | null;
  cells: TableCell[];
  caption_of?: string | null;
  footnote_of: string[];
  uncertainty: string[];
  /**
   * Why this region is absent from searchable text; the region itself remains intact.
   */
  exclusion?: string | null;
}
export interface PageLocation {
  page: number;
  elements: number[];
  /**
   * @minItems 4
   * @maxItems 4
   */
  bbox?: [number, number, number, number] | null;
}
export interface TableCell {
  id: string;
  row: number;
  column: number;
  row_span: number;
  column_span: number;
  text: string;
  /**
   * Explicit parser associations only; empty is not a claim that no header exists.
   */
  headers: string[];
  role: string;
}
export interface AddressableUnit {
  id: string;
  title: string;
  parent?: string | null;
  regions: string[];
  native_id?: string | null;
  content_sha256: string;
}
export interface Derivation {
  stage: string;
  implementation: string;
  recipe_sha256: string;
  /**
   * Input paths and SHA-256 hashes, including parser, prompt, model, and profile artifacts.
   */
  inputs: {
    [k: string]: string;
  };
  outputs: {
    [k: string]: string;
  };
}
