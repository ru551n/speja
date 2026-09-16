//! Command-line interface. All formatting and checking logic lives in the library.
//!
//! Stream contract: when reading stdin (`-`), stdout carries only the resulting source (or the
//! diff / report that was asked for); every message goes to stderr.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

mod report;

use clap::{Parser, Subcommand, ValueEnum};
use rayon::prelude::*;
use vsg_rs::config::{self, Config, Severity};
use vsg_rs::rules::{self, FixSafety, Violation};
use vsg_rs::{FormatError, Parsed};

#[derive(Parser)]
#[command(
    name = "vsg-rs",
    version,
    about = "VHDL formatter and style checker (VSG-compatible)"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Format files in place, or stdin to stdout with `-`.
    Fmt {
        #[command(flatten)]
        input: Input,
        /// Report files that would change instead of writing them.
        #[arg(long)]
        check: bool,
        /// Print a unified diff instead of writing files.
        #[arg(long)]
        diff: bool,
        /// Format only lines START to END (1-based, inclusive); stdin (`-`) only.
        #[arg(long, value_name = "START:END", value_parser = parse_line_range)]
        range: Option<(usize, usize)>,
    },
    /// Report rule violations.
    Lint {
        #[command(flatten)]
        input: Input,
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        output_format: OutputFormat,
    },
    /// Report rule violations and files that are not formatted (for CI).
    Check {
        #[command(flatten)]
        input: Input,
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        output_format: OutputFormat,
    },
    /// Apply all safe fixes and format, in place (or stdin to stdout with `-`).
    Fix {
        #[command(flatten)]
        input: Input,
        /// Print a unified diff instead of writing files.
        #[arg(long)]
        diff: bool,
        /// Also apply fixes that may change behaviour or drop comments (review the result).
        #[arg(long)]
        unsafe_fixes: bool,
    },
    /// List the implemented rules (`--all`: every VSG rule and who handles it).
    Rules {
        #[arg(long)]
        all: bool,
    },
    /// Describe a rule.
    Explain { rule: String },
}

#[derive(clap::Args)]
struct Input {
    /// Files or directories; `-` reads stdin.
    #[arg(required = true)]
    paths: Vec<PathBuf>,
    /// Path used for messages and configuration lookup when reading stdin.
    #[arg(long, value_name = "PATH")]
    stdin_filename: Option<PathBuf>,
    /// Configuration file(s) in VSG format (YAML or JSON); later files override earlier ones.
    /// Without this option, the nearest vsg-rs.yaml / .vsg-rs.yaml (or .json) is used.
    #[arg(long, short = 'c', value_name = "FILE")]
    config: Vec<PathBuf>,
    /// Target line width (overrides configuration).
    #[arg(long, value_name = "COLUMNS")]
    line_length: Option<usize>,
}

#[derive(Clone, Copy, ValueEnum)]
enum OutputFormat {
    Text,
    Json,
    /// SARIF 2.1.0 (code scanning)
    Sarif,
    /// JUnit XML (one test case per file)
    Junit,
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Format {
        check: bool,
        diff: bool,
        range: Option<(usize, usize)>,
    },
    Lint {
        check_format: bool,
    },
    Fix {
        diff: bool,
        unsafe_fixes: bool,
    },
}

/// Exit status: changes needed or violations found.
const EXIT_FINDINGS: u8 = 1;
/// Exit status: a file could not be processed, or invalid usage.
const EXIT_ERROR: u8 = 2;

fn main() -> ExitCode {
    let cli = Cli::parse();
    let (input, mode, output_format) = match cli.command {
        Command::Fmt {
            input,
            check,
            diff,
            range,
        } => (
            input,
            Mode::Format { check, diff, range },
            OutputFormat::Text,
        ),
        Command::Lint {
            input,
            output_format,
        } => (
            input,
            Mode::Lint {
                check_format: false,
            },
            output_format,
        ),
        Command::Check {
            input,
            output_format,
        } => (input, Mode::Lint { check_format: true }, output_format),
        Command::Fix {
            input,
            diff,
            unsafe_fixes,
        } => (input, Mode::Fix { diff, unsafe_fixes }, OutputFormat::Text),
        Command::Rules { all } => return list_rules(all),
        Command::Explain { rule } => return explain(&rule),
    };
    run(&input, mode, output_format)
}

// ------------------------------------------------------------------ configuration

struct Configs {
    explicit: Option<Arc<Config>>,
    line_length: Option<usize>,
    by_dir: Mutex<HashMap<PathBuf, Arc<Config>>>,
}

impl Configs {
    fn new(input: &Input) -> Result<Configs, String> {
        let explicit = if input.config.is_empty() {
            None
        } else {
            let cfg = Config::load(&input.config).map_err(|e| e.to_string())?;
            report_config_warnings(&input.config[input.config.len() - 1], &cfg);
            Some(Arc::new(cfg))
        };
        Ok(Configs {
            explicit,
            line_length: input.line_length,
            by_dir: Mutex::new(HashMap::new()),
        })
    }

    /// Configuration for a file: explicit `--config`, else the nearest configuration file.
    fn for_file(&self, file: &Path) -> Result<Arc<Config>, String> {
        let base = if let Some(cfg) = &self.explicit {
            Arc::clone(cfg)
        } else {
            self.discovered(file)?
        };
        let cfg = match base.for_path(file) {
            std::borrow::Cow::Borrowed(_) => base,
            std::borrow::Cow::Owned(cfg) => Arc::new(cfg),
        };
        Ok(match self.line_length {
            Some(width) => {
                let mut cfg = (*cfg).clone();
                cfg.format.width = width;
                Arc::new(cfg)
            }
            None => cfg,
        })
    }
}

impl Configs {
    fn discovered(&self, file: &Path) -> Result<Arc<Config>, String> {
        let dir = file
            .parent()
            .filter(|d| !d.as_os_str().is_empty())
            .map_or_else(|| PathBuf::from("."), Path::to_path_buf);
        let dir = std::path::absolute(&dir).unwrap_or(dir);
        let mut cache = self.by_dir.lock().map_err(|e| e.to_string())?;
        if let Some(cfg) = cache.get(&dir) {
            return Ok(Arc::clone(cfg));
        }
        let cfg = match config::discover(&dir) {
            Some(path) => {
                let cfg = Config::load(std::slice::from_ref(&path)).map_err(|e| e.to_string())?;
                report_config_warnings(&path, &cfg);
                cfg
            }
            None => Config::default(),
        };
        let cfg = Arc::new(cfg);
        cache.insert(dir, Arc::clone(&cfg));
        Ok(cfg)
    }
}

fn report_config_warnings(path: &Path, cfg: &Config) {
    for w in &cfg.warnings {
        eprintln!("warning: {}: {w}", path.display());
    }
}

// ------------------------------------------------------------------ processing

/// Result of processing one input.
#[derive(Default)]
struct Report {
    diagnostics: Vec<Diagnostic>,
    /// New contents to write (files) or print (stdin).
    output: Option<Vec<u8>>,
    changed: bool,
    diff: Option<String>,
    error: Option<String>,
}

#[derive(serde::Serialize)]
struct Diagnostic {
    file: String,
    line: usize,
    column: usize,
    end_line: usize,
    end_column: usize,
    rule: String,
    severity: String,
    message: String,
    /// `safe`, `unsafe` (suggestion only), `format` (fixed by the formatter) or `none`.
    fix: &'static str,
}

fn diagnostic(name: &str, parsed: &Parsed, v: &Violation) -> Diagnostic {
    let (line, column) = parsed.line_col(v.start);
    let (end_line, end_column) = parsed.line_col(v.end);
    let fix = match &v.fix {
        Some(f) if f.safety == FixSafety::Safe => "safe",
        Some(_) => "unsafe",
        None if v.rule == "length_001" && v.message.contains("fmt") => "format",
        None => "none",
    };
    Diagnostic {
        file: name.to_owned(),
        line,
        column,
        end_line,
        end_column,
        rule: v.rule.to_owned(),
        severity: v.severity.to_string(),
        message: v.message.clone(),
        fix,
    }
}

fn describe_error(parsed: &Parsed, e: &FormatError) -> String {
    let at = |offset| {
        let (line, col) = parsed.line_col(offset);
        format!("{line}:{col}")
    };
    match e {
        FormatError::Syntax(diags) => {
            let first = diags
                .first()
                .map(|d| format!(" (first at {}: {})", at(d.offset), d.message))
                .unwrap_or_default();
            format!("{e}{first}; left unchanged")
        }
        FormatError::Unsupported(d) => format!("{}: {e}; left unchanged", at(d.offset)),
        FormatError::Internal(_) => format!("{e}; left unchanged (please report this)"),
    }
}

fn unified_diff(name: &str, old: &[u8], new: &[u8]) -> String {
    let (old, new) = (String::from_utf8_lossy(old), String::from_utf8_lossy(new));
    similar::TextDiff::from_lines(old.as_ref(), new.as_ref())
        .unified_diff()
        .header(name, name)
        .to_string()
}

fn process(name: &str, source: Vec<u8>, cfg: &Config, mode: Mode) -> Report {
    let parsed = Parsed::new(source);
    let mut report = Report::default();
    let result = match mode {
        Mode::Format {
            range: Some((first, last)),
            ..
        } => {
            let src = parsed.source();
            // Byte offset where 1-based line `n` starts.
            let line_start = |n: usize| match n.checked_sub(2) {
                None => 0,
                Some(k) => src
                    .iter()
                    .enumerate()
                    .filter(|&(_, &b)| b == b'\n')
                    .nth(k)
                    .map_or(src.len(), |(i, _)| i + 1),
            };
            vsg_rs::format_range(
                &parsed,
                &cfg.format,
                line_start(first)..line_start(last + 1),
            )
            .map(|edits| vsg_rs::apply_edits(src, &edits))
        }
        Mode::Format { .. } => vsg_rs::format_parsed(&parsed, &cfg.format),
        Mode::Fix { unsafe_fixes, .. } => {
            vsg_rs::fix_with(&parsed, cfg, unsafe_fixes).map(|outcome| {
                let fixed = Parsed::new(outcome.output);
                report.diagnostics = outcome
                    .remaining
                    .iter()
                    .map(|v| diagnostic(name, &fixed, v))
                    .collect();
                fixed.source().to_vec()
            })
        }
        Mode::Lint { check_format } => {
            if parsed.syntax_errors().is_empty() {
                if !check_format {
                    report.diagnostics = rules::check(&parsed, cfg)
                        .iter()
                        .map(|v| diagnostic(name, &parsed, v))
                        .collect();
                    return report;
                }
                let (violations, formatted) = rules::check_and_format(&parsed, cfg);
                report.diagnostics = violations
                    .iter()
                    .map(|v| diagnostic(name, &parsed, v))
                    .collect();
                formatted
            } else {
                Err(FormatError::Syntax(parsed.syntax_errors().to_vec()))
            }
        }
    };
    match result {
        Ok(output) => {
            report.changed = output != parsed.source();
            let wants_diff = matches!(
                mode,
                Mode::Format { diff: true, .. } | Mode::Fix { diff: true, .. }
            );
            if report.changed && wants_diff {
                report.diff = Some(unified_diff(name, parsed.source(), &output));
            }
            if let Mode::Lint { check_format: true } = mode {
                if report.changed {
                    report.diagnostics.push(Diagnostic {
                        file: name.to_owned(),
                        line: 1,
                        column: 1,
                        end_line: 1,
                        end_column: 1,
                        rule: "format".into(),
                        severity: Severity::Error.to_string(),
                        message: "file is not formatted; run `vsg-rs fmt`".into(),
                        fix: "format",
                    });
                }
            } else {
                report.output = Some(output);
            }
        }
        Err(e) => report.error = Some(describe_error(&parsed, &e)),
    }
    report
}

/// Replace `path` with `contents` without ever leaving a partially written file.
fn write_atomically(path: &Path, contents: &[u8]) -> io::Result<()> {
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(contents)?;
    tmp.as_file().sync_all()?;
    tmp.as_file()
        .set_permissions(std::fs::metadata(path)?.permissions())?;
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

fn is_vhdl(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("vhd") || e.eq_ignore_ascii_case("vhdl"))
}

/// Expand directories (recursively, skipping hidden entries) into a sorted file list.
fn collect_files(paths: &[PathBuf]) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    let mut stack: Vec<PathBuf> = paths.to_vec();
    while let Some(path) = stack.pop() {
        if path.is_dir() {
            for entry in std::fs::read_dir(&path)? {
                let p = entry?.path();
                let hidden = p
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with('.'));
                if !hidden && (p.is_dir() || is_vhdl(&p)) {
                    stack.push(p);
                }
            }
        } else if path.is_file() {
            files.push(path);
        } else {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("{}: no such file [source_file_001]", path.display()),
            ));
        }
    }
    files.sort();
    files.dedup();
    Ok(files)
}

fn run(input: &Input, mode: Mode, output_format: OutputFormat) -> ExitCode {
    let configs = match Configs::new(input) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::from(EXIT_ERROR);
        }
    };
    let stdin = input.paths.iter().any(|p| p == Path::new("-"));
    if matches!(mode, Mode::Format { range: Some(_), .. }) && !stdin {
        eprintln!("error: `--range` requires reading stdin (`-`)");
        return ExitCode::from(EXIT_ERROR);
    }
    let reports: Vec<(String, Option<PathBuf>, Report)> = if stdin {
        if input.paths.len() > 1 {
            eprintln!("error: `-` cannot be combined with other paths");
            return ExitCode::from(EXIT_ERROR);
        }
        let hint = input.stdin_filename.clone();
        let name = hint
            .as_ref()
            .map_or_else(|| "<stdin>".to_owned(), |p| p.display().to_string());
        let mut source = Vec::new();
        let report = match (
            io::stdin().read_to_end(&mut source),
            configs.for_file(hint.as_deref().unwrap_or(Path::new("stdin.vhd"))),
        ) {
            (Err(e), _) => Report {
                error: Some(e.to_string()),
                ..Report::default()
            },
            (_, Err(e)) => Report {
                error: Some(e),
                ..Report::default()
            },
            (Ok(_), Ok(cfg)) => process(&name, source, &cfg, mode),
        };
        vec![(name, None, report)]
    } else {
        let files = match collect_files(&input.paths) {
            Ok(files) => files,
            Err(e) => {
                eprintln!("error: {e}");
                return ExitCode::from(EXIT_ERROR);
            }
        };
        // Files are processed in parallel; reports are printed in path order.
        files
            .into_par_iter()
            .map(|path| {
                let name = path.display().to_string();
                let report = match (std::fs::read(&path), configs.for_file(&path)) {
                    (Err(e), _) => Report {
                        error: Some(e.to_string()),
                        ..Report::default()
                    },
                    (_, Err(e)) => Report {
                        error: Some(e),
                        ..Report::default()
                    },
                    (Ok(source), Ok(cfg)) => process(&name, source, &cfg, mode),
                };
                (name, Some(path), report)
            })
            .collect()
    };
    emit(reports, mode, output_format)
}

fn emit(
    reports: Vec<(String, Option<PathBuf>, Report)>,
    mode: Mode,
    output_format: OutputFormat,
) -> ExitCode {
    let mut status = 0;
    let mut stdout = io::stdout().lock();
    let mut diagnostics = Vec::new();
    let mut files = Vec::new();
    for (name, path, report) in reports {
        files.push(name.clone());
        if let Some(e) = &report.error {
            eprintln!("error: {name}: {e}");
            status = EXIT_ERROR;
            continue;
        }
        let check_only = matches!(mode, Mode::Format { check: true, .. });
        if report.changed && check_only {
            eprintln!("would reformat {name}");
            status = status.max(EXIT_FINDINGS);
        }
        let wants_diff = matches!(
            mode,
            Mode::Format { diff: true, .. } | Mode::Fix { diff: true, .. }
        );
        if wants_diff {
            if let Some(diff) = &report.diff {
                // A closed pipe is not worth an error message.
                let _ = stdout.write_all(diff.as_bytes());
            }
        } else if let Some(output) = &report.output {
            match &path {
                // stdin: print the result (even if unchanged).
                None if !check_only => {
                    if stdout
                        .write_all(output)
                        .and_then(|()| stdout.flush())
                        .is_err()
                    {
                        status = EXIT_ERROR;
                    }
                }
                Some(path) if report.changed && !check_only => {
                    if let Err(e) = write_atomically(path, output) {
                        eprintln!("error: {name}: {e}");
                        status = EXIT_ERROR;
                    }
                }
                _ => {}
            }
        }
        if !report.diagnostics.is_empty() {
            status = status.max(EXIT_FINDINGS);
        }
        diagnostics.extend(report.diagnostics);
    }
    let lint_stream: &mut dyn Write = if matches!(mode, Mode::Lint { .. }) {
        &mut stdout
    } else {
        // In fmt/fix mode stdout may carry source code; remaining findings go to stderr.
        &mut io::stderr()
    };
    let _ = match output_format {
        OutputFormat::Json => serde_json::to_writer_pretty(&mut *lint_stream, &diagnostics)
            .map_err(io::Error::other)
            .and_then(|()| writeln!(lint_stream)),
        OutputFormat::Sarif => writeln!(lint_stream, "{}", report::sarif(&diagnostics)),
        OutputFormat::Junit => write!(lint_stream, "{}", report::junit(&files, &diagnostics)),
        OutputFormat::Text => diagnostics.iter().try_for_each(|d| {
            let fix = match d.fix {
                "safe" => " [fixable]",
                "format" => " [fmt]",
                "unsafe" => " [suggestion]",
                _ => "",
            };
            writeln!(
                lint_stream,
                "{}:{}:{}: {}[{}]: {}{fix}",
                d.file, d.line, d.column, d.severity, d.rule, d.message
            )
        }),
    };
    ExitCode::from(status)
}

/// Parse `START:END` (1-based, inclusive line numbers).
fn parse_line_range(s: &str) -> Result<(usize, usize), String> {
    let (a, b) = s.split_once(':').ok_or("expected START:END")?;
    let a: usize = a.trim().parse().map_err(|e| format!("START: {e}"))?;
    let b: usize = b.trim().parse().map_err(|e| format!("END: {e}"))?;
    if a == 0 || b < a {
        return Err("expected 1 <= START <= END".into());
    }
    Ok((a, b))
}

// ------------------------------------------------------------------ rule information

fn list_rules(all: bool) -> ExitCode {
    let mut out = io::stdout().lock();
    if all {
        for (id, owner) in rules::vsg_catalog() {
            let status = if rules::info(id).is_some() {
                "implemented".to_owned()
            } else if owner == rules::Owner::Formatter {
                "formatter".to_owned()
            } else if owner == rules::Owner::Cli {
                "command line".to_owned()
            } else {
                format!("planned ({owner})")
            };
            let _ = writeln!(out, "{id:32} {status}");
        }
    } else {
        for info in rules::implemented() {
            let default = if info.enabled_by_default {
                ""
            } else {
                " (disabled by default)"
            };
            let _ = writeln!(out, "{:28} {}{default}", info.id, info.description);
        }
    }
    ExitCode::SUCCESS
}

fn explain(rule: &str) -> ExitCode {
    if let Some(info) = rules::info(rule) {
        println!("{}: {}", info.id, info.description);
        println!("groups: {}", info.groups.join(", "));
        println!("default severity: {}", info.severity);
        println!("enabled by default: {}", info.enabled_by_default);
        return ExitCode::SUCCESS;
    }
    match rules::vsg_catalog().find(|(id, _)| *id == rule) {
        Some((id, rules::Owner::Formatter)) => {
            println!("{id}: layout rule; enforced by `vsg-rs fmt` (see docs/formatting.md)");
            ExitCode::SUCCESS
        }
        Some((id, rules::Owner::Cli)) => {
            println!("{id}: input files must exist; missing files are an error (exit code 2)");
            ExitCode::SUCCESS
        }
        Some((id, owner)) => {
            println!("{id}: not implemented yet ({owner} rule)");
            ExitCode::SUCCESS
        }
        None => {
            eprintln!("error: unknown rule `{rule}`");
            ExitCode::from(EXIT_ERROR)
        }
    }
}
