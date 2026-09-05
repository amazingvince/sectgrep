"""Record metadata-preserving edits and explicit full-rebuild recovery on an owned fixture."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--binary", type=Path, required=True)
parser.add_argument("--corpus", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
binary, corpus = args.binary.resolve(), args.corpus.resolve()
if corpus.exists() or args.output.exists():
    raise ValueError("preserve previous corpus and result; choose new paths")
shutil.copytree(Path("fixtures/corpus"), corpus, ignore=shutil.ignore_patterns(".sect"))
marker = corpus / "metadata-probe.txt"
alpha = b"NEEDLE_METADATA_ALPHA_20260905\n"
bravo = alpha.replace(b"ALPHA", b"BRAVO")
marker.write_bytes(alpha)

def command(*arguments):
    completed = subprocess.run([str(binary), "--corpus", str(corpus), *arguments, "--json"],
                               capture_output=True, encoding="utf8", check=True)
    return json.loads(completed.stdout)

command("index", "--embedding", "none", "--ngram", "on")
before = command("grep", "NEEDLE_METADATA_", "--glob", marker.name)
stamp = marker.stat()
marker.write_bytes(bravo)
os.utime(marker, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
assert marker.stat().st_size == stamp.st_size and marker.stat().st_mtime_ns == stamp.st_mtime_ns
after = command("grep", "NEEDLE_METADATA_", "--glob", marker.name)
command("index", "--full")
recovered = command("grep", "NEEDLE_METADATA_", "--glob", marker.name)
assert recovered["result"]["lines"][0]["text"].rstrip() == bravo.decode().rstrip()
report = {
    "purpose": "freshness limitation and recovery diagnostic, not relevance qualification",
    "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "corpus": str(corpus),
    "metadata_restored": True, "before": before, "after_same_stat_edit": after,
    "after_full_rebuild": recovered,
    "default_detected_content_edit": after["result"]["lines"][0]["text"].rstrip() == bravo.decode().rstrip(),
    "full_rebuild_recovered": True,
}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
print(json.dumps({key: report[key] for key in ["default_detected_content_edit", "full_rebuild_recovered"]}))
