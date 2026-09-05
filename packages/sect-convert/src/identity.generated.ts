/* Generated from the Rust-owned docs/identity.schema.json. Do not edit. */

export interface IdentityLedger {
  schema_version: number;
  document: string;
  next_id: number;
  revisions: {
    [k: string]: AddressableUnit[];
  };
  transitions: IdentityTransition[];
}
export interface AddressableUnit {
  id: string;
  title: string;
  parent?: string | null;
  regions: string[];
  native_id?: string | null;
  content_sha256: string;
}
export interface IdentityTransition {
  effective: string;
  from: string[];
  to: string[];
  basis: string;
  receipt_sha256?: string | null;
}
