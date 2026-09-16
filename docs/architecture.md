# Architecture

```text
            CLI (src/main.rs)              editors, CI
                     │                               │
                     └─────────────┬─────────────────┘
                                   ▼
                        library API (src/lib.rs)
                                   │
                 resolved configuration (src/config.rs)
                                   │
                    source snapshot: Parsed::new(bytes)
                                   │  one vhdl_syntax parse
                                   ▼
                    lossless concrete syntax tree
                 ┌─────────────────┴──────────────────┐
                 ▼                                    ▼
      layout builder (src/format.rs)          rules (diagnostics + fix intents)
                 │                                    │
                 ▼                                    ▼
      layout document (src/doc.rs)            central fix resolver
                 │                                    │
                 ▼                                    │
      width-aware printer ◄───────────────────────────┘
                 │
                 ▼
      output check (src/verify.rs): re-parse, compare tokens and comments
                 │
                 ▼
      trailing-comment alignment (src/align.rs, whitespace only)
                 │
                 ▼
            canonical source
```

## Invariants

* **One parse per snapshot.** `Parsed` owns the source bytes and the only tree built from them.
  Formatting and rules read that tree; nothing re-tokenizes the source. The output check parses
  the *output*, which is a different snapshot, and comment alignment reuses that parse. (A file
  with tool directives is parsed a second time with the directives masked.)
* **No source mutation between rules.** Rules only read the tree and return diagnostics and fix
  intents. Nothing depends on another rule having run first.
* **Formatting is one pass.** The layout builder emits every token exactly once, in source order,
  and decides only the whitespace between tokens. The printer takes each line-break decision once.
  Idempotence (`format(format(x)) == format(x)`) is a tested property, not something reached by
  repeating the formatter.
* **Output is verified.** Before any output is returned, it is re-parsed and must have no syntax
  errors and the same tokens (keywords compared case-insensitively) and comments, in the same
  order, attached to the same tokens. A mismatch is reported as an internal error and the input is
  left untouched. This is what makes format-on-save safe even when the formatter has a bug. The
  only later step, trailing-comment alignment, changes nothing but the spaces between code and
  a comment on the same line.
* **Refuse rather than guess.** Sources with syntax errors are returned unchanged with an error.
  VHDL-2019 tool directives on their own line are parsed as same-length comments (so byte
  offsets stay valid for rules and fixes) and put back into the output.
* **Deterministic.** Layout depends only on the tree and the resolved configuration. There is no
  hash-map iteration order in the output path. Files are processed in parallel, but results are
  reported in sorted path order.
* **Atomic writes.** A file is written only after its complete result has been computed and
  verified, via a temporary file in the same directory that is then renamed over the original. Files
  whose output is identical to their input are not rewritten.

## Formatter versus linter versus fixer

* The **formatter** owns presentation: whitespace, indentation, line breaks, line folding,
  alignment and keyword case. VSG rules in those categories map onto formatter settings, not
  onto independent fixers.
* The **linter** reports rules that are not layout: naming, structure, semantics.
* The **fixer** applies fixes classified as safe (and, on request, unsafe ones) as text edits
  over a snapshot. A central resolver accepts non-overlapping fixes in source order; the rest are
  resolved again on the new snapshot, for a bounded number of rounds, and the result goes
  through the formatter once. There are no phases and no rule-order dependencies, and users never
  need to repeat `fix`.

## Crate layout

A single package (`vsg-rs`) with a library (`vsg_rs`) and a binary (`vsg-rs`). The CLI has no
formatting logic; range formatting
(`format_range`) is a line diff of the whole-file result, so it has the same guarantees. More
crates will be split out only when a boundary proves useful.
