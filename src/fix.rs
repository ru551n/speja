//! Transactional fixing: all safe fixes of one snapshot are resolved together, applied in one
//! pass to the original source, and the result is formatted once.
//!
//! A fix is applied completely or not at all. A fix whose edits overlap an already accepted fix
//! is skipped (a later run, which sees the fixed source, reports it again). Fixes are accepted in
//! the position order of their violations, so the result does not depend on rule registration
//! order.

use crate::config::Config;
use crate::rules::{self, Edit, FixSafety, Violation};
use crate::{FormatError, Parsed, format_parsed};

#[derive(Debug)]
pub struct FixOutcome {
    /// The fixed and formatted source.
    pub output: Vec<u8>,
    /// Violations whose fixes were applied.
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

/// Select the safe fixes to apply. Returns the edits in application order and the indices of
/// the violations whose fixes were accepted.
fn resolve(violations: &[Violation]) -> (Vec<Edit>, Vec<usize>) {
    let mut accepted: Vec<Edit> = Vec::new();
    let mut applied = Vec::new();
    for (i, v) in violations.iter().enumerate() {
        let Some(fix) = v.fix.as_ref().filter(|f| f.safety == FixSafety::Safe) else {
            continue;
        };
        // Identical edits from different rules are applied once.
        let new: Vec<&Edit> = fix.edits.iter().filter(|e| !accepted.contains(e)).collect();
        if new.iter().any(|e| accepted.iter().any(|a| conflicts(a, e))) {
            continue;
        }
        accepted.extend(new.into_iter().cloned());
        applied.push(i);
    }
    accepted.sort_by_key(|e| (e.start, e.rank, e.end));
    (accepted, applied)
}

/// Characters that fuse with a neighbouring word into one lexical element.
fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'\\') || b >= 0x80
}

fn apply(source: &[u8], edits: &[Edit]) -> Vec<u8> {
    let mut out = Vec::with_capacity(source.len() + 64);
    let mut pos = 0;
    for e in edits {
        if e.start > pos {
            out.extend_from_slice(&source[pos..e.start]);
        }
        let text = e.text.as_bytes();
        // Inserted words must not fuse with adjacent words (`)begin` + ` is`).
        if text.first().copied().is_some_and(is_word) && out.last().copied().is_some_and(is_word) {
            out.push(b' ');
        }
        out.extend_from_slice(text);
        pos = pos.max(e.end);
        if text.last().copied().is_some_and(is_word)
            && source.get(pos).copied().is_some_and(is_word)
        {
            out.push(b' ');
        }
    }
    out.extend_from_slice(&source[pos.min(source.len())..]);
    out
}

/// Apply all safe fixes and format the result.
pub fn fix(parsed: &Parsed, config: &Config) -> Result<FixOutcome, FormatError> {
    if !parsed.syntax_errors().is_empty() {
        return Err(FormatError::Syntax(parsed.syntax_errors().to_vec()));
    }
    let violations = rules::check_for_fixes(parsed, config);
    let (edits, applied) = resolve(&violations);
    let fixed = Parsed::new(apply(parsed.source(), &edits));
    if let Some(e) = fixed.syntax_errors().first() {
        return Err(FormatError::Internal(format!(
            "fixes produced invalid VHDL ({})",
            e.message
        )));
    }
    let output = format_parsed(&fixed, &config.format)?;
    let result = Parsed::new(output);
    let remaining = rules::check_canonical(&result, config);
    let applied = applied.into_iter().map(|i| violations[i].clone()).collect();
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
