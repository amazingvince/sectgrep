import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { KnowledgeArtifact } from "./knowledge.generated.js";
import { validOfficeLocator, validPageLocation } from "./locators.js";

const schema = JSON.parse(readFileSync(new URL("../../../docs/knowledge.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addFormat("uint32", { type: "number", validate: (n: number) => Number.isInteger(n) && n >= 0 && n <= 4294967295 });
ajv.addFormat("double", { type: "number", validate: Number.isFinite });
const validate = ajv.compile<KnowledgeArtifact>(schema);
export function parseKnowledge(value: unknown): KnowledgeArtifact {
  if (!validate(value)) throw new Error(`invalid knowledge artifact: ${JSON.stringify(validate.errors)}`);
  if (value.schema_version !== 1) throw new Error("unsupported knowledge schema version");
  const hash = (s: string) => /^[a-f0-9]{64}$/i.test(s);
  const supported = (item: KnowledgeArtifact["concepts"][number] | KnowledgeArtifact["mentions"][number] | KnowledgeArtifact["relations"][number]) => {
    if (item.verification.state !== "passed") return true;
    return !!item.verification.method.trim() && item.evidence.length > 0 && item.evidence.every(e => {
      const l = e.locator;
      const located = l.type === "page" ? l.page > 0 && (!l.bbox || l.bbox[0] <= l.bbox[2] && l.bbox[1] <= l.bbox[3])
        : l.type === "text" ? l.line_start > 0 && l.line_end >= l.line_start
        : l.type === "xml" ? l.xpath.startsWith("/")
        : l.type === "office" ? validOfficeLocator(l.part, l.xpath)
        : l.type === "pages" ? l.locations.length >= 2 && l.locations.every(validPageLocation)
        : l.type === "sheet" ? !!l.sheet.trim() && !!l.range.trim()
        : l.type === "slide" ? l.slide > 0 : !l.pointer || l.pointer.startsWith("/");
      return located && hash(e.raw_sha256) && !!e.raw && !!e.quote.trim() && e.verification.state === "passed" && !!e.verification.method.trim();
    });
  };
  const unique = (ids: string[]) => ids.every(Boolean) && new Set(ids).size === ids.length;
  if (!value.profile.name || !value.profile.version || !unique(value.profile.relation_types.map(t => t.name)) || value.profile.relation_types.some(t => t.weight < 0 || t.weight > 1)) throw new Error("invalid profile");
  if (!unique(value.concepts.map(c => c.id)) || value.concepts.some(c => !value.profile.concept_types.includes(c.kind) || !supported(c))) throw new Error("invalid concept");
  if (!unique(value.relations.map(r => r.id)) || value.relations.some(r => !value.profile.relation_types.some(t => t.name === r.kind) || !supported(r))) throw new Error("invalid relation");
  if (value.mentions.some(m => !value.concepts.some(c => c.id === m.concept) || !supported(m))) throw new Error("invalid mention");
  if (value.derivations.some(d => !d.stage || !d.implementation || !hash(d.recipe_sha256) || [...Object.values(d.inputs), ...Object.values(d.outputs)].some(h => !hash(h)))) throw new Error("invalid derivation");
  return value;
}
export type * from "./knowledge.generated.js";
