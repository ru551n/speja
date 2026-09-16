//! vsg-rs: a VHDL formatter and style checker with VSG-compatible rules and configuration.
//!
//! The pipeline for one source snapshot is: parse once ([`Parsed::new`]), then format and/or
//! lint the same tree. Formatting output is verified by re-parsing it and comparing the token
//! stream and comments against the original before it is returned.

pub mod config;
mod doc;
mod fix;
mod format;
pub mod rules;
mod verify;

use std::fmt;

use vhdl_syntax::parser::parse_with_standard;
use vhdl_syntax::standard::VHDLStandard;
use vhdl_syntax::syntax::{AstNode, SyntaxElement, SyntaxNode, SyntaxToken, TokenKind};

pub use config::{Config, FormatConfig};
pub use doc::display_width;
pub use fix::{FixOutcome, fix};

/// One immutable source snapshot and its (single) parse.
pub struct Parsed {
    source: Vec<u8>,
    root: SyntaxNode,
    errors: Vec<Diagnostic>,
    standard: VHDLStandard,
    /// All tokens in source order (the tree's own sibling navigation is not constant-time).
    tokens: Vec<SyntaxToken>,
}

/// A located message about the source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub offset: usize,
    pub message: String,
}

impl Parsed {
    pub fn new(source: Vec<u8>) -> Parsed {
        let standard = VHDLStandard::VHDL2008;
        let (file, errors) = parse_with_standard(standard, source.as_slice());
        let errors = errors
            .iter()
            .map(|e| Diagnostic {
                offset: e.span().start,
                message: format!("{:?}", e.err()),
            })
            .collect();
        let root = file.raw();
        let mut tokens = Vec::new();
        collect_tokens(&root, &mut tokens);
        Parsed {
            source,
            root,
            errors,
            standard,
            tokens,
        }
    }

    pub fn source(&self) -> &[u8] {
        &self.source
    }

    pub fn root(&self) -> &SyntaxNode {
        &self.root
    }

    pub fn syntax_errors(&self) -> &[Diagnostic] {
        &self.errors
    }

    pub fn is_utf8(&self) -> bool {
        std::str::from_utf8(&self.source).is_ok()
    }

    /// Whether the source uses CRLF line endings (decided by its first line break).
    pub fn uses_crlf(&self) -> bool {
        self.source
            .iter()
            .position(|&b| b == b'\n')
            .is_some_and(|i| i > 0 && self.source[i - 1] == b'\r')
    }

    /// 1-based line and column (in characters) of a byte offset.
    pub fn line_col(&self, offset: usize) -> (usize, usize) {
        let before = &self.source[..offset.min(self.source.len())];
        let line_start = before
            .iter()
            .rposition(|&b| b == b'\n')
            .map_or(0, |i| i + 1);
        let line = before.iter().filter(|&&b| b == b'\n').count() + 1;
        (
            line,
            display_width(&before[line_start..], self.is_utf8(), 0) + 1,
        )
    }

    pub(crate) fn tokens(&self) -> &[SyntaxToken] {
        &self.tokens
    }

    /// Position of `t` in [`Parsed::tokens`]. Token text offsets are strictly increasing.
    pub(crate) fn token_index(&self, t: &SyntaxToken) -> Option<usize> {
        let offset = t.text_offset();
        let i = self.tokens.partition_point(|x| x.text_offset() < offset);
        (self.tokens.get(i)?.text_offset() == offset).then_some(i)
    }

    pub(crate) fn prev_token(&self, t: &SyntaxToken) -> Option<&SyntaxToken> {
        let i = self.token_index(t)?.checked_sub(1)?;
        self.tokens.get(i)
    }

    pub(crate) fn next_token(&self, t: &SyntaxToken) -> Option<&SyntaxToken> {
        self.tokens.get(self.token_index(t)? + 1)
    }

    /// True when the file contains nothing but whitespace and comments.
    fn is_blank(&self) -> bool {
        self.tokens.iter().all(|t| t.kind() == TokenKind::Eof)
    }
}

/// Append the tokens of `node` in source order (linear in the size of the node).
pub(crate) fn collect_tokens(node: &SyntaxNode, out: &mut Vec<SyntaxToken>) {
    for child in node.children_with_tokens() {
        match child {
            SyntaxElement::Token(t) => out.push(t),
            SyntaxElement::Node(n) => collect_tokens(&n, out),
        }
    }
}

#[derive(Debug)]
pub enum FormatError {
    /// The source does not parse; it is left untouched.
    Syntax(Vec<Diagnostic>),
    /// The source uses a construct the formatter does not handle safely yet.
    Unsupported(Diagnostic),
    /// The formatter produced output that is not equivalent to the input (a formatter bug).
    /// The source is left untouched.
    Internal(String),
}

impl fmt::Display for FormatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FormatError::Syntax(d) => write!(f, "cannot format: {} syntax error(s)", d.len()),
            FormatError::Unsupported(d) => write!(f, "cannot format: {}", d.message),
            FormatError::Internal(m) => write!(f, "internal formatter error: {m}"),
        }
    }
}

impl std::error::Error for FormatError {}

/// Format a source snapshot.
pub fn format(source: Vec<u8>, cfg: &FormatConfig) -> Result<Vec<u8>, FormatError> {
    format_parsed(&Parsed::new(source), cfg)
}

/// Format an already parsed snapshot.
pub fn format_parsed(parsed: &Parsed, cfg: &FormatConfig) -> Result<Vec<u8>, FormatError> {
    // A file with only comments makes the parser report a missing design unit, but there is
    // no code that could be damaged.
    if !parsed.errors.is_empty() && !parsed.is_blank() {
        return Err(FormatError::Syntax(parsed.errors.clone()));
    }
    if let Some(t) = parsed
        .tokens()
        .iter()
        .find(|t| matches!(t.kind(), TokenKind::ToolDirective | TokenKind::Unknown))
    {
        return Err(FormatError::Unsupported(Diagnostic {
            offset: t.text_offset(),
            message: "tool directives are not supported by the formatter yet".into(),
        }));
    }
    let mut builder = format::Builder::new(cfg, parsed);
    let doc = builder.node(&parsed.root);
    let opts = doc::PrintOptions {
        width: cfg.width,
        indent: cfg.indent,
    };
    let mut out = doc::print(doc, builder.groups(), &opts);
    verify::equivalent(parsed, &out).map_err(FormatError::Internal)?;
    let crlf = match cfg.line_ending {
        Some(ending) => ending == config::LineEnding::CrLf,
        None => parsed.uses_crlf(),
    };
    if crlf {
        out = to_crlf(&out);
    }
    Ok(out)
}

fn to_crlf(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() + text.len() / 16);
    for &b in text {
        if b == b'\n' {
            out.push(b'\r');
        }
        out.push(b);
    }
    out
}
