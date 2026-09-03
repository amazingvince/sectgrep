//! Sparse n-gram prefilter for `grep` (spec B.4 exact, milestone 3b).
//!
//! The index answers one question: which files can possibly contain a given byte string? Every
//! file's text (ASCII-lowercased) is cut into 4-byte grams at positions chosen by a
//! deterministic rule over corpus-derived pair weights; each gram maps to a roaring bitmap of
//! file ids. A query extracts the literals a regex must contain, cuts them the same way, and
//! intersects their postings. The real matcher then runs on the candidates only.
//!
//! **Why it never drops a match.** The gram at position `k` covers bytes `k..k+4` and is
//! selected by looking at the three byte pairs inside it and nothing else. So the grams of any
//! substring are a subset of the grams of every string containing it, which is exactly what a
//! prefilter needs: a file that matches contains the literal, so it contains every gram the
//! literal produces, so it is in every posting the query intersects.
//!
//! **What "sparse" means here.** A gram is kept only when its middle pair is a strict local
//! extremum among the three pairs, with the weights being rarity ranks of byte pairs in this
//! corpus (ties broken by the pair's value, so all weights are distinct). About two thirds of
//! positions qualify, and a literal shorter than four bytes, or whose pair weights are monotone,
//! produces no gram and falls back to a full scan.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use memmap2::Mmap;
use regex_syntax::hir::literal::{ExtractKind, Extractor};
use roaring::RoaringBitmap;
use sect_core::{Result, SectError};
use serde::Serialize;

pub const DIR: &str = "ngram";
pub const WEIGHTS: &str = "weights.bin";
pub const TABLE: &str = "table.bin";
pub const POSTINGS: &str = "postings.bin";
pub const FILES: &str = "files.txt";
pub const GRAM: usize = 4;
/// Corpora at least this large get the layer under `--ngram auto` (spec B.4: 200 MB).
pub const DEFAULT_THRESHOLD_BYTES: u64 = 200 * 1024 * 1024;
const MAGIC: &[u8; 8] = b"SECTNGR1";
const ENTRY: usize = 16;

/// Threshold in bytes for `--ngram auto`; `SECT_NGRAM_THRESHOLD_MB` overrides the default.
pub fn threshold_bytes() -> u64 {
    std::env::var("SECT_NGRAM_THRESHOLD_MB").ok().and_then(|v| v.parse::<u64>().ok()).map(|mb| mb * 1024 * 1024).unwrap_or(DEFAULT_THRESHOLD_BYTES)
}

/// Rarity rank of every byte pair in the corpus: 0 is the most common pair, 65535 the rarest.
pub struct Weights(Vec<u16>);

impl Weights {
    pub fn from_counts(counts: &[u64]) -> Weights {
        assert_eq!(counts.len(), 65536);
        let mut idx: Vec<u32> = (0..65536).collect();
        idx.sort_by(|a, b| counts[*b as usize].cmp(&counts[*a as usize]).then(a.cmp(b)));
        let mut w = vec![0u16; 65536];
        for (rank, p) in idx.iter().enumerate() {
            w[*p as usize] = rank as u16;
        }
        Weights(w)
    }

    #[inline]
    fn pair(&self, a: u8, b: u8) -> u16 {
        self.0[((a as usize) << 8) | b as usize]
    }

    fn save(&self, path: &Path) -> Result<()> {
        let mut bytes = Vec::with_capacity(65536 * 2);
        for w in &self.0 {
            bytes.extend_from_slice(&w.to_le_bytes());
        }
        fs::write(path, bytes).map_err(|e| SectError::io(path, e))
    }

    fn load(path: &Path) -> Result<Weights> {
        let bytes = fs::read(path).map_err(|e| SectError::io(path, e))?;
        if bytes.len() != 65536 * 2 {
            return Err(SectError::Other(format!("{}: not a weights table", path.display())));
        }
        Ok(Weights(bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect()))
    }
}

#[inline]
fn lower(bytes: &[u8]) -> Vec<u8> {
    bytes.iter().map(|b| b.to_ascii_lowercase()).collect()
}

/// The selected grams of `text` (already lowercased), as big-endian u32 keys. Positions are
/// not kept: the postings are per file.
pub fn grams(text: &[u8], w: &Weights, out: &mut Vec<u32>) {
    out.clear();
    if text.len() < GRAM {
        return;
    }
    for k in 0..=text.len() - GRAM {
        let (a, b, c, d) = (text[k], text[k + 1], text[k + 2], text[k + 3]);
        let (w0, w1, w2) = (w.pair(a, b), w.pair(b, c), w.pair(c, d));
        if (w1 > w0 && w1 > w2) || (w1 < w0 && w1 < w2) {
            out.push(u32::from_be_bytes([a, b, c, d]));
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BuildStats {
    pub files: usize,
    pub bytes: u64,
    pub grams: usize,
    pub table_bytes: u64,
    pub postings_bytes: u64,
    pub elapsed_ms: u128,
}

/// Build the layer for `files` (relative path, absolute path), in that order: the position in
/// the list is the file id.
pub fn build(files: &[(String, PathBuf)], out_dir: &Path) -> Result<BuildStats> {
    let t0 = Instant::now();
    fs::create_dir_all(out_dir).map_err(|e| SectError::io(out_dir, e))?;
    let mut counts = vec![0u64; 65536];
    let mut texts: Vec<Vec<u8>> = Vec::with_capacity(files.len());
    let mut bytes = 0u64;
    for (_, abs) in files {
        let t = lower(&fs::read(abs).map_err(|e| SectError::io(abs, e))?);
        bytes += t.len() as u64;
        for win in t.windows(2) {
            counts[((win[0] as usize) << 8) | win[1] as usize] += 1;
        }
        texts.push(t);
    }
    let weights = Weights::from_counts(&counts);
    let mut postings: HashMap<u32, RoaringBitmap> = HashMap::new();
    let mut buf = Vec::new();
    for (doc, t) in texts.iter().enumerate() {
        grams(t, &weights, &mut buf);
        buf.sort_unstable();
        buf.dedup();
        for g in &buf {
            postings.entry(*g).or_default().insert(doc as u32);
        }
    }
    drop(texts);
    let mut keys: Vec<u32> = postings.keys().copied().collect();
    keys.sort_unstable();
    let mut post: Vec<u8> = Vec::new();
    let mut table: Vec<u8> = Vec::with_capacity(16 + ENTRY * keys.len());
    table.extend_from_slice(MAGIC);
    table.extend_from_slice(&(keys.len() as u64).to_le_bytes());
    for k in &keys {
        let bm = &postings[k];
        let off = post.len() as u64;
        bm.serialize_into(&mut post).map_err(|e| SectError::Other(format!("postings: {e}")))?;
        let len = (post.len() as u64 - off) as u32;
        table.extend_from_slice(&k.to_le_bytes());
        table.extend_from_slice(&off.to_le_bytes());
        table.extend_from_slice(&len.to_le_bytes());
    }
    weights.save(&out_dir.join(WEIGHTS))?;
    let write = |name: &str, data: &[u8]| -> Result<()> {
        let p = out_dir.join(name);
        let mut f = fs::File::create(&p).map_err(|e| SectError::io(&p, e))?;
        f.write_all(data).map_err(|e| SectError::io(&p, e))
    };
    write(TABLE, &table)?;
    write(POSTINGS, &post)?;
    let list: String = files.iter().map(|(rel, _)| rel.as_str()).collect::<Vec<_>>().join("\n") + "\n";
    write(FILES, list.as_bytes())?;
    Ok(BuildStats { files: files.len(), bytes, grams: keys.len(), table_bytes: table.len() as u64, postings_bytes: post.len() as u64, elapsed_ms: t0.elapsed().as_millis() })
}

/// What the prefilter decided for one grep: the literals it used, the candidate files (None
/// means it could not help and the scan is exhaustive), and why.
#[derive(Debug, Clone, Serialize)]
pub struct Plan {
    pub literals: Vec<String>,
    #[serde(skip)]
    pub candidates: Option<Vec<String>>,
    pub candidate_count: Option<usize>,
    pub files_total: usize,
    pub reason: String,
    pub elapsed_ms: f64,
}

pub struct Prefilter {
    files: Vec<String>,
    weights: Weights,
    table: Mmap,
    postings: Mmap,
    count: usize,
}

impl Prefilter {
    pub fn exists(dir: &Path) -> bool {
        dir.join(TABLE).is_file() && dir.join(POSTINGS).is_file() && dir.join(WEIGHTS).is_file() && dir.join(FILES).is_file()
    }

    pub fn open(dir: &Path) -> Result<Prefilter> {
        let map = |name: &str| -> Result<Mmap> {
            let p = dir.join(name);
            let f = fs::File::open(&p).map_err(|e| SectError::io(&p, e))?;
            // SAFETY: the files are written once by `build` and replaced whole by the next build.
            unsafe { Mmap::map(&f) }.map_err(|e| SectError::io(&p, e))
        };
        let table = map(TABLE)?;
        if table.len() < 16 || &table[..8] != MAGIC {
            return Err(SectError::Other(format!("{}: not an n-gram table", dir.join(TABLE).display())));
        }
        let count = u64::from_le_bytes(table[8..16].try_into().unwrap()) as usize;
        if table.len() < 16 + count * ENTRY {
            return Err(SectError::Other(format!("{}: truncated table", dir.join(TABLE).display())));
        }
        let postings = map(POSTINGS)?;
        let weights = Weights::load(&dir.join(WEIGHTS))?;
        let files_path = dir.join(FILES);
        let files: Vec<String> = fs::read_to_string(&files_path).map_err(|e| SectError::io(&files_path, e))?.lines().map(str::to_string).collect();
        Ok(Prefilter { files, weights, table, postings, count })
    }

    pub fn files(&self) -> &[String] {
        &self.files
    }

    #[inline]
    fn entry(&self, i: usize) -> (u32, u64, u32) {
        let b = &self.table[16 + i * ENTRY..16 + (i + 1) * ENTRY];
        (u32::from_le_bytes(b[0..4].try_into().unwrap()), u64::from_le_bytes(b[4..12].try_into().unwrap()), u32::from_le_bytes(b[12..16].try_into().unwrap()))
    }

    /// The files containing a gram: binary search in the sorted table, then one bitmap decode.
    fn posting(&self, key: u32) -> Option<RoaringBitmap> {
        let (mut lo, mut hi) = (0usize, self.count);
        while lo < hi {
            let mid = (lo + hi) / 2;
            let (k, off, len) = self.entry(mid);
            if k == key {
                let bytes = &self.postings[off as usize..off as usize + len as usize];
                return RoaringBitmap::deserialize_from(bytes).ok();
            } else if k < key {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        None
    }

    /// Files that can contain `literal` (raw bytes; lowercased here). None when the literal has
    /// no gram and therefore cannot narrow anything.
    pub fn candidates_for(&self, literal: &[u8]) -> Option<RoaringBitmap> {
        let l = lower(literal);
        let mut keys = Vec::new();
        grams(&l, &self.weights, &mut keys);
        if keys.is_empty() {
            return None;
        }
        keys.sort_unstable();
        keys.dedup();
        let mut acc: Option<RoaringBitmap> = None;
        for k in keys {
            let bm = self.posting(k).unwrap_or_default();
            acc = Some(match acc {
                None => bm,
                Some(a) => a & bm,
            });
            if acc.as_ref().map(|a| a.is_empty()).unwrap_or(false) {
                break;
            }
        }
        acc
    }

    /// Decide for a whole grep: patterns are OR'ed, so candidates are the union over patterns of
    /// the union over each pattern's alternative literals of the intersection of gram postings.
    pub fn plan(&self, patterns: &[String], fixed_strings: bool, ignore_case: bool) -> Plan {
        let t0 = Instant::now();
        let total = self.files.len();
        let mut all = RoaringBitmap::new();
        let mut used: Vec<String> = Vec::new();
        for p in patterns {
            let Some(lits) = required_literals(p, fixed_strings) else {
                return Plan { literals: used, candidates: None, candidate_count: None, files_total: total, reason: format!("no required literal in {p:?}; full scan"), elapsed_ms: ms(t0) };
            };
            for lit in lits {
                if ignore_case && !lit.is_ascii() {
                    return Plan { literals: used, candidates: None, candidate_count: None, files_total: total, reason: "case-insensitive non-ASCII literal; full scan".into(), elapsed_ms: ms(t0) };
                }
                let Some(bm) = self.candidates_for(&lit) else {
                    return Plan { literals: used, candidates: None, candidate_count: None, files_total: total, reason: format!("literal {:?} produces no gram; full scan", String::from_utf8_lossy(&lit)), elapsed_ms: ms(t0) };
                };
                used.push(String::from_utf8_lossy(&lit).to_string());
                all |= bm;
            }
        }
        let files: Vec<String> = all.iter().filter_map(|i| self.files.get(i as usize).cloned()).collect();
        let n = files.len();
        Plan { literals: used, candidates: Some(files), candidate_count: Some(n), files_total: total, reason: format!("{n} of {total} files can contain a required literal"), elapsed_ms: ms(t0) }
    }
}

fn ms(t0: Instant) -> f64 {
    t0.elapsed().as_secs_f64() * 1000.0
}

/// The literals every match of `pattern` must contain, as alternatives: prefixes or suffixes
/// from `regex_syntax`'s extractor, whichever set has the longer shortest literal. None when the
/// pattern has no finite set of required literals (`\d+`, `.*`, an empty alternative).
pub fn required_literals(pattern: &str, fixed_strings: bool) -> Option<Vec<Vec<u8>>> {
    let text = if fixed_strings { regex_syntax::escape(pattern) } else { pattern.to_string() };
    let hir = regex_syntax::ParserBuilder::new().build().parse(&text).ok()?;
    let mut best: Option<Vec<Vec<u8>>> = None;
    for kind in [ExtractKind::Prefix, ExtractKind::Suffix] {
        let seq = Extractor::new().kind(kind).limit_class(16).limit_repeat(16).limit_literal_len(64).limit_total(64).extract(&hir);
        let Some(lits) = seq.literals() else { continue };
        let v: Vec<Vec<u8>> = lits.iter().map(|l| l.as_bytes().to_vec()).collect();
        if v.is_empty() || v.iter().any(|l| l.is_empty()) {
            continue;
        }
        let shortest = v.iter().map(|l| l.len()).min().unwrap_or(0);
        let better = match &best {
            None => true,
            Some(b) => shortest > b.iter().map(|l| l.len()).min().unwrap_or(0),
        };
        if better {
            best = Some(v);
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    fn weights_for(texts: &[&[u8]]) -> Weights {
        let mut counts = vec![0u64; 65536];
        for t in texts {
            for w in lower(t).windows(2) {
                counts[((w[0] as usize) << 8) | w[1] as usize] += 1;
            }
        }
        Weights::from_counts(&counts)
    }

    #[test]
    fn grams_of_a_substring_are_grams_of_the_string() {
        let corpus: &[&[u8]] = &[b"The top rail of a guardrail system shall be 42 inches above the walking surface.", b"Toeboards shall be 3.5 inches high; see 29 CFR 1926.502(j)."];
        let w = weights_for(corpus);
        let mut seed = 12345u64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut g_doc = Vec::new();
        let mut g_sub = Vec::new();
        for doc in corpus {
            let d = lower(doc);
            grams(&d, &w, &mut g_doc);
            for _ in 0..500 {
                let a = (next() as usize) % d.len();
                let b = (a + 1 + (next() as usize) % (d.len() - a)).min(d.len());
                grams(&d[a..b], &w, &mut g_sub);
                for g in &g_sub {
                    assert!(g_doc.contains(g), "gram {g:#x} of substring {:?} missing from the document", String::from_utf8_lossy(&d[a..b]));
                }
            }
        }
        // Sparse: fewer grams than positions, more than none.
        let d = lower(corpus[0]);
        grams(&d, &w, &mut g_doc);
        assert!(g_doc.len() < d.len() - 3 && g_doc.len() > (d.len() - 3) / 3, "{} grams for {} positions", g_doc.len(), d.len() - 3);
    }

    #[test]
    fn literal_extraction_prefers_the_more_selective_side() {
        let lits = required_literals(r"\bguardrail\b", false).unwrap();
        assert_eq!(lits, vec![b"guardrail".to_vec()]);
        let lits = required_literals(r"cage|toeboard", false).unwrap();
        assert_eq!(lits.len(), 2);
        let lits = required_literals(r"[0-9]+ inches", false).unwrap();
        assert!(lits.iter().all(|l| l.ends_with(b" inches")), "{lits:?}");
        assert!(required_literals(r"\d+", false).is_none());
        assert!(required_literals(r".*", false).is_none());
        let lits = required_literals(r"1926.501(a)", true).unwrap();
        assert_eq!(lits, vec![b"1926.501(a)".to_vec()]);
        let lits = required_literals(r"guard ?rail", false).unwrap();
        assert_eq!(lits.len(), 2, "{lits:?}");
    }

    #[test]
    fn build_open_and_candidates_never_miss_a_containing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let docs: Vec<(&str, &str)> = vec![
            ("a.md", "The top rail shall be 42 inches above the walking surface.\nToeboards shall be 3.5 inches high."),
            ("b.md", "A cage shall be provided on fixed ladders over 24 feet.\nSee § 1926.1053(a)(19)."),
            ("c.md", "Nothing about rails here.\nJust text with numbers 1926 and words."),
            ("d.md", "GUARDRAIL SYSTEMS: top rail height 42 inches; midrail 21 inches."),
        ];
        let mut files = Vec::new();
        for (name, text) in &docs {
            let p = tmp.path().join(name);
            fs::write(&p, text).unwrap();
            files.push((name.to_string(), p));
        }
        let stats = build(&files, &tmp.path().join("ngram")).unwrap();
        assert_eq!(stats.files, 4);
        assert!(stats.grams > 10);
        let pf = Prefilter::open(&tmp.path().join("ngram")).unwrap();
        for lit in ["42 inches", "cage", "Toeboards", "guardrail", "1926.1053", "midrail 21", "walking surface", "§ 1926", "nothing", "zzzz not there"] {
            let cands = pf.candidates_for(lit.as_bytes());
            for (i, (_, text)) in docs.iter().enumerate() {
                let contains = lower(text.as_bytes()).windows(lit.len()).any(|w| w == lower(lit.as_bytes()).as_slice());
                if contains {
                    assert!(cands.as_ref().map(|c| c.contains(i as u32)).unwrap_or(true), "{lit:?} is in {} but was excluded", docs[i].0);
                }
            }
        }
        let plan = pf.plan(&["guardrail".into()], false, true);
        assert_eq!(plan.candidates.as_ref().unwrap(), &vec!["d.md".to_string()]);
        let plan = pf.plan(&[r"\d+".into()], false, false);
        assert!(plan.candidates.is_none() && plan.reason.contains("full scan"));
        let plan = pf.plan(&["cage|rail".into()], false, false);
        let c = plan.candidates.unwrap();
        assert!(c.contains(&"b.md".to_string()) && c.contains(&"a.md".to_string()), "{c:?}");
    }
}
