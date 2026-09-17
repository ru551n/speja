# Changelog

## 0.6.0

Formatter options.

* `number_of_spaces` of VSG's 175 spacing rules sets the spaces between the tokens each rule is
  about, within its construct; `>=N` keeps wider source spacing. The token pairs are generated
  from VSG's rule documentation (`scripts/gen_spacing_rules.py`).
* `port_007` to `port_009` `spaces_before` / `spaces_after` set the spaces around port modes.
* `action: same_line` in `generic_010`, `port_014`, `generic_map_004` and `port_map_004` keeps
  the closing parenthesis on the last element's line.
* `align_left: 'yes'` with `align_paren: 'no'` in `concurrent_003` or `sequential_004` indents
  continuation lines one level instead of aligning them.
* The randomized fix test and the corpus example (`CONFIG=file`) cover these options.

## 0.5.0

Correctness.

* Fixes that delete text no longer join neighbouring words or start a comment
  (`if(a)then` with `if_002` `parenthesis: remove` produced `ifa`).
* Consistency rules skip names that the file declares with different kinds of declaration
  (for example a signal and a variable), where only name resolution could tell which one a use
  refers to.
* A new randomized test fixes files twice under random configurations (case, actions,
  disabled groups, alignment, `indent.tokens`, unsafe fixes) and requires no internal error
  and no change in the second run; it passes on the real-world corpus.
* `reserved_001` reports declarations only, and `type_mark_500` skips subprogram parameters and
  protected types (with the comparison against VSG: 12 findings that only vsg-rs reports, down
  from 49).

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
