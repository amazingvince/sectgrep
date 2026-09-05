//! Compare a legacy and normalized graph without expanding usage views into JSON.
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path};

fn digest(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        return Err("usage: graph_parity OLD_GENERATION NEW_GENERATION".into());
    }
    let old_dir = Path::new(&args[0]);
    let new_dir = Path::new(&args[1]);
    let old = sect_struct::Graph::load(old_dir)?;
    let new = sect_struct::Graph::load(new_dir)?;
    assert!(old.edges == new.edges, "relationships changed");
    assert!(old.actions == new.actions, "actions changed");
    assert!(old.tables == new.tables, "tables changed");
    assert!(
        old.terms == new.terms,
        "definition metadata or usage views changed"
    );
    let mut hashes = std::collections::BTreeMap::new();
    for name in ["chunks.jsonl", "vectors.bin", "tree.json", "regions.json"] {
        let before = digest(&old_dir.join(name))?;
        let after = digest(&new_dir.join(name))?;
        assert_eq!(before, after, "artifact changed: {name}");
        hashes.insert(name, before);
    }
    println!(
        "{}",
        serde_json::json!({
            "purpose":"representation parity, not relevance qualification",
            "old_generation":old_dir.file_name().and_then(|name| name.to_str()), "new_generation":new_dir.file_name().and_then(|name| name.to_str()),
            "relationships":old.edges.len(), "actions":old.actions.len(), "tables":old.tables.len(),
            "definitions":old.terms.len(), "usage_entries_compared":old.terms.values().map(|term| term.usages.iter().count()).sum::<usize>(),
            "all_graph_views_identical":true, "identical_artifact_sha256":hashes,
            "old_terms_bytes":std::fs::metadata(old_dir.join("terms.json"))?.len(),
            "new_terms_and_pool_bytes":std::fs::metadata(new_dir.join("terms.json"))?.len() + std::fs::metadata(new_dir.join("term-usages.json"))?.len()
        })
    );
    Ok(())
}
