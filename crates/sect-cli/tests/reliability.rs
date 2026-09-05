use sect_core::Refresh;
use sect_index::{build, check, index_dir, open, BuildOptions, Check};
use sect_query::{ReadOptions, RelationMode, SearchMode, SearchOptions};
use std::{fs, path::Path};

fn write(root: &Path, key: &str, parent: Option<&str>, title: &str, body: &str, defines: &str) {
    let id = format!("T:{key}");
    let parent = parent
        .map(|p| format!("T:{p}"))
        .unwrap_or_else(|| "null".into());
    fs::write(root.join("test").join(format!("{key}.md")), format!("---\nid: {id}\nsource: test\ntitle: {title}\nlevel: {}\nparent: {parent}\norder: 1\neffective: 2024-01-01\nsupersedes: null\nsuperseded_by: null\namended_by: []\noverrides: []\nnarrows: []\ndefines: [{defines}]\ncontext: {title} in test collection\nprovenance:\n  raw: test.xml\n  raw_sha256: {}\n  locator: {{xpath: '//P'}}\n  legal_status: derived\n  ingest_run: test\n  confidence: 1\n  verified_by: []\n---\n# {title}\n\n{body}\n", if parent == "null" { "title" } else { "section" }, "a".repeat(64))).unwrap();
}
fn corpus() -> tempfile::TempDir {
    let t = tempfile::tempdir().unwrap();
    fs::create_dir(t.path().join("test")).unwrap();
    fs::write(
        t.path().join("test/_source.yaml"),
        "name: test\nkind: base\nid_prefix: 'T:'\nprecedence: 0\nlegal_status: derived\n",
    )
    .unwrap();
    write(t.path(), "root", None, "Manual", "", "");
    write(
        t.path(),
        "a",
        Some("root"),
        "Eligibility",
        "A quasar borrower uses the ordinary process.",
        "",
    );
    write(
        t.path(),
        "b",
        Some("root"),
        "Exceptions",
        "An atypical circumstance requires additional evidence.",
        "",
    );
    t
}
fn options(full: bool) -> BuildOptions {
    BuildOptions {
        full,
        embedding: Some("none".into()),
        ngram: Some("on".into()),
        ..Default::default()
    }
}
fn indexed(root: &Path) {
    let r = build(root, &options(false)).unwrap();
    assert_eq!(r.errors(), 0, "{:?}", r.issues);
}

fn organized_fixture(root: &Path, alpha: &str, beta: &str) {
    use sha2::{Digest, Sha256};
    let hash = |s: &str| format!("{:x}", Sha256::digest(s.as_bytes()));
    let texts = ["Manual", alpha, beta];
    let raw = texts.join("\n\n");
    fs::write(root.join("test.xml"), &raw).unwrap();
    let regions:Vec<_>=texts.iter().enumerate().map(|(i,text)|serde_json::json!({
        "id":format!("r{i}"),"native_id":null,"kind":if i==0{"heading"}else{"paragraph"},"text":text,
        "locator":{"type":"text","line_start":i*2+1,"line_end":i*2+1},"order":i,
        "parent":if i==0{None}else{Some("r0")},"heading_level":if i==0{Some(1)}else{None},
        "cells":[],"caption_of":null,"footnote_of":[],"uncertainty":[],"exclusion":null
    })).collect();
    let units:Vec<_>=["T:root","T:a","T:b"].iter().enumerate().map(|(i,id)|serde_json::json!({
        "id":id,"title":texts[i],"parent":if i==0{None}else{Some("T:root")},"regions":[format!("r{i}")],"native_id":null,"content_sha256":hash(texts[i])
    })).collect();
    let artifact = serde_json::json!({"schema_version":1,"document":"T:document","effective":"2024-01-01","raw":"test.xml","raw_sha256":hash(&raw),"format":"xml","parser":"synthetic-test","regions":regions,"units":units,"derivations":[]});
    fs::write(
        root.join("test/test.document.json"),
        serde_json::to_vec(&artifact).unwrap(),
    )
    .unwrap();
}

#[test]
fn document_store_preserves_exact_search_pins_and_ignores_exports() {
    use sha2::{Digest, Sha256};
    let t = corpus();
    let a = "A quasar borrower uses the ordinary process.";
    let b = "An atypical circumstance requires additional evidence.";
    organized_fixture(t.path(), a, b);
    let artifact_path = "test/test.document.json";
    let artifact = fs::read(t.path().join(artifact_path)).unwrap();
    let native: serde_json::Value = serde_json::from_slice(&artifact).unwrap();
    let native_hash = native["raw_sha256"].as_str().unwrap();
    let mut sections = std::collections::BTreeMap::new();
    for key in ["root", "a", "b"] {
        let rel = format!("test/{key}.md");
        let text = fs::read_to_string(t.path().join(&rel))
            .unwrap()
            .replace(&"a".repeat(64), native_hash);
        fs::write(t.path().join(&rel), &text).unwrap();
        sections.insert(rel, text);
    }
    indexed(t.path());
    let markdown = open(t.path(), Refresh::No).unwrap();
    let original_chunks = serde_json::to_value(markdown.chunks().unwrap().as_ref()).unwrap();
    let bundle_path = t.path().join("test/manual.sections.json");
    let mut bundle = sect_core::sections::SectionBundle {
        schema_version: 1,
        recipe: sect_core::sections::SECTION_RECIPE.into(),
        document: "T:document".into(),
        artifacts: [(
            artifact_path.to_string(),
            format!("{:x}", Sha256::digest(&artifact)),
        )]
        .into_iter()
        .collect(),
        sections,
    };
    fs::write(&bundle_path, serde_json::to_vec(&bundle).unwrap()).unwrap();
    let registry = t.path().join("test/_source.yaml");
    fs::write(
        &registry,
        fs::read_to_string(&registry).unwrap() + "input_mode: document\n",
    )
    .unwrap();
    indexed(t.path());
    let packed = open(t.path(), Refresh::No).unwrap();
    assert_eq!(packed.manifest.files, 3);
    assert_eq!(
        serde_json::to_value(packed.chunks().unwrap().as_ref()).unwrap(),
        original_chunks
    );
    assert!(!packed.snapshot_root().join("test/a.md").exists());
    assert_eq!(
        packed.read_text("test/a.md").unwrap(),
        markdown.read_text("test/a.md").unwrap()
    );
    for pattern in [
        "quasar",
        "atypical",
        "ordinary|additional",
        "(?i)BORROWER",
        "^#",
        "[q-z]+",
    ] {
        let opts = sect_exact::GrepOptions {
            patterns: vec![pattern.into()],
            globs: vec!["*.md".into()],
            before: 1,
            after: 1,
            ..Default::default()
        };
        let plain = sect_query::grep(&markdown, &opts, true, None, Some("test"), true).unwrap();
        for no_index in [true, false] {
            let actual =
                sect_query::grep(&packed, &opts, true, None, Some("test"), no_index).unwrap();
            assert_eq!(
                serde_json::to_value(&actual.result.lines).unwrap(),
                serde_json::to_value(&plain.result.lines).unwrap(),
                "pattern {pattern}, no_index {no_index}"
            );
            assert_eq!(actual.result.total_matches, plain.result.total_matches);
        }
    }
    let bounded = sect_exact::GrepOptions {
        patterns: vec!["the|The".into()],
        max_hits: 1,
        globs: vec!["*.md".into()],
        ..Default::default()
    };
    assert_eq!(
        serde_json::to_value(packed.grep(&bounded).unwrap()).unwrap(),
        serde_json::to_value(markdown.grep(&bounded).unwrap()).unwrap()
    );
    fs::create_dir_all(t.path().join("test/exports/deep")).unwrap();
    fs::write(t.path().join("test/exports/deep/fake.md"), "quasar garbage").unwrap();
    fs::write(t.path().join("test/a.md"), "ignored obsolete export").unwrap();
    assert!(matches!(
        check(t.path()).unwrap().check,
        Check::Fresh { .. }
    ));
    assert_eq!(
        build(
            t.path(),
            &BuildOptions {
                embedding: Some("none".into()),
                ..Default::default()
            }
        )
        .unwrap()
        .mode,
        "noop"
    );
    let key = "test/a.md";
    bundle.sections.insert(
        key.into(),
        bundle.sections[key].replace("title: Eligibility", "title: Revised eligibility"),
    );
    fs::write(&bundle_path, serde_json::to_vec(&bundle).unwrap()).unwrap();
    assert!(matches!(
        check(t.path()).unwrap().check,
        Check::Stale { .. }
    ));
    indexed(t.path());
    let updated = open(t.path(), Refresh::No).unwrap();
    assert!(updated
        .read_text(key)
        .unwrap()
        .contains("title: Revised eligibility"));
    assert!(packed
        .read_text(key)
        .unwrap()
        .contains("title: Eligibility"));
    let before_failure = index_dir(t.path());
    bundle
        .artifacts
        .insert(artifact_path.into(), "0".repeat(64));
    fs::write(&bundle_path, serde_json::to_vec(&bundle).unwrap()).unwrap();
    assert!(build(t.path(), &options(false))
        .unwrap_err()
        .to_string()
        .contains("hash mismatch"));
    assert_eq!(index_dir(t.path()), before_failure);
}

#[test]
fn source_codec_upgrade_rebuilds_derivatives_and_keeps_pinned_text() {
    let t = corpus();
    indexed(t.path());
    let old = open(t.path(), Refresh::No).unwrap();
    let old_dir = index_dir(t.path());
    let original = fs::read(t.path().join("test/a.md")).unwrap();
    let manifest_file = old_dir.join("manifest.json");
    let mut previous: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_file).unwrap()).unwrap();
    previous.as_object_mut().unwrap().remove("source_codec");
    fs::write(&manifest_file, serde_json::to_vec(&previous).unwrap()).unwrap();
    assert!(matches!(
        check(t.path()).unwrap().check,
        Check::Stale { .. }
    ));
    assert!(sect_query::read(&old, "T:a", &ReadOptions::default())
        .unwrap()
        .result
        .body
        .contains("quasar"));
    build(t.path(), &options(false)).unwrap();
    assert_ne!(index_dir(t.path()), old_dir);
    assert_eq!(fs::read(t.path().join("test/a.md")).unwrap(), original);
    assert_eq!(
        open(t.path(), Refresh::No).unwrap().manifest.source_codec,
        sect_index::regions::SOURCE_CODEC
    );
    assert!(matches!(
        check(t.path()).unwrap().check,
        Check::Fresh { .. }
    ));
    // Recipe changes also publish when there are no sections to miss the parse cache.
    let empty = tempfile::tempdir().unwrap();
    fs::create_dir(empty.path().join("test")).unwrap();
    fs::copy(
        t.path().join("test/_source.yaml"),
        empty.path().join("test/_source.yaml"),
    )
    .unwrap();
    indexed(empty.path());
    for field in ["source_codec", "graph_codec", "passage_recipe"] {
        let empty_manifest = index_dir(empty.path()).join("manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&empty_manifest).unwrap()).unwrap();
        manifest.as_object_mut().unwrap().remove(field);
        fs::write(empty_manifest, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(matches!(
            check(empty.path()).unwrap().check,
            Check::Stale { .. }
        ));
        assert_ne!(build(empty.path(), &options(false)).unwrap().mode, "noop");
        assert!(matches!(
            check(empty.path()).unwrap().check,
            Check::Fresh { .. }
        ));
    }
}

#[test]
fn shared_term_usages_preserve_legacy_views_and_reject_missing_lists() {
    let t = corpus();
    write(
        t.path(),
        "a",
        Some("root"),
        "Alpha definition",
        "*Quasar* means a bright source.",
        "Quasar",
    );
    write(
        t.path(),
        "b",
        Some("root"),
        "Beta definition",
        "*Quasar* means a distant source.",
        "Quasar",
    );
    write(
        t.path(),
        "c",
        Some("root"),
        "Observation",
        "A quasar was observed.",
        "",
    );
    indexed(t.path());
    let index = open(t.path(), Refresh::No).unwrap();
    let terms = serde_json::to_value(&index.graph.terms).unwrap();
    assert_eq!(terms.as_object().unwrap().len(), 2);
    for term in terms.as_object().unwrap().values() {
        let usages = term["usages"].as_array().unwrap();
        assert_eq!(usages.len(), 2);
        assert!(usages.iter().all(|usage| usage["id"] != term["id"]));
        assert!(usages.iter().any(|usage| usage["id"] == "T:c"));
    }
    let pool: serde_json::Value =
        serde_json::from_slice(&fs::read(index.dir().join("term-usages.json")).unwrap()).unwrap();
    assert_eq!(
        pool.as_object().unwrap().len(),
        1,
        "one mention list serves both definitions"
    );

    let legacy = tempfile::tempdir().unwrap();
    index.graph.save(legacy.path()).unwrap();
    fs::write(
        legacy.path().join("terms.json"),
        serde_json::to_vec(&terms).unwrap(),
    )
    .unwrap();
    fs::remove_file(legacy.path().join("term-usages.json")).unwrap();
    let old = sect_struct::Graph::load(legacy.path()).unwrap();
    assert_eq!(serde_json::to_value(&old.terms).unwrap(), terms);
    let converted = tempfile::tempdir().unwrap();
    old.save(converted.path()).unwrap();
    assert_eq!(
        serde_json::to_value(sect_struct::Graph::load(converted.path()).unwrap().terms).unwrap(),
        terms
    );
    fs::write(converted.path().join("term-usages.json"), b"{}").unwrap();
    assert!(sect_struct::Graph::load(converted.path()).is_err());
    fs::remove_file(converted.path().join("term-usages.json")).unwrap();
    assert!(sect_struct::Graph::load(converted.path()).is_err());
}

#[test]
fn coherent_peers_preserve_member_pins_filters_evidence_and_incremental_parity() {
    let t = corpus();
    let a = "A quasar borrower uses the ordinary process.";
    let b = "An atypical circumstance requires additional evidence.";
    organized_fixture(t.path(), a, b);
    indexed(t.path());
    let old = open(t.path(), Refresh::No).unwrap();
    let chunks = old.chunks().unwrap();
    let content: Vec<_> = chunks.iter().filter(|c| !c.navigation).collect();
    assert_eq!(content.len(), 1);
    assert_eq!(content[0].spans.len(), 2);
    let found = sect_query::search(&old, &search_options("atypical", RelationMode::Off))
        .unwrap()
        .result;
    assert_eq!(found.hits[0].id, "T:b");
    let packet = found.hits[0].evidence.as_ref().unwrap();
    assert!(packet.primary.text.contains(b));
    assert!(packet.context.iter().any(|e| e.expr.starts_with("T:a@")));
    assert!(packet.section_complete);
    let expanded = sect_query::read(&old, &content[0].chunk_id, &ReadOptions::default()).unwrap();
    assert_eq!(expanded.header.counts.shown, 2);
    assert!(expanded.result.body.contains(a));
    let passage = expanded.result.passage.as_ref().unwrap();
    assert_eq!(passage.spans, content[0].spans);
    assert_eq!(passage.additional_sections.len(), 1);
    assert_eq!(passage.additional_sections[0].expr, "T:b@2024-01-01");
    assert!(passage.additional_sections[0].body.contains(b));
    assert!(passage.additional_sections[0].passage.is_none());
    assert!(sect_format::read_text(&expanded).contains("additional passage section T:b@2024-01-01"));
    let selected = sect_query::read(
        &old,
        &content[0].chunk_id,
        &ReadOptions {
            version: Some("T:b@2024-01-01".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(selected.result.expr, "T:b@2024-01-01");
    assert_eq!(
        selected.result.passage.unwrap().additional_sections[0].expr,
        "T:a@2024-01-01"
    );
    for excerpt in std::iter::once(&packet.primary).chain(packet.context.iter()) {
        assert_eq!(excerpt.spans.len(), 1);
        let span = &excerpt.spans[0];
        assert_eq!(
            &content[0].body[span.passage_start..span.passage_end],
            excerpt.text
        );
        assert_eq!(span.byte_end - span.byte_start, excerpt.text.len());
    }
    let pin = sect_query::search(&old, &search_options("T:b", RelationMode::Off))
        .unwrap()
        .result;
    assert_eq!(pin.hits[0].id, "T:b");
    assert!(pin.hits[0].pinned.is_some());
    let mut scoped = search_options("quasar", RelationMode::Off);
    scoped.scope = Some("T:a".into());
    let only = sect_query::search(&old, &scoped).unwrap().result;
    assert!(only.hits.iter().all(|h| h.id == "T:a"));
    assert!(only
        .hits
        .iter()
        .flat_map(|h| h.evidence.as_ref().unwrap().context.iter())
        .all(|c| !c.expr.starts_with("T:b@")));
    scoped.query = "quasar atypical".into();
    scoped.legacy_snippets = true;
    let legacy = sect_query::search(&old, &scoped).unwrap().result;
    assert!(legacy.hits.iter().all(|h| !h.snippet.contains("atypical")));
    let mut bounded = search_options("atypical", RelationMode::Off);
    bounded.evidence_budget = 3;
    let result = sect_query::search(&old, &bounded).unwrap().result;
    assert!(
        result
            .hits
            .iter()
            .map(|h| h.evidence.as_ref().unwrap().words)
            .sum::<usize>()
            <= 3
    );
    assert!(!result.hits[0].evidence.as_ref().unwrap().passage_complete);
    assert!(!result.hits[0]
        .evidence
        .as_ref()
        .unwrap()
        .continuation
        .is_empty());
    let replacement = format!(
        "{} Last sentence has a zebrafish exception.",
        "The ordinary rule continues. ".repeat(240)
    );
    write(t.path(), "b", Some("root"), "Exceptions", &replacement, "");
    organized_fixture(t.path(), a, &replacement);
    indexed(t.path());
    let changed = open(t.path(), Refresh::No).unwrap();
    assert!(
        sect_query::read(&changed, &content[0].chunk_id, &ReadOptions::default())
            .unwrap_err()
            .to_string()
            .contains("absent from this generation")
    );
    assert!(sect_query::read(&old, &content[0].chunk_id, &ReadOptions::default()).is_ok());
    let q = search_options("zebrafish", RelationMode::Off);
    let incremental = sect_query::search(&changed, &q).unwrap().result;
    assert!(incremental.hits[0].snippet.contains("zebrafish"));
    build(t.path(), &options(true)).unwrap();
    let full = open(t.path(), Refresh::No).unwrap();
    assert_eq!(
        serde_json::to_value(incremental).unwrap(),
        serde_json::to_value(sect_query::search(&full, &q).unwrap().result).unwrap()
    );
    assert!(
        sect_query::search(&old, &search_options("atypical", RelationMode::Off))
            .unwrap()
            .result
            .hits[0]
            .snippet
            .contains("atypical")
    );
}

#[test]
fn table_passages_keep_row_headers_and_complete_tail_evidence() {
    let t = corpus();
    let rows = (0..80)
        .map(|i| format!("| cohort{i} | {} | permitted |", i + 10))
        .collect::<Vec<_>>()
        .join("\n");
    let body=format!("| Population | Dose (mg) | Status |\n|---|---|---|\n{rows}\n\nFinal exception: exclude withdrawals.");
    write(t.path(), "a", Some("root"), "Results", &body, "");
    let note = "Source footnote: these doses apply only after calibration.";
    write(t.path(), "b", Some("root"), "Table note", note, "");
    organized_fixture(t.path(), &body, note);
    let artifact_file = t.path().join("test/test.document.json");
    let mut artifact: serde_json::Value =
        serde_json::from_slice(&fs::read(&artifact_file).unwrap()).unwrap();
    artifact["regions"][2]["footnote_of"] = serde_json::json!(["r1"]);
    fs::write(&artifact_file, serde_json::to_vec(&artifact).unwrap()).unwrap();
    let mut opts = options(false);
    opts.passage_policy = Some(sect_index::passages::PassagePolicy {
        target: 64,
        max: 80,
    });
    assert_eq!(build(t.path(), &opts).unwrap().errors(), 0);
    let index = open(t.path(), Refresh::No).unwrap();
    let chunks = index.chunks().unwrap();
    let target = chunks.iter().find(|c| c.body.contains("cohort79")).unwrap();
    let expanded = sect_query::read(&index, &target.chunk_id, &ReadOptions::default()).unwrap();
    assert!(expanded.result.body.contains("| cohort0 |"));
    assert!(expanded.result.body.contains("| cohort79 |"));
    assert!(expanded
        .result
        .body
        .contains("Final exception: exclude withdrawals."));
    assert!(expanded
        .result
        .passage
        .unwrap()
        .support
        .iter()
        .any(|s| s.text == note));
    assert!(target.text.contains("Dose (mg)"));
    assert!(target
        .support
        .iter()
        .any(|s| s.role == "table_header" && s.text.contains("Population")));
    assert!(chunks.iter().all(|c| c.token_count <= 80));
    let found = sect_query::search(&index, &search_options("cohort79", RelationMode::Off))
        .unwrap()
        .result;
    let packet = found.hits[0].evidence.as_ref().unwrap();
    assert!(packet.primary.text.contains("cohort79"));
    assert!(packet.context.iter().any(|c| c.text.contains("Dose (mg)")));
    assert!(packet.context.iter().any(|c| c.text == note));
    let joined = chunks
        .iter()
        .filter(|c| c.expr == "T:a@2024-01-01")
        .map(|c| c.body.as_str())
        .collect::<String>();
    // Canonical fragments cover each row once; their separate header context is not inserted
    // into the source body and does not corrupt source-line or byte addresses.
    for i in 0..80 {
        assert_eq!(joined.matches(&format!("| cohort{i} |")).count(), 1);
    }
    assert!(joined.contains("Final exception: exclude withdrawals."));
}

#[test]
fn retirement_hides_current_units_but_preserves_historical_reads() {
    let t = corpus();
    let file = t.path().join("test/a.md");
    let text = fs::read_to_string(&file).unwrap().replacen(
        "effective: 2024-01-01",
        "effective: 2024-01-01\nretired: 2025-01-01",
        1,
    );
    fs::write(file, text).unwrap();
    indexed(t.path());
    let index = open(t.path(), Refresh::No).unwrap();
    let current = sect_query::search(&index, &search_options("quasar", RelationMode::Off)).unwrap();
    assert!(current.result.hits.is_empty());
    let historical = sect_query::read(&index, "T:a@2024-01-01", &ReadOptions::default()).unwrap();
    assert!(historical.result.body.contains("quasar"));
}

#[test]
fn source_regions_are_pinned_and_identity_ledgers_must_match() {
    let t = corpus();
    let raw = "A quasar borrower uses the ordinary process.";
    fs::write(t.path().join("raw.txt"), raw).unwrap();
    let sha = "9d82afc1c1256def1a4e8f9057941e6104a40e8253e58d9e0fe68ac4fabc26bc";
    let unit = serde_json::json!({"id":"T:a","title":"Eligibility","parent":null,"regions":["r1"],"native_id":null,"content_sha256":sha});
    let document = serde_json::json!({"schema_version":1,"document":"DOC:test:manual","effective":"2024-01-01","raw":"raw.txt","raw_sha256":sha,"format":"text","parser":"fixture","derivations":[],"units":[unit],"regions":[{"id":"r1","native_id":null,"kind":"paragraph","text":raw,"locator":{"type":"text","line_start":1,"line_end":1},"order":0,"parent":null,"heading_level":null,"cells":[],"caption_of":null,"footnote_of":[],"uncertainty":[],"exclusion":null}]});
    fs::write(
        t.path().join("test/manual.document.json"),
        serde_json::to_vec(&document).unwrap(),
    )
    .unwrap();
    let mut ledger = serde_json::json!({"schema_version":1,"document":"DOC:test:manual","next_id":1,"revisions":{"2024-01-01":[unit]},"transitions":[]});
    let ledger_file = t.path().join("test/manual.identity.json");
    fs::write(&ledger_file, serde_json::to_vec(&ledger).unwrap()).unwrap();
    indexed(t.path());
    let index = open(t.path(), Refresh::No).unwrap();
    let read = sect_query::read(&index, "T:a", &ReadOptions::default()).unwrap();
    assert_eq!(read.result.source_region_count, 1);
    ledger["revisions"]["2024-01-01"][0]["title"] = "mismatched".into();
    fs::write(&ledger_file, serde_json::to_vec(&ledger).unwrap()).unwrap();
    assert!(build(t.path(), &options(false)).is_err());
    assert_eq!(
        sect_query::read(&index, "T:a", &ReadOptions::default())
            .unwrap()
            .result
            .source_region_count,
        1
    );
}
fn search_options(query: &str, relations: RelationMode) -> SearchOptions {
    SearchOptions {
        evidence_budget: 1500,
        legacy_snippets: false,
        baseline: None,
        query: query.into(),
        relations,
        relation_types: vec![],
        explain: true,
        mode: SearchMode::Fts,
        scope: None,
        source: None,
        kind: None,
        as_of: None,
        include_superseded: false,
        limit: 10,
        expand: None,
        seed: false,
        budget: 1500,
    }
}

#[test]
fn invalid_contract_stops_before_model_loading_and_preserves_generation() {
    let t = corpus();
    indexed(t.path());
    let published = index_dir(t.path());
    write(
        t.path(),
        "a",
        Some("absent"),
        "Eligibility",
        "A quasar borrower.",
        "",
    );
    let model = tempfile::tempdir().unwrap();
    fs::write(model.path().join("model.safetensors"), []).unwrap();
    // This explicitly local model is incomplete. Reaching model loading
    // would return Err instead of the actionable corpus validation report.
    for validate_only in [false, true] {
        let report = build(
            t.path(),
            &BuildOptions {
                embedding: Some(format!("model2vec:{}", model.path().display())),
                validate_only,
                ..options(false)
            },
        )
        .unwrap();
        assert!(report.errors() > 0);
        assert_eq!(
            report.mode,
            if validate_only { "validate" } else { "blocked" }
        );
        assert_eq!(report.works, 3);
        assert_eq!(report.chunks, 0);
        assert!(!report.written);
        assert!(report.layer_ms.contains_key("validate"));
        assert!(!report.layer_ms.contains_key("structural"));
        assert_eq!(index_dir(t.path()), published);
    }
    let pinned = open(t.path(), Refresh::No).unwrap();
    assert!(sect_query::read(&pinned, "T:a", &ReadOptions::default())
        .unwrap()
        .result
        .body
        .contains("ordinary process"));
}

#[test]
fn readers_pin_bytes_and_layers_and_failed_builds_do_not_publish() {
    let t = corpus();
    indexed(t.path());
    let old = open(t.path(), Refresh::No).unwrap();
    let generation = old.dir();
    // Warm reader, selection and lookup caches before publishing a replacement generation.
    let old_search = sect_query::search(&old, &search_options("quasar", RelationMode::Off))
        .unwrap()
        .result;
    write(
        t.path(),
        "a",
        Some("root"),
        "New eligibility",
        "Only a pulsar remains.",
        "",
    );
    indexed(t.path());
    assert_ne!(generation, index_dir(t.path()));
    assert!(sect_query::read(&old, "T:a", &ReadOptions::default())
        .unwrap()
        .result
        .body
        .contains("quasar"));
    assert_eq!(
        sect_query::search(&old, &search_options("quasar", RelationMode::Off))
            .unwrap()
            .result
            .hits[0]
            .id,
        "T:a"
    );
    let new = open(t.path(), Refresh::No).unwrap();
    assert_eq!(
        serde_json::to_value(&old_search).unwrap(),
        serde_json::to_value(
            sect_query::search(&old, &search_options("quasar", RelationMode::Off))
                .unwrap()
                .result
        )
        .unwrap()
    );
    assert_eq!(
        sect_query::read(&new, "T:a", &ReadOptions::default())
            .unwrap()
            .result
            .title,
        "New eligibility"
    );
    let published = new.dir();
    fs::write(t.path().join("test/a.md"), "invalid candidate").unwrap();
    assert!(build(t.path(), &options(false)).unwrap().errors() > 0);
    assert_eq!(published, index_dir(t.path()));
    assert!(sect_query::read(&new, "T:a", &ReadOptions::default())
        .unwrap()
        .result
        .body
        .contains("pulsar"));
}

#[test]
fn sidecars_and_registry_edits_invalidate_every_affected_layer() {
    let t = corpus();
    indexed(t.path());
    let original_chunks = fs::read(index_dir(t.path()).join("chunks.jsonl")).unwrap();
    fs::write(t.path().join("memo.txt"), "secondaryneedle").unwrap();
    assert!(matches!(
        check(t.path()).unwrap().check,
        Check::Stale { .. }
    ));
    let report = build(t.path(), &options(false)).unwrap();
    assert_eq!(report.errors(), 0);
    assert_eq!(report.mode, "incremental");
    assert_eq!(
        fs::read(index_dir(t.path()).join("chunks.jsonl")).unwrap(),
        original_chunks
    );
    // Losing the optional parse cache must not force replacement of valid search layers.
    fs::remove_file(index_dir(t.path()).join("docs.jsonl")).unwrap();
    fs::write(t.path().join("memo.txt"), "tertiaryneedle").unwrap();
    assert!(matches!(
        check(t.path()).unwrap().check,
        Check::Stale { .. }
    ));
    let report = build(t.path(), &options(false)).unwrap();
    assert_eq!(report.errors(), 0);
    assert_eq!(report.mode, "incremental");
    assert_eq!(
        fs::read(index_dir(t.path()).join("chunks.jsonl")).unwrap(),
        original_chunks
    );
    let ix = open(t.path(), Refresh::No).unwrap();
    let args = sect_verbs::GrepArgs {
        pattern: Some("tertiaryneedle".into()),
        ..Default::default()
    };
    let indexed = sect_verbs::grep(&ix, &args).unwrap();
    let brute = sect_verbs::grep(
        &ix,
        &sect_verbs::GrepArgs {
            no_index: true,
            ..args
        },
    )
    .unwrap();
    assert_eq!(
        indexed.json["result"]["lines"],
        brute.json["result"]["lines"]
    );
    assert_eq!(indexed.json["result"]["total_matches"], 1);
    let registry = t.path().join("test/_source.yaml");
    fs::write(
        &registry,
        fs::read_to_string(&registry)
            .unwrap()
            .replace("kind: base", "kind: internal"),
    )
    .unwrap();
    assert!(matches!(
        check(t.path()).unwrap().check,
        Check::Stale { .. }
    ));
    build(t.path(), &options(false)).unwrap();
    let ix = open(t.path(), Refresh::No).unwrap();
    assert_eq!(ix.tree.get("T:a").unwrap().kind, "internal");
    let result = sect_query::search(
        &ix,
        &SearchOptions {
            kind: Some("internal".into()),
            ..search_options("quasar", RelationMode::Off)
        },
    )
    .unwrap();
    assert!(result.result.hits.iter().any(|hit| hit.id == "T:a"));
}

#[test]
fn removed_expressions_and_corrupt_inventories_recover_without_a_parse_cache() {
    let t = corpus();
    indexed(t.path());
    fs::remove_file(index_dir(t.path()).join("docs.jsonl")).unwrap();
    fs::remove_file(t.path().join("test/b.md")).unwrap();
    let report = build(t.path(), &options(false)).unwrap();
    assert_eq!(report.errors(), 0);
    assert_eq!(report.mode, "incremental");
    let index = open(t.path(), Refresh::No).unwrap();
    assert!(index.tree.get("T:b").is_none());
    let query = search_options("atypical circumstance", RelationMode::Off);
    assert!(sect_query::search(&index, &query)
        .unwrap()
        .result
        .hits
        .iter()
        .all(|hit| hit.id != "T:b"));
    // An unreadable prior passage inventory cannot safely supply deletion bookkeeping.
    fs::write(index_dir(t.path()).join("chunks.jsonl"), "invalid json\n").unwrap();
    fs::write(t.path().join("memo.txt"), "new input").unwrap();
    let report = build(t.path(), &options(false)).unwrap();
    assert_eq!(report.errors(), 0);
    assert_eq!(report.mode, "full");
    let index = open(t.path(), Refresh::No).unwrap();
    assert!(sect_query::search(&index, &query)
        .unwrap()
        .result
        .hits
        .iter()
        .all(|hit| hit.id != "T:b"));
}

#[test]
fn metadata_only_edits_keep_unchanged_lexical_postings() {
    let t = corpus();
    indexed(t.path());
    let original_chunks = fs::read(index_dir(t.path()).join("chunks.jsonl")).unwrap();
    let path = t.path().join("test/a.md");
    let original = fs::read_to_string(&path).unwrap();
    let revised = original.replace("confidence: 1", "confidence: 0.99");
    assert_ne!(original, revised);
    fs::write(&path, revised).unwrap();
    let report = build(t.path(), &options(false)).unwrap();
    assert_eq!(report.errors(), 0);
    assert_eq!(report.mode, "incremental");
    assert_eq!(
        fs::read(index_dir(t.path()).join("chunks.jsonl")).unwrap(),
        original_chunks
    );
    let index = open(t.path(), Refresh::No).unwrap();
    let result = sect_query::search(&index, &search_options("quasar", RelationMode::Off)).unwrap();
    assert!(
        result.result.hits.iter().any(|hit| hit.id == "T:a"),
        "updating review metadata must not remove unchanged body postings"
    );
}

#[test]
fn inherited_context_incremental_equals_full() {
    let t = corpus();
    indexed(t.path());
    write(t.path(), "root", None, "Intergalactic manual", "", "");
    let changed = build(t.path(), &options(false)).unwrap();
    assert_eq!(changed.passage_cache.compiled_documents, 3);
    let incremental = open(t.path(), Refresh::No).unwrap().chunks().unwrap();
    build(t.path(), &options(true)).unwrap();
    let full = open(t.path(), Refresh::No).unwrap().chunks().unwrap();
    assert_eq!(incremental, full);
    assert!(full
        .iter()
        .filter(|c| c.id != "T:root")
        .all(|c| c.breadcrumb.contains("Intergalactic")));
}

fn assert_full_passage_parity(root: &Path, opts: &BuildOptions) {
    let incremental = fs::read(index_dir(root).join("chunks.jsonl")).unwrap();
    let mut full = opts.clone();
    full.full = true;
    let report = build(root, &full).unwrap();
    assert_eq!(report.errors(), 0);
    assert_eq!(report.passage_cache.reused_documents, 0);
    assert_eq!(
        fs::read(index_dir(root).join("chunks.jsonl")).unwrap(),
        incremental
    );
}

#[test]
fn compiled_passages_reuse_only_unchanged_dependencies() {
    let t = corpus();
    indexed(t.path());
    let pinned = index_dir(t.path());
    let pinned_chunks = fs::read(pinned.join("chunks.jsonl")).unwrap();
    fs::write(t.path().join("unrelated.txt"), "exact-only input").unwrap();
    let unchanged = build(t.path(), &options(false)).unwrap();
    assert_eq!(unchanged.passage_cache.reused_documents, 3);
    assert_eq!(unchanged.passage_cache.compiled_documents, 0);
    assert_eq!(
        fs::read(index_dir(t.path()).join("chunks.jsonl")).unwrap(),
        pinned_chunks
    );

    write(
        t.path(),
        "a",
        Some("root"),
        "Eligibility",
        "Quasar calibration requires the revised evidence.",
        "",
    );
    let edited = build(t.path(), &options(false)).unwrap();
    assert_eq!(edited.passage_cache.compiled_documents, 1);
    assert_eq!(edited.passage_cache.reused_documents, 2);
    let index = open(t.path(), Refresh::No).unwrap();
    let answer =
        sect_query::search(&index, &search_options("calibration", RelationMode::Off)).unwrap();
    assert!(answer.result.hits.iter().any(|h| h.id == "T:a"));
    assert_eq!(
        fs::read(pinned.join("chunks.jsonl")).unwrap(),
        pinned_chunks
    );
    assert_full_passage_parity(t.path(), &options(false));

    fs::remove_file(t.path().join("test/a.md")).unwrap();
    let removed = build(t.path(), &options(false)).unwrap();
    assert_eq!(removed.passage_cache.compiled_documents, 0);
    assert_eq!(removed.passage_cache.reused_documents, 2);
    let index = open(t.path(), Refresh::No).unwrap();
    assert!(
        sect_query::search(&index, &search_options("calibration", RelationMode::Off))
            .unwrap()
            .result
            .hits
            .is_empty()
    );
    assert_full_passage_parity(t.path(), &options(false));
}

#[test]
fn compiled_native_groups_refresh_peers_and_support_after_artifact_edits() {
    let t = corpus();
    let a = "A quasar borrower uses the ordinary process.";
    let b = "An atypical circumstance requires additional evidence.";
    organized_fixture(t.path(), a, b);
    write(
        t.path(),
        "unrelated",
        None,
        "Independent record",
        "Preserve this separate record.",
        "",
    );
    indexed(t.path());
    let artifact_file = t.path().join("test/test.document.json");
    let mut artifact: serde_json::Value =
        serde_json::from_slice(&fs::read(&artifact_file).unwrap()).unwrap();
    // Only the native dependency changes. Markdown bytes are identical.
    artifact["regions"][2]["footnote_of"] = serde_json::json!(["r1"]);
    fs::write(&artifact_file, serde_json::to_vec(&artifact).unwrap()).unwrap();
    let changed = build(t.path(), &options(false)).unwrap();
    assert_eq!(changed.errors(), 0);
    assert_eq!(changed.passage_cache.compiled_documents, 3);
    assert_eq!(changed.passage_cache.reused_documents, 1);
    let index = open(t.path(), Refresh::No).unwrap();
    assert!(index
        .chunks()
        .unwrap()
        .iter()
        .any(|c| c.has_expression("T:a@2024-01-01")
            && c.support
                .iter()
                .any(|s| s.role == "footnote" && s.text == b)));
    assert_full_passage_parity(t.path(), &options(false));

    let mut revised = options(false);
    revised.passage_policy = Some(sect_index::passages::PassagePolicy {
        target: 64,
        max: 80,
    });
    let report = build(t.path(), &revised).unwrap();
    assert_eq!(report.passage_cache.compiled_documents, 4);
    assert_eq!(report.passage_cache.reused_documents, 0);
    assert_full_passage_parity(t.path(), &revised);
}

#[test]
fn compiled_cache_damage_recompiles_instead_of_losing_evidence() {
    let t = corpus();
    indexed(t.path());
    for (i, corruption) in [
        "missing",
        "invalid-json",
        "wrong-version",
        "wrong-output",
        "missing-passage",
    ]
    .iter()
    .enumerate()
    {
        let file = index_dir(t.path()).join(sect_index::compiled_cache::FILE);
        let mut cache: serde_json::Value =
            serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        match *corruption {
            "missing" => fs::remove_file(&file).unwrap(),
            "invalid-json" => fs::write(&file, "incomplete {").unwrap(),
            other => {
                match other {
                    "wrong-version" => cache["version"] = serde_json::json!(999),
                    "wrong-output" => {
                        cache["groups"]["test/a.md"]["output"] = serde_json::json!("corrupt")
                    }
                    "missing-passage" => {
                        cache["groups"]["test/a.md"]["chunks"][0] = serde_json::json!("absent")
                    }
                    _ => unreachable!(),
                }
                fs::write(&file, serde_json::to_vec(&cache).unwrap()).unwrap();
            }
        }
        fs::write(t.path().join("trigger.txt"), format!("trigger {i}")).unwrap();
        let report = build(t.path(), &options(false)).unwrap();
        assert_eq!(report.errors(), 0, "{corruption}");
        assert!(report.passage_cache.compiled_documents > 0, "{corruption}");
        let index = open(t.path(), Refresh::No).unwrap();
        assert!(
            sect_query::search(&index, &search_options("quasar", RelationMode::Off))
                .unwrap()
                .result
                .hits
                .iter()
                .any(|h| h.id == "T:a")
        );
        assert_full_passage_parity(t.path(), &options(false));
    }
}

#[test]
fn scoped_definitions_preserve_ambiguity_and_cycles_are_rejected() {
    let t = corpus();
    write(
        t.path(),
        "a",
        Some("root"),
        "Eligibility",
        "(a) Borrower means a person.\nThe person signs the form.",
        "borrower",
    );
    write(
        t.path(),
        "b",
        Some("root"),
        "Exceptions",
        "Borrower means an organization.",
        "borrower",
    );
    indexed(t.path());
    let ix = open(t.path(), Refresh::No).unwrap();
    let ambiguous = sect_query::define(&ix, "borrower", false, None, None)
        .unwrap()
        .result;
    assert!(ambiguous.ambiguous && !ambiguous.defined);
    assert_eq!(ambiguous.occurrences.len(), 2);
    let scoped = sect_query::define(&ix, "borrower", false, Some("T:a"), None)
        .unwrap()
        .result;
    assert!(scoped.defined, "{scoped:?}");
    assert!(scoped.definition.unwrap().contains("signs the form"));
    write(t.path(), "root", Some("a"), "Cycle", "", "");
    let r = build(t.path(), &options(false)).unwrap();
    assert!(r.issues.iter().any(|i| i.message.contains("cycle")));
}

#[test]
fn verified_relations_add_evidence_candidates_without_bypassing_filters() {
    use sect_core::knowledge::*;
    let t = corpus();
    write(t.path(), "b", Some("root"), "Exceptions", "(a) An atypical circumstance requires additional evidence.\n\n(b) Consult a qualified specialist for this situation.", "");
    fs::write(
        t.path().join("test.xml"),
        "Exceptions apply to quasar eligibility.",
    )
    .unwrap();
    let verification = Verification {
        state: CheckState::Passed,
        method: "synthetic regression fixture".into(),
        reason: None,
    };
    let evidence = Evidence {
        raw: "test.xml".into(),
        raw_sha256: "fe3dee4639822028d966e2d207cb36f7310ef62a2ed45aa8e9487f60dbbee881".into(),
        locator: Locator::Text {
            line_start: 1,
            line_end: 1,
        },
        quote: "Exceptions apply to quasar eligibility.".into(),
        verification: verification.clone(),
    };
    let mut artifact = KnowledgeArtifact {
        schema_version: 1,
        profile: Profile {
            name: "test".into(),
            version: "1".into(),
            unit_types: vec![],
            concept_types: vec!["borrower".into()],
            metadata_fields: vec![],
            relation_types: vec![RelationType {
                name: "exception_to".into(),
                description: "regression relation".into(),
                direction: RelationDirection::Both,
                weight: 0.9,
                required_context: true,
            }],
        },
        concepts: vec![Concept {
            id: "quasar".into(),
            label: "Quasar borrower".into(),
            aliases: vec!["Q borrower".into()],
            kind: "borrower".into(),
            scope: Some("T:root".into()),
            definition: Some("An entity using the ordinary process.".into()),
            evidence: vec![evidence.clone()],
            verification: verification.clone(),
        }],
        mentions: vec![Mention {
            concept: "quasar".into(),
            at: Endpoint {
                revision: "T:a@2024-01-01".into(),
                anchor: None,
            },
            evidence: vec![evidence.clone()],
            verification: verification.clone(),
        }],
        relations: vec![Relation {
            scope: None,
            qualifiers: Default::default(),
            id: "r1".into(),
            from: Endpoint {
                revision: "T:a@2024-01-01".into(),
                anchor: None,
            },
            to: Endpoint {
                revision: "T:b@2024-01-01".into(),
                anchor: Some("a".into()),
            },
            kind: "exception_to".into(),
            evidence: vec![evidence],
            verification,
        }],
        derivations: vec![],
    };
    let mut second = artifact.relations[0].clone();
    second.id = "r2".into();
    second.to.anchor = Some("b".into());
    artifact.relations.push(second);
    fs::write(
        t.path().join("test/test.knowledge.json"),
        serde_json::to_vec(&artifact).unwrap(),
    )
    .unwrap();
    indexed(t.path());
    let ix = open(t.path(), Refresh::No).unwrap();
    assert!(
        sect_query::define(&ix, "Q borrower", false, Some("T:root"), None)
            .unwrap()
            .result
            .defined
    );
    assert_eq!(
        sect_query::map_concepts(&ix, "Q borrower", None, 500, false)
            .unwrap()
            .result
            .concepts[0]
            .mentions
            .len(),
        1
    );
    assert!(
        !sect_query::search(&ix, &search_options("quasar", RelationMode::Off))
            .unwrap()
            .result
            .hits
            .iter()
            .any(|h| h.id == "T:b")
    );
    let result = sect_query::search(&ix, &search_options("quasar", RelationMode::Verified))
        .unwrap()
        .result;
    let supporting = result.hits.iter().find(|h| h.id == "T:b").unwrap();
    assert_eq!(supporting.role, "supporting");
    assert!(supporting.retrieval_path.as_ref().unwrap().steps[0].required_context);
    let mut top_one = search_options("quasar", RelationMode::Verified);
    top_one.limit = 1;
    let context = sect_query::search(&ix, &top_one).unwrap().result;
    assert_eq!(context.hits.len(), 1);
    assert_eq!(context.supporting_context[0].expr, "T:b@2024-01-01");
    assert!(context.supporting_context[0].body.contains("atypical"));
    assert_eq!(context.supporting_context.len(), 2);
    assert!(context.supporting_context[1].body.contains("specialist"));
    assert_eq!(
        sect_query::refs(
            &ix,
            "T:a",
            sect_struct::Direction::Out,
            Some("exception_to"),
            1,
            None,
            false
        )
        .unwrap()
        .result
        .knowledge
        .len(),
        2
    );
    let mut scoped = search_options("quasar", RelationMode::Verified);
    scoped.scope = Some("T:a".into());
    assert!(!sect_query::search(&ix, &scoped)
        .unwrap()
        .result
        .hits
        .iter()
        .any(|h| h.id == "T:b"));
    fs::write(t.path().join("test.xml"), "Changed raw evidence").unwrap();
    assert!(build(t.path(), &options(false))
        .unwrap_err()
        .to_string()
        .contains("raw hash changed"));
}

#[test]
fn container_actions_validate_beyond_twelve_ancestors() {
    let t = corpus();
    for n in 0..16 {
        let parent = if n == 0 {
            "root".to_string()
        } else {
            format!("deep{}", n - 1)
        };
        write(
            t.path(),
            &format!("deep{n}"),
            Some(&parent),
            "Nested region",
            "Copied source text.",
            "",
        );
    }
    let notice = t.path().join("test/root.md");
    fs::write(&notice, fs::read_to_string(&notice).unwrap().replacen("amended_by: []", "actions:\n  - {action_id: 'T:root#remove', target_id: 'T:root', kind: remove, effective: 2024-01-01, text: 'Removed source sentence.'}\namended_by: []", 1)).unwrap();
    let leaf = t.path().join("test/deep15.md");
    fs::write(
        &leaf,
        fs::read_to_string(&leaf)
            .unwrap()
            .replace("amended_by: []", "amended_by: ['T:root#remove']"),
    )
    .unwrap();
    let report = build(
        t.path(),
        &BuildOptions {
            validate_only: true,
            ..options(false)
        },
    )
    .unwrap();
    assert_eq!(report.errors(), 0, "{:?}", report.issues);
}

#[test]
fn historical_metadata_and_future_revisions_share_the_text_snapshot() {
    let t = corpus();
    let current = t.path().join("test/a.md");
    let old = fs::read_to_string(&current).unwrap();
    fs::write(
        t.path().join("test/a@2024-01-01.md"),
        old.replace("superseded_by: null", "superseded_by: T:a@2099-01-01"),
    )
    .unwrap();
    fs::write(
        &current,
        old.replace("effective: 2024-01-01", "effective: 2099-01-01")
            .replace("supersedes: null", "supersedes: T:a@2024-01-01")
            .replace("title: Eligibility", "title: Future rules")
            .replace("A quasar borrower", "A future-only borrower"),
    )
    .unwrap();
    indexed(t.path());
    let ix = open(t.path(), Refresh::No).unwrap();
    let now = sect_query::read(&ix, "T:a", &ReadOptions::default())
        .unwrap()
        .result;
    assert_eq!(now.title, "Eligibility");
    assert!(now.body.contains("quasar"));
    let future = sect_query::read(&ix, "T:a@2099-01-01", &ReadOptions::default())
        .unwrap()
        .result;
    assert_eq!(future.title, "Future rules");
    assert!(future.body.contains("future-only"));
    let chunks = ix.chunks().unwrap();
    let old_passage = chunks.iter().find(|c| c.expr == "T:a@2024-01-01").unwrap();
    let future_passage = chunks.iter().find(|c| c.expr == "T:a@2099-01-01").unwrap();
    let as_of = ReadOptions {
        as_of: Some(chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap()),
        ..Default::default()
    };
    assert!(sect_query::read(&ix, &old_passage.chunk_id, &as_of).is_ok());
    assert!(sect_query::read(&ix, &future_passage.chunk_id, &as_of)
        .unwrap_err()
        .to_string()
        .contains("not in force"));
    assert!(
        sect_query::read(&ix, &future_passage.chunk_id, &ReadOptions::default())
            .unwrap()
            .result
            .body
            .contains("future-only")
    );
    assert!(sect_query::read(
        &ix,
        &old_passage.chunk_id,
        &ReadOptions {
            version: Some("T:a@2099-01-01".into()),
            ..Default::default()
        }
    )
    .unwrap_err()
    .to_string()
    .contains("exact Expression contained"));
    assert!(
        sect_query::search(&ix, &search_options("quasar", RelationMode::Off))
            .unwrap()
            .result
            .hits
            .iter()
            .all(|h| h.expr != "T:a@2099-01-01")
    );
    for year in [2099, 2024, 2023, 2099, 2024, 2023, 2025, 2026, 2027, 2099] {
        let mut opts = search_options("borrower", RelationMode::Off);
        opts.as_of = Some(chrono::NaiveDate::from_ymd_opt(year, 1, 1).unwrap());
        opts.scope = Some("T:a".into());
        let results = sect_query::search(&ix, &opts).unwrap().result;
        if year < 2024 {
            assert!(results.hits.is_empty());
        } else {
            let expected = if year < 2099 {
                "T:a@2024-01-01"
            } else {
                "T:a@2099-01-01"
            };
            assert_eq!(results.hits.len(), 1);
            assert_eq!(results.hits[0].expr, expected);
        }
        opts.include_superseded = true;
        let all = sect_query::search(&ix, &opts).unwrap().result;
        assert_eq!(
            all.hits.len(),
            if year < 2024 {
                0
            } else if year < 2099 {
                1
            } else {
                2
            }
        );
    }
}

#[test]
fn cached_selections_isolate_filters_and_unchanged_snapshot_bytes() {
    let t = corpus();
    indexed(t.path());
    let old = open(t.path(), Refresh::No).unwrap();
    let original = old.read_body("test/b.md").unwrap();
    for (scope, source, kind, expected) in [
        (None, None, None, 1),
        (Some("T:b"), None, None, 0),
        (Some("T:a"), Some("test"), Some("base"), 1),
        (None, Some("missing"), None, 0),
        (None, None, Some("overlay"), 0),
        (None, None, None, 1),
    ] {
        let mut opts = search_options("quasar", RelationMode::Off);
        opts.scope = scope.map(str::to_string);
        opts.source = source.map(str::to_string);
        opts.kind = kind.map(str::to_string);
        assert_eq!(
            sect_query::search(&old, &opts).unwrap().result.hits.len(),
            expected
        );
    }
    write(
        t.path(),
        "a",
        Some("root"),
        "Updated",
        "A pulsar borrower.",
        "",
    );
    indexed(t.path());
    let new = open(t.path(), Refresh::No).unwrap();
    assert_eq!(new.read_body("test/b.md").unwrap(), original);
    // A reused file must link to a pinned snapshot, never to this mutable input.
    write(
        t.path(),
        "b",
        Some("root"),
        "Edited source",
        "Mutable source bytes.",
        "",
    );
    assert_eq!(old.read_body("test/b.md").unwrap(), original);
    assert_eq!(new.read_body("test/b.md").unwrap(), original);
    assert!(matches!(
        check(t.path()).unwrap().check,
        Check::Stale { .. }
    ));
    assert!(
        sect_query::search(&new, &search_options("quasar", RelationMode::Off))
            .unwrap()
            .result
            .hits
            .is_empty()
    );
}

#[test]
fn search_does_not_load_source_evidence_but_read_reports_invalid_evidence() {
    let t = corpus();
    indexed(t.path());
    // Deliberate corruption of a disposable fixture artifact exposes eager reads.
    fs::write(
        index_dir(t.path()).join("regions.json"),
        "invalid evidence JSON",
    )
    .unwrap();
    let index = open(t.path(), Refresh::No).unwrap();
    assert_eq!(
        sect_query::search(&index, &search_options("quasar", RelationMode::Off))
            .unwrap()
            .result
            .hits[0]
            .id,
        "T:a"
    );
    assert!(sect_query::read(&index, "T:a", &ReadOptions::default()).is_err());
}
