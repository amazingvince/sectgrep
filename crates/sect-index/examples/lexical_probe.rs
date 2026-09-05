//! Print raw lexical scores when investigating rebuild parity; does not modify the index.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let index = sect_index::open(std::path::Path::new(&args[1]), sect_core::Refresh::No)?;
    let hits = index.lexical()?.search(
        &args[2],
        &sect_lexical::Filter {
            source: args.get(3).cloned(),
            ..Default::default()
        },
        200,
    )?;
    println!("{}", serde_json::to_string_pretty(&hits)?);
    Ok(())
}
