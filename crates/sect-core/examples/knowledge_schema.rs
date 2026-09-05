fn main() {
    println!(
        "{}",
        serde_json::to_string_pretty(&schemars::schema_for!(
            sect_core::knowledge::KnowledgeArtifact
        ))
        .unwrap()
    );
}
