import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { assertBinding, bindVerification } from "../src/binding.js";
import { mergeRun } from "../src/merge.js";

it("binds verdicts to candidate bytes, registry bytes, and dependency additions", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sect-seal-"));
  const stage = path.join(root, "stage"), input = path.join(root, "input");
  mkdirSync(stage); mkdirSync(input);
  writeFileSync(path.join(stage, "unit.md"), "must not apply");
  writeFileSync(path.join(stage, "_source.yaml"), "profile: research@1");
  const seal = bindVerification(stage, [input]);
  writeFileSync(path.join(stage, "sample.json"), "{}");
  expect(() => assertBinding(stage, seal)).not.toThrow();
  writeFileSync(path.join(stage, "unit.md"), "must apply");
  expect(() => assertBinding(stage, seal)).toThrow(/staged bytes changed/);
  writeFileSync(path.join(stage, "unit.md"), "must not apply");
  writeFileSync(path.join(input, "new.xml"), "new reference candidate");
  expect(() => assertBinding(stage, seal)).toThrow(/dependency changed/);
});

it("restores corpus files and refuses a commit when indexing fails", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sect-publish-"));
  const stage = path.join(root, "stage"), corpus = path.join(root, "corpus");
  mkdirSync(path.join(stage, "test"), { recursive: true }); mkdirSync(corpus);
  writeFileSync(path.join(stage, "test/_source.yaml"), "name: test\nkind: base\nid_prefix: 'T:'\nprecedence: 0\nlegal_status: derived\n");
  writeFileSync(path.join(stage, "test/broken.md"), "---\nid: T:broken\n---\n# Invalid candidate\n");
  writeFileSync(path.join(stage, "submit.json"), "{}");
  const report = { run_id: "stage", binding: bindVerification(stage, [corpus]), sections: [{ id: "T:broken", path: "test/broken.md", tier: "auto", judgments: [], evidence: [] }], verifier: { provider: "test", model: "test" }, counts: { judgments: 0 }, agreement_rate: 1 };
  writeFileSync(path.join(stage, "verify.json"), JSON.stringify(report));
  const bin = process.env.SECT_BIN ?? path.resolve("../../target/debug/sect" + (process.platform === "win32" ? ".exe" : ""));
  expect(() => mergeRun({ runDir: stage, source: "test", corpus, sectBin: bin, commit: true, review: path.join(root, "review"), log: () => {} })).toThrow(/index failed; corpus restored/);
  expect(existsSync(path.join(corpus, "test/broken.md"))).toBe(false);
  expect(existsSync(path.join(corpus, "test/_source.yaml"))).toBe(false);
  expect(existsSync(path.join(corpus, ".sect/merge.lock"))).toBe(false);
  expect(readFileSync(path.join(stage, "test/broken.md"), "utf8")).toContain("Invalid candidate");
}, 30000);
