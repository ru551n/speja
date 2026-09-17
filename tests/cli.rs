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

#[test]
fn stdin_range_formats_only_those_lines() {
    let src = "entity e is\nend;\narchitecture rtl of e is\nbegin\n  a<=b;\n  c<=d;\nend;\n";
    let out = vsg(&["fmt", "--range", "6:6", "-"], src);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        src.replace("c<=d", "c <= d")
    );
    let bad = vsg(&["fmt", "--range", "3:2", "-"], src);
    assert_eq!(bad.status.code(), Some(2));
    let dir = tempfile::tempdir().expect("tempdir");
    let file = write(dir.path(), "a.vhd", src);
    let not_stdin = vsg(&["fmt", "--range", "1:2", file.to_str().unwrap()], "");
    assert_eq!(not_stdin.status.code(), Some(2));
}

// ------------------------------------------------------------------ VSG command line

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("vsg-rs-cli-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create dir");
    dir
}

#[test]
fn vsg_style_report_and_exit_code() {
    let dir = scratch("report");
    let bad = write(&dir, "a.vhd", "entity e is\nend;\n");
    let good = write(&dir, "b.vhd", "entity e is\nend entity e;\n");
    let out = vsg(&["-f", bad.to_str().unwrap(), good.to_str().unwrap()], "");
    assert_eq!(out.status.code(), Some(1));
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("Phase 1 of 1... Reporting"), "{text}");
    assert!(
        text.contains("  entity_015 | Error      |          2 | Add *entity* keyword"),
        "{text}"
    );
    assert!(text.contains("Total Violations:    0"), "{text}");
    let good_only = vsg(&[good.to_str().unwrap(), "-of", "summary"], "");
    assert_eq!(good_only.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&good_only.stdout).contains(" OK ("));
}

#[test]
fn vsg_style_fix_with_backup_and_reports() {
    let dir = scratch("fix");
    let file = write(&dir, "a.vhd", "entity e is\nend;\n");
    let json = dir.join("out.json");
    let junit = dir.join("out.xml");
    let out = vsg(
        &[
            "-f",
            file.to_str().unwrap(),
            "--fix",
            "-b",
            "-js",
            json.to_str().unwrap(),
            "-j",
            junit.to_str().unwrap(),
        ],
        "",
    );
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "entity e is\nend entity e;\n"
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("a.vhd.bak")).unwrap(),
        "entity e is\nend;\n"
    );
    let report: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&json).unwrap()).unwrap();
    assert_eq!(report["files"][0]["violations"], serde_json::json!([]));
    assert!(
        std::fs::read_to_string(&junit)
            .unwrap()
            .contains("tests=\"1\"")
    );
}

#[test]
fn vsg_style_stdin_and_rule_configuration() {
    let out = vsg(&["--stdin", "-of", "syntastic"], "entity e is\nend;\n");
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        "ERROR: stdin(2)entity_015 -- Add *entity* keyword\n\
         ERROR: stdin(2)entity_019 -- Add entity simple name\n"
    );
    let fixed = vsg(&["--stdin", "--fix"], "entity e is\nend;\n");
    assert_eq!(
        String::from_utf8_lossy(&fixed.stdout),
        "entity e is\nend entity e;\n"
    );
    let rc = vsg(&["-rc", "entity_015"], "");
    let value: serde_json::Value = serde_json::from_slice(&rc.stdout).unwrap();
    assert_eq!(value["rule"]["entity_015"]["action"], "add");
    let missing = vsg(&["-f", "does/not/exist.vhd"], "");
    assert_eq!(missing.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&missing.stderr).contains("does not exist"));
}
