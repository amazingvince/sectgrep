/* Generated from the Rust-owned docs/knowledge.schema.json. Do not edit. */

export type RelationDirection = "out" | "in" | "both";
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
export type CheckState = "passed" | "failed" | "unchecked" | "not_applicable";

export interface KnowledgeArtifact {
  schema_version: number;
  profile: Profile;
  concepts: Concept[];
  mentions: Mention[];
  relations: Relation[];
  derivations: Derivation[];
}
export interface Profile {
  name: string;
  version: string;
  unit_types: string[];
  concept_types: string[];
  metadata_fields: string[];
  relation_types: RelationType[];
}
export interface RelationType {
  name: string;
  description: string;
  direction: RelationDirection;
  weight: number;
  required_context: boolean;
}
export interface Concept {
  /**
   * Profile-scoped identifier. Equal labels never imply equal identities.
   */
  id: string;
  label: string;
  aliases: string[];
  kind: string;
  scope?: string | null;
  definition?: string | null;
  evidence: Evidence[];
  verification: Verification;
}
export interface Evidence {
  raw: string;
  raw_sha256: string;
  locator: Locator;
  quote: string;
  verification: Verification;
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
export interface Verification {
  state: CheckState;
  method: string;
  reason?: string | null;
}
export interface Mention {
  concept: string;
  at: Endpoint;
  evidence: Evidence[];
  verification: Verification;
}
export interface Endpoint {
  revision: string;
  anchor?: string | null;
}
export interface Relation {
  id: string;
  from: Endpoint;
  to: Endpoint;
  kind: string;
  scope?: string | null;
  qualifiers?: {
    [k: string]: string;
  };
  evidence: Evidence[];
  verification: Verification;
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
