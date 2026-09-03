// Small DOCX and XLSX inputs for the extraction run in eval/eval_c1.py: a policy memo with a
// heading, a definition, and a table; a load schedule with a footnote row.
// usage: node scripts/make-office-samples.mjs <out dir>
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow } from "docx";
import * as XLSX from "xlsx";

const out = process.argv[2];
mkdirSync(out, { recursive: true });
const cell = (t) => new TableCell({ children: [new Paragraph(t)] });
const doc = new Document({
  sections: [{
    children: [
      new Paragraph({ text: "Fall protection policy", heading: HeadingLevel.HEADING_1 }),
      new Paragraph("This policy applies to every walking-working surface covered by 29 CFR part 1910, subpart D. See § 1910.28(b)(1) for the general duty."),
      new Paragraph({ text: "Definitions", heading: HeadingLevel.HEADING_2 }),
      new Paragraph("Toeboard means a low protective barrier that is designed to prevent materials from falling to lower levels."),
      new Paragraph("Guardrail system means a barrier erected along an unprotected side or edge of a walking-working surface."),
      new Paragraph({ text: "Heights", heading: HeadingLevel.HEADING_2 }),
      new Table({ rows: [
        new TableRow({ children: [cell("Element"), cell("Height")] }),
        new TableRow({ children: [cell("Top rail"), cell("42 in")] }),
        new TableRow({ children: [cell("Midrail"), cell("21 in")] }),
        new TableRow({ children: [cell("Toeboard"), cell("3.5 in")] }),
      ] }),
    ],
  }],
});
writeFileSync(path.join(out, "fall-protection-policy.docx"), await Packer.toBuffer(doc));

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ["Occupancy", "Uniform load (psf)", "Concentrated load (lb)"],
  ["Office", 50, 2000],
  ["Corridor", 100, ""],
  ["Storage, light", 125, ""],
  ["* Values per ASCE 7-22 Table 4.3-1; applies to new construction only"],
]), "Loads");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Element", "Height (in)"], ["Top rail", 42], ["Midrail", 21]]), "Guardrails");
writeFileSync(path.join(out, "design-loads.xlsx"), XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
console.log(`${out}: fall-protection-policy.docx, design-loads.xlsx`);
