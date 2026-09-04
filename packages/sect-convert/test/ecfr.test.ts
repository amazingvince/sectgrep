import { describe, expect, it } from "vitest";
import { convertEcfr, parseAmdDate, titleCase } from "../src/ecfr.js";

const XML = `<?xml version="1.0" encoding="UTF-8" ?>
<DLPSTEXTCLASS><TEXT><BODY><ECFRBRWS>
<AMDDATE>Dec. 29, 2022(fm)
</AMDDATE>
<DIV1 N="1" NODE="1:1" TYPE="TITLE">
<HEAD>Title 1—General Provisions--Volume 1</HEAD>
<DIV3 N="I" NODE="1:1.0.1" TYPE="CHAPTER">
<HEAD> CHAPTER I—ADMINISTRATIVE COMMITTEE OF THE FEDERAL REGISTER</HEAD>
<DIV4 N="A" NODE="1:1.0.1.1" TYPE="SUBCHAP">
<HEAD>SUBCHAPTER A—GENERAL</HEAD>
<DIV5 N="1" NODE="1:1.0.1.1.1" TYPE="PART">
<HEAD>PART 1—DEFINITIONS</HEAD>
<AUTH><HED>Authority:</HED><PSPACE>44 U.S.C. 1506; sec. 6, E.O. 10530.</PSPACE></AUTH>
<SOURCE><HED>Source:</HED><PSPACE>37 FR 23603, Nov. 4, 1972, unless otherwise noted.</PSPACE></SOURCE>
<DIV8 N="§ 1.1" NODE="1:1.0.1.1.1.0.1.1" TYPE="SECTION">
<HEAD>§ 1.1   Definitions.</HEAD>
<P>As used in this chapter, unless the context requires otherwise—
</P>
<P><I>Agency</I> means each authority of the United States; see § 1.2 and part 2 of this chapter.
</P>
<P><I>Filing</I> means making a document available; see §§ 1.2 and 1.3.
</P>
<P>Compare §§ 2.1 and 2.1 for the same number twice.
</P>
<CITA TYPE="N">[37 FR 23603, Nov. 4, 1972]</CITA>
</DIV8>
<DIV8 N="§ 1.2" NODE="1:1.0.1.1.1.0.1.2" TYPE="SECTION">
<HEAD>§ 1.2   Scope.</HEAD>
<P>(a) This part applies to <E T="04">every</E> agency.
</P>
<P>(b) It does not apply to § 9.9, which does not exist.
</P>
</DIV8>
</DIV5>
<DIV5 N="2" NODE="1:1.0.1.1.2" TYPE="PART">
<HEAD>PART 2—GENERAL INFORMATION</HEAD>
<DIV8 N="§ 2.1" NODE="1:1.0.1.1.2.0.1.1" TYPE="SECTION">
<HEAD>§ 2.1   Scope.</HEAD>
<P>Text.</P>
</DIV8>
</DIV5>
</DIV4>
</DIV3>
</DIV1>
</ECFRBRWS></BODY></TEXT></DLPSTEXTCLASS>`;

describe("eCFR converter", () => {
  const r = convertEcfr(XML, { title: 1, rawPath: "raw/cfr-title-1/2026-09-01/ECFR-title1.xml", ingestRun: "test" });
  const file = (p: string) => r.files.find((f) => f.path === p)?.text ?? "";

  it("parses dates and title-cases heads", () => {
    expect(parseAmdDate("Dec. 29, 2022(fm)")).toBe("2022-12-29");
    expect(titleCase("ADMINISTRATIVE COMMITTEE OF THE FEDERAL REGISTER")).toBe("Administrative Committee of the Federal Register");
    expect(r.effective).toBe("2022-12-29");
    expect(r.titleName).toBe("General Provisions");
  });

  it("builds the hierarchy with derived ids and paths", () => {
    expect(r.sections).toBe(3);
    const paths = r.files.map((f) => f.path);
    expect(paths).toContain("cfr-title-1/1.md");
    expect(paths).toContain("cfr-title-1/I/1-I.md");
    expect(paths).toContain("cfr-title-1/I/A/1-I-A.md");
    expect(paths).toContain("cfr-title-1/I/A/1/1-1.md");
    expect(paths).toContain("cfr-title-1/I/A/1/1.1/1-1.1.md");
    expect(paths).toContain("cfr-title-1/_source.yaml");
    const s11 = file("cfr-title-1/I/A/1/1.1/1-1.1.md");
    expect(s11).toContain('id: "CFR:1-1.1"');
    expect(s11).toContain('parent: "CFR:1-1"');
    expect(s11).toContain('node: "1:1.0.1.1.1.0.1.1"');
    expect(s11).toContain("effective: 2022-12-29");
    expect(s11).toContain('authority: "44 U.S.C. 1506; sec. 6, E.O. 10530."');
    expect(s11).toContain('citation: "37 FR 23603, Nov. 4, 1972"');
    expect(file("cfr-title-1/I/A/1/1-1.md")).toContain("- [§ 1.1 Definitions](CFR:1-1.1)");
  });

  it("extracts definitions and links explicit references that exist", () => {
    const s11 = file("cfr-title-1/I/A/1/1.1/1-1.1.md");
    expect(s11).toContain('defines: ["Agency","Filing"]');
    expect(s11).toContain("*Agency* means each authority of the United States; see [§ 1.2](CFR:1-1.2) and [part 2](CFR:1-2) of this chapter.");
    expect(s11).toContain("[§§ 1.2](CFR:1-1.2) and [1.3](CFR:1-1.3)".replace("[1.3](CFR:1-1.3)", "1.3")); // 1.3 does not exist: left unlinked
    expect(s11).toContain("Compare [§§ 2.1](CFR:1-2.1) and [2.1](CFR:1-2.1) for the same number twice.");
    const s12 = file("cfr-title-1/I/A/1/1.2/1-1.2.md");
    expect(s12).toContain("(a) This part applies to **every** agency.");
    expect(s12).toContain("§ 9.9, which does not exist");
    expect(s12).not.toContain("(CFR:1-9.9)");
  });

  it("writes a context prefix of 40 to 110 words and full provenance", () => {
    for (const f of r.files.filter((f) => f.path.endsWith(".md"))) {
      const ctx = f.text.match(/^context: (.*)$/m)?.[1] ?? "";
      const words = JSON.parse(ctx).split(/\s+/).length;
      expect(words, f.path).toBeGreaterThanOrEqual(40);
      expect(words, f.path).toBeLessThanOrEqual(110);
      expect(f.text).toContain("legal_status: unofficial-xml");
      expect(f.text).toMatch(/raw_sha256: "[0-9a-f]{64}"/);
    }
  });
});

describe("per-section effective dates from the versioner (G-N2)", () => {
  it("dates each section from the versioner, bounded by the title date, and reports the spread", async () => {
    const { sectionDatesFrom } = await import("../src/versioner.js");
    const dates = sectionDatesFrom({ content_versions: [
      { identifier: "1.2", part: "1", date: "2010-05-05", type: "section" },
      { identifier: "1.2", part: "1", date: "2003-01-01", type: "section" },
      { identifier: "1.2", part: "1", date: "2030-01-01", type: "section", removed: true },
      { identifier: "2.1", part: "2", date: "2099-01-01", type: "section" },
      { identifier: "Appendix A to Part 1", part: "1", date: "2011-01-01", type: "appendix" },
    ] });
    expect(dates).toEqual({ "1.2": "2010-05-05", "2.1": "2099-01-01" });
    const r = convertEcfr(XML, { title: 1, rawPath: "raw/x.xml", sectionDates: dates, titleDate: "2024-01-01" });
    const eff = (name: string) => /^effective:\s*(\S+)/m.exec(r.files.find((f) => f.path.endsWith(name))!.text)![1];
    expect(eff("1-1.2.md")).toBe("2010-05-05");
    // No versioner date, and a date after the title date: the title date stands.
    expect(eff("1-1.1.md")).toBe(r.effective);
    expect(eff("1-2.1.md")).toBe(r.effective);
    expect(r.dates).toMatchObject({ dated: 1, missing: 1, late: 1 });
    // The part and the title above § 1.2 are in force from its date; part 2 keeps the title date.
    const nodeEff = (id: string) => /^effective:\s*(\S+)/m.exec(r.files.find((f) => new RegExp(`^id:\\s*"?${id.replace(/[.]/g, "\\.")}"?\\s*$`, "m").test(f.text))!.text)![1];
    expect(nodeEff("CFR:1-1")).toBe("2010-05-05");
    expect(nodeEff("CFR:1")).toBe("2010-05-05");
    expect(nodeEff("CFR:1-2")).toBe(r.effective);
    for (const f of r.files.filter((f) => /^level:\s*section/m.test(f.text))) expect(eff(f.path) <= "2024-01-01").toBe(true);
    expect(Object.values(r.dates.spread).reduce((a, b) => a + b, 0)).toBe(r.sections);
    // Without dates every section carries the title date, as before.
    expect(convertEcfr(XML, { title: 1, rawPath: "raw/x.xml" }).dates).toEqual({ dated: 0, missing: 0, late: 0, spread: { [r.effective.slice(0, 4)]: r.sections } });
  });
});
