import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { SectionBundle } from "./sections.generated.js";
export type { SectionBundle } from "./sections.generated.js";

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addFormat("uint32", {
  type: "number",
  validate: (n) => Number.isInteger(n) && n >= 0 && n <= 4294967295,
});
const validate = ajv.compile<SectionBundle>(
  JSON.parse(
    readFileSync(
      new URL("../../../docs/sections.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);
const relative = (p: string) =>
  !!p &&
  !/[\\:\x00-\x1f\x7f]/.test(p) &&
  p.split("/").every((part) => part && part !== "." && part !== "..");

export function parseSections(value: unknown): SectionBundle {
  if (!validate(value))
    throw new Error(
      `invalid section bundle: ${JSON.stringify(validate.errors)}`,
    );
  if (
    value.schema_version !== 1 ||
    value.recipe !== "canonical-markdown-v1" ||
    !value.document ||
    !Object.keys(value.sections).length ||
    !Object.keys(value.artifacts).length
  )
    throw new Error("invalid section bundle identity/recipe");
  if (
    Object.entries(value.artifacts).some(
      ([p, h]) =>
        !relative(p) ||
        !p.endsWith(".document.json") ||
        !/^[a-f0-9]{64}$/.test(h),
    )
  )
    throw new Error("invalid section artifact binding");
  if (
    Object.entries(value.sections).some(
      ([p, text]) =>
        !relative(p) || !p.endsWith(".md") || !text.startsWith("---\n"),
    )
  )
    throw new Error("invalid section projection");
  return value;
}
