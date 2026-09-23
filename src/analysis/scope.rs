//! Signals declared in a wider region than the one that uses them.
//!
//! A signal can be declared in an architecture, a block or the body of a generate, and it is
//! visible from there down. Declared in the architecture and used only inside one generate, it
//! reads as architecture-wide state when it is not, and in a `for ... generate` it is one signal
//! shared by every iteration rather than one per iteration.
//!
//! * `lint_790` — a signal is only used inside one block or generate body below the region that
//!   declares it. Advisory: the fact is exact, and whether to move it is the author's call.
//!
//! The editor offers the move as a refactoring whether or not the rule is enabled, from the same
//! [`moves`], so the finding and the action cannot disagree about where the signal belongs.
//!
//! Worked out from the syntax tree, by name. That is only sound when the name means one thing
//! throughout the architecture, so a signal whose name is declared anywhere else in it (a
//! constant, a variable, a generate parameter, a port of a block) is left alone. Under-reporting
//! is the right way to be wrong about this.

use std::collections::HashMap;
use std::ops::Range;
use std::path::Path;

use crate::{Parsed, TextEdit};
use vhdl_syntax::syntax::{NodeKind, SyntaxElement, SyntaxNode, SyntaxToken};
use vhdl_syntax::tokens::TokenKind;

use super::design::{all_tokens, find, lower};
use super::lint::Finding;

/// One signal that can move to a narrower region, and the edit that moves it.
#[derive(Debug)]
pub struct Move {
    pub name: String,
    /// Where the name is declared, for placing the finding and matching an editor's cursor.
    pub at: Range<usize>,
    /// The region it moves to, as a reader names it: `generate 'g_lane'`, `block 'b'`.
    pub target: String,
    /// The target is a `for ... generate`: moved there, each iteration gets its own signal.
    pub per_iteration: bool,
    /// Removal from the old region and insertion into the new one, sorted.
    pub edits: Vec<TextEdit>,
}

/// A declarative region: the architecture, a block, or a generate body.
struct Scope {
    node: SyntaxNode,
    parent: Option<usize>,
}

/// An identifier as the walk met it.
struct Name {
    scope: usize,
    token: SyntaxToken,
    /// It declares something rather than naming it.
    declares: bool,
    /// It sits in its region's declarative part.
    in_declarations: bool,
}

struct Walk {
    scopes: Vec<Scope>,
    names: Vec<Name>,
    signals: Vec<(SyntaxNode, usize)>,
    /// Every occurrence of each name, as indices into `names`.
    by_name: HashMap<String, Vec<usize>>,
}

impl Walk {
    fn visit(&mut self, node: &SyntaxNode, scope: usize, in_declarations: bool) {
        if node.kind() == NodeKind::SignalDeclaration {
            self.signals.push((node.clone(), scope));
        }
        for element in node.children_with_tokens() {
            match element {
                SyntaxElement::Token(token) => {
                    if token.kind() == TokenKind::Identifier {
                        self.by_name
                            .entry(lower(&token))
                            .or_default()
                            .push(self.names.len());
                        self.names.push(Name {
                            scope,
                            declares: declares(node),
                            in_declarations,
                            token,
                        });
                    }
                }
                SyntaxElement::Node(child) => match child.kind() {
                    NodeKind::BlockStatement => {
                        let inner = self.open(&child, scope);
                        for part in child.children() {
                            // The guard and the header's port map are read in the enclosing
                            // region: a block's own declarations come after them.
                            let outside = matches!(
                                part.kind(),
                                NodeKind::StmtLabel
                                    | NodeKind::BlockPreamble
                                    | NodeKind::BlockHeader
                            );
                            if outside {
                                self.visit(&part, scope, in_declarations);
                            } else {
                                let decl = part.kind() == NodeKind::BlockDeclarativePart;
                                self.visit(&part, inner, decl);
                            }
                        }
                    }
                    // Its ports and generics are the component's, named in its own region: a
                    // `clk` port there is not a second `clk` in the architecture.
                    NodeKind::ComponentDeclaration => {}
                    NodeKind::GenerateStatementBody => {
                        let inner = self.open(&child, scope);
                        self.visit(&child, inner, false);
                    }
                    NodeKind::ArchitectureDeclarativePart
                    | NodeKind::BlockDeclarativePart
                    | NodeKind::GenerateBodyDeclarations => self.visit(&child, scope, true),
                    _ => self.visit(&child, scope, in_declarations),
                },
            }
        }
    }

    fn open(&mut self, node: &SyntaxNode, parent: usize) -> usize {
        self.scopes.push(Scope {
            node: node.clone(),
            parent: Some(parent),
        });
        self.scopes.len() - 1
    }

    /// The regions from `scope` up to the architecture, innermost first.
    fn chain(&self, mut scope: usize) -> Vec<usize> {
        let mut out = vec![scope];
        while let Some(parent) = self.scopes[scope].parent {
            out.push(parent);
            scope = parent;
        }
        out
    }
}

/// Whether an identifier directly under `parent` declares a name: an identifier list, a loop or
/// generate parameter, a label, or the name of any other declaration.
fn declares(parent: &SyntaxNode) -> bool {
    matches!(
        parent.kind(),
        NodeKind::IdentifierList | NodeKind::ParameterSpecification | NodeKind::StmtLabel
    ) || format!("{:?}", parent.kind()).ends_with("Declaration")
}

/// Every signal of the file that could be declared in a narrower region than it is.
#[must_use]
pub fn moves(parsed: &Parsed) -> Vec<Move> {
    let src = parsed.source();
    let mut out = Vec::new();
    for architecture in find(parsed.root(), NodeKind::ArchitectureBody) {
        let mut walk = Walk {
            scopes: vec![Scope {
                node: architecture.clone(),
                parent: None,
            }],
            names: Vec::new(),
            signals: Vec::new(),
            by_name: HashMap::new(),
        };
        walk.visit(&architecture, 0, false);

        for (declaration, home) in &walk.signals {
            let Some(list) = declaration
                .children()
                .find(|c| c.kind() == NodeKind::IdentifierList)
            else {
                continue;
            };
            let declared: Vec<SyntaxToken> = list
                .tokens()
                .filter(|t| t.kind() == TokenKind::Identifier)
                .collect();
            for token in &declared {
                if let Some(m) = narrower(src, &walk, declaration, *home, token, &declared) {
                    out.push(m);
                }
            }
        }
    }
    out
}

/// Where `token`, declared by `declaration` in region `home`, could be declared instead.
fn narrower(
    src: &[u8],
    walk: &Walk,
    declaration: &SyntaxNode,
    home: usize,
    token: &SyntaxToken,
    declared: &[SyntaxToken],
) -> Option<Move> {
    let name = lower(token);
    let same: Vec<&Name> = walk
        .by_name
        .get(&name)?
        .iter()
        .map(|&i| &walk.names[i])
        .collect();
    // Declared once, here: then every other occurrence in the architecture is this signal, or a
    // selected name's suffix, which names something else.
    if same.iter().filter(|n| n.declares).count() != 1 {
        return None;
    }
    let uses: Vec<&&Name> = same
        .iter()
        .filter(|n| !n.declares && n.token.parent().kind() != NodeKind::SelectedName)
        .collect();
    let target = common(walk, uses.iter().map(|n| n.scope))?;
    if target == home || !walk.chain(target).contains(&home) {
        return None;
    }
    let early = uses.iter().any(|n| n.scope == target && n.in_declarations);
    let region = &walk.scopes[target].node;
    let edits = edits_for(src, declaration, token, declared, region, early)?;
    let (target, per_iteration) = describe(src, region);
    Some(Move {
        name: token.text().to_string(),
        at: token.text_range(),
        target,
        per_iteration,
        edits,
    })
}

/// The innermost region containing every one of `scopes`, or `None` when there are none.
fn common(walk: &Walk, mut scopes: impl Iterator<Item = usize>) -> Option<usize> {
    let mut chain = walk.chain(scopes.next()?);
    for scope in scopes {
        let other = walk.chain(scope);
        chain.retain(|s| other.contains(s));
    }
    chain.first().copied()
}

/// How a reader names the region, and whether it is a `for ... generate`.
fn describe(src: &[u8], region: &SyntaxNode) -> (String, bool) {
    let label = |statement: &SyntaxNode| {
        statement
            .children()
            .find(|c| c.kind() == NodeKind::StmtLabel)
            .and_then(|l| l.tokens().find(|t| t.kind() == TokenKind::Identifier))
            .map_or_else(String::new, |t| format!("'{}'", t.text()))
    };
    if region.kind() == NodeKind::BlockStatement {
        return (format!("block {}", label(region)), false);
    }
    let Some(parent) = region.parent() else {
        return (String::new(), false);
    };
    let statement = || parent.parent().map(|s| label(&s)).unwrap_or_default();
    match parent.kind() {
        NodeKind::ForGenerateStatement => (format!("generate {}", label(&parent)), true),
        NodeKind::IfGenerateElsif => (
            format!("an elsif branch of generate {}", statement()),
            false,
        ),
        NodeKind::IfGenerateElse => (
            format!("the else branch of generate {}", statement()),
            false,
        ),
        NodeKind::CaseGenerateAlternative => {
            let choices = parent
                .children()
                .find(|c| c.kind() == NodeKind::Choices)
                .map(|c| text(src, &c))
                .unwrap_or_default();
            (
                format!("the `when {choices}` branch of generate {}", statement()),
                false,
            )
        }
        _ => (format!("generate {}", statement()), false),
    }
}

/// The source of a node, trivia at either end left out.
fn text(src: &[u8], node: &SyntaxNode) -> String {
    let tokens = all_tokens(node);
    let (Some(first), Some(last)) = (tokens.first(), tokens.last()) else {
        return String::new();
    };
    String::from_utf8_lossy(&src[first.text_offset()..last.text_range().end]).into_owned()
}

fn line_start(src: &[u8], at: usize) -> usize {
    src[..at]
        .iter()
        .rposition(|&b| b == b'\n')
        .map_or(0, |i| i + 1)
}

fn line_end(src: &[u8], at: usize) -> usize {
    src[at..]
        .iter()
        .position(|&b| b == b'\n')
        .map_or(src.len(), |i| at + i)
}

fn indent_of(src: &[u8], at: usize) -> String {
    src[line_start(src, at)..]
        .iter()
        .take_while(|&&b| b == b' ' || b == b'\t')
        .map(|&b| b as char)
        .collect()
}

/// Nothing but blanks, or blanks and a comment.
fn only_comment(bytes: &[u8]) -> bool {
    let rest = String::from_utf8_lossy(bytes);
    let rest = rest.trim_start();
    rest.is_empty() || rest.starts_with("--")
}

/// The edit that takes `name` out of `declaration` and declares it in `region`.
///
/// `early` puts it at the top of the region's declarative part rather than above `begin`, for a
/// signal that another declaration there already names.
fn edits_for(
    src: &[u8],
    declaration: &SyntaxNode,
    name: &SyntaxToken,
    declared: &[SyntaxToken],
    region: &SyntaxNode,
    early: bool,
) -> Option<Vec<TextEdit>> {
    let tokens = all_tokens(declaration);
    let start = tokens.first()?.text_offset();
    let last = tokens.last()?;
    let end = last.text_range().end;

    let mut edits = Vec::new();
    let moved = if declared.len() == 1 {
        // The whole declaration goes, and its line with it when it has one of its own; a comment
        // after it on the line describes it, so it moves too.
        let from = line_start(src, start);
        let to = line_end(src, end);
        if only_comment(&src[from..start]) && only_comment(&src[end..to]) {
            edits.push(edit(from, (to + 1).min(src.len()), ""));
            String::from_utf8_lossy(&src[start..to])
                .trim_end()
                .to_owned()
        } else {
            edits.push(edit(start, end, ""));
            String::from_utf8_lossy(&src[start..end]).into_owned()
        }
    } else {
        // One name out of a list: it and the comma that joins it to its neighbour go, and it
        // gets a declaration of its own with the same subtype and default.
        let index = declared.iter().position(|t| t == name)?;
        let (from, to) = if index + 1 < declared.len() {
            (name.text_offset(), declared[index + 1].text_offset())
        } else {
            let comma = name.prev_token()?;
            (comma.text_offset(), name.text_range().end)
        };
        edits.push(edit(from, to, ""));
        let colon = tokens.iter().find(|t| t.kind() == TokenKind::Colon)?;
        format!(
            "signal {} {}",
            name.text(),
            String::from_utf8_lossy(&src[colon.text_offset()..end])
        )
    };

    // The region's own `begin`, and the declarations before it if it has any.
    let holder = if region.kind() == NodeKind::GenerateStatementBody {
        region
            .children()
            .find(|c| c.kind() == NodeKind::GenerateBodyDeclarations)
    } else {
        Some(region.clone())
    };
    let child = |kind: NodeKind| {
        holder
            .as_ref()
            .and_then(|h| h.children().find(|c| c.kind() == kind))
    };
    let separator = child(NodeKind::DeclarationStatementSeparator);
    let part = child(NodeKind::BlockDeclarativePart);

    if let Some(separator) = separator {
        let begin = separator.first_token().text_offset();
        let first_declaration = part.map(|p| p.first_token().text_offset());
        let (at, indent) = match first_declaration {
            Some(d) if early => (line_start(src, d), indent_of(src, d)),
            Some(d) => (line_start(src, begin), indent_of(src, d)),
            None => (
                line_start(src, begin),
                format!("{}  ", indent_of(src, begin)),
            ),
        };
        edits.push(edit(at, at, &format!("{indent}{moved}\n")));
    } else {
        // A generate body with no declarative part: it gets one, and the `begin` that ends it,
        // after the keyword that opens the body, `generate` or a case branch's `=>`.
        let opener = region.first_token().prev_token()?;
        let after = opener.text_range().end;
        let header = match region.parent()? {
            p if p.kind() == NodeKind::IfGenerateIf => p.parent()?,
            p => p,
        };
        let indent = indent_of(src, header.first_token().text_offset());
        let eol = line_end(src, after);
        let at = if only_comment(&src[after..eol]) {
            eol
        } else {
            after
        };
        edits.push(edit(at, at, &format!("\n{indent}  {moved}\n{indent}begin")));
    }
    edits.sort_by_key(|e| (e.start, e.end));
    Some(edits)
}

fn edit(start: usize, end: usize, text: &str) -> TextEdit {
    TextEdit {
        start,
        end,
        text: text.as_bytes().to_vec(),
    }
}

/// Report every signal declared in a wider region than the one that uses it.
#[must_use]
pub fn check(parsed: &Parsed, file: &Path) -> Vec<Finding> {
    let mut findings: Vec<Finding> = moves(parsed)
        .into_iter()
        .map(|m| {
            let (line, column) = parsed.line_col(m.at.start);
            let message = if m.per_iteration {
                format!(
                    "Signal '{}' is only used inside {}: declared there, each iteration has one \
                     of its own instead of all of them sharing it",
                    m.name, m.target
                )
            } else {
                format!(
                    "Signal '{}' is only used inside {}, and can be declared there",
                    m.name, m.target
                )
            };
            Finding {
                file: file.to_path_buf(),
                rule: "lint_790",
                line,
                column,
                message,
                related: Vec::new(),
            }
        })
        .collect();
    findings.sort_by_key(|f| (f.line, f.column));
    findings
}

/// The rules this module reports, for `--list_rules`.
pub const RULES: &[super::Rule] = &[super::Rule {
    id: "lint_790",
    description: "A signal is only used inside one block or generate below the region that \
                  declares it.",
    certainty: super::Certainty::Advisory,
}];

#[cfg(test)]
mod tests {
    use super::*;

    /// The findings, and the file after each move, for an architecture of `declarations` and
    /// statements `body`.
    fn moved(body: &str, declarations: &str) -> (Vec<String>, Vec<String>) {
        let source = format!(
            "entity dut is\nend entity dut;\n\narchitecture rtl of dut is\n{declarations}begin\n\
             {body}end architecture rtl;\n"
        );
        let parsed = Parsed::new(source.into_bytes());
        assert!(parsed.syntax_errors().is_empty(), "test source must parse");
        // Only `s`: the other signals are there to use it, and often move too.
        let messages = check(&parsed, Path::new("dut.vhd"))
            .into_iter()
            .map(|f| f.message)
            .filter(|m| m.contains("'s'"))
            .collect();
        let results = moves(&parsed)
            .iter()
            .filter(|m| m.name == "s")
            .map(|m| String::from_utf8(crate::apply_edits(parsed.source(), &m.edits)).unwrap())
            .collect::<Vec<_>>();
        for result in &results {
            let reparsed = Parsed::new(result.clone().into_bytes());
            assert!(reparsed.syntax_errors().is_empty(), "moved: {result}");
        }
        (messages, results)
    }

    #[test]
    fn a_signal_used_only_in_a_block_moves_above_its_begin() {
        let (found, fixed) = moved(
            "  blk : block is\n    signal other : bit;\n  begin\n    x <= s;\n  end block blk;\n",
            "  signal s : bit; -- the flag\n  signal x : bit;\n",
        );
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(
            found[0].contains("'s' is only used inside block 'blk'"),
            "{found:?}"
        );
        assert!(
            fixed[0].contains(
                "is\n  signal x : bit;\nbegin\n  blk : block is\n    signal other : bit;\n    \
                 signal s : bit; -- the flag\n  begin\n    x <= s;"
            ),
            "{}",
            fixed[0]
        );
    }

    #[test]
    fn a_generate_without_begin_is_given_one() {
        let (found, fixed) = moved(
            "  g : if true generate\n    x <= s;\n  end generate g;\n",
            "  signal s, x : bit;\n",
        );
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].contains("inside generate 'g'"), "{found:?}");
        assert!(
            fixed[0].contains("is\n  signal x : bit;\nbegin\n"),
            "the list keeps its other name: {}",
            fixed[0]
        );
        assert!(
            fixed[0].contains("  g : if true generate\n    signal s : bit;\n  begin\n    x <= s;"),
            "{}",
            fixed[0]
        );
    }

    #[test]
    fn the_last_name_of_a_list_takes_the_comma_before_it() {
        let (_, fixed) = moved(
            "  g : if true generate\n    x <= s;\n  end generate g;\n",
            "  signal x, s : bit;\n",
        );
        assert!(
            fixed[0].contains("is\n  signal x : bit;\nbegin\n"),
            "{}",
            fixed[0]
        );
    }

    #[test]
    fn a_case_generate_branch_is_given_a_begin_too() {
        let (found, fixed) = moved(
            "  g : case 1 generate\n    when 1 =>\n      x <= s;\n    when others =>\n  \
             end generate g;\n",
            "  signal s : bit;\n  signal x : bit;\n",
        );
        assert!(
            found[0].contains("the `when 1` branch of generate 'g'"),
            "{found:?}"
        );
        assert!(
            fixed[0].contains("    when 1 =>\n      signal s : bit;\n    begin\n      x <= s;"),
            "{}",
            fixed[0]
        );
    }

    #[test]
    fn an_else_branch_is_named_as_one() {
        let (found, fixed) = moved(
            "  g : if false generate\n  else generate\n    x <= s;\n  end generate g;\n",
            "  signal s : bit;\n  signal x : bit;\n",
        );
        assert!(
            found[0].contains("the else branch of generate 'g'"),
            "{found:?}"
        );
        assert!(
            fixed[0].contains("  else generate\n    signal s : bit;\n  begin\n    x <= s;"),
            "{}",
            fixed[0]
        );
    }

    #[test]
    fn a_for_generate_says_each_iteration_gets_one() {
        let (found, fixed) = moved(
            "  g : for i in 0 to 3 generate\n  begin\n    x(i) <= s;\n  end generate g;\n",
            "  signal s : bit;\n  signal x : bit_vector(0 to 3);\n",
        );
        assert!(
            found[0].contains("each iteration has one of its own"),
            "{found:?}"
        );
        assert!(
            fixed[0].contains("generate\n    signal s : bit;\n  begin\n"),
            "{}",
            fixed[0]
        );
    }

    #[test]
    fn a_name_the_target_declarations_use_goes_first_among_them() {
        let (_, fixed) = moved(
            "  blk : block is\n    signal y : bit;\n    alias a is s;\n  begin\n    y <= a;\n  \
             end block blk;\n",
            "  signal s : bit;\n",
        );
        assert!(
            fixed[0].contains("block is\n    signal s : bit;\n    signal y : bit;\n    alias a"),
            "{}",
            fixed[0]
        );
    }

    #[test]
    fn nested_regions_move_to_the_innermost_that_holds_every_use() {
        let (found, _) = moved(
            "  g : if true generate\n    blk : block is\n    begin\n      x <= s;\n    end block;\n  \
             end generate g;\n",
            "  signal s : bit;\n  signal x : bit;\n",
        );
        assert!(found[0].contains("block 'blk'"), "{found:?}");
    }

    #[test]
    fn a_signal_declared_in_a_generate_moves_further_down() {
        let (found, _) = moved(
            "  g : if true generate\n    signal s : bit;\n  begin\n    blk : block is\n    begin\n  \
             x <= s;\n    end block;\n  end generate g;\n",
            "  signal x : bit;\n",
        );
        assert!(
            found
                .iter()
                .any(|f| f.contains("'s'") && f.contains("block 'blk'")),
            "{found:?}"
        );
    }

    #[test]
    fn a_signal_used_in_two_regions_stays() {
        let (found, _) = moved(
            "  a : if true generate\n    x <= s;\n  end generate a;\n  b : if true generate\n    \
             y <= s;\n  end generate b;\n",
            "  signal s, x, y : bit;\n",
        );
        assert!(found.iter().all(|f| !f.contains("'s'")), "{found:?}");
    }

    #[test]
    fn a_signal_used_in_the_statement_part_stays() {
        let (found, _) = moved(
            "  g : if true generate\n    x <= s;\n  end generate g;\n  y <= s;\n",
            "  signal s, x, y : bit;\n",
        );
        assert!(found.iter().all(|f| !f.contains("'s'")), "{found:?}");
    }

    #[test]
    fn a_name_declared_twice_is_left_alone() {
        let (found, _) = moved(
            "  g : if true generate\n    p : process is\n      variable s : bit;\n    begin\n      \
             s := x;\n      wait;\n    end process;\n  end generate g;\n  x <= '0';\n",
            "  signal s, x : bit;\n",
        );
        assert!(found.iter().all(|f| !f.contains("'s'")), "{found:?}");
    }

    #[test]
    fn the_guard_of_a_block_is_outside_it() {
        // A block's header is read in the enclosing region, before the block's own
        // declarations exist, so a signal used there cannot move into the block.
        let (found, _) = moved(
            "  blk : block (s = '1') is\n  begin\n    x <= s;\n  end block blk;\n",
            "  signal s, x : bit;\n",
        );
        assert!(found.iter().all(|f| !f.contains("'s'")), "{found:?}");
    }

    #[test]
    fn a_selected_name_suffix_is_not_a_use() {
        let (found, _) = moved(
            "  g : if true generate\n    x <= s;\n  end generate g;\n  y <= r.s;\n",
            "  signal s, x, y : bit;\n",
        );
        assert!(found.iter().any(|f| f.contains("'s'")), "{found:?}");
    }

    #[test]
    fn a_component_port_of_the_same_name_is_not_a_second_declaration() {
        let (found, _) = moved(
            "  g : if true generate\n    x <= s;\n  end generate g;\n",
            "  signal s, x : bit;\n  component c is\n    port (s : in bit);\n  end component;\n",
        );
        assert_eq!(found.len(), 1, "{found:?}");
    }

    #[test]
    fn an_unused_signal_is_not_this_rules_business() {
        let (found, _) = moved("", "  signal s : bit;\n");
        assert!(found.is_empty(), "{found:?}");
    }
}
