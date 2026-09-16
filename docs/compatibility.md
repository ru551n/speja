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
| `indent_style`, `user_error_message` | accepted and ignored |
| `rule.length_001.length` | sets the formatter's target width and the `length_001` limit |
| `rule.global.indent_size` | sets the formatter's indentation |
| `rule.global.case`, `rule.group.case` / `case::keyword` `.case` | sets keyword case (`lower` or `upper`) |
| `rule.group.case` / `case::keyword` `.disable: true` | keeps keywords as written |
| rule options such as `action` (`add`/`remove`) and `parenthesis` (`insert`/`remove`) | supported by the rules that define them |
| `linesep` | supported (`"\n"` or `"\r\n"`); without it, the input's line ending is kept |
| `file_list` | ignored with a warning; pass files and directories on the command line |
| `file_rules` | supported, as a mapping or a list; keys are paths or glob patterns (`*`, `?`, `**`); a relative pattern matches any path ending with it |
| `local_rules`, `indent`, `pragma` | not supported; ignored with a warning |
| `rule.length_001.error_length` | vsg-rs extension: lines longer than this are reported with severity `error` (formatting still uses `length`) |
| unknown rule ids | warning; the settings are ignored |

Settings of VSG rules that vsg-rs does not implement individually (for example most whitespace,
indentation and alignment rules) are accepted without warnings. Their behaviour comes from the
formatter's policy, and their options are not honoured yet.

### Discovery

VSG only reads configuration passed with `-c`. vsg-rs also accepts `-c/--config` (repeatable;
later files override earlier ones). Without it, vsg-rs looks for `vsg-rs.yaml`, `.vsg-rs.yaml`,
`vsg-rs.json` or `.vsg-rs.json` in the file's directory and its parents, which is how editor
integrations work without extra arguments. An existing VSG configuration can be used by passing it
with `-c` or by copying it to one of these names.

## Command line

| VSG | vsg-rs |
|---|---|
| `vsg -f FILES` | `vsg-rs lint FILES` (directories are searched recursively) |
| `vsg -f FILES --fix` | `vsg-rs fix FILES` |
| `vsg -f FILES --fix -fp N`, `--all_phases` | no equivalent: there are no phases, and all violations are always reported |
| `vsg --stdin` | `vsg-rs lint -`, `vsg-rs fix -`, `vsg-rs fmt -` with `--stdin-filename` |
| `-c FILE` | `-c FILE` / `--config FILE` |
| `-of vsg`, `-js FILE` | `--output-format text` (default) / `--output-format json` (stdout) |
| `-j FILE` (JUnit) | `--output-format junit` (stdout) |
| — | `--output-format sarif` (SARIF 2.1.0, for code scanning) |
| `--quality_report`, `-of syntastic` | not yet |
| `-b` (backup) | not needed: files are replaced atomically and only after verification |
| `--force_fix` | not provided: files with syntax errors are never modified |
| `-p N` (jobs) | automatic (all cores) |
| `-rc RULE`, `-oc FILE` | `vsg-rs explain RULE`, `vsg-rs rules --all` |
| — | `vsg-rs fmt` (canonical formatting), `vsg-rs check` (lint plus format check for CI) |

### Exit codes

VSG returns 0 or 1. vsg-rs distinguishes:

* `0`: no violations / nothing to change;
* `1`: violations found, or (`fmt --check`, `check`) files need formatting;
* `2`: a file could not be processed (I/O error, syntax error, unsupported construct,
  internal error) or invalid usage.

## Intentional differences

* **No phases.** VSG stops reporting at the first phase with violations and fixes phase by phase,
  sometimes needing several `--fix` runs. vsg-rs reports all violations at once. `vsg-rs fix`
  applies every safe fix in one transaction and then formats; running it again changes nothing.
* **Formatting is not a set of fixes.** Whitespace, indentation, alignment, blank lines, keyword
  case and line length are handled by one formatter with one canonical layout. Individual rules in
  those groups are not reported as separate violations. `vsg-rs check` reports "file is not
  formatted" instead.
* **`length_001` is fixable.** VSG never shortens lines. vsg-rs folds them. `length_001` reports only
  what remains, and says whether `vsg-rs fmt` would fold it.
* **Safety classes.** A fix that may change behaviour (for example `port_012`, removing a port
  default) is reported as a suggestion and never applied automatically.
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

See `rule-status.md` for rule coverage. Notable formatter policies that VSG offers and vsg-rs does
not have yet: identifier case, required blank lines (for example around processes), comment
alignment, per-construct indentation (`indent.tokens`), alternative alignment styles, and
`--fix_only`.
