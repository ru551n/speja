//! End-to-end tests of the `vsg-rs` command line.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const UNFORMATTED: &str = "entity e is port (a : in bit); end;\n";
const FORMATTED: &str = "entity e is\n  port (\n    a : in    bit\n  );\nend;\n";
const MALFORMED: &str = "entity e is port (a : in bit; end;\n";

fn vsg(args: &[&str], stdin: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_vsg-rs"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn vsg-rs");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(stdin.as_bytes())
        .expect("write stdin");
    child.wait_with_output().expect("wait")
}

fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, text).expect("write file");
    path
}

#[test]
fn stdin_to_stdout_contains_only_source() {
    let out = vsg(&["fmt", "--stdin-filename", "x.vhd", "-"], UNFORMATTED);
    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), FORMATTED);
    assert!(out.stderr.is_empty());
}

#[test]
fn stdin_syntax_error_prints_nothing_to_stdout() {
    let out = vsg(&["fmt", "--stdin-filename", "bad.vhd", "-"], MALFORMED);
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("bad.vhd") && err.contains("syntax"), "{err}");
}

#[test]
fn stdin_check_and_diff() {
    assert_eq!(
        vsg(&["fmt", "--check", "-"], UNFORMATTED).status.code(),
        Some(1)
    );
    assert_eq!(
        vsg(&["fmt", "--check", "-"], FORMATTED).status.code(),
        Some(0)
    );
    let diff = vsg(&["fmt", "--diff", "-"], UNFORMATTED);
    assert!(diff.status.success());
    assert!(String::from_utf8_lossy(&diff.stdout).contains("+  port ("));
    assert!(vsg(&["fmt", "--diff", "-"], FORMATTED).stdout.is_empty());
}

#[test]
fn files_in_place_check_and_idempotence() {
    let dir = tempfile::tempdir().expect("tempdir");
    let file = write(dir.path(), "a.vhd", UNFORMATTED);
    write(dir.path(), "ignored.txt", UNFORMATTED);
    let path = dir.path().to_str().expect("utf-8 path");

    assert_eq!(vsg(&["fmt", "--check", path], "").status.code(), Some(1));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), UNFORMATTED);

    let out = vsg(&["fmt", path], "");
    assert!(out.status.success());
    assert!(out.stdout.is_empty());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), FORMATTED);
    assert_eq!(
        std::fs::read_to_string(dir.path().join("ignored.txt")).unwrap(),
        UNFORMATTED
    );

    let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
    assert_eq!(vsg(&["fmt", "--check", path], "").status.code(), Some(0));
    assert!(vsg(&["fmt", path], "").status.success());
    // Unchanged output is not rewritten.
    assert_eq!(
        std::fs::metadata(&file).unwrap().modified().unwrap(),
        modified
    );
}

#[test]
fn malformed_file_is_left_untouched() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bad = write(dir.path(), "bad.vhd", MALFORMED);
    let good = write(dir.path(), "good.vhd", UNFORMATTED);
    let out = vsg(&["fmt", dir.path().to_str().unwrap()], "");
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(std::fs::read_to_string(bad).unwrap(), MALFORMED);
    // Other files are still processed.
    assert_eq!(std::fs::read_to_string(good).unwrap(), FORMATTED);
}

#[test]
fn crlf_is_preserved() {
    let out = vsg(&["fmt", "-"], &UNFORMATTED.replace('\n', "\r\n"));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        FORMATTED.replace('\n', "\r\n")
    );
}

#[test]
fn empty_and_comment_only_input() {
    assert!(vsg(&["fmt", "-"], "").stdout.is_empty());
    let out = vsg(&["fmt", "-"], "\n\n-- only a comment   \n\n");
    assert_eq!(String::from_utf8_lossy(&out.stdout), "-- only a comment\n");
}

#[test]
fn line_length_option() {
    let src = "architecture a of e is begin x <= f(alpha, beta, gamma); end;\n";
    let out = vsg(&["fmt", "--line-length", "20", "-"], src);
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("  x <= f(\n    alpha,\n"), "{text}");
}

#[test]
fn machine_readable_reports() {
    let src = "entity e is\nend;\n";
    let sarif = vsg(
        &[
            "lint",
            "--output-format",
            "sarif",
            "--stdin-filename",
            "e.vhd",
            "-",
        ],
        src,
    );
    assert_eq!(sarif.status.code(), Some(1));
    let doc: serde_json::Value = serde_json::from_slice(&sarif.stdout).expect("valid JSON");
    assert_eq!(doc["version"], "2.1.0");
    assert_eq!(doc["runs"][0]["results"][0]["ruleId"], "entity_015");
    let junit = vsg(&["lint", "--output-format", "junit", "-"], src);
    let text = String::from_utf8_lossy(&junit.stdout);
    assert!(
        text.contains("<testsuite name=\"vsg-rs\" tests=\"1\" failures=\"1\">"),
        "{text}"
    );
}
