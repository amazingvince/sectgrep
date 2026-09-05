import {readFileSync,writeFileSync,existsSync} from "node:fs";
const lock=JSON.parse(readFileSync("eval/corpora/creation.lock.json","utf8"));
const manifest={schema_version:1,name:"Corpus creation pilot",root:"../..",run:"review/corpus-creation/pilot-v1",corpus:"corpora/corpus-creation-pilot-v1",campaign:"review/corpus-creation",seed:"sect-public-corpus-creation-2026-09-04-v1",enrichment:"off",discover_profiles:true,extraction_sample:{lending:30,ml:15,biomedical:15},sect_bin:"target/debug/sect.exe",sources:lock.sources.map(s=>({id:s.id.replaceAll(".","-"),source:s.domain==="lending"?"lending":"research",input:s.file,sha256:s.sha256,effective:s.effective,profile:`profiles/${s.domain==="lending"?"lending":"research"}.json`,domain:s.domain,...(s.discipline?{discipline:s.discipline}:{}),license:s.license,url:s.url}))};
const file="eval/corpora/creation.manifest.json";
if(existsSync(file))throw new Error("manifest already exists; edit intentionally instead of replacing");
writeFileSync(file,JSON.stringify(manifest,null,2)+"\n");console.log(`${manifest.sources.length} sources prepared; paid calls disabled for the initial integration check`);
