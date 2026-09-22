# Language server

```sh
speja lsp
```

A language server that speaks over stdin and stdout, offering what speja is: **diagnostics and
formatting**. It is not a VHDL language server, and it does not pretend to be one.

## It is meant to run beside `vhdl_ls`, not instead of it

| | |
|---|---|
| [`vhdl_ls`](https://github.com/VHDL-LS/rust_hdl) | completion, hover, go to definition, references, rename, symbols |
| `speja lsp` | diagnostics, related locations, formatting |

The two are independent: neither requires the other, and running both gives an editor the union.
speja **does not advertise** completion, hover, definition, declaration, type definition,
implementation, references, rename, document symbols, workspace symbols, semantic tokens,
signature help or inlay hints, so an editor never asks it for an answer it has no business
giving. A test asserts each of those is absent.

## What it supports

| Request | Behaviour |
|---|---|
| `initialize`, `shutdown` | |
| `textDocument/didOpen`, `didChange`, `didClose` | full-document sync |
| `textDocument/publishDiagnostics` | the style rules and the lint layer, with `relatedInformation` |
| `textDocument/formatting` | one edit for the whole document |
| `textDocument/rangeFormatting` | the selected lines only, the rest untouched |
| `textDocument/codeAction` | a quick fix per fixable finding, `source.fixAll`, and `source.organizeImports` |

## Formatting a selection

*Format Selection* formats the lines you have selected and leaves the rest of the file alone. It
works in whole lines, as `--range` does on the command line: a layout is decided for a line, not
for the columns someone happened to drag across, and half a line cannot be folded. A selection
that stops at the start of a line stops before it, which is where an editor puts the end when
whole lines are selected.

Underneath, the document is formatted in full and only the edits falling in the range are kept,
with the partial result re-parsed to confirm it still has no syntax error. A selection cutting
through a construct therefore yields the part that can be applied safely rather than half a fold.

## What the colours mean

Red is what is wrong, or what speja can put right itself. Amber is what it will not decide for
you: a finding whose only fix is classified unsafe, meaning applying it can change what the
design does. `signal_007` is the example, since it wants a signal's initial value removed and
that value is its power-on state. Colouring that the same red as a missing keyword would call
the author's judgement a mistake.

Only the editor does this. The command line keeps VSG's severities, because that report is
VSG's.

## Quick fixes and fix-all

A quick fix comes from the fix the finding already carries, so what an editor offers is what
`--fix` would do to that one violation. **Fix-all** (`source.fixAll`) is the whole document as
`--fix` would write it.

A line the formatter would change also offers **speja: format line N**, whatever tripped it.
The per-rule fixes are one rule each, and a badly laid out line usually breaks several at once,
an indent and a blank line and a fold; picking them off one at a time is not what someone looking
at the squiggle wants. The action carries the same edit `--fix` would make, restricted to those
lines.

A fix that can change what the design does is offered too, and says so: `signal_007: Remove
default assignment. (may change behaviour)`. It is never the preferred action, so nothing applies
it without being asked, and it stays out of **fix-all** and out of format-on-save, both of which
are built from the same entry point `--fix` uses and never ask for unsafe fixes. Amber without an
action was a dead end: an underline saying the call is yours and no way to make it.

Only fixes speja would apply itself are applied automatically. A fix VSG does not apply by
default (the ones `--unsafe_fixes` exists for) is never offered as a quick fix and never
included in fix-all, because it may change what the design does. One safety rule governs the
command line, quick fixes and fix-all alike; a test asserts fix-all leaves an unsafe fix alone.

## Waiving a finding

Every finding offers three actions, from the lightbulb: **waive it on this line**, **in this
file**, or **everywhere**. Choosing one asks for a reason, and the entry is written to the
project's [waiver file](waivers.md), which is what `--waivers` reads. An empty reason cancels: a
waiver without one is only a suppression.

The server also *reads* that file. A finding the project has already accepted is not underlined,
because the command line does not count it either, and an editor that kept showing it would be the
one place still arguing about a decision that has been made.

The waiver file is the nearest `speja-waivers.yaml` in the file's directory or an ancestor, and
a project that has none gets one at the workspace root. A client can name it differently with the
initialization option `waiverFile`. The entry goes through `workspace/applyEdit`, so the client
applies it: it can be undone, and a waiver file that is open in the editor is edited rather than
overwritten behind it.

A waiver file that does not parse is ignored here rather than reported. It is not the source
file's error, the command line says so, and hiding findings because the *suppression* list is
malformed would be the wrong way round.

## Sorting the context clauses

`source.organizeImports` sorts the `library` and `use` clauses of a file: `ieee` and `std` first,
then everything else alphabetically, then `work` last, with the `use` clauses sorted inside each
library.

It is an action, not a rule, and `--fix` does not do it. No order of a context clause is wrong:
every one of them analyses, so there is nothing to report. It is a convention, which is what this
kind of action is for, and an editor can run it on save by listing `source.organizeImports` in
`editor.codeActionsOnSave`.

It moves whole lines and never rewrites one, so a comment, an alignment or a spelling cannot be
lost. A comment on the line above a clause travels with it, and a trailing comment stays on its
line. Where that cannot be done safely there is no action at all: two clauses sharing a line,
`library ieee, work;`, a context reference, or a comment that cannot be attributed to a clause.

## It analyses the buffer

Diagnostics describe what the editor currently holds, not what is on disk. A file that has never
been saved is analysed in the project its path belongs to, because the path decides the
configuration and the library.

A result that a newer edit has overtaken is dropped rather than published: analyses run
concurrently and do not finish in the order they start, so a small edit can overtake the larger
buffer before it, and showing that late result would leave stale diagnostics on screen.

## It is the same tool underneath

The server calls the same library the command line does: the same parser, formatter, analysis
and configuration. There is no editor-specific implementation of anything:

* **Formatting** goes through the entry point `--fix` uses, so formatting on save leaves a file
  the command line then reports nothing about. A test asserts the edit equals what `--fix` writes.
* **Diagnostics** are the rules of `--check style,lint`.
* **Configuration** is discovered as the command line discovers it: the nearest `speja.yaml` (or
  `.json`) in the file's directory or an ancestor. There is no editor-only configuration of rules
  or formatting, so an editor and CI cannot disagree.

A file that does not parse reports its syntax errors and nothing else, and is never reformatted.

## Editors

Any client that can launch a command works. On VS Code there is an
[extension](https://github.com/ru551n/speja/tree/main/editors/vscode) that launches it for you,
and that also carries [editing actions](vscode-editing.md) such as instantiating an entity. Those
work through VHDL-LS, not through this server, which still answers no request about what a name
means. Everywhere else, launch `speja lsp` directly. See [editors](editors.md).

```jsonc
// Neovim, with nvim-lspconfig's generic interface
vim.lsp.start({ name = "speja", cmd = { "speja", "lsp" }, filetypes = { "vhdl" } })
```
