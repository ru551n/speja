//! The VSG command line: the arguments, reports and exit codes of VSG 3.35, with one
//! difference: there are no phases. Every violation is reported at once (`-fp` and `-ap` are
//! accepted and have no effect) and `--fix` fixes everything in one run.

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{CommandFactory, Parser, ValueEnum};
use rayon::prelude::*;
use vsg_rs::config::Config;
use vsg_rs::{FixOptions, Parsed, rules};

use crate::{Diagnostic, describe_error, diagnostic, format_findings, write_atomically};

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
#[value(rename_all = "lower")]
enum OutputFormat {
    Vsg,
    Syntastic,
    Summary,
}

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
enum Style {
    #[value(name = "indent_only")]
    IndentOnly,
    #[value(name = "jcl")]
    Jcl,
}

#[derive(Parser)]
#[allow(clippy::struct_excessive_bools)] // VSG's flags.
#[command(
    name = "VHDL Style Guide (VSG)",
    bin_name = "vsg-rs",
    about = "Analyzes VHDL files for style guide violations. Reference documentation is \
             located at: http://vhdl-style-guide.readthedocs.io/en/latest/index.html",
    disable_version_flag = true,
    after_help = "vsg-rs also provides the subcommands `fmt`, `lint`, `check`, `fix`, `rules` \
                  and `explain` (for example `vsg-rs fmt --help`)."
)]
struct Args {
    /// File to analyze
    #[arg(value_name = "FILENAME")]
    positional: Vec<PathBuf>,
    /// File to analyze
    #[arg(short = 'f', long = "filename", value_name = "FILENAME", num_args = 1..)]
    filename: Vec<PathBuf>,
    /// Path to local rules
    #[arg(long = "local_rules", value_name = "LOCAL_RULES")]
    local_rules: Option<PathBuf>,
    /// JSON or YAML configuration file(s)
    #[arg(short = 'c', long = "configuration", value_name = "CONFIGURATION", num_args = 1..)]
    configuration: Vec<PathBuf>,
    /// Fix issues found
    #[arg(long)]
    fix: bool,
    /// Fix issues up to and including this phase (vsg-rs has one phase)
    #[arg(long = "fix_phase", value_name = "FIX_PHASE")]
    fix_phase: Option<u32>,
    /// Extract Junit file
    #[arg(short = 'j', long = "junit", value_name = "JUNIT")]
    junit: Option<PathBuf>,
    /// Extract JSON file
    #[arg(long = "json", value_name = "JSON")]
    json: Option<PathBuf>,
    /// Sets the output format.
    #[arg(long = "output_format", value_enum, default_value = "vsg")]
    output_format: OutputFormat,
    /// Creates a copy of input file for comparison with fixed version.
    #[arg(short = 'b', long)]
    backup: bool,
    /// Write configuration to file name.
    #[arg(long = "output_configuration", value_name = "OUTPUT_CONFIGURATION")]
    output_configuration: Option<PathBuf>,
    /// Display configuration of a rule
    #[arg(long = "rule_configuration", value_name = "RULE_CONFIGURATION")]
    rule_configuration: Option<String>,
    /// Use predefined style
    #[arg(long, value_enum)]
    style: Option<Style>,
    /// Displays version information
    #[arg(short = 'v', long)]
    version: bool,
    /// Do not stop when a violation is detected (always the case in vsg-rs)
    #[arg(long = "all_phases")]
    all_phases: bool,
    /// Restrict fixing via JSON file.
    #[arg(long = "fix_only", value_name = "FIX_ONLY")]
    fix_only: Option<PathBuf>,
    /// Read VHDL input from stdin, disables all other file selections, disables
    /// multiprocessing
    #[arg(long)]
    stdin: bool,
    /// Apply fixes if syntax errors are detected (no effect: such files are never changed)
    #[arg(long = "force_fix")]
    force_fix: bool,
    /// Create code quality report for GitLab
    #[arg(long = "quality_report", value_name = "QUALITY_REPORT")]
    quality_report: Option<PathBuf>,
    /// number of parallel jobs to use, default is the number of cpu cores
    #[arg(short = 'p', long, value_name = "JOBS")]
    jobs: Option<usize>,
    /// Displays verbose debug information
    #[arg(long)]
    debug: bool,
    /// vsg-rs: with --fix, also apply fixes that may change behaviour
    #[arg(long = "unsafe_fixes")]
    unsafe_fixes: bool,
}

/// VSG's multi-letter single-dash options, as long options.
fn normalize(args: impl Iterator<Item = String>) -> Vec<String> {
    args.map(|a| {
        let long = match a.as_str() {
            "-lr" => "--local_rules",
            "-fp" => "--fix_phase",
            "-js" => "--json",
            "-of" => "--output_format",
            "-oc" => "--output_configuration",
            "-rc" => "--rule_configuration",
            "-ap" => "--all_phases",
            _ => return a,
        };
        long.to_owned()
    })
    .collect()
}

fn usage_error(message: &str) -> ExitCode {
    let mut cmd = Args::command();
    eprintln!("{}", cmd.render_usage());
    eprintln!("VHDL Style Guide (VSG): error: {message}");
    ExitCode::from(1)
}

/// Renders a report file from all results.
type Render = fn(&[FileResult]) -> String;

/// The result for one input.
struct FileResult {
    name: String,
    violations: Vec<Diagnostic>,
    error: Option<String>,
    output: Option<Vec<u8>>,
}

fn capitalized(severity: &str) -> &'static str {
    if severity == "warning" {
        "Warning"
    } else {
        "Error"
    }
}

fn check(
    name: &str,
    source: Vec<u8>,
    cfg: &Config,
    args: &Args,
    options: &FixOptions,
) -> FileResult {
    let parsed = Parsed::new(source);
    let mut result = FileResult {
        name: name.to_owned(),
        violations: Vec::new(),
        error: None,
        output: None,
    };
    if !parsed.syntax_errors().is_empty() {
        let e = vsg_rs::FormatError::Syntax(parsed.syntax_errors().to_vec());
        result.error = Some(describe_error(&parsed, &e));
        return result;
    }
    let indent_only = args.style == Some(Style::IndentOnly);
    if args.fix {
        let fixed = if indent_only {
            vsg_rs::reindent(&parsed, &cfg.format).map(|out| (out, Vec::new()))
        } else {
            vsg_rs::fix_with(&parsed, cfg, options).map(|o| {
                let fixed = Parsed::new(o.output.clone());
                let remaining = o
                    .remaining
                    .iter()
                    .map(|v| diagnostic(name, &fixed, v))
                    .collect();
                (o.output, remaining)
            })
        };
        match fixed {
            Ok((output, remaining)) => {
                result.violations = remaining;
                result.output = Some(output);
            }
            Err(e) => result.error = Some(describe_error(&parsed, &e)),
        }
        return result;
    }
    let formatted = if indent_only {
        vsg_rs::reindent(&parsed, &cfg.format)
    } else {
        let (violations, formatted) = rules::check_and_format(&parsed, cfg);
        result.violations = violations
            .iter()
            .map(|v| diagnostic(name, &parsed, v))
            .collect();
        formatted
    };
    match formatted {
        Ok(formatted) if formatted != parsed.source() => {
            result
                .violations
                .extend(format_findings(name, parsed.source(), &formatted));
        }
        Ok(_) => {}
        Err(e) => result.error = Some(describe_error(&parsed, &e)),
    }
    result
}

/// Console order: by line, then rule.
fn by_line(r: &FileResult) -> Vec<&Diagnostic> {
    let mut v: Vec<&Diagnostic> = r.violations.iter().collect();
    v.sort_by(|a, b| (a.line, &a.rule).cmp(&(b.line, &b.rule)));
    v
}

/// File report order: by rule, then line.
fn by_rule(r: &FileResult) -> Vec<&Diagnostic> {
    let mut v: Vec<&Diagnostic> = r.violations.iter().collect();
    v.sort_by(|a, b| (&a.rule, a.line).cmp(&(&b.rule, b.line)));
    v
}

fn counts(r: &FileResult) -> (usize, usize) {
    let errors = r
        .violations
        .iter()
        .filter(|d| d.severity != "warning")
        .count();
    (errors, r.violations.len() - errors)
}

fn vsg_report(out: &mut String, r: &FileResult, rules_checked: usize) {
    use std::fmt::Write as _;
    let banner = "=".repeat(80);
    let (errors, warnings) = counts(r);
    let _ = writeln!(out, "{banner}\nFile:  {}\n{banner}", r.name);
    let _ = writeln!(out, "Phase 1 of 1... Reporting");
    let _ = writeln!(out, "Total Rules Checked: {rules_checked}");
    let _ = writeln!(out, "Total Violations: {:>4}", r.violations.len());
    let _ = writeln!(out, "  Error   : {errors:>5}");
    let _ = writeln!(out, "  Warning : {warnings:>5}");
    if r.violations.is_empty() {
        out.push('\n');
        return;
    }
    let width = r
        .violations
        .iter()
        .map(|d| d.rule.len())
        .max()
        .unwrap_or(0)
        .max(4)
        + 1;
    let separator = format!(
        "{}+------------+------------+{}",
        "-".repeat(width + 2),
        "-".repeat(38)
    );
    let _ = writeln!(out, "{separator}");
    let _ = writeln!(
        out,
        "  {:width$}|  severity  |  line(s)   | Solution",
        "Rule"
    );
    let _ = writeln!(out, "{separator}");
    for d in by_line(r) {
        let _ = writeln!(
            out,
            "  {:width$}| {:11}|{:>11} | {}",
            d.rule,
            capitalized(&d.severity),
            d.line,
            d.message
        );
    }
    let _ = writeln!(out, "{separator}");
    let _ = writeln!(
        out,
        "NOTE: Refer to online documentation at \
         https://vhdl-style-guide.readthedocs.io/en/latest/index.html for more information."
    );
}

fn syntastic_report(out: &mut String, r: &FileResult) {
    use std::fmt::Write as _;
    for d in by_line(r) {
        let _ = writeln!(
            out,
            "{}: {}({}){} -- {}",
            capitalized(&d.severity).to_uppercase(),
            r.name,
            d.line,
            d.rule,
            d.message
        );
    }
}

fn summary_report(out: &mut String, r: &FileResult, rules_checked: usize) {
    use std::fmt::Write as _;
    let (errors, warnings) = counts(r);
    let status = if errors > 0 { "ERROR" } else { "OK" };
    let _ = writeln!(
        out,
        "File: {} {status} ({rules_checked} rules checked) [Error: {errors}] [Warning: {warnings}]",
        r.name
    );
}

fn json_report(results: &[FileResult]) -> String {
    let files: Vec<serde_json::Value> = results
        .iter()
        .map(|r| {
            let violations: Vec<serde_json::Value> = by_rule(r)
                .into_iter()
                .map(|d| {
                    serde_json::json!({
                        "rule": d.rule,
                        "linenumber": d.line,
                        "severity": capitalized(&d.severity),
                        "solution": d.message,
                    })
                })
                .collect();
            serde_json::json!({ "file_path": r.name, "violations": violations })
        })
        .collect();
    serde_json::to_string_pretty(&serde_json::json!({ "files": files })).unwrap_or_default()
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The current UTC time as `YYYY-MM-DDTHH:MM:SS`.
fn timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let days = i64::try_from(secs / 86_400).unwrap_or(0);
    let rest = secs % 86_400;
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}",
        rest / 3600,
        rest / 60 % 60,
        rest % 60
    )
}

fn hostname() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|h| h.trim().to_owned())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "localhost".into())
}

fn junit_report(results: &[FileResult]) -> String {
    use std::fmt::Write as _;
    let failures = results.iter().filter(|r| !r.violations.is_empty()).count();
    let mut out = String::from("<?xml version=\"1.0\" ?>\n");
    let _ = writeln!(
        out,
        "<testsuite errors=\"0\" hostname=\"{}\" failures=\"{failures}\" timestamp=\"{}\" \
         tests=\"{}\" time=\"0\" name=\"vhdl-style-guide\">",
        xml_escape(&hostname()),
        timestamp(),
        results.len()
    );
    out.push_str("  <properties>\n  </properties>\n");
    for r in results {
        let _ = writeln!(
            out,
            "  <testcase name=\"{}\" time=\"0\">",
            xml_escape(&r.name)
        );
        if !r.violations.is_empty() {
            out.push_str("    <failure type=\"Failure\">\n");
            for d in by_rule(r) {
                let _ = writeln!(
                    out,
                    "      {}: {} : {}",
                    d.rule,
                    d.line,
                    xml_escape(&d.message)
                );
            }
            out.push_str("    </failure>\n");
        }
        out.push_str("  </testcase>\n");
    }
    out.push_str(
        "  <system-out>\n  </system-out>\n  <system-err>\n  </system-err>\n</testsuite>\n",
    );
    out
}

fn quality_report(results: &[FileResult]) -> String {
    let issues: Vec<serde_json::Value> = results
        .iter()
        .flat_map(|r| by_rule(r).into_iter().map(move |d| (r, d)))
        .map(|(r, d)| {
            let key = format!("{}:{}:{}:{}", r.name, d.rule, d.line, d.message);
            serde_json::json!({
                "description": format!("{} :: {}", d.rule, d.message),
                "fingerprint": crate::report::fingerprint(&key),
                "severity": if d.severity == "warning" { "minor" } else { "critical" },
                "location": { "path": r.name, "lines": { "begin": d.line } },
            })
        })
        .collect();
    serde_json::to_string_pretty(&issues).unwrap_or_default()
}

fn write_file(path: &Path, text: &str) -> Result<(), String> {
    std::fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
}

fn directory_result(name: String) -> FileResult {
    FileResult {
        name: name.clone(),
        violations: vec![Diagnostic {
            file: name,
            line: 0,
            column: 0,
            end_line: 0,
            end_column: 0,
            rule: "source_file_001".into(),
            severity: "error".into(),
            message: "Is a directory".into(),
            fix: "none",
        }],
        error: None,
        output: None,
    }
}

/// Write a fixed file (with an optional `.bak` copy of the original).
fn write_fixed(path: &Path, output: &[u8], backup: bool) -> Result<(), String> {
    let original = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if output == original.as_slice() {
        return Ok(());
    }
    if backup {
        let mut name = path.as_os_str().to_owned();
        name.push(".bak");
        std::fs::write(&name, &original)
            .map_err(|e| format!("{}: {e}", Path::new(&name).display()))?;
    }
    write_atomically(path, output).map_err(|e| format!("{}: {e}", path.display()))
}

fn fix_options(args: &Args) -> Result<FixOptions, String> {
    let only = match &args.fix_only {
        None => None,
        Some(path) => Some(
            std::fs::read_to_string(path)
                .map_err(|e| e.to_string())
                .and_then(|t| FixOptions::parse_fix_only(&t))
                .map_err(|e| format!("{}: {e}", path.display()))?,
        ),
    };
    Ok(FixOptions {
        unsafe_fixes: args.unsafe_fixes,
        only,
    })
}

pub fn main(command_line: Vec<String>) -> ExitCode {
    let args = match Args::try_parse_from(normalize(command_line.into_iter())) {
        Ok(args) => args,
        Err(e) => e.exit(),
    };
    if args.version {
        println!(
            "vsg-rs version: {} (VHDL Style Guide (VSG) 3.35 compatible)",
            env!("CARGO_PKG_VERSION")
        );
        return ExitCode::SUCCESS;
    }
    if args.local_rules.is_some() {
        eprintln!(
            "ERROR: local rules are Python plugins for VSG's own rule engine and cannot be \
             loaded by vsg-rs."
        );
        return ExitCode::from(1);
    }
    if let Some(jobs) = args.jobs {
        let _ = rayon::ThreadPoolBuilder::new()
            .num_threads(jobs.max(1))
            .build_global();
    }
    let mut cfg = match Config::load(&args.configuration) {
        Ok(cfg) => cfg,
        Err(e) => {
            eprintln!("ERROR: {e}");
            return ExitCode::from(1);
        }
    };
    for w in &cfg.warnings {
        eprintln!("WARNING: {w}");
    }
    if args.style == Some(Style::IndentOnly) {
        cfg.enable_only_group("indent");
    }
    if let Some(id) = &args.rule_configuration {
        let Some(value) = cfg.rule_configuration(id) else {
            println!("ERROR: rule {id} was not found.");
            return ExitCode::from(1);
        };
        let doc = serde_json::json!({ "rule": { id.as_str(): value } });
        println!("{}", serde_json::to_string_pretty(&doc).unwrap_or_default());
        return ExitCode::SUCCESS;
    }
    if let Some(path) = &args.output_configuration {
        let text = serde_json::to_string_pretty(&cfg.effective_configuration()).unwrap_or_default();
        if let Err(e) = write_file(path, &(text + "\n")) {
            eprintln!("ERROR: {e}");
            return ExitCode::from(1);
        }
    }
    let options = match fix_options(&args) {
        Ok(options) => options,
        Err(e) => {
            eprintln!("ERROR: {e}");
            return ExitCode::from(1);
        }
    };
    let mut files: Vec<PathBuf> = args.filename.clone();
    files.extend(args.positional.iter().cloned());
    if !args.stdin && files.is_empty() {
        if args.output_configuration.is_none() {
            let _ = Args::command().print_help();
        }
        return ExitCode::SUCCESS;
    }
    if !args.stdin
        && let Some(missing) = files.iter().find(|f| !f.exists())
    {
        return usage_error(&format!(
            "argument -f/--filename: The file {} does not exist.",
            missing.display()
        ));
    }
    let rules_checked = cfg.enabled_rule_count();
    let start = std::time::Instant::now();
    let results: Vec<FileResult> = if args.stdin {
        let mut source = Vec::new();
        if let Err(e) = io::stdin().read_to_end(&mut source) {
            eprintln!("ERROR: stdin: {e}");
            return ExitCode::from(1);
        }
        vec![check("stdin", source, &cfg, &args, &options)]
    } else {
        files
            .par_iter()
            .map(|path| {
                let name = path.display().to_string();
                if path.is_dir() {
                    return directory_result(name);
                }
                match std::fs::read(path) {
                    Ok(source) => check(&name, source, &cfg.for_path(path), &args, &options),
                    Err(e) => FileResult {
                        name,
                        violations: Vec::new(),
                        error: Some(e.to_string()),
                        output: None,
                    },
                }
            })
            .collect()
    };
    if args.debug {
        eprintln!(
            "DEBUG: {} input(s) processed in {:.2?}",
            results.len(),
            start.elapsed()
        );
    }
    let mut failed = false;
    let mut report = String::new();
    for (i, r) in results.iter().enumerate() {
        if let Some(e) = &r.error {
            eprintln!("ERROR: {}: {e}", r.name);
            failed = true;
            continue;
        }
        if let Some(output) = &r.output {
            if args.stdin {
                let _ = io::stdout().write_all(output);
            } else if let Err(e) = write_fixed(&files[i], output, args.backup) {
                eprintln!("ERROR: {e}");
                failed = true;
                continue;
            }
        }
        failed |= counts(r).0 > 0;
        match args.output_format {
            OutputFormat::Vsg => vsg_report(&mut report, r, rules_checked),
            OutputFormat::Syntastic => syntastic_report(&mut report, r),
            OutputFormat::Summary => summary_report(&mut report, r, rules_checked),
        }
    }
    // With `--stdin --fix`, stdout carries the fixed source and the report goes to stderr.
    if args.stdin && args.fix {
        eprint!("{report}");
    } else {
        print!("{report}");
    }
    let outputs: [(&Option<PathBuf>, Render); 3] = [
        (&args.json, json_report),
        (&args.junit, junit_report),
        (&args.quality_report, quality_report),
    ];
    for (path, render) in outputs {
        if let Some(path) = path
            && let Err(e) = write_file(path, &(render(&results) + "\n"))
        {
            eprintln!("ERROR: {e}");
            failed = true;
        }
    }
    let _ = io::stdout().flush();
    ExitCode::from(u8::from(failed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(violations: Vec<(&str, usize, &str)>) -> FileResult {
        FileResult {
            name: "a.vhd".into(),
            violations: violations
                .into_iter()
                .map(|(rule, line, severity)| Diagnostic {
                    file: "a.vhd".into(),
                    line,
                    column: 1,
                    end_line: line,
                    end_column: 1,
                    rule: rule.into(),
                    severity: severity.into(),
                    message: "Add *entity* keyword".into(),
                    fix: "safe",
                })
                .collect(),
            error: None,
            output: None,
        }
    }

    #[test]
    fn vsg_table_layout() {
        let mut out = String::new();
        vsg_report(
            &mut out,
            &result(vec![("entity_019", 3, "error"), ("port_014", 2, "error")]),
            177,
        );
        let expected = "\
================================================================================
File:  a.vhd
================================================================================
Phase 1 of 1... Reporting
Total Rules Checked: 177
Total Violations:    2
  Error   :     2
  Warning :     0
-------------+------------+------------+--------------------------------------
  Rule       |  severity  |  line(s)   | Solution
-------------+------------+------------+--------------------------------------
  port_014   | Error      |          2 | Add *entity* keyword
  entity_019 | Error      |          3 | Add *entity* keyword
-------------+------------+------------+--------------------------------------
NOTE: Refer to online documentation at https://vhdl-style-guide.readthedocs.io/en/latest/index.html for more information.
";
        assert_eq!(out, expected);
        let mut clean = String::new();
        vsg_report(&mut clean, &result(vec![]), 889);
        assert!(clean.ends_with("  Warning :     0\n\n"));
    }

    #[test]
    fn short_options() {
        let args = |a: &[&str]| normalize(a.iter().map(|s| (*s).to_owned()));
        assert_eq!(
            args(&["vsg-rs", "-fp", "3", "-of", "summary", "-f", "x"]),
            [
                "vsg-rs",
                "--fix_phase",
                "3",
                "--output_format",
                "summary",
                "-f",
                "x"
            ]
        );
        let parsed = Args::try_parse_from(args(&[
            "vsg-rs", "-f", "a.vhd", "b.vhd", "-js", "o.json", "-ap", "--fix",
        ]))
        .unwrap();
        assert_eq!(parsed.filename.len(), 2);
        assert!(parsed.fix && parsed.all_phases && parsed.json.is_some());
    }

    #[test]
    fn timestamp_format() {
        let t = timestamp();
        assert_eq!(t.len(), 19);
        assert_eq!(&t[4..5], "-");
        assert_eq!(&t[10..11], "T");
    }
}
