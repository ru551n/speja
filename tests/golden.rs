//! Golden formatting tests.
//!
//! Every `tests/formatting/<name>.vhd` is formatted and compared with `<name>.out.vhd`. The
//! expected output must itself be a fixed point of the formatter. The target width is taken
//! from an optional first line `-- vsg-rs-test: width=N` (default 120).
//!
//! Run with `UPDATE_EXPECT=1` to (re)write the expected files; review the diff before
//! committing.

use std::path::Path;

use vsg_rs::FormatConfig;

fn config_for(input: &str) -> FormatConfig {
    let mut cfg = FormatConfig::default();
    if let Some(width) = input
        .lines()
        .next()
        .and_then(|l| l.strip_prefix("-- vsg-rs-test: width="))
    {
        cfg.width = width.trim().parse().expect("width directive");
    }
    cfg
}

fn format(src: &str, cfg: &FormatConfig) -> String {
    let out = vsg_rs::format(src.as_bytes().to_vec(), cfg).unwrap_or_else(|e| panic!("{e}"));
    String::from_utf8(out).expect("utf-8 output")
}

#[test]
fn golden() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/formatting");
    let update = std::env::var_os("UPDATE_EXPECT").is_some();
    let mut inputs: Vec<_> = std::fs::read_dir(&dir)
        .expect("fixture directory")
        .map(|e| e.expect("entry").path())
        .filter(|p| {
            p.extension().is_some_and(|e| e == "vhd") && !p.to_string_lossy().ends_with(".out.vhd")
        })
        .collect();
    inputs.sort();
    assert!(!inputs.is_empty());
    let mut failures = Vec::new();
    for input in inputs {
        let src = std::fs::read_to_string(&input).expect("read input");
        let cfg = config_for(&src);
        let expected_path = input.with_extension("out.vhd");
        let actual = format(&src, &cfg);
        if update {
            std::fs::write(&expected_path, &actual).expect("write expected");
            continue;
        }
        let name = input
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let Ok(expected) = std::fs::read_to_string(&expected_path) else {
            failures.push(format!("{name}: missing {}", expected_path.display()));
            continue;
        };
        if actual != expected {
            let diff = similar::TextDiff::from_lines(&expected, &actual)
                .unified_diff()
                .header("expected", "actual")
                .to_string();
            failures.push(format!("{name}: output differs\n{diff}"));
        }
        if format(&expected, &cfg) != expected {
            failures.push(format!("{name}: expected output is not a fixed point"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
