//! Rule engine: rules read one parsed snapshot and report violations with optional fixes.
//!
//! Rules never modify the source and never depend on each other. Results are sorted by
//! position and rule id, so the order in which rules run is irrelevant.

mod catalog;
mod length;
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

pub(crate) struct Rule {
    pub(crate) info: RuleInfo,
    pub(crate) check: fn(&Context<'_>, &RuleSettings, &mut Vec<Violation>),
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
    /// The formatted snapshot, parsed (`None` when the source cannot be formatted).
    formatted: OnceCell<Option<Parsed>>,
}

impl<'a> Context<'a> {
    fn new(parsed: &'a Parsed, config: &'a Config) -> Self {
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
        }
    }

    pub(crate) fn nodes(&self, kind: NodeKind) -> &[SyntaxNode] {
        self.by_kind.get(&kind).map_or(&[], Vec::as_slice)
    }

    /// The canonical formatting of this snapshot, parsed once on first use.
    pub(crate) fn formatted(&self) -> Option<&Parsed> {
        self.formatted
            .get_or_init(|| {
                crate::format_parsed(self.parsed, &self.config.format)
                    .ok()
                    .map(Parsed::new)
            })
            .as_ref()
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
        all.extend(length::rules());
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
    let cx = Context::new(parsed, config);
    let mut out = Vec::new();
    for rule in rules() {
        let settings = config.rule(&rule.info);
        if !settings.enabled {
            continue;
        }
        let before = out.len();
        (rule.check)(&cx, &settings, &mut out);
        if !settings.fixable {
            for v in &mut out[before..] {
                v.fix = None;
            }
        }
    }
    out.sort_by(|a, b| (a.start, a.rule, a.end).cmp(&(b.start, b.rule, b.end)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_sorted_and_contains_implemented_rules() {
        assert!(catalog::VSG_RULES.windows(2).all(|w| w[0].0 < w[1].0));
        for info in implemented() {
            assert!(is_known_rule(info.id), "{} is not a VSG rule", info.id);
        }
    }
}
