"""Stack N copies of a converted corpus under renamed sources and ids, to measure the grep
prefilter near the spec's 200 MB auto threshold with real legal text rather than synthetic
repetition.

  python eval/scale_corpus.py --copies 10 --src corpora/ecfr --out corpora/scaled

Copy n of source `cfr-title-29` becomes `cfr-title-29-c<n>` with ids `CFR:29<nn>-...`, so every id
stays unique and every link still resolves inside its copy. Nothing in the output is real law.
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--copies", type=int, default=10)
    ap.add_argument("--src", default="corpora/ecfr")
    ap.add_argument("--out", default="corpora/scaled")
    a = ap.parse_args()
    src, out = Path(a.src), Path(a.out)
    sources = sorted(p for p in src.iterdir() if p.is_dir() and (p / "_source.yaml").exists())
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    files = 0
    for n in range(1, a.copies + 1):
        for s in sources:
            title = s.name.split("-")[-1]
            new_name = f"{s.name}-c{n}"
            old_prefix, new_prefix = f"CFR:{title}-", f"CFR:{title}{n:02d}-"
            for p in s.rglob("*"):
                rel = p.relative_to(s)
                dst = out / new_name / rel
                if p.is_dir():
                    dst.mkdir(parents=True, exist_ok=True)
                    continue
                if p.name == ".sect" or ".sect" in p.parts:
                    continue
                text = p.read_text(encoding="utf-8")
                # Section ids carry the prefix; the title's root id is the bare `CFR:<title>`.
                text = text.replace(s.name, new_name).replace(old_prefix, new_prefix)
                text = re.sub(rf"CFR:{title}(?![0-9-])", f"CFR:{title}{n:02d}", text)
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.write_text(text, encoding="utf-8", newline="\n")
                files += 1
    print(f"wrote {files} files ({a.copies} copies of {len(sources)} sources) under {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
