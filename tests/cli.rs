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

/// Split a stream of `Content-Length`-framed LSP messages.
fn lsp_messages(mut data: &[u8]) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    while let Some(header_end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
        let header = String::from_utf8_lossy(&data[..header_end]);
        let len: usize = header
            .lines()
            .find_map(|l| l.strip_prefix("Content-Length: "))
            .expect("Content-Length")
            .trim()
            .parse()
            .expect("length");
        let body = &data[header_end + 4..header_end + 4 + len];
        out.push(serde_json::from_slice(body).expect("JSON body"));
        data = &data[header_end + 4 + len..];
    }
    out
}

/// Run `vsg-rs lsp` on framed `messages`; returns every message it wrote.
fn lsp_run(messages: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let mut input = String::new();
    for m in messages {
        let body = m.to_string();
        input.push_str("Content-Length: ");
        input.push_str(&body.len().to_string());
        input.push_str("\r\n\r\n");
        input.push_str(&body);
    }
    let out = vsg(&["lsp"], &input);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    lsp_messages(&out.stdout)
}

#[test]
fn lsp_session() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = write(dir.path(), "e.vhd", UNFORMATTED);
    let uri = format!("file://{}", path.display());
    let doc = serde_json::json!({ "uri": uri });
    let messages = [
        serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"capabilities": {}}}),
        serde_json::json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}),
        serde_json::json!({"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {
            "textDocument": {"uri": uri, "languageId": "vhdl", "version": 1, "text": UNFORMATTED}}}),
        serde_json::json!({"jsonrpc": "2.0", "id": 2, "method": "textDocument/formatting",
            "params": {"textDocument": doc, "options": {"tabSize": 2, "insertSpaces": true}}}),
        serde_json::json!({"jsonrpc": "2.0", "id": 3, "method": "textDocument/codeAction",
            "params": {"textDocument": doc,
                "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 40}},
                "context": {"diagnostics": []}}}),
        serde_json::json!({"jsonrpc": "2.0", "id": 4, "method": "textDocument/formatting",
            "params": {"bogus": true}}),
        serde_json::json!({"jsonrpc": "2.0", "id": 5, "method": "shutdown"}),
        serde_json::json!({"jsonrpc": "2.0", "method": "exit"}),
    ];
    let replies = lsp_run(&messages);
    let response = |id: u64| {
        replies
            .iter()
            .find(|m| m["id"] == id)
            .unwrap_or_else(|| panic!("no response {id} in {replies:?}"))
    };

    let caps = &response(1)["result"]["capabilities"];
    assert_eq!(caps["documentFormattingProvider"], true);
    assert_eq!(caps["documentRangeFormattingProvider"], true);

    let diagnostics = replies
        .iter()
        .find(|m| m["method"] == "textDocument/publishDiagnostics")
        .expect("diagnostics")["params"]["diagnostics"]
        .as_array()
        .expect("array")
        .clone();
    assert!(!diagnostics.is_empty());
    assert!(diagnostics.iter().all(|d| d["source"] == "vsg-rs"));
    assert!(diagnostics.iter().any(|d| d["code"] == "entity_019"));

    let edits = response(2)["result"].as_array().expect("edits").clone();
    assert_eq!(edits.len(), 1);
    assert_eq!(edits[0]["newText"], FORMATTED);
    assert_eq!(
        edits[0]["range"]["end"],
        serde_json::json!({"line": 1, "character": 0})
    );

    let actions = response(3)["result"].as_array().expect("actions").clone();
    assert!(actions.iter().any(|a| a["kind"] == "quickfix"
        && a["diagnostics"][0]["code"].is_string()
        && a["edit"]["changes"][&uri].is_array()));
    let fix_all = actions
        .iter()
        .find(|a| a["kind"] == "source.fixAll.vsg-rs")
        .expect("fixAll action");
    let new_text = fix_all["edit"]["changes"][&uri][0]["newText"]
        .as_str()
        .expect("text");
    assert!(new_text.contains("end entity e;"), "{new_text}");

    assert!(response(4)["error"]["code"].is_i64());
    assert!(response(5)["result"].is_null());
}

#[test]
fn lsp_formatting_failure_is_logged_not_fatal() {
    let uri = "untitled:bad.vhd";
    let messages = [
        serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"capabilities": {}}}),
        serde_json::json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}),
        serde_json::json!({"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {
            "textDocument": {"uri": uri, "languageId": "vhdl", "version": 1, "text": MALFORMED}}}),
        serde_json::json!({"jsonrpc": "2.0", "id": 2, "method": "textDocument/rangeFormatting",
            "params": {"textDocument": {"uri": uri},
                "range": {"start": {"line": 0, "character": 0}, "end": {"line": 9, "character": 0}},
                "options": {"tabSize": 2, "insertSpaces": true}}}),
        serde_json::json!({"jsonrpc": "2.0", "id": 3, "method": "shutdown"}),
        serde_json::json!({"jsonrpc": "2.0", "method": "exit"}),
    ];
    let replies = lsp_run(&messages);
    let diagnostics = &replies
        .iter()
        .find(|m| m["method"] == "textDocument/publishDiagnostics")
        .expect("diagnostics")["params"]["diagnostics"];
    assert_eq!(diagnostics[0]["severity"], 1);
    let formatting = replies.iter().find(|m| m["id"] == 2).expect("response");
    assert_eq!(formatting["result"], serde_json::json!([]));
    assert!(replies.iter().any(|m| m["method"] == "window/logMessage"));
}
