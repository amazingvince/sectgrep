import { describe, expect, it } from "vitest";
import { consensus } from "../src/verifier.js";
import type { StagedRecord } from "../src/tools.js";
import type { Candidate } from "../src/refs.js";
import { applyXrefs } from "../src/tools.js";

const record: StagedRecord = { id: "DOC:A", input: "a.md", path: "s/a.md", context: "", defines: [], flags: [], body_tokens: 1, xrefs: [{ text: "reference", id: "DOC:B", anchor: "a", confidence: 1, search: "reference" }] };
describe("review: complete verification claims", () => {
  it("does not nest short citations inside a linked longer citation", () => {
    const xrefs = [
      { ...record.xrefs[0], text: "§ 1.1", id: "DOC:B" },
      { ...record.xrefs[0], text: "40 CFR § 1.1", id: "DOC:C" },
    ];
    const result = applyXrefs("Read 40 CFR § 1.1 and then § 1.1.", xrefs);
    expect(result.body).toBe("Read [40 CFR § 1.1](DOC:C#a) and then [§ 1.1](DOC:B#a).");
  });
  it("rejects another anchor and a missing answer even with a sole candidate", () => {
    const candidates = new Map<string, Candidate[]>([["reference", [{ id: "DOC:B", title: "B", anchor: "a", via: "pattern" }]]]);
    expect(consensus(record, { xrefs: [{ text: "reference", id: "DOC:B", anchor: "b", confidence: 1 }], defines: [] }, [], candidates, "normal", {})[0].agree).toBe(false);
    expect(consensus(record, { xrefs: [], defines: [] }, [], candidates, "normal", {})[0].agree).toBe(false);
    expect(consensus(record, { xrefs: [{ text: "reference", id: "DOC:B#a", confidence: 1 }], defines: [] }, [], candidates, "normal", {})[0].agree).toBe(true);
  });
  it("does not equate add with remove or infer an operation from a candidate", () => {
    const r = { ...record, xrefs: [], actions: [{ action_id: "ACT:1", target_id: "DOC:B", target_anchor: "a", kind: "remove" }] };
    const candidates = new Map<string, Candidate[]>([["ACT:1", [{ id: "DOC:B", title: "B", via: "pattern" }]]]);
    const answer = { xrefs: [], defines: [], actions: [{ action_id: "ACT:1", target_id: "DOC:B", target_anchor: "a", kind: "add" }] };
    expect(consensus(r, answer, [], candidates, "normal", {})[0].agree).toBe(false);
    expect(consensus(r, answer, [], candidates, "normal", {})[0]).toMatchObject({ ingest_kind: "remove", verifier_kind: "add" });
    expect(consensus(r, { xrefs: [], defines: [] }, [], candidates, "normal", {})[0].agree).toBe(false);
  });
});
