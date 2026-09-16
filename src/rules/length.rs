//! `length_001`: lines longer than the configured width.
//!
//! The formatter folds long lines, so this rule mainly reports what formatting cannot fix. Each
//! violation says whether `vsg-rs fmt` folds the line: the tokens of the long line are looked up
//! (by index, the token streams are identical) in the formatted snapshot, and the line counts as
//! foldable when none of them ends up on a line that is still too long.
//!
//! `length` is the formatting width and the warning limit. The vsg-rs option `error_length`
//! reports lines longer than it with severity `error` (for "prefer 120, never more than 160"
//! policies); it does not change formatting.

use std::collections::HashSet;

use vhdl_syntax::syntax::SyntaxToken;

use super::{Context, Rule, RuleInfo, Violation};
use crate::config::{RuleSettings, Severity};
use crate::{Parsed, display_width};

pub(super) fn rules() -> Vec<Rule> {
    vec![Rule {
        info: RuleInfo {
            id: "length_001",
            groups: &["length"],
            severity: Severity::Warning,
            enabled_by_default: true,
            description: "Lines must not be longer than the configured length.",
        },
        check,
    }]
}

/// Byte ranges (without line terminators) and widths of lines wider than `width`.
fn long_lines(source: &[u8], utf8: bool, width: usize) -> Vec<(usize, usize, usize)> {
    let mut out = Vec::new();
    let mut start = 0;
    for line in source.split(|&b| b == b'\n') {
        let end = start + line.len() - usize::from(line.ends_with(b"\r"));
        let w = display_width(&source[start..end], utf8, 0);
        if w > width {
            out.push((start, end, w));
        }
        start += line.len() + 1;
    }
    out
}

fn token_offsets(parsed: &Parsed) -> Vec<usize> {
    parsed
        .tokens()
        .iter()
        .map(SyntaxToken::text_offset)
        .collect()
}

fn check(cx: &Context<'_>, settings: &RuleSettings, out: &mut Vec<Violation>) {
    let width = settings
        .option_usize("length")
        .unwrap_or(cx.config.format.width);
    let parsed = cx.parsed;
    let long = long_lines(parsed.source(), parsed.is_utf8(), width);
    if long.is_empty() {
        return;
    }
    let source_tokens = token_offsets(parsed);
    // Indices of tokens that are still on a long line after formatting.
    let still_long: Option<HashSet<usize>> = cx.formatted().map(|f| {
        let offsets = token_offsets(f);
        long_lines(f.source(), f.is_utf8(), width)
            .into_iter()
            .flat_map(|(s, e, _)| {
                offsets.partition_point(|&o| o < s)..offsets.partition_point(|&o| o < e)
            })
            .collect()
    });
    let error_length = settings.option_usize("error_length");
    for (start, end, w) in long {
        let first = source_tokens.partition_point(|&o| o < start);
        let last = source_tokens.partition_point(|&o| o < end);
        let foldable = still_long
            .as_ref()
            .is_some_and(|still| first < last && !(first..last).any(|i| still.contains(&i)));
        let hint = if foldable {
            "`vsg-rs fmt` folds it"
        } else if first == last {
            "only a comment is too long; comments are not wrapped"
        } else {
            "it cannot be folded automatically (unbreakable tokens or comments)"
        };
        out.push(Violation {
            rule: "length_001",
            severity: if error_length.is_some_and(|limit| w > limit) {
                Severity::Error
            } else {
                settings.severity
            },
            start,
            end,
            message: format!("line is {w} columns long, limit is {width}; {hint}"),
            fix: None,
        });
    }
}

#[cfg(test)]
mod tests {
    use crate::Parsed;
    use crate::config::{Config, Severity};

    fn check(src: &str, width: usize) -> Vec<String> {
        let cfg = Config::parse(&format!("rule: {{length_001: {{length: {width}}}}}")).unwrap();
        crate::rules::check(&Parsed::new(src.as_bytes().to_vec()), &cfg)
            .into_iter()
            .filter(|v| v.rule == "length_001")
            .map(|v| v.message)
            .collect()
    }

    #[test]
    fn classifies_overflow() {
        let src = "architecture a of e is\nbegin\n  x <= f(alpha, beta, gamma, delta);\n  y <= \"a very long string literal\"; -- and a long comment here\nend;\n";
        let messages = check(src, 30);
        assert_eq!(messages.len(), 2, "{messages:?}");
        assert!(messages[0].contains("folds it"), "{}", messages[0]);
        assert!(messages[1].contains("cannot be folded"), "{}", messages[1]);
        assert!(check(src, 120).is_empty());
    }

    #[test]
    fn error_threshold() {
        let cfg = Config::parse("rule: {length_001: {length: 20, error_length: 30}}").unwrap();
        let src =
            "entity e is\nend;\n-- 25 columns............\n-- 35 columns......................\n";
        let severities: Vec<_> = crate::rules::check(&Parsed::new(src.as_bytes().to_vec()), &cfg)
            .into_iter()
            .filter(|v| v.rule == "length_001")
            .map(|v| v.severity)
            .collect();
        assert_eq!(severities, [Severity::Warning, Severity::Error]);
    }

    #[test]
    fn exact_boundary() {
        let src = "entity e is\nend;\n-- 20 columns.......\n";
        assert!(check(src, 20).is_empty());
        assert_eq!(check(src, 19).len(), 1);
    }
}
