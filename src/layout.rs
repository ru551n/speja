//! What formatting changes, token by token, and which VSG layout rule reports it.
//!
//! The formatted snapshot has the same tokens as the source, so the two token streams are
//! compared pairwise. Each difference in the whitespace before a token (indentation, spaces,
//! line breaks, blank lines, trailing whitespace, comment column) or in a keyword's case becomes
//! a [`LayoutChange`]. Keyword case maps to its VSG rule directly. The other kinds map to VSG
//! rules through a table learned by comparing with VSG's reports on real code
//! (`scripts/learn_layout_rules.py`); unknown changes are reported under `format`.

use std::collections::HashMap;
use std::sync::OnceLock;

use vhdl_syntax::syntax::{SyntaxNode, SyntaxToken};
use vhdl_syntax::tokens::TokenKind as T;

use crate::Parsed;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    /// The indentation of a line.
    Indent,
    /// Spaces between two tokens on one line.
    Spacing,
    /// A token moves to a new line.
    LineBreak,
    /// A line break before a token is removed.
    Join,
    /// The number of blank lines before a line.
    BlankLines,
    /// Whitespace at the end of a line.
    Trailing,
    /// The case of a keyword.
    KeywordCase,
    /// The column of a trailing comment.
    CommentColumn,
}

/// One layout difference between a snapshot and its formatting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutChange {
    /// 1-based line in the source.
    pub line: usize,
    pub kind: ChangeKind,
    /// Context of the change for the rule table, such as `Indent:ProcessStatementPart:signal`.
    pub key: String,
    /// The VSG rule that reports the change, if known without the table.
    pub rule: Option<&'static str>,
    /// Expected indentation or spaces (columns), or blank lines.
    pub expected: usize,
    /// The token the change is about, as formatted.
    pub token: String,
    /// The token as written in the source.
    pub original: String,
}

/// Whitespace and comments between two tokens.
struct Gap<'a> {
    text: &'a [u8],
}

impl Gap<'_> {
    fn newlines(&self) -> usize {
        self.text.iter().filter(|&&b| b == b'\n').count()
    }

    fn has_comment(&self) -> bool {
        self.text.windows(2).any(|w| w == b"--" || w == b"/*")
    }

    /// Width of the whitespace after the last line break (or of the whole gap).
    fn tail(&self) -> usize {
        let start = self
            .text
            .iter()
            .rposition(|&b| b == b'\n')
            .map_or(0, |p| p + 1);
        self.text[start..]
            .iter()
            .filter(|&&b| matches!(b, b' ' | b'\t'))
            .count()
    }

    /// Whether a line that ends in the gap ends with spaces or tabs.
    fn trailing_whitespace(&self) -> bool {
        self.text.split(|&b| b == b'\n').rev().skip(1).any(|line| {
            line.strip_suffix(b"\r")
                .unwrap_or(line)
                .last()
                .is_some_and(|b| matches!(b, b' ' | b'\t'))
        })
    }

    /// Spaces before a comment on the same line as the previous token.
    fn comment_offset(&self) -> Option<usize> {
        let first = self
            .text
            .windows(2)
            .position(|w| w == b"--" || w == b"/*")?;
        let before = &self.text[..first];
        (!before.contains(&b'\n')).then_some(before.len())
    }
}

fn gap<'a>(src: &'a [u8], tokens: &[SyntaxToken], i: usize) -> Gap<'a> {
    let start = if i == 0 {
        0
    } else {
        tokens[i - 1].text_range().end
    };
    Gap {
        text: &src[start..tokens[i].text_offset()],
    }
}

fn kind_name(t: &SyntaxToken) -> String {
    match t.kind() {
        T::Keyword(k) => format!("{k:?}").to_ascii_lowercase(),
        other => format!("{other:?}"),
    }
}

fn construct(t: &SyntaxToken) -> String {
    format!("{:?}", t.parent().kind())
}

/// The `case::keyword` rule for a keyword: the one for the innermost construct that has one.
fn keyword_rule(t: &SyntaxToken) -> Option<&'static str> {
    let word = String::from_utf8_lossy(t.text().as_bytes()).to_ascii_lowercase();
    let candidates: Vec<&'static crate::rules::RuleInfo> = crate::keywords::RULES
        .iter()
        .filter(|(_, words)| words.contains(&word.as_str()))
        .map(|(info, _)| info)
        .collect();
    let mut node: Option<SyntaxNode> = Some(t.parent());
    while let Some(n) = node {
        let kind = crate::format::construct_kind(&n);
        if let Some(info) = candidates
            .iter()
            .find(|info| crate::keywords::constructs(info.id).contains(&kind))
        {
            return Some(info.id);
        }
        node = n.parent();
    }
    candidates
        .iter()
        .find(|info| crate::keywords::constructs(info.id).is_empty())
        .map(|info| info.id)
}

/// The layout differences between `before` and its formatting `after` (same tokens).
pub fn layout_changes(before: &Parsed, after: &Parsed) -> Vec<LayoutChange> {
    let (bt, at) = (before.tokens(), after.tokens());
    if bt.len() != at.len() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for (i, (b, a)) in bt.iter().zip(at).enumerate() {
        let line = before.line_col(b.text_offset()).0;
        let token = String::from_utf8_lossy(a.text().as_bytes()).into_owned();
        let original = String::from_utf8_lossy(b.text().as_bytes()).into_owned();
        let mut push = |kind, key: String, rule, expected, line| {
            out.push(LayoutChange {
                line,
                kind,
                key,
                rule,
                expected,
                token: token.clone(),
                original: original.clone(),
            });
        };
        if b.text().as_bytes() != a.text().as_bytes() && matches!(b.kind(), T::Keyword(_)) {
            push(
                ChangeKind::KeywordCase,
                format!("KeywordCase:{}", kind_name(b)),
                keyword_rule(b),
                0,
                line,
            );
        }
        let (gb, ga) = (gap(before.source(), bt, i), gap(after.source(), at, i));
        if gb.text == ga.text {
            continue;
        }
        let (nb, na) = (gb.newlines(), ga.newlines());
        let prev = if i == 0 {
            "Start".to_owned()
        } else {
            kind_name(&bt[i - 1])
        };
        let here = format!("{}:{}", construct(b), kind_name(b));
        if gb.trailing_whitespace() && !ga.trailing_whitespace() {
            let first_line = line.saturating_sub(nb).max(1);
            push(ChangeKind::Trailing, "Trailing".into(), None, 0, first_line);
        }
        if gb.has_comment() || ga.has_comment() {
            if let (Some(ob), Some(oa)) = (gb.comment_offset(), ga.comment_offset())
                && ob != oa
                && i > 0
            {
                push(
                    ChangeKind::CommentColumn,
                    format!("CommentColumn:{}", construct(&bt[i - 1])),
                    None,
                    oa,
                    line.saturating_sub(nb),
                );
            }
            // Own-line comments keep their layout; only the token's indentation counts.
            if nb > 0 && na > 0 && gb.tail() != ga.tail() {
                push(
                    ChangeKind::Indent,
                    format!("Indent:{here}"),
                    None,
                    ga.tail(),
                    line,
                );
            }
            continue;
        }
        match (nb, na) {
            (0, 0) => push(
                ChangeKind::Spacing,
                format!("Spacing:{}:{prev}>{}", construct(b), kind_name(b)),
                None,
                ga.tail(),
                line,
            ),
            (0, _) => push(
                ChangeKind::LineBreak,
                format!("LineBreak:{here}"),
                None,
                ga.tail(),
                line,
            ),
            (_, 0) => push(ChangeKind::Join, format!("Join:{here}"), None, 0, line),
            (x, y) => {
                if x != y {
                    push(
                        ChangeKind::BlankLines,
                        format!("BlankLines:{here}"),
                        None,
                        y - 1,
                        line,
                    );
                }
                if gb.tail() != ga.tail() {
                    push(
                        ChangeKind::Indent,
                        format!("Indent:{here}"),
                        None,
                        ga.tail(),
                        line,
                    );
                }
            }
        }
    }
    out
}

/// The learned `key → VSG rule` table.
fn table() -> &'static HashMap<String, String> {
    static TABLE: OnceLock<HashMap<String, String>> = OnceLock::new();
    TABLE
        .get_or_init(|| serde_json::from_str(include_str!("layout_rules.json")).unwrap_or_default())
}

/// The VSG rule that reports a change: known directly, from the learned table, or `format`.
pub fn rule_for(change: &LayoutChange) -> &str {
    if let Some(rule) = change.rule {
        return rule;
    }
    if let Some(rule) = table().get(&change.key) {
        return rule;
    }
    match change.kind {
        ChangeKind::Trailing => "whitespace_001",
        _ => "format",
    }
}

/// A VSG-style solution text for a change.
pub fn message(change: &LayoutChange, indent_size: usize) -> String {
    let token = &change.token;
    match change.kind {
        ChangeKind::Indent => format!("Indent level {}", change.expected / indent_size.max(1)),
        ChangeKind::Spacing if change.expected == 0 => {
            format!("Remove the space before {token}")
        }
        ChangeKind::Spacing => format!(
            "Change the number of spaces before {token} to {}",
            change.expected
        ),
        ChangeKind::LineBreak => format!("Move {token} to the next line"),
        ChangeKind::Join => format!("Move {token} to the previous line"),
        ChangeKind::BlankLines if change.expected == 0 => "Remove blank lines above".into(),
        ChangeKind::BlankLines => "Add blank line above".into(),
        ChangeKind::Trailing => "Remove trailing whitespace".into(),
        ChangeKind::KeywordCase => format!("Change \"{}\" to \"{token}\"", change.original),
        ChangeKind::CommentColumn => "Align the comment".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_changes() {
        let src = "ENTITY e is\nport (a:in bit);  \n\n\nend;\n";
        let before = Parsed::new(src.as_bytes().to_vec());
        let cfg = crate::FormatConfig::default();
        let after = Parsed::new(crate::format_parsed(&before, &cfg).unwrap());
        let changes = layout_changes(&before, &after);
        let kinds: Vec<ChangeKind> = changes.iter().map(|c| c.kind).collect();
        for kind in [
            ChangeKind::KeywordCase,
            ChangeKind::Indent,
            ChangeKind::LineBreak,
            ChangeKind::Spacing,
            ChangeKind::Trailing,
            ChangeKind::BlankLines,
        ] {
            assert!(kinds.contains(&kind), "{kind:?} missing in {changes:#?}");
        }
        let case = changes
            .iter()
            .find(|c| c.kind == ChangeKind::KeywordCase)
            .unwrap();
        assert_eq!((case.line, case.rule), (1, Some("entity_004")));
        let trailing = changes
            .iter()
            .find(|c| c.kind == ChangeKind::Trailing)
            .unwrap();
        assert_eq!(trailing.line, 2);
    }
}
