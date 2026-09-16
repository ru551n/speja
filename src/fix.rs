//! Transactional fixing: all safe fixes of one snapshot are resolved together, applied in one
//! pass to the original source, and the result is formatted once.
//!
//! A fix is applied completely or not at all. A fix whose edits overlap an already accepted fix
//! is deferred: the accepted fixes are applied, the new snapshot is parsed and checked, and the
//! remaining fixes are resolved again (at most [`MAX_ROUNDS`] times). Fixes are accepted in the
//! position order of their violations, so the result does not depend on rule registration
//! order. The final snapshot is formatted once.

use crate::config::Config;
use crate::rules::{self, Edit, FixSafety, Violation};
use crate::{FormatError, Parsed, TextEdit, apply_edits, format_parsed};

#[derive(Debug)]
pub struct FixOutcome {
    /// The fixed and formatted source.
    pub output: Vec<u8>,
    /// Violations whose fixes were applied (positions refer to the snapshot of their round).
    pub applied: Vec<Violation>,
    /// Violations of the fixed output (not fixable, unsafe, or skipped because of a conflict).
    pub remaining: Vec<Violation>,
}

/// Whether two edits cannot both be applied.
fn conflicts(a: &Edit, b: &Edit) -> bool {
    let insertion = |e: &Edit| e.start == e.end;
    match (insertion(a), insertion(b)) {
        // Insertions at the same offset are ordered by rank.
        (true, true) => false,
        (true, false) => a.start > b.start && a.start < b.end,
        (false, true) => b.start > a.start && b.start < a.end,
        (false, false) => a.start < b.end && b.start < a.end,
    }
}

/// Rounds of conflict resolution before giving up on the remaining conflicting fixes.
const MAX_ROUNDS: usize = 8;

/// Select the fixes to apply (safe ones, plus unsafe ones if `unsafe_fixes`). Returns the edits
/// in application order, the indices of the violations whose fixes were accepted and whether a
/// fix was deferred because it conflicts with an accepted one.
fn resolve(violations: &[Violation], unsafe_fixes: bool) -> (Vec<Edit>, Vec<usize>, bool) {
    let mut accepted: Vec<Edit> = Vec::new();
    let mut applied = Vec::new();
    let mut deferred = false;
    for (i, v) in violations.iter().enumerate() {
        let Some(fix) = v
            .fix
            .as_ref()
            .filter(|f| unsafe_fixes || f.safety == FixSafety::Safe)
        else {
            continue;
        };
        // Identical edits from different rules are applied once.
        let new: Vec<&Edit> = fix.edits.iter().filter(|e| !accepted.contains(e)).collect();
        if new.iter().any(|e| accepted.iter().any(|a| conflicts(a, e))) {
            deferred = true;
            continue;
        }
        accepted.extend(new.into_iter().cloned());
        applied.push(i);
    }
    accepted.sort_by_key(|e| (e.start, e.rank, e.end));
    (accepted, applied, deferred)
}

/// Characters that fuse with a neighbouring word into one lexical element.
fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'\\') || b >= 0x80
}

/// Byte replacements for `edits` (sorted by offset and rank, non-conflicting), with spaces
/// added so that inserted words do not fuse with adjacent words (`)begin` + ` is`).
pub fn fix_edits(source: &[u8], edits: &[Edit]) -> Vec<TextEdit> {
    let mut out = Vec::with_capacity(edits.len());
    let mut pos = 0;
    let mut last = None;
    for e in edits {
        if e.start > pos {
            last = Some(source[e.start - 1]);
        }
        let mut text = Vec::with_capacity(e.text.len() + 2);
        if e.text.bytes().next().is_some_and(is_word) && last.is_some_and(is_word) {
            text.push(b' ');
        }
        text.extend_from_slice(e.text.as_bytes());
        let start = e.start.max(pos);
        pos = pos.max(e.end);
        if e.text.bytes().last().is_some_and(is_word)
            && source.get(pos).copied().is_some_and(is_word)
        {
            text.push(b' ');
        }
        if let Some(&b) = text.last() {
            last = Some(b);
        }
        out.push(TextEdit {
            start,
            end: pos,
            text,
        });
    }
    out
}

fn apply(source: &[u8], edits: &[Edit]) -> Vec<u8> {
    apply_edits(source, &fix_edits(source, edits))
}

/// Apply all safe fixes and format the result.
pub fn fix(parsed: &Parsed, config: &Config) -> Result<FixOutcome, FormatError> {
    fix_with(parsed, config, false)
}

/// [`fix`], also applying unsafe fixes (which may change behaviour) if `unsafe_fixes`.
pub fn fix_with(
    parsed: &Parsed,
    config: &Config,
    unsafe_fixes: bool,
) -> Result<FixOutcome, FormatError> {
    if !parsed.syntax_errors().is_empty() {
        return Err(FormatError::Syntax(parsed.syntax_errors().to_vec()));
    }
    let mut applied = Vec::new();
    let mut fixed: Option<Parsed> = None;
    for _ in 0..MAX_ROUNDS {
        let current = fixed.as_ref().unwrap_or(parsed);
        let violations = rules::check_for_fixes(current, config);
        let (edits, accepted, deferred) = resolve(&violations, unsafe_fixes);
        if edits.is_empty() {
            break;
        }
        let next = Parsed::new(apply(current.source(), &edits));
        if let Some(e) = next.syntax_errors().first() {
            return Err(FormatError::Internal(format!(
                "fixes produced invalid VHDL ({})",
                e.message
            )));
        }
        applied.extend(accepted.into_iter().map(|i| violations[i].clone()));
        fixed = Some(next);
        if !deferred {
            break;
        }
    }
    let fixed = fixed.as_ref().unwrap_or(parsed);
    let output = format_parsed(fixed, &config.format)?;
    let result = Parsed::new(output);
    let remaining = rules::check_canonical(&result, config);
    Ok(FixOutcome {
        output: result.source().to_vec(),
        applied,
        remaining,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(src: &str) -> FixOutcome {
        fix(&Parsed::new(src.as_bytes().to_vec()), &Config::default()).unwrap()
    }

    #[test]
    fn many_fixes_in_one_pass() {
        let src = "entity e is\nend;\narchitecture rtl of e is\nbegin\n  process (clk) begin\n    if a then null; end if;\n  end process;\nend;\npackage p is\nend;\npackage body p is\n  function f return bit is begin return '0'; end;\nend;\n";
        let out = run(src);
        let text = String::from_utf8(out.output.clone()).unwrap();
        for expected in [
            "end entity e;",
            "end architecture rtl;",
            "process (clk) is",
            "if (a) then",
            "end package p;",
            "end package body p;",
            "end function f;",
        ] {
            assert!(text.contains(expected), "missing {expected:?} in\n{text}");
        }
        // Only the unfixable process label remains, and fixing again changes nothing.
        let remaining: Vec<_> = out.remaining.iter().map(|v| v.rule).collect();
        assert_eq!(remaining, ["process_016"]);
        assert_eq!(run(&text).output, out.output);
    }

    #[test]
    fn unsafe_fixes_are_not_applied() {
        let src = "entity e is\n  port (\n    a : in    bit := '0'\n  );\nend entity e;\n";
        let out = run(src);
        assert_eq!(String::from_utf8(out.output).unwrap(), src);
        assert_eq!(out.remaining[0].rule, "port_012");
    }

    #[test]
    fn conflict_detection() {
        let ins = |at, text: &str| Edit {
            start: at,
            end: at,
            text: text.into(),
            rank: 0,
        };
        let del = |start, end| Edit {
            start,
            end,
            text: String::new(),
            rank: 0,
        };
        assert!(!conflicts(&ins(5, "a"), &ins(5, "b")));
        assert!(conflicts(&ins(6, "a"), &del(5, 8)));
        assert!(!conflicts(&ins(5, "a"), &del(5, 8)));
        assert!(!conflicts(&ins(8, "a"), &del(5, 8)));
        assert!(conflicts(&del(1, 6), &del(5, 8)));
        assert!(!conflicts(&del(1, 5), &del(5, 8)));
        assert_eq!(
            apply(b"ab,cd,ef", &[del(2, 3), ins(5, "x"), ins(5, "y")]),
            b"abcd x y,ef"
        );
        assert_eq!(apply(b"(all)begin", &[ins(5, " is")]), b"(all) is begin");
    }
}
