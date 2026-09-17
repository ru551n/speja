//! End-to-end tests of the `vsg-rs` command line.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const UNFORMATTED: &str = "entity e is port (a : in bit); end;\n";
const FORMATTED: &str = "entity e is\n  port (\n    a : in    bit\n  );\nend entity e;\n";
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
fn stdin_fix_prints_only_source() {
    let out = vsg(&["--stdin", "--fix"], UNFORMATTED);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(String::from_utf8_lossy(&out.stdout), FORMATTED);
}

#[test]
fn stdin_fix_succeeds_with_remaining_violations() {
    // process_016 (missing process label) has no fix.
    let src = "architecture a of e is\nbegin\n  process is\n  begin\n    wait;\n  end process;\nend architecture a;\n";
    let out = vsg(&["--stdin", "--fix"], src);
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    assert!(String::from_utf8_lossy(&out.stderr).contains("process_016"));
}

#[test]
fn syntax_errors_are_reported_and_nothing_is_changed() {
    let out = vsg(&["--stdin", "--fix"], MALFORMED);
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("syntax"), "{err}");
    let dir = tempfile::tempdir().expect("tempdir");
    let bad = write(dir.path(), "bad.vhd", MALFORMED);
    let good = write(dir.path(), "good.vhd", UNFORMATTED);
    let out = vsg(
        &["-f", bad.to_str().unwrap(), good.to_str().unwrap(), "--fix"],
        "",
    );
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(std::fs::read_to_string(bad).unwrap(), MALFORMED);
    // Other files are still processed.
    assert_eq!(std::fs::read_to_string(good).unwrap(), FORMATTED);
}

#[test]
fn fix_in_place_is_idempotent() {
    let dir = tempfile::tempdir().expect("tempdir");
    let file = write(dir.path(), "a.vhd", UNFORMATTED);
    let path = file.to_str().unwrap();
    let report = vsg(&[path], "");
    assert_eq!(report.status.code(), Some(1));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), UNFORMATTED);
    assert!(vsg(&[path, "--fix"], "").status.success());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), FORMATTED);
    let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
    assert!(vsg(&[path], "").status.success());
    assert!(vsg(&[path, "--fix"], "").status.success());
    // Unchanged output is not rewritten.
    assert_eq!(
        std::fs::metadata(&file).unwrap().modified().unwrap(),
        modified
    );
}

#[test]
fn crlf_is_preserved() {
    let out = vsg(&["--stdin", "--fix"], &UNFORMATTED.replace('\n', "\r\n"));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        FORMATTED.replace('\n', "\r\n")
    );
}

#[test]
fn comment_only_input() {
    let out = vsg(&["--stdin", "--fix"], "\n\n-- only a comment   \n\n");
    assert_eq!(String::from_utf8_lossy(&out.stdout), "-- only a comment\n");
}

#[test]
fn line_length_from_configuration() {
    let dir = tempfile::tempdir().expect("tempdir");
    let cfg = write(
        dir.path(),
        "c.yaml",
        "rule:\n  length_001:\n    length: 20\n",
    );
    let src = "architecture a of e is begin x <= f(alpha, beta, gamma); end architecture a;\n";
    let out = vsg(&["--stdin", "--fix", "-c", cfg.to_str().unwrap()], src);
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("  x <= f(\n    alpha,\n"), "{text}");
}

#[test]
fn unsafe_fixes_are_opt_in() {
    let src = "entity e is\n  port (a : bit);\nend entity e;\n";
    let safe = vsg(&["--stdin", "--fix"], src);
    assert!(String::from_utf8_lossy(&safe.stdout).contains("a : bit"));
    let all = vsg(&["--stdin", "--fix", "--unsafe_fixes"], src);
    assert!(
        String::from_utf8_lossy(&all.stdout).contains("a : in    bit"),
        "{all:?}"
    );
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

#[test]
fn extensions_diff_range_sarif_and_rule_list() {
    let diff = vsg(&["--stdin", "--fix", "--diff"], UNFORMATTED);
    assert!(String::from_utf8_lossy(&diff.stdout).contains("+  port ("));
    let src = "entity e is\nend entity e;\narchitecture rtl of e is\nbegin\n  a<=b;\n  c<=d;\nend architecture rtl;\n";
    let range = vsg(&["--stdin", "--fix", "--range", "6:6"], src);
    assert_eq!(
        String::from_utf8_lossy(&range.stdout),
        src.replace("c<=d", "c <= d")
    );
    let dir = tempfile::tempdir().expect("tempdir");
    let sarif = dir.path().join("out.sarif");
    let out = vsg(
        &["--stdin", "--sarif", sarif.to_str().unwrap()],
        "entity e is\nend;\n",
    );
    assert_eq!(out.status.code(), Some(1));
    let doc: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&sarif).unwrap()).unwrap();
    assert_eq!(doc["runs"][0]["results"][0]["ruleId"], "entity_015");
    let list = vsg(&["--list_rules"], "");
    assert_eq!(String::from_utf8_lossy(&list.stdout).lines().count(), 972);
}

#[test]
fn configuration_is_discovered_next_to_the_input() {
    let dir = tempfile::tempdir().expect("tempdir");
    write(
        dir.path(),
        "vsg-rs.yaml",
        "rule:\n  entity_015:\n    disable: true\n",
    );
    let file = write(dir.path(), "a.vhd", "entity e is\nend e;\n");
    let out = vsg(&[file.to_str().unwrap()], "");
    assert_eq!(out.status.code(), Some(0), "{out:?}");
}
