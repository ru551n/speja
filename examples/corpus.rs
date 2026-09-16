//! Formats every VHDL file below the given directories and reports formatter defects:
//! internal errors (output not equivalent), non-idempotent output and remaining long code lines.
//!
//! `cargo run --release --example corpus -- [--width N] DIR...` (set `SHOW_LONG=1` to list
//! long lines, `FIX=1` to run `vsg_rs::fix` instead of formatting, `FIX=unsafe` to also apply
//! unsafe fixes).

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use vsg_rs::{Config, FormatError, Parsed};

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect(&p, out);
        } else if p
            .extension()
            .and_then(|x| x.to_str())
            .is_some_and(|x| x.eq_ignore_ascii_case("vhd") || x.eq_ignore_ascii_case("vhdl"))
        {
            out.push(p);
        }
    }
}

fn first_difference(a: &[u8], b: &[u8]) -> String {
    let (a, b) = (String::from_utf8_lossy(a), String::from_utf8_lossy(b));
    a.lines()
        .zip(b.lines())
        .enumerate()
        .find(|(_, (x, y))| x != y)
        .map_or_else(
            || "length differs".into(),
            |(i, (x, y))| format!("line {}:\n    {x}\n    {y}", i + 1),
        )
}

#[allow(clippy::cast_precision_loss)]
fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut config = Config::default();
    if args.first().is_some_and(|a| a == "--width") {
        config.format.width = args[1].parse().expect("width must be a number");
        args.drain(..2);
    }
    let cfg = config.format.clone();
    let fix = std::env::var("FIX").ok();
    let run = |src: Vec<u8>| -> Result<Vec<u8>, FormatError> {
        let parsed = Parsed::new(src);
        if let Some(mode) = &fix {
            vsg_rs::fix_with(&parsed, &config, mode == "unsafe").map(|o| o.output)
        } else {
            vsg_rs::format_parsed(&parsed, &cfg)
        }
    };
    let show_long = std::env::var_os("SHOW_LONG").is_some();
    let mut files = Vec::new();
    for a in &args {
        collect(Path::new(a), &mut files);
    }
    files.sort();
    let (mut ok, mut syntax, mut unsupported, mut internal, mut unstable, mut long) =
        (0, 0, 0, 0, 0, 0);
    let (mut time, mut bytes, mut slowest) = (Duration::ZERO, 0, (Duration::ZERO, PathBuf::new()));
    for f in &files {
        let Ok(src) = std::fs::read(f) else { continue };
        bytes += src.len();
        let start = Instant::now();
        let result = run(src);
        let elapsed = start.elapsed();
        time += elapsed;
        if elapsed > slowest.0 {
            slowest = (elapsed, f.clone());
        }
        let out = match result {
            Ok(out) => out,
            Err(FormatError::Syntax(_)) => {
                syntax += 1;
                continue;
            }
            Err(FormatError::Unsupported(_)) => {
                unsupported += 1;
                continue;
            }
            Err(FormatError::Internal(m)) => {
                internal += 1;
                println!("INTERNAL {}: {m}", f.display());
                continue;
            }
        };
        ok += 1;
        match run(out.clone()) {
            Ok(again) if again == out => {}
            Ok(again) => {
                unstable += 1;
                println!(
                    "UNSTABLE {} {}",
                    f.display(),
                    first_difference(&out, &again)
                );
            }
            Err(e) => {
                unstable += 1;
                println!("UNSTABLE {} second pass: {e}", f.display());
            }
        }
        let utf8 = std::str::from_utf8(&out).is_ok();
        for (i, line) in out.split(|&b| b == b'\n').enumerate() {
            let text = String::from_utf8_lossy(line);
            // Only code counts: trailing comments are never folded.
            let code = text.split("--").next().unwrap_or("").trim_end();
            if vsg_rs::display_width(code.as_bytes(), utf8, 0) > cfg.width {
                long += 1;
                if show_long {
                    println!("LONG {}:{} {}", f.display(), i + 1, text.trim());
                }
            }
        }
    }
    println!(
        "files {} ok {ok} syntax-errors {syntax} unsupported {unsupported} internal {internal} unstable {unstable} long-code-lines {long}",
        files.len()
    );
    println!(
        "{:.1} MB in {time:.2?} (parse+format+verify); slowest {:.2?} {}",
        bytes as f64 / 1e6,
        slowest.0,
        slowest.1.display()
    );
}
