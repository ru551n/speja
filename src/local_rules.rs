//! VSG local rules (`-lr DIR` or `local_rules: DIR`): Python plugins for VSG's own rule engine,
//! which only VSG can run. vsg-rs runs the installed VSG (`vsg` on the path, or the command in
//! `VSG_RS_VSG`) with the same configuration files plus one that disables every built-in rule,
//! so that only the local rules report or fix, and reads VSG's `syntastic` report.

use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Environment variable with the command that runs VSG, for example
/// `uvx --from vsg==3.35.0 vsg`.
const VSG_ENV: &str = "VSG_RS_VSG";

/// A violation reported by a local rule.
pub(crate) struct Finding {
    /// The path as passed to VSG.
    pub path: String,
    pub line: usize,
    pub rule: String,
    /// `error` or `warning`.
    pub severity: String,
    pub message: String,
}

pub(crate) struct LocalRules {
    command: Vec<String>,
    dir: PathBuf,
    configs: Vec<PathBuf>,
    jobs: Option<usize>,
    /// Copies of inputs, and the configuration that disables the built-in rules.
    scratch: tempfile::TempDir,
}

impl LocalRules {
    pub(crate) fn new(
        dir: PathBuf,
        configs: Vec<PathBuf>,
        jobs: Option<usize>,
    ) -> Result<LocalRules, String> {
        if !dir.is_dir() {
            return Err(format!(
                "local rules directory {} does not exist",
                dir.display()
            ));
        }
        let command: Vec<String> = std::env::var(VSG_ENV)
            .ok()
            .map(|c| c.split_whitespace().map(str::to_owned).collect())
            .filter(|c: &Vec<String>| !c.is_empty())
            .unwrap_or_else(|| vec!["vsg".to_owned()]);
        let scratch = tempfile::tempdir().map_err(|e| e.to_string())?;
        let rules: serde_json::Map<String, serde_json::Value> = vsg_rs::vsg_defaults::rule_ids()
            .filter(|id| *id != "global")
            .map(|id| (id.to_owned(), serde_json::json!({ "disable": true })))
            .collect();
        let text = serde_json::json!({ "rule": rules }).to_string();
        std::fs::write(scratch.path().join("builtin_rules_off.json"), text)
            .map_err(|e| e.to_string())?;
        Ok(LocalRules {
            command,
            dir,
            configs,
            jobs,
            scratch,
        })
    }

    /// Write `source` to a scratch file with the name of `path`; `key` keeps copies apart.
    pub(crate) fn scratch_copy(
        &self,
        key: &str,
        path: &Path,
        source: &[u8],
    ) -> io::Result<PathBuf> {
        let dir = self.scratch.path().join(key);
        std::fs::create_dir_all(&dir)?;
        let copy = dir.join(path.file_name().unwrap_or(path.as_os_str()));
        std::fs::write(&copy, source)?;
        Ok(copy)
    }

    /// Run the local rules on `files`: report, or fix the files in place.
    pub(crate) fn run(&self, files: &[PathBuf], fix: bool) -> Result<Vec<Finding>, String> {
        if files.is_empty() {
            return Ok(Vec::new());
        }
        let mut cmd = Command::new(&self.command[0]);
        cmd.args(&self.command[1..])
            .arg("-lr")
            .arg(&self.dir)
            .arg("-c")
            .args(&self.configs)
            .arg(self.scratch.path().join("builtin_rules_off.json"))
            .args(["-of", "syntastic"]);
        // VSG refuses `-ap` with `--fix`.
        cmd.arg(if fix { "--fix" } else { "-ap" });
        if let Some(jobs) = self.jobs {
            cmd.arg("-p").arg(jobs.to_string());
        }
        cmd.arg("-f").args(files);
        let out = cmd.output().map_err(|e| {
            format!(
                "local rules need VSG, which could not be started ({}: {e}); install vsg or set {VSG_ENV}",
                self.command.join(" ")
            )
        })?;
        let findings = parse(&String::from_utf8_lossy(&out.stdout));
        // VSG exits with 1 when violations remain; anything else, or 1 without a report, is a
        // failure of VSG or of the rules.
        let code = out.status.code();
        if code == Some(0) || (code == Some(1) && !findings.is_empty()) {
            return Ok(findings);
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let detail = if stderr.trim().is_empty() {
            stdout
        } else {
            stderr
        };
        Err(format!(
            "VSG failed to run the local rules in {}: {}",
            self.dir.display(),
            detail.trim()
        ))
    }
}

/// Parse VSG's `syntastic` lines: `ERROR: path(line)rule -- message`.
fn parse(report: &str) -> Vec<Finding> {
    let line =
        regex::Regex::new(r"^(ERROR|WARNING): (.*)\((\d+)\)(\w+) -- (.*)$").expect("valid regex");
    report
        .lines()
        .filter_map(|l| line.captures(l.trim_end()))
        .map(|c| Finding {
            path: c[2].to_owned(),
            line: c[3].parse().unwrap_or(0),
            rule: c[4].to_owned(),
            severity: c[1].to_ascii_lowercase(),
            message: c[5].to_owned(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_syntastic_reports() {
        let found = super::parse(
            "ERROR: src/a (1).vhd(12)todo_001 -- Replace TODO\nWARNING: b.vhd(3)x_002 -- Hm\nnoise\n",
        );
        assert_eq!(found.len(), 2);
        assert_eq!(
            (
                found[0].path.as_str(),
                found[0].line,
                found[0].rule.as_str()
            ),
            ("src/a (1).vhd", 12, "todo_001")
        );
        assert_eq!(found[1].severity, "warning");
    }
}
