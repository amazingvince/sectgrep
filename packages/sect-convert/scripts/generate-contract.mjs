import { readFileSync, writeFileSync } from "node:fs";
import { compile } from "json-schema-to-typescript";
for (const [name, type] of [["knowledge", "KnowledgeArtifact"], ["document", "DocumentArtifact"], ["identity", "IdentityLedger"], ["sections", "SectionBundle"]]) {
  const schema = JSON.parse(readFileSync(new URL(`../../../docs/${name}.schema.json`, import.meta.url), "utf8"));
  writeFileSync(new URL(`../src/${name}.generated.ts`, import.meta.url), await compile(schema, type, { bannerComment: `/* Generated from the Rust-owned docs/${name}.schema.json. Do not edit. */`, additionalProperties: false }));
}
