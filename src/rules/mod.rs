//! Rule engine: rules read one parsed snapshot and report violations with optional fixes.
//!
//! Rules never modify the source and never depend on each other. Results are sorted by
//! position and rule id, so the order in which rules run is irrelevant.

mod case;
mod catalog;
mod length;
mod naming;
mod select;
mod structure;

use std::cell::OnceCell;
use std::collections::HashMap;
use std::fmt;

use vhdl_syntax::syntax::{NodeKind, SyntaxNode, SyntaxToken};

use crate::Parsed;
use crate::config::{Config, RuleSettings, Severity};

/// Which part of vsg-rs is responsible for a VSG rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Owner {
    /// Layout policy, enforced by `vsg-rs fmt`.
    Formatter,
    /// Structural rule whose fix is a syntax-local edit.
    Structure,
    /// Style policy that is reported, not fixed.
    Lint,
    /// Needs name resolution across declarations.
    Semantic,
}

impl fmt::Display for Owner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Owner::Formatter => "formatter",
            Owner::Structure => "structure",
            Owner::Lint => "lint",
            Owner::Semantic => "semantic",
        })
    }
}

/// Static description of an implemented rule.
#[derive(Debug)]
pub struct RuleInfo {
    pub id: &'static str,
    /// VSG rule groups the rule belongs to (for `rule.group` configuration).
    pub groups: &'static [&'static str],
    pub severity: Severity,
    pub enabled_by_default: bool,
    pub description: &'static str,
}

pub(crate) type Check = fn(&Context<'_>, &RuleSettings, &mut Vec<Violation>);

pub(crate) struct Rule {
    pub(crate) info: RuleInfo,
    pub(crate) check: Check,
}

/// How safe it is to apply a fix without review.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FixSafety {
    /// Syntax-local and meaning-preserving; applied by `vsg-rs fix`.
    Safe,
    /// May change behaviour; shown as a suggestion only.
    Unsafe,
}

/// Replace `start..end` of the original source with `text`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edit {
    pub start: usize,
    pub end: usize,
    pub text: String,
    /// Orders insertions at the same offset (lower first).
    pub rank: u8,
}

#[derive(Debug, Clone)]
pub struct Fix {
    pub safety: FixSafety,
    pub edits: Vec<Edit>,
}

#[derive(Debug, Clone)]
pub struct Violation {
    pub rule: &'static str,
    pub severity: Severity,
    /// Byte range in the source.
    pub start: usize,
    pub end: usize,
    pub message: String,
    pub fix: Option<Fix>,
}

/// Shared, lazily built information about one snapshot.
pub(crate) struct Context<'a> {
    pub(crate) parsed: &'a Parsed,
    pub(crate) config: &'a Config,
    by_kind: HashMap<NodeKind, Vec<SyntaxNode>>,
    /// The formatted snapshot, parsed; computed on first use.
    formatted: OnceCell<Result<Parsed, crate::FormatError>>,
    /// The snapshot is known to be formatted already.
    canonical: bool,
}

impl<'a> Context<'a> {
    fn new(parsed: &'a Parsed, config: &'a Config, canonical: bool) -> Self {
        let mut by_kind: HashMap<NodeKind, Vec<SyntaxNode>> = HashMap::new();
        let mut stack = vec![parsed.root().clone()];
        while let Some(n) = stack.pop() {
            stack.extend(n.children());
            by_kind.entry(n.kind()).or_default().push(n);
        }
        // Source order, independent of traversal order.
        for nodes in by_kind.values_mut() {
            nodes.sort_by_key(SyntaxNode::offset);
        }
        Context {
            parsed,
            config,
            by_kind,
            formatted: OnceCell::new(),
            canonical,
        }
    }

    pub(crate) fn nodes(&self, kind: NodeKind) -> &[SyntaxNode] {
        self.by_kind.get(&kind).map_or(&[], Vec::as_slice)
    }

    /// The canonical formatting of this snapshot, parsed once on first use.
    pub(crate) fn formatted(&self) -> Option<&Parsed> {
        if self.canonical {
            return Some(self.parsed);
        }
        self.format_result().as_ref().ok()
    }

    fn format_result(&self) -> &Result<Parsed, crate::FormatError> {
        self.formatted
            .get_or_init(|| crate::format_parsed(self.parsed, &self.config.format).map(Parsed::new))
    }
}

pub(crate) fn violation(
    settings: &RuleSettings,
    rule: &'static str,
    at: &SyntaxToken,
    message: impl Into<String>,
) -> Violation {
    let range = at.text_range();
    Violation {
        rule,
        severity: settings.severity,
        start: range.start,
        end: range.end,
        message: message.into(),
        fix: None,
    }
}

fn rules() -> &'static [Rule] {
    static RULES: std::sync::OnceLock<Vec<Rule>> = std::sync::OnceLock::new();
    RULES.get_or_init(|| {
        let mut all = Vec::new();
        all.extend(case::rules());
        all.extend(length::rules());
        all.extend(naming::rules());
        all.extend(structure::rules());
        all.sort_by_key(|r| r.info.id);
        all
    })
}

/// Description of an implemented rule.
pub fn info(id: &str) -> Option<&'static RuleInfo> {
    rules().iter().map(|r| &r.info).find(|i| i.id == id)
}

/// All implemented rules, sorted by id.
pub fn implemented() -> impl Iterator<Item = &'static RuleInfo> {
    rules().iter().map(|r| &r.info)
}

/// Every VSG rule id with the part of vsg-rs that owns it.
pub fn vsg_catalog() -> impl Iterator<Item = (&'static str, Owner)> {
    catalog::VSG_RULES.iter().copied()
}

pub(crate) fn is_known_rule(id: &str) -> bool {
    catalog::VSG_RULES
        .binary_search_by_key(&id, |(r, _)| r)
        .is_ok()
}

/// Run every enabled rule on a snapshot. Violations are sorted by position, then rule id.
pub fn check(parsed: &Parsed, config: &Config) -> Vec<Violation> {
    run(&Context::new(parsed, config, false))
}

/// [`check`] plus the formatted source, formatting the snapshot at most once.
pub fn check_and_format(
    parsed: &Parsed,
    config: &Config,
) -> (Vec<Violation>, Result<Vec<u8>, crate::FormatError>) {
    let cx = Context::new(parsed, config, false);
    let violations = run(&cx);
    let _ = cx.format_result();
    let formatted = cx
        .formatted
        .into_inner()
        .expect("initialized above")
        .map(|p| p.source().to_vec());
    (violations, formatted)
}

/// [`check`] for collecting fixes: formatter-owned violations (which have no fix) do not need
/// the formatted snapshot, so it is not computed.
pub(crate) fn check_for_fixes(parsed: &Parsed, config: &Config) -> Vec<Violation> {
    run(&Context::new(parsed, config, true))
}

/// [`check`] for a snapshot that is the formatter's own output.
pub(crate) fn check_canonical(parsed: &Parsed, config: &Config) -> Vec<Violation> {
    run(&Context::new(parsed, config, true))
}

fn run(cx: &Context<'_>) -> Vec<Violation> {
    let mut out = Vec::new();
    for rule in rules() {
        let settings = cx.config.rule(&rule.info);
        if !settings.enabled {
            continue;
        }
        let before = out.len();
        (rule.check)(cx, &settings, &mut out);
        if !settings.fixable {
            for v in &mut out[before..] {
                v.fix = None;
            }
        }
    }
    let suppressions = suppressions(cx.parsed);
    if !suppressions.is_empty() {
        out.retain(|v| !suppressed(&suppressions, v));
    }
    out.sort_by(|a, b| (a.start, a.rule, a.end).cmp(&(b.start, b.rule, b.end)));
    out
}

/// A VSG `-- vsg_off [rule ...]` (`on == false`) or `-- vsg_on [rule ...]` comment. An empty
/// rule list applies to all rules.
struct Suppression {
    offset: usize,
    on: bool,
    rules: Vec<String>,
}

fn suppressions(parsed: &Parsed) -> Vec<Suppression> {
    let mut out = Vec::new();
    for t in parsed.tokens() {
        for piece in t.leading_trivia() {
            let vhdl_syntax::tokens::TriviaPiece::LineComment(c) = piece else {
                continue;
            };
            let text = String::from_utf8_lossy(c.as_bytes()).to_ascii_lowercase();
            let mut words = text.trim_start_matches('-').split_whitespace();
            let on = match words.next() {
                Some("vsg_off") => false,
                Some("vsg_on") => true,
                _ => continue,
            };
            out.push(Suppression {
                offset: t.text_offset(),
                on,
                rules: words.map(str::to_owned).collect(),
            });
        }
    }
    out
}

fn suppressed(suppressions: &[Suppression], v: &Violation) -> bool {
    let mut off = false;
    for s in suppressions.iter().take_while(|s| s.offset <= v.start) {
        if s.rules.is_empty() || s.rules.iter().any(|r| r == v.rule) {
            off = !s.on;
        }
    }
    off
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vsg_off_comments_suppress_rules() {
        let src = "entity a is\nend;\n-- vsg_off entity_019\nentity b is\nend;\n-- vsg_on\n-- vsg_off\nentity c is\nend;\n-- vsg_on\nentity d is\nend;\n";
        let starts = ["entity a", "entity b", "entity c", "entity d"].map(|e| src.find(e).unwrap());
        let found: Vec<(usize, &str)> =
            check(&Parsed::new(src.as_bytes().to_vec()), &Config::default())
                .into_iter()
                .map(|v| (starts.iter().rposition(|s| *s <= v.start).unwrap(), v.rule))
                .collect();
        assert_eq!(
            found,
            [
                (0, "entity_015"),
                (0, "entity_019"),
                (1, "entity_015"),
                (3, "entity_015"),
                (3, "entity_019"),
            ]
        );
    }

    #[test]
    fn catalog_is_sorted_and_contains_implemented_rules() {
        assert!(catalog::VSG_RULES.windows(2).all(|w| w[0].0 < w[1].0));
        for info in implemented() {
            assert!(is_known_rule(info.id), "{} is not a VSG rule", info.id);
        }
    }
}
