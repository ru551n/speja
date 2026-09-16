# Line folding

Long lines are folded by the formatter, based on the syntax tree. `length_001` is a formatter
setting first and a lint rule second: after `vsg-rs fmt`, the only lines longer than the limit
are ones that cannot be folded safely.

## Width

* The **target width** is `length_001.length` (default 120) or `--line-length`.
* Width is measured in **display columns**: one column per character. For files that are valid
  UTF-8 that means per Unicode scalar value; other files are treated as Latin-1, one column per
  byte. Tabs (which can only appear in comments) advance to the next multiple of 4. Line
  endings are not counted. The same function is used by the layout engine and by the
  `length_001` lint.
* The target decides layout. Any separate warning or error threshold only affects diagnostics
  and never changes formatting.

## Model

The syntax tree is lowered into a document of atoms (tokens, comments), line breaks,
indentation, alignment and **groups**. A group is printed flat if everything up to the next
possible line break after it fits in the remaining width; otherwise its line breaks are taken.
Outer groups are decided before inner groups. That makes the cost model:

1. break at the outermost structural boundary first (list separators, lowest-precedence
   operators, the start of a declaration's value);
2. only then break inside nested constructs, each independently.

Breaking a group never forces its children to break. A child that fits on its new line stays
flat. Decisions are made once, top to bottom, with a bounded look-ahead, so layout time is linear
in practice. There is no search over alternatives and no re-running.

Two special forms:

* **Choice**: a value after `:=`, `=>`, `<=` that folds well inside its own parentheses (a call,
  aggregate or qualified expression) stays on the line if its *first line* fits; otherwise it moves
  to an indented continuation line. The printer takes the first alternative whose first line fits.
* **Fill**: aggregates made only of short items (literals, simple names) put as many items on
  each line as fit.

## Break points and their order

| Construct | Break points | Layout when broken |
|---|---|---|
| Parenthesized list (call, aggregate, parameter list, index constraint, enumeration, sensitivity list) | after `(`, after each `,` / `;`, before `)` | one element per line, indented one level, `)` on its own line |
| Interface clause, generic/port map | always broken | one element per line, `:` / `=>` aligned |
| Operator chain of equal precedence | before each operator | operator first on each continuation line, aligned with the first operand |
| Parenthesized expression | inside the parentheses | contents aligned after `(` |
| Declaration value (`:= value`) | before `:=` | `:= value` on an indented continuation line |
| Named association (`formal => actual`) | after `=>` | actual on an indented continuation line |
| Simple assignment (`target <= value`) | after `<=` / `:=`, only if the first line of the value cannot fit | value on an indented continuation line |
| Conditional assignment | after each `else` (always); before `when` | `when condition` indented under its value |
| Selected assignment | after `select … <=` and each `,` (always); before `when` | alternatives indented |
| Choices (`a \| b \| c`) | before each `\|` | aligned with the first choice |
| Waveforms / identifier lists / names | after each `,` | aligned with the first element |
| `report … severity`, `wait on … until … for`, file open information, `after` clauses | before the clause keyword | clause on an indented continuation line |
| `attribute … is value`, `alias … is name` | before `is` | indented continuation line |
| Array type definitions | before `of` | indented continuation line |
| `assert … report … severity` | always before `report` and `severity` | indented |

Operator precedence classes, from lowest (broken first) to highest: range direction
(`to`, `downto`), logical, relational (including matching operators), shift, adding (`+ - &`),
multiplying, `**`. Only a left-nested chain of the same class is flattened, so line breaks
always follow the parsed expression. Parentheses are never added or removed.

## Operator placement

Operators start continuation lines:

```vhdl
valid <= input_valid
         and output_ready
         and not fifo_full;
```

Conditional assignments are the exception: `else` ends its line, matching VSG's default layout.

## Continuation indentation

* Lists and clauses: one indentation level deeper than the line that opened them.
* Operator chains, flat lists and parenthesized expressions: aligned with their first element.
* Alignment is bounded. If the alignment column is past 40% of the width, continuation lines use
  the current line's indentation plus two levels instead. This keeps deep nesting from
  staircasing off the right edge.

## Flat versus broken, and stability

* Existing line breaks in the source are not kept (except blank lines between items and the line
  structure implied by comments). The layout is a function of the tokens, comments and width
  only. That is why the result is stable: formatting the output again produces the same decisions.
* A construct that fits is always printed flat, except the always-broken forms listed above. A
  construct is never flattened into something that would break again on the next run: the fit
  test for a group includes everything up to the next possible break after it.
* Boundaries: a line of exactly the target width counts as fitting; one column more does not.

## Comments

* A trailing comment is printed after the token it follows. It does **not** count towards
  the width when layout is decided, so a long comment never changes how code is folded.
  A trailing comment forces the enclosing groups to break, and it always ends its line.
* An own-line comment stays on its own line before the same token, indented like that token.
  Comments before `end` or `)` are indented with the body.
* Comment text is never wrapped and never moved to another token.
* A line that is too long only because of its trailing comment is not an avoidable overflow.
* Special comments (synthesis pragmas, `translate_off` / `translate_on`, lint waivers) are safe
  because comments never move relative to code.

## Unbreakable content

Tokens are never split: identifiers (including extended identifiers), string, character, bit
string, based and physical literals, and selected names (`lib.pkg.item`). If a line is still too
long after all enclosing structure has been broken, the remaining overflow is unavoidable.
Formatting accepts it, and the `length_001` lint reports it.

## Guarantees and tests

* `format(format(x)) == format(x)` for every golden test and every file in the real-world
  corpus, at widths 40, 80 and 120 (`examples/corpus.rs`).
* Output always re-parses, with identical tokens and comments.
* Golden tests (`tests/formatting/*.vhd`) cover each construct family at explicit widths,
  including exact-boundary cases.
