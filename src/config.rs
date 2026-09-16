//! Configuration: VSG-compatible files resolved into the settings the formatter and the rules
//! consume.
//!
//! Pipeline: raw YAML/JSON document → validation (unknown or unsupported keys become warnings)
//! → VSG compatibility mapping → [`Config`]. Formatter and rules only read the resolved form.

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};

use yaml_serde::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeywordCase {
    Lower,
    Upper,
    Preserve,
}

/// Formatting policy. Everything here influences canonical output.
#[derive(Debug, Clone)]
pub struct FormatConfig {
    /// Target line width in display columns (see `docs/line-folding.md`).
    pub width: usize,
    /// Spaces per indentation level.
    pub indent: usize,
    pub keyword_case: KeywordCase,
    /// Output line ending; `None` keeps the line ending of the input.
    pub line_ending: Option<LineEnding>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    Lf,
    CrLf,
}

impl Default for FormatConfig {
    fn default() -> Self {
        FormatConfig {
            width: 120,
            indent: 2,
            keyword_case: KeywordCase::Lower,
            line_ending: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Warning,
    Error,
}

impl fmt::Display for Severity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Severity::Warning => "warning",
            Severity::Error => "error",
        })
    }
}

/// Settings of one rule as written in a configuration file (`None`: not set at this level).
#[derive(Debug, Clone, Default)]
struct RuleLayer {
    disable: Option<bool>,
    severity: Option<Severity>,
    fixable: Option<bool>,
    options: BTreeMap<String, Value>,
}

/// Effective settings of one rule.
#[derive(Debug, Clone)]
pub struct RuleSettings {
    pub enabled: bool,
    pub severity: Severity,
    pub fixable: bool,
    options: BTreeMap<String, Value>,
}

impl RuleSettings {
    pub fn option_str(&self, key: &str) -> Option<&str> {
        self.options.get(key).and_then(Value::as_str)
    }

    pub fn option_usize(&self, key: &str) -> Option<usize> {
        self.options
            .get(key)
            .and_then(Value::as_u64)
            .and_then(|v| usize::try_from(v).ok())
    }
}

/// Resolved configuration.
#[derive(Debug, Clone, Default)]
pub struct Config {
    pub format: FormatConfig,
    global: RuleLayer,
    groups: BTreeMap<String, RuleLayer>,
    rules: BTreeMap<String, RuleLayer>,
    /// Problems found while loading that did not prevent loading.
    pub warnings: Vec<String>,
}

#[derive(Debug)]
pub struct ConfigError {
    pub path: PathBuf,
    pub message: String,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.path.display(), self.message)
    }
}

impl std::error::Error for ConfigError {}

/// File names looked up by [`discover`], in order of preference.
pub const CONFIG_FILE_NAMES: [&str; 4] =
    ["vsg-rs.yaml", ".vsg-rs.yaml", "vsg-rs.json", ".vsg-rs.json"];

/// The nearest configuration file in `dir` or its ancestors.
pub fn discover(dir: &Path) -> Option<PathBuf> {
    dir.ancestors()
        .flat_map(|d| CONFIG_FILE_NAMES.iter().map(move |n| d.join(n)))
        .find(|p| p.is_file())
}

impl Config {
    /// Load and merge configuration files; later files override earlier ones.
    pub fn load(paths: &[PathBuf]) -> Result<Config, ConfigError> {
        let mut cfg = Config::default();
        for path in paths {
            let error = |message: String| ConfigError {
                path: path.clone(),
                message,
            };
            let text = std::fs::read_to_string(path).map_err(|e| error(e.to_string()))?;
            // JSON is a subset of YAML, so one parser handles both formats.
            let doc: Value = yaml_serde::from_str(&text).map_err(|e| error(e.to_string()))?;
            cfg.merge(&doc).map_err(error)?;
        }
        cfg.resolve_format();
        Ok(cfg)
    }

    /// Load configuration from a YAML or JSON string.
    pub fn parse(text: &str) -> Result<Config, String> {
        let doc: Value = yaml_serde::from_str(text).map_err(|e| e.to_string())?;
        let mut cfg = Config::default();
        cfg.merge(&doc)?;
        cfg.resolve_format();
        Ok(cfg)
    }

    fn merge(&mut self, doc: &Value) -> Result<(), String> {
        let Some(map) = doc.as_mapping() else {
            if doc.is_null() {
                return Ok(());
            }
            return Err("expected a mapping at the top level".into());
        };
        for (key, value) in map {
            let key = key.as_str().unwrap_or_default();
            match key {
                "rule" => self.merge_rules(value)?,
                "linesep" => {
                    self.format.line_ending = match value.as_str() {
                        Some("\n") => Some(LineEnding::Lf),
                        Some("\r\n") => Some(LineEnding::CrLf),
                        _ => return Err(format!("linesep: unsupported value {value:?}")),
                    };
                }
                // Files are selected on the command line.
                "file_list" => self.warn("file_list is ignored; pass files on the command line"),
                "file_rules" | "local_rules" | "indent" | "pragma" => {
                    self.warn(&format!("`{key}` is not supported yet and is ignored"));
                }
                _ => self.warn(&format!("unknown top-level key `{key}` ignored")),
            }
        }
        Ok(())
    }

    fn merge_rules(&mut self, value: &Value) -> Result<(), String> {
        let Some(map) = value.as_mapping() else {
            return Err("`rule` must be a mapping".into());
        };
        for (key, settings) in map {
            let key = key.as_str().unwrap_or_default();
            match key {
                "global" => merge_layer(&mut self.global, settings, key)?,
                "group" => {
                    let Some(groups) = settings.as_mapping() else {
                        return Err("`rule.group` must be a mapping".into());
                    };
                    for (name, settings) in groups {
                        let name = name.as_str().unwrap_or_default().to_owned();
                        let layer = self.groups.entry(name.clone()).or_default();
                        merge_layer(layer, settings, &name)?;
                    }
                }
                id => {
                    if !crate::rules::is_known_rule(id) {
                        self.warn(&format!(
                            "rule `{id}` is not implemented by vsg-rs; its settings are ignored"
                        ));
                    }
                    merge_layer(self.rules.entry(id.to_owned()).or_default(), settings, id)?;
                }
            }
        }
        Ok(())
    }

    fn warn(&mut self, message: &str) {
        self.warnings.push(message.to_owned());
    }

    /// Map VSG rule options that are formatter policy onto the formatter configuration.
    fn resolve_format(&mut self) {
        if let Some(width) = self.layer_option("length_001", &["length"], "length")
            && let Some(width) = width.as_u64().and_then(|w| usize::try_from(w).ok())
        {
            self.format.width = width;
        }
        if let Some(size) = self
            .global
            .options
            .get("indent_size")
            .and_then(Value::as_u64)
        {
            self.format.indent = usize::try_from(size).unwrap_or(2);
        }
        let case = ["case::keyword", "case"]
            .iter()
            .find_map(|g| self.groups.get(*g).and_then(|l| l.options.get("case")))
            .or_else(|| self.global.options.get("case"))
            .and_then(Value::as_str);
        match case {
            Some("lower") => self.format.keyword_case = KeywordCase::Lower,
            Some("upper") => self.format.keyword_case = KeywordCase::Upper,
            Some(other) => self.warn(&format!("keyword case `{other}` is not supported")),
            None => {}
        }
        let keyword_case_disabled = ["case::keyword", "case"]
            .iter()
            .any(|g| self.groups.get(*g).and_then(|l| l.disable) == Some(true));
        if keyword_case_disabled {
            self.format.keyword_case = KeywordCase::Preserve;
        }
    }

    fn layer_option(&self, rule: &str, groups: &[&str], key: &str) -> Option<&Value> {
        self.rules
            .get(rule)
            .and_then(|l| l.options.get(key))
            .or_else(|| {
                groups
                    .iter()
                    .find_map(|g| self.groups.get(*g)?.options.get(key))
            })
            .or_else(|| self.global.options.get(key))
    }

    /// Effective settings for a rule: rule-specific settings override its groups, which
    /// override `global`, which override the rule's defaults.
    pub fn rule(&self, info: &crate::rules::RuleInfo) -> RuleSettings {
        let mut layers = vec![&self.global];
        layers.extend(info.groups.iter().filter_map(|g| self.groups.get(*g)));
        layers.extend(self.rules.get(info.id));
        let mut settings = RuleSettings {
            enabled: info.enabled_by_default,
            severity: info.severity,
            fixable: true,
            options: BTreeMap::new(),
        };
        for layer in layers {
            if let Some(disable) = layer.disable {
                settings.enabled = !disable;
            }
            if let Some(severity) = layer.severity {
                settings.severity = severity;
            }
            if let Some(fixable) = layer.fixable {
                settings.fixable = fixable;
            }
            for (k, v) in &layer.options {
                settings.options.insert(k.clone(), v.clone());
            }
        }
        settings
    }
}

fn merge_layer(layer: &mut RuleLayer, settings: &Value, name: &str) -> Result<(), String> {
    let Some(map) = settings.as_mapping() else {
        return Err(format!("settings of `{name}` must be a mapping"));
    };
    for (key, value) in map {
        let key = key.as_str().unwrap_or_default();
        let bad = || format!("`{name}.{key}` has an invalid value {value:?}");
        match key {
            "disable" => layer.disable = Some(value.as_bool().ok_or_else(bad)?),
            "fixable" => layer.fixable = Some(value.as_bool().ok_or_else(bad)?),
            "severity" => {
                layer.severity = Some(
                    match value.as_str().map(str::to_ascii_lowercase).as_deref() {
                        Some("error") => Severity::Error,
                        Some("warning") => Severity::Warning,
                        _ => return Err(bad()),
                    },
                );
            }
            // VSG phases do not exist in vsg-rs; see docs/compatibility.md.
            "phase" | "indent_style" | "user_error_message" => {}
            _ => {
                layer.options.insert(key.to_owned(), value.clone());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vsg_style_configuration() {
        let cfg = Config::parse(
            "rule:\n  global:\n    indent_size: 4\n  group:\n    case::keyword:\n      case: upper\n  length_001:\n    length: 100\n  entity_015:\n    disable: true\n    severity: warning\nlinesep: \"\\r\\n\"\nindent:\n  tokens: {}\n",
        )
        .unwrap();
        assert_eq!(cfg.format.width, 100);
        assert_eq!(cfg.format.indent, 4);
        assert_eq!(cfg.format.keyword_case, KeywordCase::Upper);
        assert_eq!(cfg.format.line_ending, Some(LineEnding::CrLf));
        assert!(cfg.warnings.iter().any(|w| w.contains("indent")));
        let info = crate::rules::info("entity_015").unwrap();
        let rule = cfg.rule(info);
        assert!(!rule.enabled);
        assert_eq!(rule.severity, Severity::Warning);
    }

    #[test]
    fn precedence_global_group_rule() {
        let cfg = Config::parse(
            "rule:\n  global:\n    disable: true\n  group:\n    structure::optional:\n      disable: false\n  entity_019:\n    disable: true\n",
        )
        .unwrap();
        assert!(cfg.rule(crate::rules::info("entity_015").unwrap()).enabled);
        assert!(!cfg.rule(crate::rules::info("entity_019").unwrap()).enabled);
        assert!(!cfg.rule(crate::rules::info("process_016").unwrap()).enabled);
    }

    #[test]
    fn json_and_errors() {
        let cfg = Config::parse(r#"{"rule": {"length_001": {"length": 80}}}"#).unwrap();
        assert_eq!(cfg.format.width, 80);
        assert!(Config::parse("rule: {entity_015: {disable: maybe}}").is_err());
        assert!(
            Config::parse("rule: {no_such_rule_999: {disable: true}}")
                .unwrap()
                .warnings
                .iter()
                .any(|w| w.contains("no_such_rule_999"))
        );
    }
}
