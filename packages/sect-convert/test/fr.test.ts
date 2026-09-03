import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { anchorOf, convertFr, designators, kindOf, parseLongDate, sectionOf } from "../src/fr.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const xml = readFileSync(path.join(here, "fixtures/fr/2026-00653.xml"), "utf-8");

describe("Federal Register rule -> notice with Action candidates", () => {
  it("parses dates, designators, sections, and kinds", () => {
    expect(parseLongDate("Effective Date January 15, 2026.")).toBe("2026-01-15");
    expect(anchorOf("(j)(2)(i)")).toBe("j-2-i");
    expect(designators("Amend § 1910.1200 by revising paragraphs (j)(2)(i) and (ii) and (j)(3)(i) and (ii) to read as follows:")).toEqual(["j-2-i", "ii", "j-3-i"]);
    expect(sectionOf("2. Amend § 1910.1200 by revising")).toBe("1910.1200");
    expect(sectionOf("1. The authority citation for subpart Z of 29 CFR part 1910 is revised")).toBeNull();
    expect(kindOf("2. Amend § 1910.1200 by revising paragraphs (j)(2)(i)")).toBe("amend");
    expect(kindOf("3. Amend § 1926.502 by adding paragraph (k) to read as follows:")).toBe("add");
    expect(kindOf("4. Add § 1910.1201 to read as follows:")).toBe("add");
    expect(kindOf("5. Remove § 1910.1202.")).toBe("remove");
    expect(kindOf("6. Redesignate paragraphs (d) through (f) as paragraphs (e) through (g).")).toBe("redesignate");
    expect(kindOf("7. Section 1910.1000 is amended by removing paragraph (c).")).toBe("remove");
  });

  it("converts the Hazard Communication rule", () => {
    const n = convertFr(xml, { docnum: "2026-00653", published: "2026-01-15", raw: "raw/fr/2026/2026-00653.xml" });
    expect(n.id).toBe("FR:2026-00653");
    expect(n.title).toBe("Hazard Communication Standard");
    expect(n.effective).toBe("2026-01-15");
    expect(n.parts_affected).toEqual(["CFR:29-1910"]);
    expect(n.actions).toHaveLength(2);
    expect(n.actions[0]).toMatchObject({ action_id: "FR:2026-00653#instr-1", target_id: "CFR:29-1910-Z", kind: "amend", target_anchor: null });
    expect(n.actions[0].text).toContain("29 U.S.C. 653, 655, 657");
    expect(n.actions[1]).toMatchObject({ action_id: "FR:2026-00653#instr-2", target_id: "CFR:29-1910.1200", target_anchor: "j-2-i", kind: "amend" });
    expect(n.actions[1].anchors).toEqual(["j-2-i", "ii", "j-3-i"]);
    expect(n.actions[1].text).toContain("May 19, 2026");
    expect(n.frontMatter).toContain("kind: notice");
    expect(n.frontMatter).toContain("  - action_id: FR:2026-00653#instr-2");
    expect(n.frontMatter).toContain("parts_affected: [CFR:29-1910]");
    expect(n.markdown.startsWith("# Hazard Communication Standard")).toBe(true);
    expect(n.markdown).toContain("## Regulatory text");
    expect(n.citation).toMatch(/^91 FR \d+$/);
  });
});

describe("a part removed without an amendatory paragraph", () => {
  const rescission = readFileSync(path.join(here, "fixtures/fr/2026-17726.xml"), "utf-8");
  it("is one remove action on the part, and bare part mentions link to the rule's single title", () => {
    const n = convertFr(rescission, { docnum: "2026-17726", published: "2026-08-31", raw: "raw/fr/2026/2026-17726.xml" });
    expect(n.parts_affected).toEqual(["CFR:29-42"]);
    expect(n.actions).toHaveLength(1);
    expect(n.actions[0]).toMatchObject({ kind: "remove", target_id: "CFR:29-42", target_anchor: null });
    expect(n.actions[0].instruction).toContain("removes and reserves 29 CFR Part 42");
    expect(n.markdown).toContain("[Part 42](CFR:29-42)");
    expect(n.markdown).not.toContain("29 CFR [Part 42]");
  });
});
