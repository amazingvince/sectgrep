/* Generated from the Rust-owned docs/sections.schema.json. Do not edit. */

export interface SectionBundle {
  schema_version: number;
  recipe: string;
  document: string;
  /**
   * Corpus-relative organized document artifacts, including historical revisions, with SHA-256.
   */
  artifacts: {
    [k: string]: string;
  };
  /**
   * Virtual paths preserve the exact-search, citation, and revision contracts.
   */
  sections: {
    [k: string]: string;
  };
}
