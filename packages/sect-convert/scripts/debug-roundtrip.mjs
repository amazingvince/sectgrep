// Print, for given corpus files, the body tokens missing from their source and the matched span.
// usage: node scripts/debug-roundtrip.mjs <corpus root> <raw root> <file rel> [...]
import path from "node:path";
import { buildContext, bodyBelowHeading } from "../dist/validators/index.js";
import { spanMatch, tokens } from "../dist/validators/text.js";
const [root, rawRoot, ...files] = process.argv.slice(2);
const cx = buildContext({ staging: root, rawRoot, skipIndex: true });
for (const rel of files) {
  const doc = cx.staging.docs.find((d) => d.rel === rel);
  if (!doc) { console.log("no such doc", rel); continue; }
  const body = tokens(bodyBelowHeading(doc.body));
  const src = cx.sourceOf(doc).text;
  if (!src) { console.log(rel, "no source"); continue; }
  const s = spanMatch(body, src.tokens);
  const have = new Set(src.tokens);
  console.log(`${rel}: score ${s.score.toFixed(3)} lcs ${s.lcs}/${body.length} span ${s.end - s.start + 1}`);
  console.log("  missing:", body.filter((t) => !have.has(t)).join(" "));
  console.log("  span   :", src.tokens.slice(s.start, s.end + 1).join(" ").slice(0, 400));
  console.log("  body   :", body.join(" ").slice(0, 400));
}
