import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { proposeKnowledge, reviewKnowledge } from "../src/knowledge.js";

it("requires an explicit byte-bound decision before a proposal can become accepted", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sect-knowledge-"));
  const corpus = path.join(root, "corpus"); mkdirSync(corpus);
  const raw = "A requires B."; writeFileSync(path.join(corpus, "raw.txt"), raw);
  const verification = { state: "passed", method: "model self-rating", reason: null };
  const artifact = { schema_version: 1, profile: { name: "generic", version: "1", unit_types: [], concept_types: [], metadata_fields: [], relation_types: [{ name: "requires", description: "requires context", direction: "out", weight: 1, required_context: true }] }, concepts: [], mentions: [], relations: [{ id: "one", from: { revision: "D:a@2026-01-01", anchor: null }, to: { revision: "D:b@2026-01-01", anchor: null }, kind: "requires", evidence: [{ raw: "raw.txt", raw_sha256: createHash("sha256").update(raw).digest("hex"), locator: { type: "text", line_start: 1, line_end: 1 }, quote: raw, verification }], verification }], derivations: [] };
  const candidate = path.join(root, "candidate.json"); writeFileSync(candidate, JSON.stringify(artifact));
  const run = path.join(root, "proposal");
  const proposed = proposeKnowledge(candidate, corpus, run);
  expect(JSON.parse(readFileSync(proposed.proposal, "utf8")).relations[0].verification.state).toBe("unchecked");
  const decisions = JSON.parse(readFileSync(proposed.decisions, "utf8"));
  expect(() => reviewKnowledge(run, proposed.decisions, path.join(root, "out.json"))).toThrow(/reviewer/);
  decisions.reviewer = "synthetic test reviewer"; decisions.decisions[0].decision = "accept"; decisions.decisions[0].reason = "synthetic quote and endpoints checked";
  writeFileSync(proposed.decisions, JSON.stringify(decisions));
  expect(reviewKnowledge(run, proposed.decisions, path.join(root, "out.json")).relations[0].verification.state).toBe("passed");
  writeFileSync(path.join(corpus, "raw.txt"), "Changed.");
  expect(() => reviewKnowledge(run, proposed.decisions, path.join(root, "other.json"))).toThrow(/dependency changed/);
});
