# Changelog

## 0.4.0

Measurable VSG compatibility.

* Layout findings are reported under the VSG rule that reports each kind of change (keyword
  case exactly; indentation, spacing, line breaks, blank lines and comment columns through a
  table learned from VSG 3.35's reports, `src/layout_rules.json`). Unknown changes stay `format`.
* `scripts/compare_vsg.py` compares findings per rule with VSG; `scripts/learn_layout_rules.py`
  relearns the layout table.
* Consistency rules accept `spelling: declaration` to compare with the declaration as written.
* Closer to VSG: `if_002` accepts names with any parenthesized part, `type_mark_500` skips
  subprogram parameters and protected types, `reserved_001` checks declarations only and knows
  the VHDL-AMS words, `process_018` and `loop_statement_007` also report unlabelled statements,
  and the texts of `component_021` and `block_comment_002` match VSG.

## 0.3.0

* The command line is VSG's (one phase) with `--unsafe_fixes`, `--diff`, `--range`,
  `--stdin_filename`, `--sarif` and `--list_rules`.
* `--fix` applies VSG's default fix set plus formatting.
* `indent.tokens`, contextual keyword case, cross-file consistency, VSG solution texts.
* Standalone binaries for Linux, Windows and macOS.

## 0.2.0

* 192 VSG rules with fixes, blank-line and alignment policies, per-keyword case, smart tabs,
  signature folding, VHDL-2019 tool directives.

## 0.1.0

* First release: formatter with line folding, structural rules, VSG configuration.
