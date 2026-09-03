// Paragraph anchors of a section body, the same rule `sect` applies (crates/sect-corpus
// document.rs): a line opening with `(a)`, `(1)`, `(i)` nests letter > number > roman; a run
// `(b)(2)(i)` opens every level on one line; `(i)`, `(v)`, `(x)` are numerals inside a numbered
// paragraph unless the next marker continues the alphabet, or the enclosing letter is the one
// they would follow. The converter uses it to drop anchors a target section does not have.

const ROMAN = new Set(["ii", "iii", "iv", "vi", "vii", "viii", "ix"]);
const RUN = /^((?:\((?:[a-z]{1,4}|\d{1,2})\))+)\s/;
const ONE = /\(([a-z]{1,4}|\d{1,2})\)/g;

function ambiguousIsRoman(lab: string, lvl1: string | null, following: string | null): boolean {
  if ((lab === "i" && following === "ii") || (lab === "v" && following === "vi") || (lab === "x" && following === "xi")) return true;
  if ((lab === "i" && following === "j") || (lab === "v" && following === "w") || (lab === "x" && following === "y")) return false;
  const preceding = lab === "i" ? "h" : lab === "v" ? "u" : "w";
  return lvl1 !== preceding;
}

export function paragraphAnchors(body: string): Array<{ anchor: string; line: number }> {
  const runs: Array<{ line: number; labels: string[] }> = [];
  body.split("\n").forEach((raw, i) => {
    const m = RUN.exec(raw.trim());
    if (m) runs.push({ line: i + 1, labels: Array.from(m[1].matchAll(ONE)).map((x) => x[1]) });
  });
  const out: Array<{ anchor: string; line: number }> = [];
  let lvl1: string | null = null;
  let lvl2: string | null = null;
  runs.forEach((run, r) => {
    const nextFirst = runs[r + 1]?.labels[0] ?? null;
    run.labels.forEach((lab, j) => {
      const following = j + 1 < run.labels.length ? run.labels[j + 1] : nextFirst;
      const isDigits = /^\d+$/.test(lab);
      const isRoman = lvl2 !== null && (ROMAN.has(lab) || (["i", "v", "x"].includes(lab) && ambiguousIsRoman(lab, lvl1, following)));
      let anchor: string;
      if (isDigits) {
        anchor = lvl1 ? `${lvl1}-${lab}` : lab;
        lvl2 = lab;
      } else if (isRoman) {
        anchor = `${lvl1 ?? ""}-${lvl2}-${lab}`;
      } else {
        lvl1 = lab;
        lvl2 = null;
        anchor = lab;
      }
      out.push({ anchor, line: run.line });
    });
  });
  return out;
}
