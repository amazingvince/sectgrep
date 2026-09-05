//! Isolate lexical build failures/cost from extraction and snapshot I/O.
//! cargo run --release -p sect-lexical --example build_chunks -- path/to/chunks.jsonl
use std::io::{BufRead, BufReader};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("expected chunks.jsonl path")?;
    let mut docs = Vec::new();
    for line in BufReader::new(std::fs::File::open(path)?).lines() {
        let mut value: serde_json::Value = serde_json::from_str(&line?)?;
        value["path"] = value["breadcrumb"].clone();
        docs.push(serde_json::from_value::<sect_lexical::LexDoc>(value)?);
    }
    let directory = match std::env::args().nth(2) {
        Some(parent) => tempfile::tempdir_in(parent)?,
        None => tempfile::tempdir()?,
    }
    .keep();
    eprintln!("Lexical diagnostic directory: {}", directory.display());
    let start = std::time::Instant::now();
    sect_lexical::build(&directory, &docs)?;
    println!(
        "{}",
        serde_json::json!({"documents":docs.len(), "elapsed_ms":start.elapsed().as_millis(), "directory":directory})
    );
    Ok(())
}
