//! Attribute process-cold query loading costs; not a latency qualification runner.
use std::{path::Path, time::Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::args().nth(1).ok_or("usage: query_load CORPUS")?;
    let mut times = std::collections::BTreeMap::new();
    let start = Instant::now();
    let index = sect_index::open(Path::new(&root), sect_core::Refresh::No)?;
    times.insert(
        "open_including_freshness_ms",
        start.elapsed().as_secs_f64() * 1000.0,
    );
    let start = Instant::now();
    let state = index.search_state()?;
    times.insert(
        "query_projection_ms",
        start.elapsed().as_secs_f64() * 1000.0,
    );
    let start = Instant::now();
    let _lexical = index.lexical()?;
    times.insert("lexical_ms", start.elapsed().as_secs_f64() * 1000.0);
    let start = Instant::now();
    let _vectors = index.vectors()?;
    times.insert("vectors_ms", start.elapsed().as_secs_f64() * 1000.0);
    let start = Instant::now();
    let _model = index.embedder()?;
    times.insert("model_ms", start.elapsed().as_secs_f64() * 1000.0);
    println!(
        "{}",
        serde_json::json!({"generation":index.manifest.generation,"passages":state.chunks.len(),"stages":times})
    );
    Ok(())
}
