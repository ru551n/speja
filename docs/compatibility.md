# Compatibility with VSG

vsg-rs reads VSG configuration files and uses VSG rule identifiers, but it is an independent
implementation with a different architecture. This page lists what carries over, what does not,
and where vsg-rs deliberately differs. The VSG behaviour described here is based on VSG 3.35.0
documentation and black-box runs (see `vsg-config.md`).

## Configuration files

vsg-rs accepts VSG configuration documents in YAML or JSON.

| VSG key | vsg-rs |
|---|---|
| `rule.global`, `rule.group.<name>`, `rule.<id>` | supported, with the same precedence: global < group < rule |
| `disable`, `severity`, `fixable` | supported for implemented rules |
| `phase` | accepted and ignored (vsg-rs has no phases) |
| `user_error_message` | accepted and ignored |
| `rule.length_001.length` | sets the formatter's target width and the `length_001` limit |
| `rule.global.indent_size` | sets the formatter's indentation |
| `rule.global.indent_style` | `spaces` (default) or `smart_tabs` |
| `rule.global.case`, `rule.group.case` / `case::keyword` `.case` | sets keyword case (`lower` or `upper`) and the default of the identifier case rules |
| `rule.group.case` / `case::keyword` `.disable: true` | keeps keywords as written |
| keyword case rules (`entity_004`, …) `.case`, `.disable` | per keyword (see `formatting.md`) |
| `blank_line` rules `.style`, `whitespace_200`, `pragma_400`–`pragma_403` | applied by the formatter |
| alignment rules `.disable` and group options | applied by the formatter per kind of alignment (see `formatting.md`) |
| rule options such as `action`, `parenthesis`, `case`, `case_exceptions`, `prefix_exceptions`, `suffix_exceptions`, `regex`, `prefixes`, `suffixes`, `exceptions`, `names`, `consecutive`, `method`, `clock`, `magnitude`, `units`, `keywords`, `standard` and the `block_comment` options | supported by the rules that define them |
| `linesep` | supported (`"\n"` or `"\r\n"`); without it, the input's line ending is kept |
| `file_list` | ignored with a warning; pass files and directories on the command line |
| `file_rules` | supported, as a mapping or a list; keys are paths or glob patterns (`*`, `?`, `**`); a relative pattern matches any path ending with it |
| `pragma.patterns` | supported (`open`, `close` regular expressions) |
| `indent.tokens` | supported for construct-level indentation (see `formatting.md`); other settings are reported |
| `local_rules` | not supported; ignored with a warning |
| `rule.length_001.error_length` | vsg-rs extension: lines longer than this are reported with severity `error` (formatting still uses `length`) |
| unknown rule ids | warning; the settings are ignored |

Settings of formatter-owned rules that vsg-rs does not map individually (for example most
whitespace and indentation rules) are accepted without warnings. Their behaviour comes from the
formatter's policy.

### Discovery

VSG only reads configuration passed with `-c`. vsg-rs also accepts `-c/--config` (repeatable;
later files override earlier ones). Without it, vsg-rs looks for `vsg-rs.yaml`, `.vsg-rs.yaml`,
`vsg-rs.json` or `.vsg-rs.json` in the file's directory and its parents, which is how editor
integrations work without extra arguments. An existing VSG configuration can be used by passing it
with `-c` or by copying it to one of these names.

## Command line

`vsg-rs` accepts VSG 3.35's arguments with the same meaning: `-f`, positional file names, `-c`,
`--fix`, `-fp`, `-j`, `-js`, `-of {vsg,syntastic,summary}`, `-b`, `-oc`, `-rc`, `--style
{indent_only,jcl}`, `-v`, `-ap`, `--fix_only`, `--stdin`, `--force_fix`, `--quality_report`,
`-p` and `--debug`. The console report, JSON, JUnit and GitLab code-quality files have VSG's
layout.

| Argument | Difference |
|---|---|
| `-fp`, `-ap` | accepted, no effect: there is one phase |
| `-lr` | refused: local rules are Python plugins for VSG's rule engine |
| `--force_fix` | accepted, no effect: files with syntax errors are never changed |
| `--stdin --fix` | prints the fixed source on stdout and the report on stderr (VSG 3.35 fails); exit code 0 when code is printed |
| `-v` | prints vsg-rs's version |
| directories | reported as `source_file_001` (as in VSG); pass files |

vsg-rs additions: `--unsafe_fixes`, `--diff`, `--range START:END`, `--stdin_filename PATH`,
`--sarif FILE`, `--list_rules`, and configuration discovery (`vsg-rs.yaml` / `.vsg-rs.yaml` /
`.json` next to the input) when `-c` is not given.

### Exit codes

As in VSG: `0` when no error-severity violations were found, `1` otherwise (also for files that
could not be processed, missing files and invalid arguments).

## Intentional differences

* **One phase.** VSG stops reporting at the first phase with violations and fixes phase by phase,
  sometimes needing several `--fix` runs. vsg-rs reports all violations at once. `--fix`
  applies the fixes of a snapshot in one transaction; fixes that overlap an applied one are
  resolved again on the new text (a bounded number of rounds), and the result is formatted once.
  Running it again changes nothing.
* **Formatting is not a set of fixes.** Whitespace, indentation, alignment, blank lines, keyword
  case and line length are handled by one formatter with one canonical layout. Individual rules in
  those groups are not reported as separate violations; unformatted lines are reported as
  `format` violations instead.
* **`length_001` is fixable.** VSG never shortens lines. vsg-rs folds them. `length_001` reports only
  what remains, and says whether `--fix` would fold it.
* **Which fixes `--fix` applies.** The same as VSG: the fixes of rules VSG fixes by default
  (its per-rule `fixable` default, or `fixable` from the configuration). Fixes of rules VSG does
  not fix by default (for example `port_023`, adding a port mode, or `signal_007`, removing a
  default value), and removing a statement label that is referenced elsewhere (which would
  break the code), are applied only with `--unsafe_fixes`.
* **Identifier case consistency.** The consistency rules (`signal_014`, …) target the spelling
  the declaration's case rule requires, so declaration and uses are fixed in the same run.
* **Syntax errors.** VSG may try to fix files it cannot fully parse. vsg-rs leaves such files
  untouched and reports the first syntax error.
* **Output verification.** Every fixed or formatted file is re-parsed and compared token by token
  (and comment by comment) with the input before it is written.
* **`if_002`.** A condition that is a single name ending in a parenthesized part
  (`rising_edge(clk)`, `valid(i)`) counts as enclosed, which matches what VSG 3.35 does in
  practice.
* **`-- vsg_off [rules]` / `-- vsg_on [rules]`** suppress the listed rules (all rules without a
  list) between the comments, as in VSG. A bare `-- vsg_off` also switches formatting off (see
  `formatting.md`); `-- vsg-rs: fmt off` switches off only formatting.
* **Line width** is measured in characters (Unicode scalar values for UTF-8 files), not bytes.

## Known gaps

See `rule-status.md` for rule coverage. Not supported: `local_rules` (Python plugins), and
`indent.tokens` settings that are not about construct-level indentation (see `formatting.md`).
The consistency rules check other files only when they are passed in the same run.
