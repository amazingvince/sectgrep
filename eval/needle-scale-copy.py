"""Copy a prepared scale corpus to a fresh filesystem location without derived indexes."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path)
parser.add_argument("destination", type=Path)
args = parser.parse_args()
source, destination = args.source.resolve(), args.destination.resolve()
if destination.exists() or source == destination or source in destination.parents:
    raise ValueError("destination must be new and outside the source corpus")
preparation = json.loads((source / ".work/scale-preparation.json").read_text(encoding="utf8"))
if preparation["purpose"] != "real native-XML scale diagnostic; no relevance labels":
    raise ValueError("requires a prepared scale diagnostic corpus")
shutil.copytree(source, destination, ignore=lambda path, names: [".sect"] if Path(path) == source else [])
for row in preparation["sources"]:
    with (destination / f"cfr-title-{row['title']}/raw.xml").open("rb") as handle:
        if hashlib.file_digest(handle, "sha256").hexdigest() != row["raw_sha256"]:
            raise ValueError("copied raw source hash differs")
print(json.dumps({"source": str(source), "destination": str(destination), "raw_hashes_verified": True}))
