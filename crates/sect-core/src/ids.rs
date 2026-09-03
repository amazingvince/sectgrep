//! Work / Expression identifiers (spec B.4). A Work is `CFR:99-2.7`; an Expression is
//! `CFR:99-2.7@2024-01-01`; an Action is `FR:2026-00001#instr-1`.

use chrono::NaiveDate;

/// Expression id for a Work at an effective date; falls back to the Work id when undated.
pub fn expr_id(work: &str, effective: Option<NaiveDate>) -> String {
    match effective {
        Some(d) => format!("{work}@{}", d.format("%Y-%m-%d")),
        None => work.to_string(),
    }
}

/// Split `CFR:99-2.7@2024-01-01` into (`CFR:99-2.7`, Some(`2024-01-01`)).
pub fn split_expr(s: &str) -> (&str, Option<&str>) {
    match s.split_once('@') {
        Some((w, d)) => (w, Some(d)),
        None => (s, None),
    }
}

/// Strip an anchor: `CFR:99-1.5#a-2` -> (`CFR:99-1.5`, Some(`a-2`)).
pub fn split_anchor(s: &str) -> (&str, Option<&str>) {
    match s.split_once('#') {
        Some((w, a)) => (w, Some(a)),
        None => (s, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expr_roundtrip() {
        let d = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
        assert_eq!(expr_id("CFR:99-2.7", Some(d)), "CFR:99-2.7@2024-01-01");
        assert_eq!(split_expr("CFR:99-2.7@2024-01-01"), ("CFR:99-2.7", Some("2024-01-01")));
        assert_eq!(split_expr("CFR:99-2.7"), ("CFR:99-2.7", None));
        assert_eq!(split_anchor("CFR:99-1.5#a-2"), ("CFR:99-1.5", Some("a-2")));
    }
}
