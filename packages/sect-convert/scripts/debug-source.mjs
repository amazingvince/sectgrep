// Print the source tokens the round-trip sees for given corpus files, beside the body tokens.
// usage: node scripts/debug-source.mjs <corpus root> <raw root> <file rel> [...]
import { buildContext, bodyBelowHeading } from "../dist/validators/index.js";
import { tokens } from "../dist/validators/text.js";
const [root, rawRoot, ...files] = process.argv.slice(2);
const cx = buildContext({ staging: root, rawRoot, skipIndex: true });
for (const rel of files) {
  const doc = cx.staging.docs.find((d) => d.rel === rel);
  if (!doc) { console.log("no such doc", rel); continue; }
  const src = cx.sourceOf(doc).text;
  console.log(`${rel}:`);
  console.log("  body  :", tokens(bodyBelowHeading(doc.body)).join(" ").slice(0, 500));
  console.log("  source:", (src ? src.tokens.join(" ") : "(none)").slice(0, 500));
}
