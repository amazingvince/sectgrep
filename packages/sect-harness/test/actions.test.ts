import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { splitFrontMatter, spanMatch, tokens } from "@sectgrep/convert";
import YAML from "yaml";
import { applyAction, applyActions, redesignation, wordEdit, type Action } from "../src/actions.js";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const fixture = path.resolve(here, "../../../fixtures/corpus");

const base = (id: string, extra: Partial<Action> = {}): Action => ({ action_id: `N#${id}`, notice: "N", target_id: "X", target_anchor: null, kind: "amend", effective: "2026-01-01", text: "", ...extra });

describe("actions applied in code (D.2 step 9)", () => {
  const body = "# § 1.1 Rules\n\n(a) First.\n\n(b) Second, with a cage or well.\n\n(1) Nested one.\n\n(2) Nested two.\n\n(c) Third.\n";

  it("replaces a paragraph with the quoted text, sub-paragraphs included", () => {
    const r = applyActions(body, [base("1", { target_anchor: "b", text: "(b) New second.\n\n(1) New nested." })]);
    expect(r.unapplied).toEqual([]);
    expect(r.body).toBe("# § 1.1 Rules\n\n(a) First.\n\n(b) New second.\n\n(1) New nested.\n\n(c) Third.\n");
    // Only the introductory text revised: the nested paragraphs stay.
    const intro = applyActions(body, [base("1b", { target_anchor: "b", instruction: "Revising paragraph (b) introductory text.", text: "(b) Second, revised." })]);
    expect(intro.body).toBe("# § 1.1 Rules\n\n(a) First.\n\n(b) Second, revised.\n\n(1) Nested one.\n\n(2) Nested two.\n\n(c) Third.\n");
  });

  it("makes a word-level edit in the named paragraph, or everywhere when told", () => {
    const one = applyAction(body, base("2", { kind: "remove", target_anchor: "b", instruction: "Amend § 1.1 by removing the words “cage or well” in paragraph (b) and adding in their place the words “ladder safety system”." }));
    expect(one.body).toContain("(b) Second, with a ladder safety system.");
    expect(wordEdit("removing the word “he” wherever it appears and adding “they”")).toEqual({ remove: "he", add: "they", everywhere: true });
    const missing = applyAction(body, base("3", { kind: "remove", target_anchor: "a", instruction: "removing the words “not here”" }));
    expect(missing.why).toMatch(/not in paragraph \(a\)/);
  });

  it("redesignates, adds in order, removes and reserves", () => {
    expect(redesignation("Redesignate paragraph (c) as paragraph (d); and adding a new paragraph (c).")).toEqual([{ from: "c", to: "d" }]);
    const re = applyActions(body, [base("4", { kind: "redesignate", instruction: "Redesignate paragraph (c) as paragraph (d) and add a new paragraph (c).", text: "(c) Inserted third." })]);
    expect(re.body).toContain("(c) Inserted third.\n\n(d) Third.");
    const added = applyActions(body, [base("5", { kind: "add", target_anchor: "d", text: "(d) Fourth." })]);
    expect(added.body.trimEnd().endsWith("(c) Third.\n\n(d) Fourth.")).toBe(true);
    const nested = applyActions(body, [base("6", { kind: "add", target_anchor: "b", text: "(3) Nested three." })]);
    expect(nested.body).toContain("(2) Nested two.\n\n(3) Nested three.\n\n(c) Third.");
    // Inline first sub-paragraph, then roman ones under it.
    const roman = applyActions("# § 1.1 Rules\n\n(a) First.\n", [base("6b", { kind: "add", text: "(e) Special rules. (1) Except as follows:\n\n(i) One.\n\n(ii) Two.\n\n(2) Other." })]);
    // A sub-paragraph whose parent is inline is a person's to place; the rest lands.
    expect(roman.body).toContain("(e) Special rules. (1) Except as follows:\n\n(2) Other.");
    expect(roman.partial?.[0]?.notes.join(" ")).toMatch(/inline in its parent/);
    const removed = applyAction(body, base("7", { kind: "remove", target_anchor: "b", instruction: "Remove and reserve paragraph (b)." }));
    expect(removed.body).toBe("# § 1.1 Rules\n\n(a) First.\n\n(b) [Reserved]\n\n(c) Third.\n");
    const gone = applyAction(body, base("8", { kind: "remove", target_anchor: "b", instruction: "Remove paragraph (b)." }));
    expect(gone.body).toBe("# § 1.1 Rules\n\n(a) First.\n\n(c) Third.\n");
  });

  it("reports what it cannot apply instead of guessing, and skips header instructions", () => {
    const r = applyActions(body, [
      base("9", { instruction: "Amend § 1.1 by:" }),
      base("10", { target_anchor: "z", text: "(z) Nowhere." }),
      base("11", { target_anchor: "a", text: "(a) First, revised." }),
    ]);
    expect(r.applied.map((a) => a.action_id)).toEqual(["N#11"]);
    expect(r.unapplied.map((u) => `${u.action.action_id}: ${u.why}`)).toEqual(["N#10: paragraph (z) not found"]);
    const partial = applyActions(body, [base("12", { target_anchor: "b", text: "(b) * * * Second, in part." })]);
    expect(partial.unapplied[0]?.why).toMatch(/asterisks/);
    expect(r.body).toContain("(a) First, revised.");
  });

  it("reproduces the fixture's amended Expression from the prior one and the notice's Action", () => {
    const prior = splitFrontMatter(readFileSync(path.join(fixture, "cfr-title-99", "I", "A", "2", "2.7", "99-2.7@2024-01-01.md"), "utf-8"))!;
    const current = splitFrontMatter(readFileSync(path.join(fixture, "cfr-title-99", "I", "A", "2", "2.7", "99-2.7.md"), "utf-8"))!;
    const notice = YAML.parse(splitFrontMatter(readFileSync(path.join(fixture, "fr", "2026", "2026-00001.md"), "utf-8"))!.front) as { actions: Action[] };
    const actions = notice.actions.filter((a) => a.target_id === "CFR:99-2.7");
    const r = applyActions(prior.body, actions);
    expect(r.unapplied).toEqual([]);
    expect(r.applied).toHaveLength(1);
    // What validator 7 asks of an amended Expression: the Action's text is present at the
    // round-trip threshold; the paragraphs the Action did not touch are the prior's, and the
    // current fixture Expression carries the same amended paragraph.
    expect(spanMatch(tokens(actions[0].text), tokens(r.body), 0.92).score).toBeGreaterThanOrEqual(0.92);
    expect(spanMatch(tokens(actions[0].text), tokens(current.body), 0.92).score).toBeGreaterThanOrEqual(0.92);
    const untouched = prior.body.split("\n").filter((l) => /^\(a\)/.test(l));
    for (const l of untouched) expect(r.body).toContain(l);
    expect(r.body).not.toContain(prior.body.split("\n").find((l) => /^\(b\)/.test(l)) ?? "@@");
  });
});
