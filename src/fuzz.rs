//! Randomized property tests (deterministic seed, no external dependencies).
//!
//! * Formatting depends only on tokens and comments: changing whitespace between tokens that
//!   have no comments or line breaks around them does not change the output.
//! * Deleting tokens never causes a panic; whenever the result still parses, it formats
//!   without an internal error and idempotently.

use std::path::Path;

use crate::config::FormatConfig;
use crate::{FormatError, Parsed, format, format_parsed};

/// xorshift64*
struct Rng(u64);

impl Rng {
    fn below(&mut self, n: usize) -> usize {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        let value = self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 32;
        usize::try_from(value).unwrap_or(0) % n.max(1)
    }
}

fn inputs() -> Vec<(String, Vec<u8>)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    let mut out = Vec::new();
    for dir in ["formatting", "regressions"] {
        let Ok(entries) = std::fs::read_dir(root.join(dir)) else {
            continue;
        };
        for path in entries.flatten().map(|e| e.path()) {
            let name = path.display().to_string();
            if let (false, Ok(src)) = (name.ends_with(".out.vhd"), std::fs::read(&path)) {
                out.push((name, src));
            }
        }
    }
    // Extra corpora: `VSG_FUZZ_DIRS=dir1:dir2 cargo test --release fuzz`.
    let mut dirs: Vec<std::path::PathBuf> = std::env::var_os("VSG_FUZZ_DIRS")
        .map(|v| std::env::split_paths(&v).collect())
        .unwrap_or_default();
    while let Some(dir) = dirs.pop() {
        for path in std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
        {
            if path.is_dir() {
                dirs.push(path);
            } else if path.extension().is_some_and(|e| e == "vhd" || e == "vhdl")
                && let Ok(src) = std::fs::read(&path)
            {
                out.push((path.display().to_string(), src));
            }
        }
    }
    out.sort();
    out
}

#[test]
fn whitespace_does_not_change_the_layout() {
    let cfg = FormatConfig::default();
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for (name, src) in inputs() {
        let parsed = Parsed::new(src.clone());
        // Formatter-off regions keep their whitespace by design.
        let text = String::from_utf8_lossy(&src);
        if !parsed.syntax_errors().is_empty()
            || text.contains("fmt off")
            || text.contains("vsg_off")
        {
            continue;
        }
        let expected = format_parsed(&parsed, &cfg).expect("formats");
        // Whitespace in front of tokens, where it holds no comment and no line break.
        let gaps: Vec<(usize, usize)> = parsed
            .tokens()
            .iter()
            .skip(1)
            .filter(|t| {
                !t.leading_trivia().contains_comments() && !t.leading_trivia().has_newline()
            })
            .map(|t| (t.offset(), t.text_offset()))
            .collect();
        for _ in 0..8 {
            let mut mutated = Vec::with_capacity(src.len() + 64);
            let mut pos = 0;
            for &(start, end) in &gaps {
                mutated.extend_from_slice(&src[pos..start]);
                match rng.below(6) {
                    0 => {
                        let eol: &[u8] = if parsed.uses_crlf() { b"\r\n" } else { b"\n" };
                        mutated.extend_from_slice(eol);
                        mutated.extend_from_slice(b"    ");
                    }
                    1 => mutated.push(b'\t'),
                    2 => mutated.extend_from_slice(b"   "),
                    _ => mutated.extend_from_slice(&src[start..end]),
                }
                pos = end;
            }
            mutated.extend_from_slice(&src[pos..]);
            let actual = format(mutated, &cfg).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(
                String::from_utf8_lossy(&actual),
                String::from_utf8_lossy(&expected),
                "{name}: layout depends on whitespace"
            );
        }
    }
}

#[test]
fn token_deletions_are_safe() {
    let cfg = FormatConfig::default();
    let mut rng = Rng(0xD1B5_4A32_D192_ED03);
    let mut formatted = 0;
    for (name, src) in inputs() {
        let parsed = Parsed::new(src.clone());
        let tokens: Vec<(usize, usize)> = parsed
            .tokens()
            .iter()
            .map(|t| (t.text_offset(), t.text_range().end))
            .collect();
        for _ in 0..40 {
            // Delete one to three consecutive tokens.
            let first = rng.below(tokens.len());
            let last = (first + rng.below(3)).min(tokens.len() - 1);
            let (start, end) = (tokens[first].0, tokens[last].1);
            let mut mutated = src.clone();
            mutated.drain(start..end);
            match format(mutated.clone(), &cfg) {
                Ok(out) => {
                    formatted += 1;
                    let again = format(out.clone(), &cfg)
                        .unwrap_or_else(|e| panic!("{name}: second pass: {e}"));
                    assert_eq!(again, out, "{name}: not idempotent after deletion");
                }
                Err(FormatError::Syntax(_) | FormatError::Unsupported(_)) => {}
                Err(FormatError::Internal(m)) => panic!(
                    "{name}: internal error after deleting {start}..{end}: {m}\n{}",
                    String::from_utf8_lossy(&mutated)
                ),
            }
        }
    }
    assert!(formatted > 50, "too few mutants parsed: {formatted}");
}

/// A random VSG configuration: case policies, `action` options, disabled groups, alignment and
/// indentation settings.
fn random_config(rng: &mut Rng) -> String {
    let pick = |rng: &mut Rng, options: &[&'static str]| options[rng.below(options.len())];
    let mut yaml = String::from("rule:\n  global:\n");
    yaml += &format!("    case: {}\n", pick(rng, &["lower", "upper"]));
    yaml += &format!("    indent_size: {}\n", pick(rng, &["2", "3", "4"]));
    yaml += &format!(
        "    indent_style: {}\n",
        pick(rng, &["spaces", "smart_tabs"])
    );
    let mut groups = String::new();
    for group in ["alignment", "blank_line", "case::keyword", "structure"] {
        if rng.below(3) == 0 {
            groups += &format!("    {group}:\n      disable: true\n");
        }
    }
    if !groups.is_empty() {
        yaml += "  group:\n";
        yaml += &groups;
    }
    for rule in [
        "entity_015",
        "architecture_024",
        "instantiation_033",
        "if_002",
        "process_012",
    ] {
        if rng.below(2) == 0 {
            let action = if rule == "if_002" {
                format!("parenthesis: {}", pick(rng, &["insert", "remove"]))
            } else {
                format!("action: {}", pick(rng, &["add", "remove"]))
            };
            yaml += &format!("  {rule}:\n    {action}\n");
        }
    }
    if rng.below(2) == 0 {
        yaml += "  signal_015:\n    consecutive: 1\n  port_023:\n    fixable: true\n";
    }
    if rng.below(2) == 0 {
        yaml += "indent:\n  tokens:\n    case_statement:\n      case_keyword: {after: \"+1\", token: current}\n      end_keyword: {after: \"-1\", token: \"-1\"}\n    case_statement_alternative:\n      when_keyword: {after: current, token: current}\n";
    }
    yaml
}

#[test]
fn fixes_are_complete_under_random_configurations() {
    let mut rng = Rng(0xD1B5_4A32_D192_ED03);
    for (name, src) in inputs() {
        if !Parsed::new(src.clone()).syntax_errors().is_empty() {
            continue;
        }
        for _ in 0..3 {
            let yaml = random_config(&mut rng);
            let config = crate::Config::parse(&yaml).expect("valid configuration");
            let options = crate::FixOptions {
                unsafe_fixes: rng.below(2) == 0,
                ..crate::FixOptions::default()
            };
            let once = match crate::fix_with(&Parsed::new(src.clone()), &config, &options) {
                Ok(out) => out.output,
                Err(FormatError::Internal(e)) => panic!("{name} with\n{yaml}: {e}"),
                Err(_) => continue,
            };
            let twice = crate::fix_with(&Parsed::new(once.clone()), &config, &options)
                .unwrap_or_else(|e| panic!("{name} (second run) with\n{yaml}: {e}"))
                .output;
            assert!(
                once == twice,
                "{name}: a second fix run changes the output with\n{yaml}\n{}",
                crate::fuzz::first_difference(&once, &twice)
            );
        }
    }
}

fn first_difference(a: &[u8], b: &[u8]) -> String {
    let (a, b) = (String::from_utf8_lossy(a), String::from_utf8_lossy(b));
    a.lines()
        .zip(b.lines())
        .enumerate()
        .find(|(_, (x, y))| x != y)
        .map_or_else(
            || "(length differs)".into(),
            |(i, (x, y))| format!("line {}:\n  {x}\n  {y}", i + 1),
        )
}
