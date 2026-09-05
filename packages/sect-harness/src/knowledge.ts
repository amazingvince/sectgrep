import { parseKnowledge, type KnowledgeArtifact, type Verification } from "@sectgrep/convert/knowledge";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertBinding, bindVerification, within, type VerificationBinding } from "./binding.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const pending: Verification = { state: "unchecked", method: "proposal", reason: "awaiting independent review" };
type Record = KnowledgeArtifact["concepts"][number] | KnowledgeArtifact["relations"][number] | KnowledgeArtifact["mentions"][number];
function records(artifact: KnowledgeArtifact): Array<{ key: string; record: Record }> {
  return [
    ...artifact.concepts.map(record => ({ key: `concept:${record.id}`, record })),
    ...artifact.relations.map(record => ({ key: `relation:${record.id}`, record })),
    ...artifact.mentions.map((record, i) => ({ key: `mention:${i}:${record.concept}@${record.at.revision}`, record })),
  ];
}

/** Adapter output becomes a reviewable proposal. A model cannot mark its own work accepted. */
export function proposeKnowledge(candidate: string, corpus: string, runDir: string): { proposal: string; decisions: string } {
  const bytes = readFileSync(candidate);
  const artifact = JSON.parse(bytes.toString("utf8")) as KnowledgeArtifact;
  // Validate shape before iteration, allowing candidate verification claims only as untrusted input.
  for (const record of [...(artifact.concepts ?? []), ...(artifact.mentions ?? []), ...(artifact.relations ?? [])]) {
    record.verification = { ...pending };
    for (const evidence of record.evidence ?? []) evidence.verification = { ...pending };
  }
  parseKnowledge(artifact);
  if (existsSync(runDir)) throw new Error("proposal directory already exists; use a new run directory");
  mkdirSync(runDir, { recursive: true });
  const proposal = path.join(runDir, "proposal.json");
  writeFileSync(proposal, JSON.stringify(artifact, null, 2) + "\n");
  const binding = bindVerification(runDir, [path.resolve(corpus), path.resolve(candidate)]);
  writeFileSync(path.join(runDir, "verify.json"), JSON.stringify({ corpus: path.resolve(corpus), binding }, null, 2) + "\n");
  const decisions = `${path.resolve(runDir)}.decisions.json`;
  writeFileSync(decisions, JSON.stringify({ proposal_sha256: hash(readFileSync(proposal)), reviewer: "", decisions: records(artifact).map(({ key, record }) => ({ key, decision: "unchecked", reason: "", evidence: record.evidence })) }, null, 2) + "\n", { flag: "wx" });
  return { proposal, decisions };
}

/** Apply explicit record-level review to an unchanged proposal and raw-source snapshot.
 * This emits a portable artifact; `sect index` separately checks endpoints and publishes it.
 */
export function reviewKnowledge(runDir: string, decisionsFile: string, output: string): KnowledgeArtifact {
  const audit = JSON.parse(readFileSync(path.join(runDir, "verify.json"), "utf8")) as { corpus: string; binding: VerificationBinding };
  assertBinding(runDir, audit.binding);
  const bytes = readFileSync(path.join(runDir, "proposal.json"));
  const decisions = JSON.parse(readFileSync(decisionsFile, "utf8")) as { proposal_sha256: string; reviewer: string; decisions: Array<{ key: string; decision: "accept" | "reject" | "unchecked"; reason: string }> };
  if (decisions.proposal_sha256 !== hash(bytes) || !decisions.reviewer?.trim()) throw new Error("review must identify its reviewer and the exact proposal hash");
  const artifact = parseKnowledge(JSON.parse(bytes.toString("utf8")));
  const known = new Map(records(artifact).map(r => [r.key, r.record]));
  const seen = new Set<string>();
  for (const decision of decisions.decisions) {
    if (!known.has(decision.key) || seen.has(decision.key) || !["accept", "reject", "unchecked"].includes(decision.decision)) throw new Error(`unknown/duplicate review decision: ${decision.key}`);
    seen.add(decision.key);
    if (decision.decision === "unchecked") continue;
    if (!decision.reason?.trim()) throw new Error(`review reason required: ${decision.key}`);
    const record = known.get(decision.key)!;
    const verification: Verification = { state: decision.decision === "accept" ? "passed" : "failed", method: `human:${decisions.reviewer}`, reason: decision.reason };
    if (decision.decision === "accept") for (const evidence of record.evidence) {
      const raw = within(audit.corpus, evidence.raw);
      if (hash(readFileSync(raw)) !== evidence.raw_sha256.toLowerCase()) throw new Error(`raw evidence hash differs: ${evidence.raw}`);
      evidence.verification = verification;
    }
    record.verification = verification;
  }
  parseKnowledge(artifact); // Accepted records require located, quoted evidence.
  if (existsSync(output)) throw new Error("review output already exists; retain the earlier decision and choose a new output");
  mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  writeFileSync(output, JSON.stringify(artifact, null, 2) + "\n", { flag: "wx" });
  writeFileSync(`${output}.review.json`, JSON.stringify({ proposal_sha256: hash(bytes), decisions_sha256: hash(readFileSync(decisionsFile)), reviewer: decisions.reviewer, output_sha256: hash(readFileSync(output)), created_at: new Date().toISOString() }, null, 2) + "\n", { flag: "wx" });
  return artifact;
}
