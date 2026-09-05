//! Parse selected real source files without building an index or changing the corpus.
use sect_corpus::{load_sources, parse_document, CorpusFile, Resolver};
use std::{path::PathBuf, time::Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(
        args.next()
            .ok_or("usage: parsebench CORPUS RELATIVE_FILE...")?,
    );
    let sources = load_sources(&root)?;
    let resolver = Resolver::new(&sources);
    for relative in args {
        if relative == "--walk" {
            eprintln!("walk-start: {}", root.display());
            let start = Instant::now();
            let files = sect_corpus::walk_corpus(&root, &sources)?;
            println!(
                "{}",
                serde_json::json!({"walk_ms": start.elapsed().as_secs_f64() * 1000.0, "files": files.len()})
            );
            continue;
        }
        let source = sources
            .values()
            .find(|s| relative.starts_with(&format!("{}/", s.dir)))
            .ok_or("file is outside configured sources")?;
        let file = CorpusFile {
            abs: root.join(&relative),
            rel: relative,
            source: source.name.clone(),
        };
        eprintln!("parse-start: {}", file.rel);
        let start = Instant::now();
        let doc = parse_document(&file, &resolver)?;
        println!(
            "{}",
            serde_json::json!({"file": file.rel, "elapsed_ms": start.elapsed().as_secs_f64() * 1000.0,
            "body_bytes": doc.body.len(), "definitions": doc.definitions.len(), "links": doc.links.len(),
            "tables": doc.tables.len(), "rows": doc.tables.iter().map(|t| t.rows.len()).sum::<usize>(),
            "paragraph_anchors": doc.paragraph_anchors.len()})
        );
    }
    Ok(())
}
