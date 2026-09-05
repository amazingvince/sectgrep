//! Lexical index (spec B.4 "Lexical") on tantivy 0.26.
//!
//! Fields: `id`, `node` (stored), `title` (boost 3), `path` breadcrumb (boost 2), `context`
//! (boost 1.5), `body`, `citations` (every id token found in the chunk, its own field; the
//! Poly-Vector idea), `terms_defined` (boost 4), `source` and `kind` facets, `effective` date,
//! `superseded` bool. Text fields use a stopword-removing, stemming analyzer (decisions #18);
//! `citations` uses [`IdTokenizer`], which splits section ids into components.

use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use sect_core::{Result, SectError};
use serde::{Deserialize, Serialize};
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, BoostQuery, Occur, Query, TermQuery, TermSetQuery};
use tantivy::schema::{
    Facet, FacetOptions, Field, IndexRecordOption, Schema, TextFieldIndexing, TextOptions, Value,
    FAST, INDEXED, STORED, STRING,
};
use tantivy::tokenizer::{
    Language, LowerCaser, RemoveLongFilter, SimpleTokenizer, Stemmer, StopWordFilter, TextAnalyzer,
    Token, TokenStream, Tokenizer,
};
use tantivy::{doc, DateTime, Index, ReloadPolicy, TantivyDocument, Term};

mod directory;

pub const TEXT_TOKENIZER: &str = "sect_text";
pub const ID_TOKENIZER: &str = "sect_id";
pub const CANDIDATES: usize = 100;

/// Segment layouts can change the last floating-point bits of BM25 sums. Ranking feeds
/// ordinal fusion, so distinguish millipoints and break ties by the durable chunk address.
fn score_key(score: f32) -> i64 {
    (f64::from(score) * 1000.0).round() as i64
}

/// Field boosts from spec B.4, plus `self_id`: the chunk's own id components, boosted so that a
/// citation-shaped query prefers the cited section over the sections that cite it.
pub const BOOSTS: &[(&str, f32)] = &[
    ("title", 3.0),
    ("path", 2.0),
    ("context", 1.5),
    ("body", 1.0),
    ("citations", 3.0),
    ("terms_defined", 4.0),
    ("self_id", 6.0),
];

/// One document of the lexical index: a chunk of a section (spec B.4 "Chunking").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LexDoc {
    pub chunk_id: String,
    pub expr: String,
    pub id: String,
    pub node: Option<String>,
    pub title: String,
    pub path: String,
    pub context: String,
    pub body: String,
    /// Work ids cited by the chunk (its own id first).
    pub citations: Vec<String>,
    pub terms_defined: Vec<String>,
    pub source: String,
    pub kind: String,
    pub effective: Option<chrono::NaiveDate>,
    pub superseded: bool,
}

/// Filters applied as query clauses (facets) or as an allowed-expression set (as-of, scope).
#[derive(Debug, Clone, Default)]
pub struct Filter {
    pub source: Option<String>,
    pub kind: Option<String>,
    /// Only these Expression ids may match (None = no restriction).
    pub exprs: Option<HashSet<String>>,
}

pub enum ExpressionFilter<'a> {
    Unrestricted,
    /// Same constant score as a full TermSetQuery, without enumerating every revision.
    AllIndexed,
    Only(&'a HashSet<String>),
}
pub struct SelectedFilter<'a> {
    pub source: Option<&'a str>,
    pub kind: Option<&'a str>,
    pub expressions: ExpressionFilter<'a>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LexHit {
    pub chunk_id: String,
    pub expr: String,
    pub id: String,
    pub score: f32,
}

static ID_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[A-Za-z]+:[A-Za-z0-9][A-Za-z0-9.\-]*|\b\d{1,3}\.\d{1,4}[a-z]?\b|\b[A-Za-z]{1,4}-\d{1,5}\b|\b20\d{2}-\d{5}\b").unwrap()
});

/// Tokens for one id: the id, its tail after the scheme, and its section number when it has one.
/// `CFR:99-2.8` -> `cfr:99-2.8`, `99-2.8`, `2.8`; `CITY:AM-1` -> `city:am-1`, `am-1`.
pub fn id_components(raw: &str) -> Vec<String> {
    let base = raw.split('#').next().unwrap_or(raw).to_lowercase();
    let mut out = vec![base.clone()];
    let tail = base
        .split_once(':')
        .map(|(_, t)| t.to_string())
        .unwrap_or_else(|| base.clone());
    if tail != base {
        out.push(tail.clone());
    }
    if let Some(last) = tail.rsplit('-').next() {
        if last.contains('.') && last != tail {
            out.push(last.to_string());
        }
    }
    out.dedup();
    out
}

/// Id-shaped matches in text, skipping anything that follows a `#` (an anchor such as `a-2`).
fn id_matches(text: &str) -> Vec<regex::Match<'_>> {
    ID_RE
        .find_iter(text)
        .filter(|m| m.start() == 0 || text.as_bytes()[m.start() - 1] != b'#')
        .collect()
}

/// Every id-shaped token in free text, split into components (used for the `citations` field
/// at index time and for the query side).
pub fn cite_tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for m in id_matches(text) {
        for c in id_components(m.as_str()) {
            if !out.contains(&c) {
                out.push(c);
            }
        }
    }
    out
}

/// tantivy tokenizer that splits section ids into components (spec B.4 "custom tokenizer").
#[derive(Clone, Default)]
pub struct IdTokenizer;

pub struct IdTokenStream {
    tokens: Vec<Token>,
    index: usize,
}

impl Tokenizer for IdTokenizer {
    type TokenStream<'a> = IdTokenStream;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> IdTokenStream {
        let mut tokens = Vec::new();
        let mut position = 0usize;
        for m in id_matches(text) {
            for c in id_components(m.as_str()) {
                tokens.push(Token {
                    offset_from: m.start(),
                    offset_to: m.end(),
                    position,
                    text: c,
                    position_length: 1,
                });
                position += 1;
            }
        }
        IdTokenStream { tokens, index: 0 }
    }
}

impl TokenStream for IdTokenStream {
    fn advance(&mut self) -> bool {
        if self.index < self.tokens.len() {
            self.index += 1;
            true
        } else {
            false
        }
    }
    fn token(&self) -> &Token {
        &self.tokens[self.index - 1]
    }
    fn token_mut(&mut self) -> &mut Token {
        &mut self.tokens[self.index - 1]
    }
}

fn text_analyzer() -> TextAnalyzer {
    TextAnalyzer::builder(SimpleTokenizer::default())
        .filter(RemoveLongFilter::limit(40))
        .filter(LowerCaser)
        .filter(StopWordFilter::new(Language::English).expect("english stopwords"))
        .filter(Stemmer::new(Language::English))
        .build()
}

fn register(index: &Index) {
    index.tokenizers().register(TEXT_TOKENIZER, text_analyzer());
    index.tokenizers().register(ID_TOKENIZER, IdTokenizer);
}

struct Fields {
    chunk_id: Field,
    expr: Field,
    id: Field,
    node: Field,
    title: Field,
    path: Field,
    context: Field,
    body: Field,
    citations: Field,
    self_id: Field,
    terms_defined: Field,
    source: Field,
    kind: Field,
    effective: Field,
    superseded: Field,
}

fn schema() -> (Schema, Fields) {
    let mut b = Schema::builder();
    let text = |tok: &str| {
        TextOptions::default().set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer(tok)
                .set_index_option(IndexRecordOption::WithFreqsAndPositions),
        )
    };
    let f = Fields {
        chunk_id: b.add_text_field("chunk_id", STRING | STORED),
        expr: b.add_text_field("expr", STRING | STORED),
        id: b.add_text_field("id", STRING | STORED),
        node: b.add_text_field("node", STRING | STORED),
        title: b.add_text_field("title", text(TEXT_TOKENIZER)),
        path: b.add_text_field("path", text(TEXT_TOKENIZER)),
        context: b.add_text_field("context", text(TEXT_TOKENIZER)),
        body: b.add_text_field("body", text(TEXT_TOKENIZER)),
        citations: b.add_text_field("citations", text(ID_TOKENIZER)),
        self_id: b.add_text_field("self_id", text(ID_TOKENIZER)),
        terms_defined: b.add_text_field("terms_defined", text(TEXT_TOKENIZER)),
        source: b.add_facet_field("source", FacetOptions::default()),
        kind: b.add_facet_field("kind", FacetOptions::default()),
        effective: b.add_date_field("effective", INDEXED | STORED | FAST),
        superseded: b.add_bool_field("superseded", INDEXED | STORED),
    };
    (b.build(), f)
}

fn err(e: impl std::fmt::Display) -> SectError {
    SectError::Other(format!("tantivy: {e}"))
}

fn add_document(writer: &mut tantivy::IndexWriter, document: TantivyDocument) -> Result<()> {
    if let Err(original) = writer.add_document(document) {
        // Joining workers exposes their original error, which add_document otherwise hides.
        // Preparing is not committing: the failed generation is never published.
        let detail = writer.prepare_commit().err();
        return Err(SectError::Other(format!(
            "tantivy: {original}; worker detail: {detail:?}"
        )));
    }
    Ok(())
}

/// Build (replace) the lexical index under `dir`.
pub fn build(dir: &Path, docs: &[LexDoc]) -> Result<()> {
    let parent = dir
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(|e| SectError::io(parent, e))?;
    let staging = tempfile::Builder::new()
        .prefix(".sect-lexical-build-")
        .tempdir_in(parent)
        .map_err(|e| SectError::io(parent, e))?;
    // Build and close every writer before exposing files at the layer's destination.
    // On Windows this also isolates active segment files from observers of that path.
    build_staged(staging.path(), docs)?;
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|e| SectError::io(dir, e))?;
    }
    std::fs::rename(staging.path(), dir).map_err(|e| SectError::io(dir, e))?;
    Ok(())
}

fn build_staged(dir: &Path, docs: &[LexDoc]) -> Result<()> {
    std::fs::create_dir_all(dir).map_err(|e| SectError::io(dir, e))?;
    let (schema, f) = schema();
    let index = Index::create(
        directory::IndexDirectory::open(dir).map_err(err)?,
        schema,
        Default::default(),
    )
    .map_err(err)?;
    register(&index);
    let mut writer = index.writer(50_000_000).map_err(err)?;
    // New generations merge after the commit, with no concurrent automatic compaction.
    writer.set_merge_policy(Box::new(tantivy::merge_policy::NoMergePolicy));
    for d in docs {
        let date = d.effective.map(|dt| {
            DateTime::from_timestamp_secs(dt.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp())
        });
        let mut document = doc!(
            f.chunk_id => d.chunk_id.as_str(),
            f.expr => d.expr.as_str(),
            f.id => d.id.as_str(),
            f.node => d.node.clone().unwrap_or_default(),
            f.title => d.title.as_str(),
            f.path => d.path.as_str(),
            f.context => d.context.as_str(),
            f.body => d.body.as_str(),
            f.citations => d.citations.join(" "),
            f.self_id => d.id.as_str(),
            f.terms_defined => d.terms_defined.join(" "),
            f.source => Facet::from(&format!("/{}", d.source)),
            f.kind => Facet::from(&format!("/{}", d.kind)),
            f.superseded => d.superseded,
        );
        if let Some(dt) = date {
            document.add_date(f.effective, dt);
        }
        add_document(&mut writer, document)?;
    }
    writer.commit().map_err(err)?;
    let segments = index.searchable_segment_ids().map_err(err)?;
    if segments.len() > 1 {
        writer.merge(&segments).wait().map_err(err)?;
    }
    writer.wait_merging_threads().map_err(err)?;
    Ok(())
}

/// Incremental update: drop every chunk of the given Expressions, then add the new chunks.
/// A single commit, so a query never sees the half-way state.
pub fn update(dir: &Path, remove_exprs: &[String], add: &[LexDoc]) -> Result<()> {
    let index = Index::open(directory::IndexDirectory::open(dir).map_err(err)?).map_err(err)?;
    register(&index);
    let (_, f) = schema();
    let mut writer = index.writer(50_000_000).map_err(err)?;
    for e in remove_exprs {
        writer.delete_term(Term::from_field_text(f.expr, e));
    }
    for d in add {
        let date = d.effective.map(|dt| {
            DateTime::from_timestamp_secs(dt.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp())
        });
        let mut document = doc!(
            f.chunk_id => d.chunk_id.as_str(),
            f.expr => d.expr.as_str(),
            f.id => d.id.as_str(),
            f.node => d.node.clone().unwrap_or_default(),
            f.title => d.title.as_str(),
            f.path => d.path.as_str(),
            f.context => d.context.as_str(),
            f.body => d.body.as_str(),
            f.citations => d.citations.join(" "),
            f.self_id => d.id.as_str(),
            f.terms_defined => d.terms_defined.join(" "),
            f.source => Facet::from(&format!("/{}", d.source)),
            f.kind => Facet::from(&format!("/{}", d.kind)),
            f.superseded => d.superseded,
        );
        if let Some(dt) = date {
            document.add_date(f.effective, dt);
        }
        add_document(&mut writer, document)?;
    }
    writer.commit().map_err(err)?;
    writer.wait_merging_threads().map_err(err)?;
    Ok(())
}

pub struct LexicalIndex {
    index: Index,
    fields: Fields,
    reader: tantivy::IndexReader,
}

impl LexicalIndex {
    pub fn open(dir: &Path) -> Result<LexicalIndex> {
        let index = Index::open_in_dir(dir).map_err(err)?;
        register(&index);
        let (_, fields) = schema();
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()
            .map_err(err)?;
        Ok(LexicalIndex {
            index,
            fields,
            reader,
        })
    }

    /// Analyze query text with the text-field analyzer (stopwords out, stemmed).
    pub fn text_terms(&self, query: &str) -> Vec<String> {
        let mut analyzer = self
            .index
            .tokenizers()
            .get(TEXT_TOKENIZER)
            .expect("registered");
        let mut stream = analyzer.token_stream(query);
        let mut out = Vec::new();
        while stream.advance() {
            let t = stream.token().text.clone();
            if !out.contains(&t) {
                out.push(t);
            }
        }
        out
    }

    /// Fielded BM25 (spec B.4 boosts) with facet and expression filters; top `limit` chunks.
    pub fn search(&self, query: &str, filter: &Filter, limit: usize) -> Result<Vec<LexHit>> {
        self.search_fields(query, filter, limit, false)
    }

    pub fn search_fields(
        &self,
        query: &str,
        filter: &Filter,
        limit: usize,
        body_only: bool,
    ) -> Result<Vec<LexHit>> {
        self.search_selected(
            query,
            &SelectedFilter {
                source: filter.source.as_deref(),
                kind: filter.kind.as_deref(),
                expressions: filter
                    .exprs
                    .as_ref()
                    .map(ExpressionFilter::Only)
                    .unwrap_or(ExpressionFilter::Unrestricted),
            },
            limit,
            body_only,
        )
    }

    /// Borrow a generation-cached selection instead of copying all eligible revision IDs.
    pub fn search_selected(
        &self,
        query: &str,
        filter: &SelectedFilter<'_>,
        limit: usize,
        body_only: bool,
    ) -> Result<Vec<LexHit>> {
        let f = &self.fields;
        let terms = self.text_terms(query);
        let cites = cite_tokens(query);
        let mut should: Vec<(Occur, Box<dyn Query>)> = Vec::new();
        for (name, boost) in BOOSTS {
            if body_only && *name != "body" {
                continue;
            }
            let field = match *name {
                "title" => f.title,
                "path" => f.path,
                "context" => f.context,
                "body" => f.body,
                "citations" => f.citations,
                "self_id" => f.self_id,
                _ => f.terms_defined,
            };
            let toks = if *name == "citations" || *name == "self_id" {
                &cites
            } else {
                &terms
            };
            for t in toks {
                let tq = TermQuery::new(
                    Term::from_field_text(field, t),
                    IndexRecordOption::WithFreqs,
                );
                should.push((
                    Occur::Should,
                    Box::new(BoostQuery::new(Box::new(tq), *boost)),
                ));
            }
        }
        if should.is_empty() {
            return Ok(vec![]);
        }
        let mut clauses: Vec<(Occur, Box<dyn Query>)> =
            vec![(Occur::Must, Box::new(BooleanQuery::new(should)))];
        if let Some(s) = filter.source {
            clauses.push((
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_facet(f.source, &Facet::from(&format!("/{s}"))),
                    IndexRecordOption::Basic,
                )),
            ));
        }
        if let Some(k) = filter.kind {
            clauses.push((
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_facet(f.kind, &Facet::from(&format!("/{k}"))),
                    IndexRecordOption::Basic,
                )),
            ));
        }
        if let ExpressionFilter::Only(exprs) = filter.expressions {
            let terms: Vec<Term> = exprs
                .iter()
                .map(|e| Term::from_field_text(f.expr, e))
                .collect();
            clauses.push((Occur::Must, Box::new(TermSetQuery::new(terms))));
        }
        if matches!(filter.expressions, ExpressionFilter::AllIndexed) {
            clauses.push((Occur::Must, Box::new(tantivy::query::AllQuery)));
        }
        let query = BooleanQuery::new(clauses);
        let searcher = self.reader.searcher();
        let limit = limit.max(1);
        let mut take = limit.saturating_add(1);
        let top = loop {
            let top = searcher
                .search(&query, &TopDocs::with_limit(take).order_by_score())
                .map_err(err)?;
            // Include the entire tie at the candidate boundary. Sorting just the requested
            // window would still select arbitrary document IDs when a tie crosses it.
            if top.len() < take
                || top.len() <= limit
                || score_key(top[limit - 1].0) != score_key(top.last().unwrap().0)
            {
                break top;
            }
            take = take.saturating_mul(2);
        };
        let cutoff = top
            .get(limit - 1)
            .map(|(s, _)| score_key(*s))
            .unwrap_or(i64::MIN);
        let mut out = Vec::with_capacity(top.len());
        for (score, addr) in top {
            if score_key(score) < cutoff {
                break;
            }
            let d: TantivyDocument = searcher.doc(addr).map_err(err)?;
            let get = |field: Field| {
                d.get_first(field)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            out.push(LexHit {
                chunk_id: get(f.chunk_id),
                expr: get(f.expr),
                id: get(f.id),
                score: score_key(score) as f32 / 1000.0,
            });
        }
        out.sort_by(|a, b| {
            score_key(b.score)
                .cmp(&score_key(a.score))
                .then(a.chunk_id.cmp(&b.chunk_id))
        });
        out.truncate(limit);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_tokenizer_splits_components() {
        assert_eq!(
            id_components("CFR:99-2.8"),
            vec!["cfr:99-2.8", "99-2.8", "2.8"]
        );
        assert_eq!(id_components("CITY:AM-1"), vec!["city:am-1", "am-1"]);
        assert_eq!(
            id_components("FR:2026-00001#instr-1"),
            vec!["fr:2026-00001", "2026-00001"]
        );
        let toks = cite_tokens("see 99 CFR 2.8 and CITY:AM-2 or § 1.5(a)");
        assert!(
            toks.contains(&"2.8".to_string())
                && toks.contains(&"am-2".to_string())
                && toks.contains(&"1.5".to_string()),
            "{toks:?}"
        );
        let mut tk = IdTokenizer;
        let mut s = tk.token_stream("CFR:99-2.8 text CFR:99-1.5#a-2");
        let mut got = Vec::new();
        while s.advance() {
            got.push(s.token().text.clone());
        }
        assert_eq!(
            got,
            vec!["cfr:99-2.8", "99-2.8", "2.8", "cfr:99-1.5", "99-1.5", "1.5"]
        );
    }

    fn doc(id: &str, title: &str, body: &str, kind: &str) -> LexDoc {
        LexDoc {
            chunk_id: format!("{id}@2024-01-01#c0"),
            expr: format!("{id}@2024-01-01"),
            id: id.into(),
            node: None,
            title: title.into(),
            path: format!("Title 99 > § {title}"),
            context: String::new(),
            body: body.into(),
            citations: vec![id.into()],
            terms_defined: vec![],
            source: "cfr-title-99".into(),
            kind: kind.into(),
            effective: chrono::NaiveDate::from_ymd_opt(2024, 1, 1),
            superseded: false,
        }
    }

    #[test]
    fn tied_candidates_are_stable_across_build_order_and_incremental_segments() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let mut docs: Vec<_> = (0..240)
            .map(|i| {
                doc(
                    &format!("T:{i:04}"),
                    "Quasar",
                    "An identical quasar condition.",
                    "base",
                )
            })
            .collect();
        build(a.path(), &docs).unwrap();
        docs.reverse();
        build(b.path(), &docs[..120]).unwrap();
        update(b.path(), &[], &docs[120..]).unwrap();
        let search = |dir: &Path| {
            LexicalIndex::open(dir)
                .unwrap()
                .search("quasar", &Filter::default(), 17)
                .unwrap()
                .into_iter()
                .map(|h| (h.chunk_id, h.score))
                .collect::<Vec<_>>()
        };
        let first = search(a.path());
        assert_eq!(first, search(b.path()));
        assert_eq!(first.len(), 17);
        assert!(first[0].0.starts_with("T:0000@"));
        assert!(first[16].0.starts_with("T:0016@"));
        assert_eq!(score_key(103.723724), score_key(103.72373));
    }

    #[test]
    fn builds_and_searches_with_boosts_and_filters() {
        let tmp = tempfile::tempdir().unwrap();
        let docs = vec![
            doc(
                "CFR:99-2.8",
                "Guardrail systems",
                "The top rail shall be 42 inches above the walking surface.",
                "base",
            ),
            doc(
                "CFR:99-2.4",
                "Duty to have fall protection",
                "A guardrail system meeting the criteria; see CFR:99-2.8.",
                "base",
            ),
            doc(
                "NOTE:x",
                "Guardrails compared",
                "guardrail guardrail guardrail rails and rails",
                "note",
            ),
        ];
        build(tmp.path(), &docs).unwrap();
        let lx = LexicalIndex::open(tmp.path()).unwrap();
        assert_eq!(
            lx.text_terms("The guardrails of the top rail"),
            vec!["guardrail", "top", "rail"]
        );
        let hits = lx
            .search("guardrail systems", &Filter::default(), 10)
            .unwrap();
        assert_eq!(hits[0].id, "CFR:99-2.8", "title boost wins: {hits:?}");
        let hits = lx
            .search(
                "guardrail",
                &Filter {
                    kind: Some("note".into()),
                    ..Default::default()
                },
                10,
            )
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "NOTE:x");
        let hits = lx.search("99 CFR 2.8", &Filter::default(), 10).unwrap();
        assert_eq!(hits[0].id, "CFR:99-2.8", "citations field: {hits:?}");
        let only = HashSet::from(["CFR:99-2.4@2024-01-01".to_string()]);
        let hits = lx
            .search(
                "guardrail",
                &Filter {
                    exprs: Some(only),
                    ..Default::default()
                },
                10,
            )
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "CFR:99-2.4");
        // Incremental update: replace one Expression's chunks, remove another's.
        let mut changed = doc(
            "CFR:99-2.8",
            "Guardrail systems",
            "The top rail shall be 48 inches now.",
            "base",
        );
        changed.chunk_id = "CFR:99-2.8@2024-01-01#c0".into();
        update(
            tmp.path(),
            &[
                "CFR:99-2.8@2024-01-01".to_string(),
                "NOTE:x@2024-01-01".to_string(),
            ],
            &[changed],
        )
        .unwrap();
        let lx = LexicalIndex::open(tmp.path()).unwrap();
        let hits = lx.search("48 inches", &Filter::default(), 10).unwrap();
        assert_eq!(hits[0].id, "CFR:99-2.8");
        assert!(
            lx.search("42", &Filter::default(), 10).unwrap().is_empty(),
            "old text gone"
        );
        assert!(
            lx.search(
                "guardrail",
                &Filter {
                    kind: Some("note".into()),
                    ..Default::default()
                },
                10
            )
            .unwrap()
            .is_empty(),
            "removed Expression gone"
        );
    }
}
