# Formatting

`vsg-rs fmt` produces one canonical layout for a given source and configuration. The layout
is chosen to be close to VSG's default style, so existing VSG users see little churn.

## Usage

```sh
vsg-rs fmt src/                                       # rewrite files in place
vsg-rs fmt --check src/                               # exit 1 if any file would change
vsg-rs fmt --diff foo.vhd                             # print a unified diff
cat foo.vhd | vsg-rs fmt --stdin-filename foo.vhd -   # stdin -> stdout
vsg-rs fmt --line-length 100 foo.vhd
```

Exit codes: `0` success / nothing to change, `1` `--check` found files to reformat, `2` a file
could not be processed (I/O error, syntax error, unsupported construct, internal error).

In pipe mode (`-`), stdout contains only the formatted source (or the diff with `--diff`).
All messages go to stderr. On any error nothing is written to stdout, so an editor keeps its
buffer.

Directories are searched recursively for `*.vhd` / `*.vhdl` (case-insensitive), skipping hidden
entries.

## What the formatter owns

* Whitespace between tokens (a fixed spacing table, see below).
* Indentation (default 2 spaces per level).
* Line structure: every design unit, context item, declaration and statement starts on its own
  line. Blocks (`is … begin … end`) indent their content.
* Line folding to the configured width (`line-folding.md`).
* Alignment of `:` in interface lists and record elements, of `=>` in named association lists
  that are printed one element per line, and port mode padding (`in    `, `out   `,
  `inout `).
* Keyword case (default lower).
* Blank lines: kept between items (declarations, statements, design units, list elements, and
  before closing keywords), collapsed to at most one. Blank lines inside expressions are removed.
* Trailing whitespace is removed, including at the end of line comments. Files end with exactly one
  newline.
* Line endings follow the first line break of the input (LF or CRLF).

## What it never changes

* Token text other than keyword case: identifiers (including extended identifiers), literals,
  strings, bit strings and operator symbols are copied byte for byte.
* Comment text (only trailing spaces are removed; line breaks inside block comments are
  normalized to the file's line ending).
* The order of tokens and comments, and which token a comment is attached to. A trailing comment
  stays at the end of the line of the token it follows. An own-line comment stays on its own line
  in front of the same token. Comments before a closing `end` or `)` are indented with the body
  they follow.

## Spacing

One space between tokens, except:

* none before `,` `;` `)` `]` `.` `'`, and none after `(` `[` `.` `'` `@` `^`;
* none before `(` that starts a call, index, slice or type conversion (`f(x)`,
  `std_logic_vector(7 downto 0)`), or an index constraint that follows a type mark;
* none after a unary sign (`-x`);
* a space before `.` after a keyword (external names: `<< signal .tb.x : bit >>`).

After those rules, a space is always inserted where the lexer requires one.

## Layout of common constructs

* `library` clauses start a context; the `use` clauses after them are indented one level.
* `generic (…)` and `port (…)` clauses in entities, components and blocks, and `generic map` /
  `port map` aspects, always have one element per line. Maps are indented under the instance.
* Subprogram parameter lists, calls, aggregates, index constraints, enumerations and
  sensitivity lists are flat when they fit, otherwise one element per line (see
  `line-folding.md`). Aggregates made only of short literals or names fill each line instead.
* Conditional assignments with an `else` have one branch per line, with `else` ending each line.
  Selected assignments have one alternative per line.
* `assert` statements put `report` and `severity` on their own indented lines.

## Configuration

See `compatibility.md` for the VSG configuration mapping. Formatter settings: `width` (from
`length_001.length`, default 120), `indent` (default 2) and keyword case (default lower).

## Not yet implemented

* Formatter disable regions (`-- vsg-rs: fmt off` / `fmt on`). A syntax and its behaviour need to
  be designed first.
* Required blank lines (VSG inserts blank lines around processes, instances and `begin`).
  vsg-rs currently keeps blank lines from the source and collapses them.
* Identifier case, tabs for indentation, range formatting.
