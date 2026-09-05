//! Ad-hoc: per-call cost of the stat paths on a corpus. `cargo run --release -p sect-corpus --example statbench -- <root>`
use std::path::PathBuf;
use std::time::Instant;

fn main() {
    let root = PathBuf::from(std::env::args().nth(1).expect("root"));
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    for e in ignore::WalkBuilder::new(&root)
        .hidden(true)
        .build()
        .flatten()
    {
        if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            dirs.push(e.into_path());
        } else if e.path().extension().map(|x| x == "md").unwrap_or(false) {
            files.push(e.into_path());
        }
    }
    println!("{} files, {} dirs", files.len(), dirs.len());
    for round in 0..2 {
        let t = Instant::now();
        let mut n = 0;
        for f in &files {
            if sect_corpus::stat_file(f).is_ok() {
                n += 1;
            }
        }
        println!(
            "round {round}: stat_file (fast path) files: {} ms ({n} ok)",
            t.elapsed().as_millis()
        );
        let t = Instant::now();
        for f in &files {
            let _ = std::fs::metadata(f);
        }
        println!(
            "round {round}: std::fs::metadata files: {} ms",
            t.elapsed().as_millis()
        );
        let t = Instant::now();
        for d in &dirs {
            let _ = sect_corpus::stat_file(d);
        }
        println!(
            "round {round}: stat_file dirs: {} ms",
            t.elapsed().as_millis()
        );
        let t = Instant::now();
        let mut entries = 0usize;
        for d in &dirs {
            if let Ok(rd) = std::fs::read_dir(d) {
                for e in rd.flatten() {
                    let _ = e.metadata();
                    entries += 1;
                }
            }
        }
        println!(
            "round {round}: read_dir + entry metadata over all dirs: {} ms ({entries} entries)",
            t.elapsed().as_millis()
        );
    }
}
