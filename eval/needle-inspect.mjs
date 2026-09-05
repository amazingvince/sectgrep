// Start the opt-in source/section/passage inspector on an immutable diagnostic generation.
import {readFileSync,writeFileSync,readdirSync,mkdirSync} from "node:fs";
import path from "node:path";
import {startReviewServer} from "../packages/sect-harness/dist/pipeline/server.js";

const corpus=path.resolve(process.argv[2]??"corpora/needle-retrieval-v5");
const run=path.resolve("review/needle-retrieval/inspector");
const generation=readdirSync(path.join(corpus,".sect/published")).filter(n=>n.endsWith(".ready")).sort().at(-1)?.slice(0,-6);
if(!generation)throw new Error("index the diagnostic corpus first");
const queries=JSON.parse(readFileSync("eval/results/chunk-search-examples-2026-09-05.json","utf8")).map(x=>x.query);
queries.push("sample-79 calibration pressure", "quasar temperature retention provisional calibration", "nova-079 provisional temperature");
mkdirSync(run,{recursive:true});
writeFileSync(path.join(run,"retrieval.json"),JSON.stringify({purpose:"diagnostic",corpus,generation,sect_bin:path.resolve(process.platform==="win32"?"target/release/sect.exe":"target/release/sect"),before:path.resolve("eval/results/chunk-search-examples-2026-09-05.json"),queries},null,2));
const {url}=await startReviewServer(run,Number(process.argv[3]??4179));
writeFileSync(path.join(run,"session-url.txt"),url);
console.log(url);
