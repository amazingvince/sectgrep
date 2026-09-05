// Reproduce extraction/organization in an isolated evaluation corpus. No review labels or
// production publication are written. All inputs are pinned bytes from the earlier pilot.
import {readFileSync,writeFileSync,readdirSync,mkdirSync,existsSync,copyFileSync} from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {extract} from "../packages/sect-convert/dist/extract.js";
import {organizeDocument,reconcileIdentity} from "../packages/sect-convert/dist/document.js";
import {ingestFile} from "../packages/sect-convert/dist/ingest-file.js";
import {addFixtures} from "./needle-fixtures.mjs";

const origin="corpora/corpus-creation-pilot-v2";
const generation="01788581250937340100";
const snapshot=path.join(origin,".sect/generations",generation,"corpus");
const out=process.argv[2]??"corpora/needle-retrieval-v1";
const work="review/needle-retrieval/extraction";
mkdirSync("review/needle-retrieval",{recursive:true});
const docs=["lending","research"].flatMap(source=>readdirSync(path.join(snapshot,source)).filter(f=>f.endsWith(".document.json")&&!f.includes("@")).map(file=>({source,doc:JSON.parse(readFileSync(path.join(snapshot,source,file),"utf8"))})));
const wanted=new Set(["fha-handbook-u18","fannie-self-employed","attention-v7","arxiv-1601-06733v1"]);
for (const {doc} of docs.filter(x=>x.doc.format==="xml").slice(0,2)) wanted.add(doc.document.split(":").at(-1));
const results=[];
for (const {source,doc:before} of docs.filter(x=>wanted.has(x.doc.document.split(":").at(-1)))) {
  const id=before.document.split(":").at(-1);
  console.log(`Extracting ${id} from pinned ${before.raw_sha256}`);
  mkdirSync("review/needle-retrieval/inputs",{recursive:true});
  const input=path.join("review/needle-retrieval/inputs",id+path.extname(before.raw));
  if(!existsSync(input))copyFileSync(path.join(origin,before.raw),input);
  if(createHash("sha256").update(readFileSync(input)).digest("hex")!==before.raw_sha256) throw new Error("input changed");
  const extracted=await extract({input,work});
  const elements=readFileSync(path.join(extracted.dir,"elements.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
  const organized=organizeDocument({document:before.document,effective:before.effective,raw:before.raw,report:extracted.report,elements});
  const identity=reconcileIdentity(organized);
  if(identity.conflicts.length) throw new Error("unexpected identity conflicts in isolated first import");
  await ingestFile({input,work,out,source,id,effective:before.effective,profile:source==="lending"?"lending":"research",prepared:{...extracted,document:identity.document}});
  writeFileSync(path.join(out,source,`${id}.identity.json`),JSON.stringify(identity.ledger,null,2)+"\n");
  const stats=d=>({units:d.units.length,regions:d.regions.length,parented_units:d.units.filter(u=>u.parent).length,excluded:d.regions.filter(r=>r.exclusion).length,headings:d.regions.filter(r=>r.kind==="heading").length,unknown_heading_level:d.regions.filter(r=>r.kind==="heading"&&!r.heading_level&&!r.exclusion).length});
  const result={document:before.document,raw_sha256:before.raw_sha256,parser:identity.document.parser,before:stats(before),after:stats(identity.document),review_status:"unjudged"};
  results.push(result); console.log(JSON.stringify(result));
  writeFileSync(`review/needle-retrieval/${path.basename(out)}.organization.json`,JSON.stringify({origin,generation,out,documents:results},null,2)+"\n");
}
const fixtures=await addFixtures(out,work);
writeFileSync(`review/needle-retrieval/${path.basename(out)}.organization.json`,JSON.stringify({origin,generation,out,documents:results,fixtures},null,2)+"\n");
