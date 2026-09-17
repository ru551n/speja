//! Machine-readable reports: SARIF 2.1.0, JUnit XML, GitLab code quality, and VSG's
//! `syntastic` and `summary` console formats.

use std::fmt::Write as _;

use serde_json::json;

use crate::Diagnostic;

fn level(severity: &str) -> &'static str {
    if severity == "error" {
        "error"
    } else {
        "warning"
    }
}

pub fn sarif(diagnostics: &[Diagnostic]) -> String {
    let mut rules: Vec<&str> = diagnostics.iter().map(|d| d.rule.as_str()).collect();
    rules.sort_unstable();
    rules.dedup();
    let results: Vec<_> = diagnostics
        .iter()
        .map(|d| {
            json!({
                "ruleId": d.rule,
                "level": level(&d.severity),
                "message": { "text": d.message },
                "locations": [{
                    "physicalLocation": {
                        "artifactLocation": { "uri": d.file.replace('\\', "/") },
                        "region": {
                            "startLine": d.line,
                            "startColumn": d.column,
                            "endLine": d.end_line,
                            "endColumn": d.end_column,
                        }
                    }
                }]
            })
        })
        .collect();
    let doc = json!({
        "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
        "version": "2.1.0",
        "runs": [{
            "tool": {
                "driver": {
                    "name": "vsg-rs",
                    "version": env!("CARGO_PKG_VERSION"),
                    "rules": rules.iter().map(|r| json!({ "id": r })).collect::<Vec<_>>(),
                }
            },
            "results": results,
        }]
    });
    serde_json::to_string_pretty(&doc).unwrap_or_default()
}

fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // Control characters are not allowed in XML 1.0.
            c if u32::from(c) < 0x20 && !matches!(c, '\n' | '\t') => {}
            c => out.push(c),
        }
    }
    out
}

/// One test case per checked file; files with findings fail.
pub fn junit(files: &[String], diagnostics: &[Diagnostic]) -> String {
    let failures = files
        .iter()
        .filter(|f| diagnostics.iter().any(|d| &d.file == *f))
        .count();
    let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    let _ = writeln!(
        out,
        "<testsuites>\n  <testsuite name=\"vsg-rs\" tests=\"{}\" failures=\"{failures}\">",
        files.len()
    );
    for file in files {
        let name = xml_escape(file);
        let found: Vec<&Diagnostic> = diagnostics.iter().filter(|d| &d.file == file).collect();
        if found.is_empty() {
            let _ = writeln!(out, "    <testcase classname=\"vsg-rs\" name=\"{name}\"/>");
            continue;
        }
        let _ = writeln!(out, "    <testcase classname=\"vsg-rs\" name=\"{name}\">");
        let _ = writeln!(
            out,
            "      <failure message=\"{} violation(s)\">",
            found.len()
        );
        for d in found {
            let line = format!(
                "{}:{}:{}: {}[{}]: {}",
                d.file, d.line, d.column, d.severity, d.rule, d.message
            );
            let _ = writeln!(out, "{}", xml_escape(&line));
        }
        out.push_str("      </failure>\n    </testcase>\n");
    }
    out.push_str("  </testsuite>\n</testsuites>\n");
    out
}

/// VSG's `-of syntastic`: `ERROR: file(line)rule -- message`.
pub fn syntastic(diagnostics: &[Diagnostic]) -> String {
    let mut out = String::new();
    for d in diagnostics {
        let _ = writeln!(
            out,
            "{}: {}({}){} -- {}",
            d.severity.to_uppercase(),
            d.file,
            d.line,
            d.rule,
            d.message
        );
    }
    out
}

/// VSG's `-of summary`: one line per file with the number of errors and warnings.
pub fn summary(files: &[String], diagnostics: &[Diagnostic]) -> String {
    let mut out = String::new();
    for file in files {
        let count = |severity: &str| {
            diagnostics
                .iter()
                .filter(|d| &d.file == file && d.severity == severity)
                .count()
        };
        let (errors, warnings) = (count("error"), count("warning"));
        let status = if errors > 0 { "ERROR" } else { "OK" };
        let _ = writeln!(
            out,
            "File: {file} {status} [Error: {errors}] [Warning: {warnings}]"
        );
    }
    out
}

/// 64-bit FNV-1a, stable across platforms and releases.
fn fnv1a(bytes: impl IntoIterator<Item = u8>, seed: u64) -> u64 {
    bytes.into_iter().fold(seed, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

/// A stable 128-bit hex fingerprint of `key`.
pub fn fingerprint(key: &str) -> String {
    format!(
        "{:016x}{:016x}",
        fnv1a(key.bytes(), 0xcbf2_9ce4_8422_2325),
        fnv1a(key.bytes().rev(), 0x8422_2325_cbf2_9ce4)
    )
}

/// GitLab code quality report (VSG `--quality_report`).
pub fn gitlab(diagnostics: &[Diagnostic]) -> String {
    let issues: Vec<_> = diagnostics
        .iter()
        .map(|d| {
            let key = format!(
                "{}\0{}\0{}\0{}\0{}",
                d.file, d.rule, d.line, d.column, d.message
            );
            let fingerprint = fingerprint(&key);
            json!({
                "description": format!("{} :: {}", d.rule, d.message),
                "check_name": d.rule,
                "fingerprint": fingerprint,
                "severity": if d.severity == "error" { "critical" } else { "major" },
                "location": {
                    "path": d.file.replace('\\', "/"),
                    "lines": { "begin": d.line }
                }
            })
        })
        .collect();
    serde_json::to_string_pretty(&issues).unwrap_or_default()
}
