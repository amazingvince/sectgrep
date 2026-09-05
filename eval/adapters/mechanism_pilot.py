"""Exercise pinned LangExtract grounding and Docling Graph template machinery.

Uses fixed source excerpts and explicit negative controls. No human labels, no
model calls, and no framework-generated Python execution. This tests adapter
mechanisms, not end-to-end semantic extraction accuracy.
"""
import argparse
import ast
import dataclasses
import hashlib
import importlib.metadata as metadata
import json
from pathlib import Path
import time

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("document", type=Path)
    p.add_argument("profile", type=Path)
    p.add_argument("output", type=Path)
    a = p.parse_args()
    pins = {"langextract":"1.6.0", "docling-graph":"1.9.1"}
    if any(metadata.version(k) != v for k,v in pins.items()): raise ValueError("package pin mismatch")
    from langextract.core.data import Extraction
    from langextract.resolver import Resolver
    from docling_graph.templategen.spec import TemplateSpec
    from docling_graph.templategen.renderer import render_template
    document = json.loads(a.document.read_text(encoding="utf-8"))
    document = document.get("document", document)
    profile = json.loads(a.profile.read_text(encoding="utf-8"))
    samples = [r for r in document["regions"] if len(r["text"]) >= 80 and not r.get("exclusion")][:20]
    started = time.perf_counter()
    rows = []
    for region in samples:
        quote = region["text"][:150]
        for label,text in [("exact",quote),("negative_control",quote+" THIS_SENTENCE_IS_NOT_IN_THE_SOURCE")]:
            aligned = list(Resolver().align([Extraction(extraction_class="evidence",extraction_text=text)],region["text"],token_offset=0,char_offset=0,enable_fuzzy_alignment=False,accept_match_lesser=False))
            item = aligned[0] if aligned else None
            interval = item.char_interval if item else None
            # Independent contract validation remains authoritative even if token alignment succeeds.
            exact = bool(interval and region["text"][interval.start_pos:interval.end_pos] == text)
            rows.append({"region":region["id"],"case":label,"aligned":bool(interval),"exact_source_slice":exact,"interval":dataclasses.asdict(interval) if interval else None})
    spec = TemplateSpec.model_validate({"root":"CorpusRecords","module_docstring":"Source-grounded concepts for "+profile["name"],"models":[
        {"name":"CorpusRecords","kind":"root","docstring":"One document's scoped concept records.","identity_fields":["document"],"fields":[{"name":"document","type":"str","role":"identity","description":"Copy the supplied document identifier."},{"name":"concepts","type":"Concept","is_list":True,"role":"edge","edge_label":"MENTIONS","description":"Concepts explicitly grounded in this document."}]},
        {"name":"Concept","kind":"entity","docstring":"A scoped source concept, not a label-only identity.","identity_fields":["id"],"canonical_home":"CorpusRecords.concepts","fields":[{"name":"id","type":"str","role":"identity","description":"Copy the source-scoped concept identifier."},{"name":"label","type":"str","description":"Copy the exact source label.","examples":[samples[0]["text"][:80]] if samples else []},{"name":"scope","type":"str","description":"Copy the supplied document scope."},{"name":"evidence","type":"str","description":"Copy a verbatim supporting source span."}]}]})
    code = render_template(spec)
    ast.parse(code)  # Never exec generated Python to validate a profile.
    a.output.mkdir(parents=True, exist_ok=True)
    (a.output/"template.py").write_text(code,encoding="utf-8")
    (a.output/"template-spec.json").write_text(spec.model_dump_json(indent=2),encoding="utf-8")
    result = {"packages":pins,"purpose":"mechanism comparison, not semantic/human qualification","document_sha256":hashlib.sha256(a.document.read_bytes()).hexdigest(),"profile_sha256":hashlib.sha256(a.profile.read_bytes()).hexdigest(),"rows":rows,"template_sha256":hashlib.sha256(code.encode()).hexdigest(),"template_syntax_valid":True,"elapsed_seconds":time.perf_counter()-started,"hosted_cost_usd":0}
    (a.output/"result.json").write_text(json.dumps(result,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"exact_matches":sum(r["exact_source_slice"] for r in rows if r["case"]=="exact"),"negative_controls_rejected":sum(not r["exact_source_slice"] for r in rows if r["case"]=="negative_control"),"samples":len(samples),"template_syntax_valid":True}))

if __name__ == "__main__": main()
