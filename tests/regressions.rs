//! Regression tests for bugs and limitations reported against VSG (see
//! `docs/upstream-bugs.md`). The reproducers in `tests/regressions/` were written
//! independently for speja.
//!
//! Every reproducer must be handled without a panic. Valid ones must format and fix
//! idempotently; invalid ones must be refused with a syntax error and left untouched.

use std::fmt::Write;
use std::path::Path;
use std::time::{Duration, Instant};

use speja::{Config, FormatConfig, FormatError, Parsed};

fn format(src: &[u8]) -> Result<Vec<u8>, FormatError> {
    speja::format(src.to_vec(), &FormatConfig::default())
}

fn fix(src: &[u8]) -> Result<Vec<u8>, FormatError> {
    speja::fix(&Parsed::new(src.to_vec()), &Config::default()).map(|o| o.output)
}

#[test]
fn reproducers_are_handled_safely() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/regressions");
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .expect("regression directory")
        .map(|e| e.expect("entry").path())
        .collect();
    files.sort();
    assert!(files.len() >= 20);
    for file in files {
        let name = file.display().to_string();
        let src = std::fs::read(&file).expect("read reproducer");
        let parsed = Parsed::new(src.clone());
        let _ = speja::rules::check(&parsed, &Config::default());
        if parsed.syntax_errors().is_empty() {
            let once = format(&src).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(
                format(&once).unwrap(),
                once,
                "{name}: format is not idempotent"
            );
            let fixed = fix(&src).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(fix(&fixed).unwrap(), fixed, "{name}: fix is not idempotent");
        } else {
            assert!(
                matches!(format(&src), Err(FormatError::Syntax(_))),
                "{name}"
            );
            assert!(matches!(fix(&src), Err(FormatError::Syntax(_))), "{name}");
        }
    }
}

/// VSG-BUG-007: pragma comments stay exactly where they were relative to the code.
#[test]
fn pragma_comments_keep_their_position() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/regressions/vsg_bug_007.vhd");
    let out = String::from_utf8(fix(&std::fs::read(path).unwrap()).unwrap()).unwrap();
    let lines: Vec<&str> = out.lines().map(str::trim).collect();
    let off = lines
        .iter()
        .position(|l| *l == "-- synthesis translate_off")
        .unwrap();
    assert!(lines[off + 1].starts_with("report \"sim only\""), "{out}");
    let on = lines
        .iter()
        .position(|l| *l == "-- synthesis translate_on")
        .unwrap();
    assert_eq!(lines[on - 1], "end if;", "{out}");
}

/// VSG-BUG-008: a trailing comment never swallows the code after it.
#[test]
fn closing_parenthesis_after_trailing_comment() {
    let src = b"package p is\n  procedure run (\n    n : natural -- note\n  );\nend package p;\n";
    let out = String::from_utf8(format(src).unwrap()).unwrap();
    assert!(out.contains("n : natural -- note\n"), "{out}");
    assert!(out.contains("\n  );\n"), "{out}");
}

/// VSG-BUG-010: a block comment containing `--` does not disable later fixes.
#[test]
fn block_comment_with_dashes_does_not_stop_fixing() {
    let src = b"entity e is\n  /* see -- the spec */\nend;\narchitecture a of e is\nbegin\nend;\n";
    let out = String::from_utf8(fix(src).unwrap()).unwrap();
    assert!(out.contains("/* see -- the spec */"), "{out}");
    assert!(out.contains("end entity e;"), "{out}");
    assert!(out.contains("end architecture a;"), "{out}");
}

/// VSG-BUG-011: bytes of a Latin-1 encoded file are preserved.
#[test]
fn latin1_bytes_are_preserved() {
    let src = b"entity e is -- r\xe9sum\xe9\nend entity e;\narchitecture a of e is\n  constant s : string := \"\xe5\xe4\xf6\";\nbegin\nend architecture a;\n";
    let out = format(src).unwrap();
    assert!(out.windows(7).any(|w| w == b"r\xe9sum\xe9\n"));
    assert!(out.windows(5).any(|w| w == b"\"\xe5\xe4\xf6\""));
}

/// VSG-BUG-014: multi-line block comments do not drift on repeated runs.
#[test]
fn multiline_block_comment_is_stable() {
    let src = b"architecture a of e is\nbegin\n  /* first line\n     second line */\n  x <= y;\nend architecture a;\n";
    let once = format(src).unwrap();
    assert_eq!(format(&once).unwrap(), once);
    let text = String::from_utf8(once).unwrap();
    assert!(
        text.contains("  /* first line\n     second line */\n"),
        "{text}"
    );
}

/// VSG-BUG-026: long lines are folded by the formatter.
#[test]
fn long_lines_are_folded() {
    let src = b"architecture a of e is\nbegin\n  y <= first_long_signal_name and second_long_signal_name and third_long_signal_name and fourth_name;\nend architecture a;\n";
    let out = String::from_utf8(format(src).unwrap()).unwrap();
    assert!(out.lines().all(|l| l.len() <= 120), "{out}");
    let cfg = Config::parse("rule: {length_001: {length: 60}}").unwrap();
    let out = speja::fix(&Parsed::new(src.to_vec()), &cfg).unwrap();
    let text = String::from_utf8(out.output).unwrap();
    assert!(text.lines().all(|l| l.len() <= 60), "{text}");
    assert!(out.remaining.iter().all(|v| v.rule != "length_001"));
}

/// VSG-BUG-032: large files are processed in linear time.
#[test]
fn large_file_is_fast() {
    let mut src = String::from("architecture a of e is\nbegin\n");
    for i in 0..5000 {
        let _ = writeln!(
            src,
            "  s{i} <= a{i} and b{i} when c{i} = '1' else d{i}; -- comment {i}"
        );
    }
    src.push_str("end architecture a;\n");
    let start = Instant::now();
    assert!(!fix(src.as_bytes()).unwrap().is_empty());
    // Generous bound for unoptimized builds.
    assert!(
        start.elapsed() < Duration::from_secs(30),
        "{:?}",
        start.elapsed()
    );
}
