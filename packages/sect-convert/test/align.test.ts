import { describe, expect, it } from "vitest";
import { alignEcfr } from "../src/align.js";

const wrap = (amddate: string, parts: string) => `<?xml version="1.0" encoding="UTF-8"?>
<DLPSTEXTCLASS><TEXT><BODY><ECFRBRWS>
<AMDDATE>${amddate}</AMDDATE>
<DIV1 N="1" NODE="1:1" TYPE="TITLE">
<HEAD>Title 1—General Provisions--Volume 1</HEAD>
<DIV3 N="I" NODE="1:1.0.1" TYPE="CHAPTER">
<HEAD>CHAPTER I—ADMINISTRATIVE COMMITTEE</HEAD>
<DIV4 N="A" NODE="1:1.0.1.1" TYPE="SUBCHAP">
<HEAD>SUBCHAPTER A—GENERAL</HEAD>
${parts}
</DIV4></DIV3></DIV1>
</ECFRBRWS></BODY></TEXT></DLPSTEXTCLASS>
`;

const OLD = wrap(
  "Jan. 1, 2024",
  `<DIV5 N="1" NODE="1:1.0.1.1.1" TYPE="PART">
<HEAD>PART 1—DEFINITIONS</HEAD>
<DIV8 N="§ 1.1" NODE="1:1.0.1.1.1.0.1.1" TYPE="SECTION"><HEAD>§ 1.1   Definitions.</HEAD><P>As used in this chapter, agency means each authority of the United States.</P></DIV8>
<DIV8 N="§ 1.2" NODE="1:1.0.1.1.1.0.1.2" TYPE="SECTION"><HEAD>§ 1.2   Scope.</HEAD><P>(a) This part applies to every agency.</P><P>(b) It does not apply to the courts.</P></DIV8>
<DIV8 N="§ 1.3" NODE="1:1.0.1.1.1.0.1.3" TYPE="SECTION"><HEAD>§ 1.3   Filing.</HEAD><P>Filing means making a document available for public inspection at the Office of the Federal Register during official hours.</P></DIV8>
<DIV8 N="§ 1.4" NODE="1:1.0.1.1.1.0.1.4" TYPE="SECTION"><HEAD>§ 1.4   Reserved matter.</HEAD><P>This section is reserved for later use by the committee.</P></DIV8>
</DIV5>
<DIV5 N="2" NODE="1:1.0.1.1.2" TYPE="PART">
<HEAD>PART 2—GENERAL INFORMATION</HEAD>
<DIV8 N="§ 2.1" NODE="1:1.0.1.1.2.0.1.1" TYPE="SECTION"><HEAD>§ 2.1   Publication.</HEAD><P>The Office publishes the daily issue and makes it available online without charge to any person.</P></DIV8>
</DIV5>`,
);

const NEW = wrap(
  "July 1, 2024",
  `<DIV5 N="1" NODE="1:1.0.1.1.1" TYPE="PART">
<HEAD>PART 1—DEFINITIONS</HEAD>
<DIV8 N="§ 1.1" NODE="1:1.0.1.1.1.0.1.1" TYPE="SECTION"><HEAD>§ 1.1   Definitions.</HEAD><P>As used in this chapter, agency means each authority of the United States.</P></DIV8>
<DIV8 N="§ 1.2" NODE="1:1.0.1.1.1.0.1.2" TYPE="SECTION"><HEAD>§ 1.2   Scope.</HEAD><P>(a) This part applies to every agency and to the Administrative Committee.</P><P>(b) It does not apply to the courts.</P></DIV8>
<DIV8 N="§ 1.5" NODE="1:1.0.1.1.1.0.1.5" TYPE="SECTION"><HEAD>§ 1.5   Filing.</HEAD><P>Filing means making a document available for public inspection at the Office of the Federal Register during official hours.</P></DIV8>
<DIV8 N="§ 1.6" NODE="1:1.0.1.1.1.0.1.6" TYPE="SECTION"><HEAD>§ 1.6   Electronic filing.</HEAD><P>A document may be filed electronically through the portal.</P></DIV8>
</DIV5>
<DIV5 N="2" NODE="1:1.0.1.1.2" TYPE="PART">
<HEAD>PART 2—GENERAL INFORMATION</HEAD>
<DIV8 N="§ 2.7" NODE="1:1.0.1.1.2.0.1.7" TYPE="SECTION"><HEAD>§ 2.7   Availability of the daily issue.</HEAD><P>The Office publishes the daily issue and makes it available online without charge to any person.</P></DIV8>
</DIV5>`,
);

describe("C.6 align", () => {
  it("matches by node, then id, then title, then text, and reports the rest as added or removed", () => {
    const r = alignEcfr(OLD, NEW, 1, { old: "2024-01-01", new: "2024-07-01" });
    expect(r.old.sections).toBe(5);
    expect(r.new.sections).toBe(5);
    const by = (id: string) => r.changes.find((c) => c.id === id || c.old_id === id);
    // § 1.1 unchanged by node: not listed among changes, but counted.
    expect(r.summary.unchanged).toBeGreaterThanOrEqual(1);
    expect(by("CFR:1-1.1")).toBeUndefined();
    // § 1.2: same node, new text.
    expect(by("CFR:1-1.2")).toMatchObject({ kind: "changed" });
    expect(by("CFR:1-1.2")?.diff?.added.join(" ")).toContain("Administrative Committee");
    expect(by("CFR:1-1.2")?.similarity).toBeGreaterThan(0.6);
    // § 1.3 -> § 1.5: new node and id, same title.
    expect(by("CFR:1-1.3")).toMatchObject({ kind: "renumbered", old_id: "CFR:1-1.3", new_id: "CFR:1-1.5" });
    // § 2.1 -> § 2.7: new title, same text.
    expect(by("CFR:1-2.1")).toMatchObject({ kind: "moved", old_id: "CFR:1-2.1", new_id: "CFR:1-2.7" });
    // § 1.4 gone, § 1.6 new.
    expect(by("CFR:1-1.4")).toMatchObject({ kind: "removed" });
    expect(by("CFR:1-1.6")).toMatchObject({ kind: "added" });
    expect(r.summary).toMatchObject({ changed: 1, renumbered: 1, moved: 1, added: 1, removed: 1 });
  });
});
