import {createRequire} from "node:module";
import {mkdirSync,existsSync,writeFileSync,readFileSync} from "node:fs";
import path from "node:path";
import {extract} from "../packages/sect-convert/dist/extract.js";
import {organizeDocument,reconcileIdentity} from "../packages/sect-convert/dist/document.js";
import {ingestFile} from "../packages/sect-convert/dist/ingest-file.js";
const require=createRequire(new URL("../packages/sect-convert/package.json",import.meta.url));

export async function addFixtures(out,work) {
  const dir="review/needle-retrieval/fixtures";mkdirSync(dir,{recursive:true});
  const docx=path.join(dir,"laboratory-archive.docx");
  if(!existsSync(docx)) {
    const {Document,Packer,Paragraph,HeadingLevel}=require("docx");
    const document=new Document({sections:[{children:[
      new Paragraph({text:"Laboratory archive",heading:HeadingLevel.HEADING_1}),
      new Paragraph({text:"Quasar temperature records",heading:HeadingLevel.HEADING_2}),
      new Paragraph("The Quasar archive retains temperature observations for seven years. Measurements use kelvin, and the calibration identifier must accompany each record."),
      new Paragraph("Exception: provisional observations remain excluded from the published data until an operator confirms calibration."),
      new Paragraph({text:"Access",heading:HeadingLevel.HEADING_2}),
      new Paragraph("Readers may inspect the original observations and their calibration history.")
    ]}]});writeFileSync(docx,await Packer.toBuffer(document));
  }
  const xlsx=path.join(dir,"observations.xlsx");
  if(!existsSync(xlsx)){const XLSX=require("xlsx");const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([["Sample","Pressure (kPa)","Condition"],...Array.from({length:80},(_,i)=>[`sample-${i}`,i+100,i===79?"calibration required":"confirmed"])]),"Observations");XLSX.writeFile(book,xlsx);}
  const records=path.join(dir,"records.json");
  if(!existsSync(records))writeFileSync(records,JSON.stringify({observations:[{id:"aster-041",method:"spectroscopy",temperature_kelvin:283,status:"confirmed"},{id:"nova-079",method:"interferometry",temperature_kelvin:301,status:"provisional",condition:"exclude until calibration confirmed"}]},null,2)+"\n");
  const results=[];
  for(const input of [docx,xlsx,records]) {
    const id=path.basename(input,path.extname(input)),source="fixtures",effective="2026-09-05";
    const extracted=await extract({input,work});
    const elements=readFileSync(path.join(extracted.dir,"elements.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
    const raw=`assets/${extracted.report.doc_sha}${path.extname(input)}`;
    const identity=reconcileIdentity(organizeDocument({document:`DOC:${source}:${id}`,effective,raw,report:extracted.report,elements}));
    await ingestFile({input,work,out,source,id,effective,profile:"generic",prepared:{...extracted,document:identity.document}});
    writeFileSync(path.join(out,source,`${id}.identity.json`),JSON.stringify(identity.ledger,null,2)+"\n");
    results.push({document:identity.document.document,raw_sha256:extracted.report.doc_sha,format:extracted.report.format,synthetic:true,units:identity.document.units.length,regions:identity.document.regions.length});
  }
  return results;
}
