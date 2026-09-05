"""Copy the six pinned original representations into an isolated matched-source baseline."""
import json
import shutil
from pathlib import Path

origin = Path("corpora/corpus-creation-pilot-v2/.sect/generations/01788581250937340100/corpus")
output = Path("corpora/needle-retrieval-baseline")
selected = {"fha-handbook-u18", "fannie-self-employed", "attention-v7", "arxiv-1601-06733v1", "pmc10538420", "pmc11093778"}
if output.exists():
    raise RuntimeError("baseline already exists; retain its immutable generation")
sources = []
for source in ["lending", "research"]:
    (output/source).mkdir(parents=True, exist_ok=True)
    shutil.copy2(origin/source/"_source.yaml", output/source/"_source.yaml")
    for name in sorted(selected):
        artifact = origin/source/f"{name}.document.json"
        if not artifact.exists():
            continue
        document = json.loads(artifact.read_text(encoding="utf8"))
        sources.append({"document": document["document"], "raw_sha256": document["raw_sha256"]})
        for file in (origin/source).glob(name+"*"):
            if file.is_dir():
                shutil.copytree(file, output/source/file.name)
            else:
                shutil.copy2(file, output/source/file.name)
        raw = output/document["raw"]
        raw.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(origin/document["raw"], raw)
(output/"baseline-sources.json").write_text(json.dumps(sources,indent=2)+"\n",encoding="utf8")
print(json.dumps({"corpus":str(output),"sources":sources},indent=2))
