//! Query projection of immutable passage records. Index-only context and serialized model
//! inputs stay on disk; evidence bodies, addresses and support spans remain available.
use crate::chunks::{SourceSpan, SupportSpan};
use chrono::NaiveDate;
use rayon::prelude::*;
use sect_core::{Result, SectError};
use serde::Deserialize;
use std::{
    collections::HashSet,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
};

#[derive(Debug, Deserialize)]
pub struct QueryChunk {
    pub chunk_id: String,
    pub expr: String,
    pub id: String,
    pub part: usize,
    pub nparts: usize,
    pub label: String,
    pub title: String,
    pub breadcrumb: String,
    pub body: String,
    pub line_start: usize,
    pub source: String,
    pub kind: String,
    pub effective: Option<NaiveDate>,
    pub superseded: bool,
    #[serde(default)]
    pub recipe: String,
    #[serde(default)]
    pub spans: Vec<SourceSpan>,
    #[serde(default)]
    pub navigation: bool,
    #[serde(default)]
    pub source_document: bool,
    #[serde(default)]
    pub support: Vec<SupportSpan>,
    #[serde(skip)]
    offset: u64,
    #[serde(skip)]
    length: usize,
}

impl QueryChunk {
    pub fn has_expression(&self, expr: &str) -> bool {
        self.expr == expr || self.spans.iter().any(|s| s.expr == expr)
    }

    pub fn selected(&self, allowed: &HashSet<String>) -> bool {
        allowed.contains(&self.expr) || self.spans.iter().any(|s| allowed.contains(&s.expr))
    }

    /// Old passage recipes may lack source spans. Preserve their exact confidence input
    /// by reading just the selected immutable record rather than reconstructing its text.
    pub fn legacy_text(&self, path: &Path) -> Result<String> {
        #[derive(Deserialize)]
        struct Text {
            chunk_id: String,
            text: String,
        }
        let mut file = std::fs::File::open(path).map_err(|e| SectError::io(path, e))?;
        file.seek(SeekFrom::Start(self.offset))
            .map_err(|e| SectError::io(path, e))?;
        let mut bytes = vec![0; self.length];
        file.read_exact(&mut bytes)
            .map_err(|e| SectError::io(path, e))?;
        let record: Text = serde_json::from_slice(&bytes)?;
        if record.chunk_id != self.chunk_id {
            return Err(SectError::Other(
                "pinned passage record identity changed".into(),
            ));
        }
        Ok(record.text)
    }
}

pub fn load(path: &Path) -> Result<Vec<QueryChunk>> {
    let mut reader = BufReader::with_capacity(
        1024 * 1024,
        std::fs::File::open(path).map_err(|e| SectError::io(path, e))?,
    );
    // Reuse a small batch of line buffers. Parse independent records in parallel while
    // retaining file order and deterministic errors. Oversized single records remain
    // intact; the byte threshold prevents accumulating many large records together.
    let mut batch = vec![(0, Vec::new()); 256];
    let mut chunks = Vec::new();
    let mut offset = 0;
    loop {
        let mut used = 0;
        let mut bytes = 0;
        for (start, line) in &mut batch {
            line.clear();
            let length = reader
                .read_until(b'\n', line)
                .map_err(|e| SectError::io(path, e))?;
            if length == 0 {
                break;
            }
            *start = offset;
            offset += length as u64;
            used += 1;
            bytes += length;
            if bytes >= 8 * 1024 * 1024 {
                break;
            }
        }
        if used == 0 {
            break;
        }
        let records: Vec<Result<Option<QueryChunk>>> = batch[..used]
            .par_iter()
            .with_min_len(16)
            .map(|(offset, bytes)| {
                // Validate the whole record, including ignored indexing fields. Moving
                // this scan to the parsing workers avoids serial UTF-8 work during I/O.
                let line = std::str::from_utf8(bytes).map_err(|e| {
                    SectError::io(
                        path,
                        std::io::Error::new(std::io::ErrorKind::InvalidData, e),
                    )
                })?;
                if line.trim().is_empty() {
                    return Ok(None);
                }
                let mut chunk: QueryChunk = serde_json::from_str(line)?;
                chunk.offset = *offset;
                chunk.length = line.len();
                Ok(Some(chunk))
            })
            .collect();
        for record in records {
            if let Some(chunk) = record? {
                chunks.push(chunk);
            }
        }
    }
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_text_reads_exact_selected_record_after_unicode_and_blank_lines() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chunks.jsonl");
        let mut bytes = String::from("\r\n");
        for n in 0..519 {
            let id = format!("record-{n}");
            let row = serde_json::json!({
                "chunk_id":id,"expr":id,"id":id,"part":0,"nparts":1,"label":"λ",
                "title":"α", "breadcrumb":"é", "body":"body", "line_start":1,
                "source":"s", "kind":"base", "effective":null, "superseded":false,
                "text":format!("原文 {id}\n\"quoted\""), "context":"unused index context"
            });
            bytes.push_str(&row.to_string());
            bytes.push_str("\r\n\r\n");
        }
        std::fs::write(&path, bytes).unwrap();
        let chunks = load(&path).unwrap();
        assert_eq!(chunks.len(), 519);
        for (n, c) in chunks.iter().enumerate() {
            assert_eq!(c.chunk_id, format!("record-{n}"));
            assert_eq!(
                c.legacy_text(&path).unwrap(),
                format!("原文 {}\n\"quoted\"", c.chunk_id)
            );
        }
        let mut altered = chunks;
        altered[1].chunk_id = "wrong".into();
        assert!(altered[1].legacy_text(&path).is_err());
        std::fs::write(&path, b"{\"context\":\"\xff\"}\n").unwrap();
        assert!(matches!(load(&path), Err(SectError::Io { .. })));
    }
}
