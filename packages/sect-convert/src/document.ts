import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Element, ExtractReport } from "./elements/types.js";
import { recoverStructure } from "./structure.js";
import { validOfficeLocator, validPageLocation } from "./locators.js";
import type {
  DocumentArtifact,
  Region,
  AddressableUnit,
} from "./document.generated.js";
import type { IdentityLedger } from "./identity.generated.js";
export type * from "./document.generated.js";
export type { IdentityLedger } from "./identity.generated.js";
export { readOfficeXml } from "./locators.js";

export const contentHash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addFormat("uint32", {
  type: "number",
  validate: (n: number) => Number.isInteger(n) && n >= 0 && n <= 4294967295,
});
ajv.addFormat("double", { type: "number", validate: Number.isFinite });
const validate = ajv.compile<DocumentArtifact>(
  JSON.parse(
    readFileSync(
      new URL("../../../docs/document.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);
const validateLedger = ajv.compile<IdentityLedger>(
  JSON.parse(
    readFileSync(
      new URL("../../../docs/identity.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);

export function parseDocument(value: unknown): DocumentArtifact {
  if (!validate(value))
    throw new Error(`invalid document: ${JSON.stringify(validate.errors)}`);
  const d = value;
  if (
    d.schema_version !== 1 ||
    !d.document ||
    !/^[a-f0-9]{64}$/i.test(d.raw_sha256)
  )
    throw new Error("invalid document identity/version/hash");
  const regions = new Map(d.regions.map((r) => [r.id, r]));
  const units = new Map(d.units.map((u) => [u.id, u]));
  if (regions.size !== d.regions.length || units.size !== d.units.length)
    throw new Error("duplicate region or unit identity");
  function hierarchy<T extends { id: string; parent?: string | null }>(
    items: Map<string, T>,
  ) {
    for (const item of items.values()) {
      const seen = new Set([item.id]);
      let parent = item.parent;
      while (parent) {
        if (seen.has(parent) || !items.has(parent))
          throw new Error("unknown parent or hierarchy cycle");
        seen.add(parent);
        parent = items.get(parent)!.parent;
      }
    }
  }
  hierarchy(regions);
  hierarchy(units);
  const orders = new Set<number>();
  const covered = new Set<string>();
  for (const r of d.regions) {
    const l = r.locator;
    if (
      !r.id ||
      orders.has(r.order) ||
      (l.type === "page" &&
        (!l.page ||
          (l.bbox && (l.bbox[0] > l.bbox[2] || l.bbox[1] > l.bbox[3])))) ||
      (l.type === "text" && (!l.line_start || l.line_end < l.line_start)) ||
      (l.type === "xml" && !l.xpath.startsWith("/")) ||
      (l.type === "office" && !validOfficeLocator(l.part, l.xpath)) ||
      (l.type === "pages" && (l.locations.length < 2 || !l.locations.every(validPageLocation))) ||
      (l.type === "slide" && !l.slide) ||
      (l.type === "sheet" && (!l.sheet.trim() || !l.range.trim())) ||
      (l.type === "record" && l.pointer && !l.pointer.startsWith("/"))
    )
      throw new Error("invalid region locator/order/identity");
    orders.add(r.order);
    const cells = new Set(r.cells.map((c) => c.id));
    if (
      cells.size !== r.cells.length ||
      r.cells.some(
        (c) =>
          !c.id ||
          !c.row_span ||
          !c.column_span ||
          c.headers.some((h) => !cells.has(h)),
      )
    )
      throw new Error("invalid table cell/header association");
    if (
      [...(r.caption_of ? [r.caption_of] : []), ...r.footnote_of].some(
        (id) => id === r.id || !regions.has(id),
      )
    )
      throw new Error("invalid region association");
  }
  for (const u of d.units) {
    if (!u.id) throw new Error("empty unit identity");
    for (const id of u.regions) {
      if (!regions.has(id) || covered.has(id))
        throw new Error("unknown or multiply assigned unit region");
      covered.add(id);
    }
    if (
      u.content_sha256 !==
      contentHash(u.regions.map((id) => regions.get(id)!.text).join("\n\n"))
    )
      throw new Error("unit text hash does not match source regions");
  }
  if (d.regions.some((r) => !r.exclusion && !covered.has(r.id)))
    throw new Error("unaccounted source region");
  return d;
}

export function parseIdentity(value: unknown): IdentityLedger {
  if (!validateLedger(value) || value.schema_version !== 1)
    throw new Error("invalid identity ledger");
  return value;
}

/** No semantic claims are inferred from a table's first row, adjacency, or font size. */
export function organizeDocument(input: {
  document: string;
  effective: string;
  raw: string;
  report: ExtractReport;
  elements: Element[];
}): DocumentArtifact {
  const elements = recoverStructure(input.elements, input.report);
  const regions: Region[] = elements.map((e) => {
    const id = `r-${contentHash(`${input.report.doc_sha}:${e.seq}:${JSON.stringify(e.locator ?? e.bbox)}`).slice(0, 24)}`;
    const native =
      e.native_id ??
      e.flags.find((f) => f.startsWith("native_id:"))?.slice(10) ??
      null;
    const heading =
      e.heading_level ??
      (e.type === "heading"
        ? (/^(#+)\s/.exec(e.text)?.[1].length ?? null)
        : null);
    return {
      id,
      native_id: native,
      kind: e.type,
      text: e.text,
      order: e.seq,
      locator: e.locator ?? {
        type: "page",
        page: e.page,
        elements: [e.seq],
        bbox: e.bbox,
      },
      parent: null,
      heading_level: heading,
      caption_of: null,
      footnote_of: [],
      cells:
        e.cells ??
        (e.table_grid ?? []).flatMap((row, ri) =>
          row.map((text, ci) => ({
            id: `${id}:c${ri}:${ci}`,
            row: ri,
            column: ci,
            row_span: 1,
            column_span: 1,
            text,
            headers: [],
            role: "unknown",
          })),
        ),
      uncertainty: [
        ...e.flags,
        ...(e.type === "heading" && !heading ? ["heading_level_unknown"] : []),
        ...(e.table_grid?.length && !e.cells
          ? ["table_header_associations_unknown"]
          : []),
      ],
      exclusion: e.exclusion ?? null,
    };
  });
  const bySeq = new Map(elements.map((e, i) => [e.seq, regions[i].id]));
  const stack: Region[] = [];
  for (const [i, r] of regions.entries()) {
    const e = elements[i];
    if (r.exclusion) continue;
    if (r.heading_level) {
      while (
        stack.length &&
        (stack.at(-1)!.heading_level ?? Infinity) >= r.heading_level
      )
        stack.pop();
      r.parent = stack.at(-1)?.id ?? null;
      stack.push(r);
    } else r.parent = stack.at(-1)?.id ?? null;
    if (e.parent_seq !== undefined) r.parent = bySeq.get(e.parent_seq) ?? null;
    if (e.caption_of !== undefined)
      r.caption_of = bySeq.get(e.caption_of) ?? null;
    r.footnote_of = (e.footnote_of ?? []).map((seq) => {
      const id = bySeq.get(seq);
      if (!id) throw new Error("unknown footnote target");
      return id;
    });
  }
  const units: AddressableUnit[] = [];
  let previousBoundary: string | undefined;
  for (const r of regions) {
    if (r.exclusion) continue;
    const record = r.uncertainty.find((f) => f.startsWith("record_scope:"))?.slice(13);
    const boundary = record !== undefined ? `record:${record}`
      : r.locator.type === "sheet" ? `sheet:${r.locator.sheet}`
      : r.locator.type === "slide" ? `slide:${r.locator.slide}` : undefined;
    if (!units.length || r.kind === "heading" || (boundary !== undefined && boundary !== previousBoundary))
      units.push({
        id: `${input.document}/pending-${units.length + 1}`,
        title:
          r.kind === "heading" ? r.text.replace(/^#+\s*/, "")
            : record !== undefined ? `Record ${record || "/"}`
            : r.locator.type === "sheet" ? r.locator.sheet
            : r.locator.type === "slide" ? `Slide ${r.locator.slide}` : input.document,
        parent: null,
        regions: [],
        native_id: r.native_id,
        content_sha256: "",
      });
    units.at(-1)!.regions.push(r.id);
    previousBoundary = boundary;
  }
  const unitByRegion = new Map(
    units.flatMap((u) => u.regions.map((id) => [id, u.id] as const)),
  );
  const regionById = new Map(regions.map((r) => [r.id, r]));
  for (const u of units) {
    const first = regionById.get(u.regions[0])!;
    u.parent = first.parent ? (unitByRegion.get(first.parent) ?? null) : null;
    if (u.parent === u.id) u.parent = null;
    u.content_sha256 = contentHash(
      u.regions.map((id) => regionById.get(id)!.text).join("\n\n"),
    );
  }
  return parseDocument({
    schema_version: 1,
    document: input.document,
    effective: input.effective,
    raw: input.raw,
    raw_sha256: input.report.doc_sha,
    format: input.report.format,
    parser: `native:${input.report.recipe_sha256}`,
    regions,
    units,
    derivations: [],
  });
}

export interface IdentityDecision {
  from: string[];
  to: string[];
  receipt_sha256: string;
}
export interface IdentityConflict {
  candidate: string | null;
  previous: string[];
  reason: string;
}
export function reconcileIdentity(
  document: DocumentArtifact,
  previous?: IdentityLedger,
  decisions: IdentityDecision[] = [],
): {
  document: DocumentArtifact;
  ledger: IdentityLedger;
  conflicts: IdentityConflict[];
} {
  const d = structuredClone(document);
  const ledger: IdentityLedger = previous
    ? structuredClone(parseIdentity(previous))
    : {
        schema_version: 1,
        document: d.document,
        next_id: 1,
        revisions: {},
        transitions: [],
      };
  if (ledger.document !== d.document)
    throw new Error("identity ledger belongs to another document");
  const dates = Object.keys(ledger.revisions).sort();
  if (dates.at(-1) && dates.at(-1)! > d.effective)
    throw new Error("cannot reconcile an older revision");
  const prior = ledger.revisions[dates.at(-1) ?? ""] ?? [];
  const reviewedFrom = new Set<string>();
  const reviewedTo = new Set<string>();
  for (const decision of decisions) {
    if (
      !Array.isArray(decision.from) ||
      !Array.isArray(decision.to) ||
      (!decision.from.length && !decision.to.length) ||
      !/^[a-f0-9]{64}$/.test(decision.receipt_sha256)
    )
      throw new Error("invalid identity decision");
    for (const id of decision.from) {
      if (reviewedFrom.has(id) || !prior.some((u) => u.id === id))
        throw new Error("overlapping or unknown prior identity mapping");
      reviewedFrom.add(id);
    }
    for (const id of decision.to) {
      if (reviewedTo.has(id) || !d.units.some((u) => u.id === id))
        throw new Error("overlapping or unknown candidate identity mapping");
      reviewedTo.add(id);
    }
  }
  const assigned = new Set<string>();
  const renames = new Map<string, string>();
  const conflicts: IdentityConflict[] = [];
  const unique = (u: AddressableUnit, field: "native_id" | "content_sha256") =>
    u[field] && d.units.filter((x) => x[field] === u[field]).length === 1
      ? prior.filter((x) => x[field] === u[field])
      : [];
  const consumed = new Set<string>();
  for (const u of d.units) {
    const native = unique(u, "native_id");
    const exact = unique(u, "content_sha256");
    const match =
      native.length === 1
        ? native[0]
        : exact.length === 1
          ? exact[0]
          : undefined;
    const decision = decisions.find((x) => x.to.includes(u.id));
    if (
      decision &&
      (!/^[a-f0-9]{64}$/.test(decision.receipt_sha256) ||
        decision.from.some((id) => !prior.some((x) => x.id === id)))
    )
      throw new Error("invalid identity decision");
    let id: string;
    if (decision) {
      decision.from.forEach((id) => consumed.add(id));
      id =
        decision.from.length === 1 && decision.to.length === 1
          ? decision.from[0]
          : `${d.document}/u${String(ledger.next_id++).padStart(6, "0")}`;
    } else if (
      match &&
      !assigned.has(match.id) &&
      !reviewedFrom.has(match.id)
    ) {
      id = match.id;
      consumed.add(id);
    } else if (!prior.length)
      id = `${d.document}/u${String(ledger.next_id++).padStart(6, "0")}`;
    else {
      conflicts.push({
        candidate: u.id,
        previous: prior.filter((x) => !consumed.has(x.id)).map((x) => x.id),
        reason:
          "new, changed, duplicate, split, or merged content requires an explicit decision",
      });
      continue;
    }
    assigned.add(id);
    renames.set(u.id, id);
    if (!ledger.revisions[d.effective])
      ledger.transitions.push({
        effective: d.effective,
        from: decision?.from ?? (match ? [match.id] : []),
        to: [id],
        basis: decision
          ? "human"
          : match
            ? native.length === 1
              ? "unique_native_id"
              : "unique_exact_content"
            : "new_document",
        receipt_sha256: decision?.receipt_sha256 ?? null,
      });
  }
  for (const old of prior)
    if (!consumed.has(old.id)) {
      const retirement = decisions.find(
        (x) => x.from.includes(old.id) && !x.to.length,
      );
      if (retirement && /^[a-f0-9]{64}$/.test(retirement.receipt_sha256))
        ledger.transitions.push({
          effective: d.effective,
          from: [old.id],
          to: [],
          basis: "human_retirement",
          receipt_sha256: retirement.receipt_sha256,
        });
      else
        conflicts.push({
          candidate: null,
          previous: [old.id],
          reason: "retirement or ambiguous move requires review",
        });
    }
  if (conflicts.length)
    return {
      document: d,
      ledger: previous ?? { ...ledger, transitions: [], revisions: {} },
      conflicts,
    };
  d.units = d.units.map((u) => ({
    ...u,
    id: renames.get(u.id)!,
    parent: u.parent ? (renames.get(u.parent) ?? null) : null,
  }));
  if (
    ledger.revisions[d.effective] &&
    JSON.stringify(ledger.revisions[d.effective]) !== JSON.stringify(d.units)
  )
    throw new Error("same-date identity revision is immutable");
  ledger.revisions[d.effective] = d.units;
  return { document: parseDocument(d), ledger, conflicts };
}
