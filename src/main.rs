//! Command-line interface. All formatting and checking logic lives in the library.
//!
//! Stream contract: in pipe mode (`fmt -`) stdout carries only the formatted source; every
//! message goes to stderr.

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use rayon::prelude::*;
use vsg_rs::{FormatConfig, FormatError, Parsed};

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
    /// Format VHDL files in place, or stdin to stdout with `-`.
    Fmt(FmtArgs),
}

#[derive(clap::Args)]
struct FmtArgs {
    /// Files or directories; `-` reads stdin and writes the result to stdout.
    #[arg(required = true)]
    paths: Vec<PathBuf>,
    /// Report files that would change instead of writing them.
    #[arg(long)]
    check: bool,
    /// Print a unified diff instead of writing files.
    #[arg(long)]
    diff: bool,
    /// Path used for messages (and configuration lookup) when reading stdin.
    #[arg(long, value_name = "PATH")]
    stdin_filename: Option<PathBuf>,
    /// Target line width (overrides configuration).
    #[arg(long, value_name = "COLUMNS")]
    line_length: Option<usize>,
}

/// Exit status: changes found (`--check`) or rule violations.
const EXIT_CHANGES: u8 = 1;
/// Exit status: a file could not be processed.
const EXIT_ERROR: u8 = 2;

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::Fmt(args) => fmt(&args),
    }
}

fn fmt(args: &FmtArgs) -> ExitCode {
    let mut cfg = FormatConfig::default();
    if let Some(width) = args.line_length {
        cfg.width = width;
    }
    if args.paths.iter().any(|p| p == Path::new("-")) {
        if args.paths.len() > 1 {
            eprintln!("error: `-` cannot be combined with other paths");
            return ExitCode::from(EXIT_ERROR);
        }
        return fmt_stdin(args, &cfg);
    }
    let files = match collect_files(&args.paths) {
        Ok(files) => files,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::from(EXIT_ERROR);
        }
    };
    // Files are processed in parallel; reports are printed in path order.
    let results: Vec<(PathBuf, Result<Outcome, String>)> = files
        .into_par_iter()
        .map(|path| {
            let result = fmt_file(&path, args, &cfg);
            (path, result)
        })
        .collect();
    let mut status = 0;
    let mut out = io::stdout().lock();
    for (path, result) in results {
        match result {
            Ok(Outcome::Unchanged) => {}
            Ok(Outcome::Changed(diff)) => {
                if args.check {
                    eprintln!("would reformat {}", path.display());
                    status = status.max(EXIT_CHANGES);
                }
                if let Some(diff) = diff {
                    // A closed pipe is not worth an error message.
                    let _ = out.write_all(diff.as_bytes());
                }
            }
            Err(e) => {
                eprintln!("error: {}: {e}", path.display());
                status = EXIT_ERROR;
            }
        }
    }
    ExitCode::from(status)
}

enum Outcome {
    Unchanged,
    Changed(Option<String>),
}

fn fmt_file(path: &Path, args: &FmtArgs, cfg: &FormatConfig) -> Result<Outcome, String> {
    let source = std::fs::read(path).map_err(|e| e.to_string())?;
    let parsed = Parsed::new(source);
    let formatted = vsg_rs::format_parsed(&parsed, cfg).map_err(|e| describe(&parsed, &e))?;
    if formatted == parsed.source() {
        return Ok(Outcome::Unchanged);
    }
    if args.diff {
        return Ok(Outcome::Changed(Some(unified_diff(
            path,
            parsed.source(),
            &formatted,
        ))));
    }
    if !args.check {
        write_atomically(path, &formatted).map_err(|e| e.to_string())?;
    }
    Ok(Outcome::Changed(None))
}

fn fmt_stdin(args: &FmtArgs, cfg: &FormatConfig) -> ExitCode {
    let name = args
        .stdin_filename
        .clone()
        .unwrap_or_else(|| PathBuf::from("<stdin>"));
    let mut source = Vec::new();
    if let Err(e) = io::stdin().read_to_end(&mut source) {
        eprintln!("error: {}: {e}", name.display());
        return ExitCode::from(EXIT_ERROR);
    }
    let parsed = Parsed::new(source);
    let formatted = match vsg_rs::format_parsed(&parsed, cfg) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("error: {}: {}", name.display(), describe(&parsed, &e));
            return ExitCode::from(EXIT_ERROR);
        }
    };
    let changed = formatted != parsed.source();
    if args.check {
        if changed {
            eprintln!("would reformat {}", name.display());
            return ExitCode::from(EXIT_CHANGES);
        }
        return ExitCode::SUCCESS;
    }
    let bytes = match (args.diff, changed) {
        (true, true) => unified_diff(&name, parsed.source(), &formatted).into_bytes(),
        (true, false) => Vec::new(),
        (false, _) => formatted,
    };
    let mut out = io::stdout().lock();
    if out.write_all(&bytes).and_then(|()| out.flush()).is_err() {
        return ExitCode::from(EXIT_ERROR);
    }
    ExitCode::SUCCESS
}

fn describe(parsed: &Parsed, e: &FormatError) -> String {
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
            format!("{e}{first}; file left unchanged")
        }
        FormatError::Unsupported(d) => format!("{}: {e}; file left unchanged", at(d.offset)),
        FormatError::Internal(_) => format!("{e}; file left unchanged (please report this)"),
    }
}

fn unified_diff(path: &Path, old: &[u8], new: &[u8]) -> String {
    let (old, new) = (String::from_utf8_lossy(old), String::from_utf8_lossy(new));
    let name = path.display().to_string();
    similar::TextDiff::from_lines(old.as_ref(), new.as_ref())
        .unified_diff()
        .header(&name, &name)
        .to_string()
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
                format!("{}: no such file", path.display()),
            ));
        }
    }
    files.sort();
    files.dedup();
    Ok(files)
}
