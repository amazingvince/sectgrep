# From a search passage to its original source

Implemented on 2026-09-05 as a continuation of the needle-retrieval plan. Search
passage addresses now work with `read`; native Word addresses and complete Docling
location groups survive the source contract. These changes improve navigation and
mechanical fidelity. They do not qualify broad extraction or retrieval accuracy.

## Passage reads

```powershell
sect --corpus PATH read 'EXPRESSION#pHASH' --json
```

Use the exact `chunk_id` returned by search. The response retains the normal
canonical section fields and adds a versioned `passage` object containing the
original passage body, recipe, source spans, supporting spans and complete
additional canonical sections when the passage merged several sections. Reading
one part of a long table or section returns its complete canonical body, including
its tail. Text rendering also shows the additional sections and support.

`--version` can select a particular member Expression within a merged passage.
An incompatible `--as-of` or version is rejected: a passage address identifies
fixed source revisions, and cannot silently become a different revision. Read the
canonical Work address when selecting another date. A passage absent from the
selected generation returns an explicit error; a reader already pinned to its old
generation continues to resolve it. Ordinary section and paragraph-anchor reads
keep their existing behavior and do not load the passage lookup merely to read.

## Native Word mapping

The converter still uses Mammoth for DOCX rendering. It now compares each eligible
converted block against original WordprocessingML paragraphs and simple tables in
`word/document.xml`, `word/footnotes.xml` and `word/endnotes.xml`. A unique text match
receives an `office` locator with the exact package member and positional XPath.
The XPath does not depend on the producer's XML namespace prefixes. Native paragraph
IDs are retained only when unique within their part.

This follows WordprocessingML's
[document/paragraph structure](https://learn.microsoft.com/en-us/office/open-xml/word/how-to-open-and-add-text-to-a-word-processing-document)
and [table/row/cell structure](https://learn.microsoft.com/en-us/office/open-xml/word/working-with-wordprocessingml-tables).
It does not infer a rendered page number from an Office paragraph.

Both the source block and converted text must match under the recorded whitespace
normalization. Repeated text, unsupported conversion results, tracked revisions,
fields, mathematics, drawings and merged/nested tables remain unresolved instead
of receiving a guessed address. This is conservative mapping, not a complete native
Office parser or a character-by-character normalization map. The six regions in the
existing laboratory Word fixture all resolve to original paragraphs. A separate
fixture exercises duplicate paragraphs and simple tables.

The review API can return the original Office XML part after checking the raw
document hash. The UI selects the addressed node and displays its serialized XML
as text. It does not execute source markup or claim to reproduce Word's page layout.

## Docling completion and multiple locations

Capture adapter version 2 records conversion status, input-page count and converted
pages. The harness accepts only successful complete captures covering every page;
it rejects partial captures even when their metadata claims completeness. The
15-page Attention paper was recaptured successfully with Docling 2.126.0 and OCR
disabled. Completion is not a text-fidelity approval.

Six regions in that capture have multiple source boxes: two author regions each
have four boxes on page 1; four paragraphs span pages 4/5, 6/7, 8/9 and 9/10. The
previous importer retained only the first box of each region. The new `pages`
locator retains their ordered union: 16 boxes for those six regions, including all
ten previously dropped boxes. Single-box regions retain their existing shape.

The importer validates each page, coordinate origin and box. Per-box character
alignment remains explicitly unverified. A whole region quote belongs to the
union of its boxes. The review UI offers a box selector and states this limitation;
the retrieval inspector accepts every page in a section's location groups.

## Numeric fidelity and index recipes

An independent comparison against the captured coordinates exposed decimal drift
in Rust JSON decoding, for example `230.69199999999998` becoming `230.692`.
The workspace enables serde_json's `float_roundtrip` decoding and tests exact
floating-point round trips. The audit keeps exact coordinate equality rather than
masking the mismatch with a tolerance.

New manifests record `source_codec: json-f64-roundtrip-v1`. A missing or different
codec makes freshness stale and invalidates derived parse caches on the next
index build. Raw source bytes and source identities stay intact. Old generations
remain readable with the explicit no-refresh path; rebuilding is necessary to
restore coordinates already rounded in their derived artifacts.

JSON ingestion also preserves each original numeric token. JavaScript's ordinary
`JSON.parse` converts `9007199254740993` to `9007199254740992`, which made exact
identifier lookup impossible after conversion. The converter now takes the source
token from the parser's reviver context, as specified by
[ECMAScript](https://tc39.es/ecma262/multipage/structured-data.html#sec-internalizejsonproperty),
and never converts that token back through a JavaScript number. Large integers,
decimal precision, exponents outside binary64 range and negative zero survive.
An end-to-end test ingests the original ID, indexes it with Rust and finds the
original spelling while rejecting the rounded spelling. Duplicate JSON object
keys and character-level mappings for escaped strings remain separate gaps.

## Inspect and verify

The isolated corpora are `corpora/needle-native-office-v1` and
`corpora/needle-docling-attention-v3`. They preserve the earlier experiment corpora.

```powershell
node eval/needle-navigation-inspect.mjs
python eval/needle-navigation-validation.py
```

The inspector prints a local URL. Choose the Attention item and switch from page
4 to page 5; choose the Word item to inspect the original paragraph XML. These are
diagnostic review items with no decisions or independent relevance labels.

The independent Python audit resolves the Word XPath against the ZIP's actual XML,
compares every grouped Docling box against the pinned capture, checks source hashes,
and compares passage expansion with canonical section reads. [All 12 inspected
regions and their 22 native locations pass](../eval/results/needle-navigation-2026-09-05.json).
Its default executable
is the local Linux validation build; dependencies and corpora must first be prepared.

Browser checks used Chrome at 1600×1000 and 390×844: both PDF pages rendered, Word
XML resolved, no horizontal mobile overflow, and no page errors or failed requests.
Screenshots were inspected. Rust regressions cover merged and split passage reads,
historical selection, obsolete passage addresses, typed native locators and codec
invalidation. The existing real-eCFR n-gram versus exhaustive-search property test
also passed; it is an exact-search correctness check, not a 100k latency qualification.
The final suites pass 69 Rust tests on Windows, 68 on Linux and 143 TypeScript tests;
strict workspace Clippy and package builds pass. Real-corpus qualification tests
were excluded from the final short rerun after the separate eCFR correctness run.

Remaining gaps include native handling of complex Office constructs, reversible
character normalization, source judgments for mathematical notation, spreadsheet
header discovery and complete relation/context evaluation across document families.
