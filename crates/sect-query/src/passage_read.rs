//! A derived passage expands to the exact canonical revisions that supplied its spans.
use super::{ReadOptions, ReadResult};
use sect_core::{split_expr, Response, Result, SectError};
use sect_index::{
    chunks::{SourceSpan, SupportSpan},
    Index,
};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct PassageRead {
    pub version: u32,
    pub chunk_id: String,
    pub recipe: String,
    /// The passage body before canonical-section expansion or overlay display markers.
    pub body: String,
    pub spans: Vec<SourceSpan>,
    pub support: Vec<SupportSpan>,
    /// Other complete canonical sections in source order. The selected section is the
    /// enclosing ReadResult; each nested result has passage=None.
    pub additional_sections: Vec<ReadResult>,
}

pub(super) fn is_address(id: &str) -> bool {
    id.rsplit_once("#p")
        .is_some_and(|(_, hash)| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
}

pub(super) fn read(index: &Index, id: &str, opts: &ReadOptions) -> Result<Response<ReadResult>> {
    let state = index.search_state()?;
    let chunk = state
        .by_chunk
        .get(id)
        .map(|&i| &state.chunks[i])
        .filter(|c| c.chunk_id == id)
        .ok_or_else(|| {
            SectError::NotFound(format!(
                "{id} (passage is absent from this generation; use its canonical Expression address to navigate other revisions)"
            ))
        })?;
    let mut members = Vec::new();
    for span in &chunk.spans {
        if !members.contains(&span.expr.as_str()) {
            members.push(span.expr.as_str());
        }
    }
    if members.is_empty() {
        members.push(&chunk.expr);
    }
    let selected = opts.version.as_deref().unwrap_or(&chunk.expr);
    if !members.contains(&selected) {
        return Err(SectError::Other(
            "--version must name an exact Expression contained in this passage; read the canonical Work to select another revision".into(),
        ));
    }
    if let Some(date) = opts.as_of {
        for member in &members {
            if index
                .tree
                .as_of(split_expr(member).0, date)
                .is_none_or(|e| e.expr != *member)
            {
                return Err(SectError::Other(format!(
                    "passage member {member} is not in force as of {date}; read its canonical Work to select that date"
                )));
            }
        }
    }
    let canonical_options = ReadOptions {
        version: None,
        ..opts.clone()
    };
    let mut result = super::read(index, selected, &canonical_options)?;
    let additional_sections = members
        .iter()
        .filter(|&&e| e != selected)
        .map(|e| super::read(index, e, &canonical_options).map(|r| r.result))
        .collect::<Result<Vec<_>>>()?;
    result.header.counts.shown = members.len();
    result.header.counts.matched = members.len();
    result.result.passage = Some(PassageRead {
        version: 1,
        chunk_id: chunk.chunk_id.clone(),
        recipe: chunk.recipe.clone(),
        body: chunk.body.clone(),
        spans: chunk.spans.clone(),
        support: chunk.support.clone(),
        additional_sections,
    });
    Ok(result)
}
