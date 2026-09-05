//! Document inputs and a generation-local, mapped store for their virtual section projections.
use sect_core::{
    sections::{safe_relative, SectionBundle},
    Result, SectError, SourceConfig,
};
use sect_corpus::{Document, Resolver};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub const CATALOG: &str = "sections.json";
const TEXT: &str = "sections.bin";

pub struct Input {
    pub doc: Document,
    pub text: String,
    pub hash: String,
}

pub fn load_inputs(
    root: &Path,
    sources: &BTreeMap<String, SourceConfig>,
    files: &BTreeMap<String, PathBuf>,
    fingerprints: &BTreeMap<String, sect_corpus::Fingerprint>,
    resolver: &Resolver,
) -> Result<BTreeMap<String, Input>> {
    let mut out = BTreeMap::new();
    for src in sources
        .values()
        .filter(|s| s.input_mode == sect_core::source::InputMode::Document)
    {
        let prefix = format!("{}/", src.dir);
        for (rel, abs) in files
            .iter()
            .filter(|(p, _)| p.starts_with(&prefix) && p.ends_with(".sections.json"))
        {
            let bytes = std::fs::read(abs).map_err(|e| SectError::io(abs, e))?;
            if blake3::hash(&bytes).to_hex().as_str() != fingerprints[rel].blake3 {
                return Err(SectError::Other(format!(
                    "section bundle changed during build: {rel}; retry"
                )));
            }
            let bundle: SectionBundle = serde_json::from_slice(&bytes)?;
            if bundle.schema_version != sect_core::sections::SECTION_BUNDLE_VERSION
                || bundle.recipe != sect_core::sections::SECTION_RECIPE
                || bundle.sections.is_empty()
                || bundle.artifacts.is_empty()
            {
                return Err(SectError::Other(format!("invalid section bundle: {rel}")));
            }
            let mut revisions = BTreeMap::new();
            for (artifact, hash) in &bundle.artifacts {
                if !safe_relative(artifact)
                    || !artifact.starts_with(&prefix)
                    || !artifact.ends_with(".document.json")
                    || !files.contains_key(artifact)
                {
                    return Err(SectError::Other(format!(
                        "invalid section artifact binding: {artifact}"
                    )));
                }
                let bytes =
                    std::fs::read(root.join(artifact)).map_err(|e| SectError::io(artifact, e))?;
                if format!("{:x}", Sha256::digest(&bytes)) != *hash {
                    return Err(SectError::Other(format!(
                        "section artifact hash mismatch: {artifact}"
                    )));
                }
                let document: sect_core::regions::DocumentArtifact =
                    serde_json::from_slice(&bytes)?;
                document.validate().map_err(SectError::Other)?;
                if document.document != bundle.document
                    || revisions
                        .insert(document.effective.clone(), document)
                        .is_some()
                {
                    return Err(SectError::Other(format!(
                        "section artifact identity mismatch: {artifact}"
                    )));
                }
            }
            for (path, text) in bundle.sections {
                if !safe_relative(&path)
                    || !path.starts_with(&prefix)
                    || path.starts_with(&format!("{prefix}exports/"))
                    || !path.ends_with(".md")
                    || files.contains_key(&path)
                {
                    return Err(SectError::Other(format!(
                        "invalid or colliding virtual section path: {path}"
                    )));
                }
                let doc = sect_corpus::document::parse_text(&path, &src.name, &text, resolver)?;
                let id = doc.front.id.as_deref().unwrap_or_default();
                let date = doc
                    .front
                    .effective
                    .map(|d| d.to_string())
                    .unwrap_or_default();
                let artifact = revisions.get(&date).ok_or_else(|| {
                    SectError::Other(format!("section revision lacks a bound artifact: {path}"))
                })?;
                if doc.front.source.as_deref() != Some(&src.name)
                    || (id != bundle.document && !artifact.units.iter().any(|u| u.id == id))
                    || doc
                        .front
                        .provenance
                        .as_ref()
                        .and_then(|p| p.raw_sha256.as_deref())
                        != Some(&artifact.raw_sha256)
                {
                    return Err(SectError::Other(format!(
                        "section identity/provenance differs from organized document: {path}"
                    )));
                }
                let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
                if out
                    .insert(path.clone(), Input { doc, text, hash })
                    .is_some()
                {
                    return Err(SectError::Other(format!(
                        "duplicate virtual section path: {path}"
                    )));
                }
            }
        }
    }
    Ok(out)
}

#[derive(Serialize, Deserialize)]
struct Span {
    start: usize,
    end: usize,
}

pub fn write(dir: &Path, inputs: &BTreeMap<String, Input>) -> Result<()> {
    use std::io::Write;
    let mut data = std::fs::File::create(dir.join(TEXT)).map_err(|e| SectError::io(dir, e))?;
    let mut catalog = BTreeMap::new();
    let mut start = 0;
    for (path, input) in inputs {
        let end = start + input.text.len();
        data.write_all(input.text.as_bytes())
            .map_err(|e| SectError::io(dir, e))?;
        catalog.insert(path, Span { start, end });
        start = end;
    }
    data.sync_all().map_err(|e| SectError::io(dir, e))?;
    std::fs::write(dir.join(CATALOG), serde_json::to_vec(&catalog)?)
        .map_err(|e| SectError::io(dir, e))?;
    Ok(())
}

pub struct Store {
    catalog: BTreeMap<String, Span>,
    data: Option<memmap2::Mmap>,
}

impl Store {
    pub fn open(dir: &Path) -> Result<Self> {
        if !dir.join(CATALOG).exists() {
            return Ok(Self {
                catalog: BTreeMap::new(),
                data: None,
            });
        }
        let catalog: BTreeMap<String, Span> = serde_json::from_slice(
            &std::fs::read(dir.join(CATALOG)).map_err(|e| SectError::io(dir, e))?,
        )?;
        let file = std::fs::File::open(dir.join(TEXT)).map_err(|e| SectError::io(dir, e))?;
        let len = file.metadata().map_err(|e| SectError::io(dir, e))?.len() as usize;
        let mut end = 0;
        for (path, span) in &catalog {
            if !safe_relative(path) || span.start != end || span.end <= span.start || span.end > len
            {
                return Err(SectError::Other("invalid mapped section catalog".into()));
            }
            end = span.end;
        }
        if end != len {
            return Err(SectError::Other("section store length mismatch".into()));
        }
        // Published generations are immutable and the mapping is retained for this reader.
        let data = if len == 0 {
            None
        } else {
            Some(
                unsafe { memmap2::MmapOptions::new().map(&file) }
                    .map_err(|e| SectError::io(dir, e))?,
            )
        };
        Ok(Self { catalog, data })
    }

    pub fn text(&self, path: &str) -> Result<Option<&str>> {
        self.catalog
            .get(path)
            .map(|s| {
                std::str::from_utf8(
                    &self.data.as_ref().expect("nonempty catalog has data")[s.start..s.end],
                )
                .map_err(|e| SectError::Other(format!("invalid section UTF-8: {path}: {e}")))
            })
            .transpose()
    }

    pub fn paths(&self) -> impl Iterator<Item = &String> {
        self.catalog.keys()
    }
}
