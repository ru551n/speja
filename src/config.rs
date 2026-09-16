//! Resolved configuration consumed by the formatter and the rules.

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
}

impl Default for FormatConfig {
    fn default() -> Self {
        FormatConfig {
            width: 120,
            indent: 2,
            keyword_case: KeywordCase::Lower,
        }
    }
}
