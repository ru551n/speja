# Rule status

`vsg-rs rules --all` prints this table for every rule. This page summarizes it.

VSG 3.35.0 has 972 rules. Each is assigned to the part of vsg-rs that handles it:

| Owner | Meaning | Rules | Status |
|---|---|---|---|
| formatter | whitespace, indentation, blank lines, alignment, case, line length, line structure | 711 | handled by `vsg-rs fmt` policy (options not honoured individually; see gaps below). `length_001` is also implemented as a rule |
| structure | adding or removing optional syntax, labels, parentheses | 187 | 27 implemented, 160 planned |
| lint | naming conventions and style policies without automatic fixes | 60 | planned |
| semantic | needs name resolution (for example consistent capitalization of a declared name) | 14 | planned (requires `vhdl_lang`) |

The classification comes from VSG's rule groups: `whitespace`, `indent`, `blank_line`,
`alignment`, `length` and `case*` → formatter; `structure*` → structure; `naming` → lint. A handful
of case-consistency rules are reclassified as semantic. Some rules VSG groups under `structure`
("X on its own line", "code after `begin`") are about line layout. vsg-rs's formatter enforces
their intent, and they will be marked accordingly once reviewed.

## Implemented rules

| Rule | Description | Default | Fix |
|---|---|---|---|
| `architecture_010` | `end` of an architecture includes the `architecture` keyword | on | safe (`action: add/remove`) |
| `architecture_024` | `end` of an architecture repeats the architecture name | on | safe (`action`) |
| `block_002` | block statements include the optional `is` | on | safe (`action`) |
| `block_007` | `end block` repeats the block label | on | safe (`action`) |
| `component_021` | component declarations include the optional `is` | on | safe (`action`) |
| `component_022` | `end component` repeats the component name | on | safe (`action`) |
| `context_021` | `end` of a context includes the `context` keyword | on | safe (`action`) |
| `context_022` | `end` of a context repeats the context name | on | safe (`action`) |
| `entity_015` | `end` of an entity includes the `entity` keyword | on | safe (`action`) |
| `entity_019` | `end` of an entity repeats the entity name | on | safe (`action`) |
| `function_018` | `end` of a function body includes `function` | on | safe (`action`) |
| `function_020` | `end` of a function body repeats its designator | on | safe (`action`) |
| `generate_011` | `end generate` repeats the generate label | on | safe (`action`) |
| `if_002` | if/elsif conditions are enclosed in parentheses | on | safe (`parenthesis: insert/remove`) |
| `length_001` | lines are not longer than `length` (default 120) | on (warning) | by `vsg-rs fmt` |
| `loop_statement_006` | loop statements have a label | off | none |
| `loop_statement_007` | `end loop` repeats the loop label | off | safe (`action`) |
| `package_007` | `end` of a package includes the `package` keyword | on | safe (`action`) |
| `package_014` | `end` of a package repeats the package name | on | safe (`action`) |
| `package_body_002` | `end` of a package body includes `package body` | on | safe (`action`) |
| `package_body_003` | `end` of a package body repeats the package name | on | safe (`action`) |
| `port_012` | ports have no default values | on | unsafe (suggestion only) |
| `procedure_012` | `end` of a procedure body includes `procedure` | on | safe (`action`) |
| `procedure_014` | `end` of a procedure body repeats its designator | on | safe (`action`) |
| `process_012` | process statements include the optional `is` | on | safe (`action`) |
| `process_016` | process statements have a label | on | none |
| `process_018` | `end process` repeats the process label | on | safe (`action`) |
| `record_type_definition_005` | `end record` repeats the record type name | on | safe (`action`) |

Defaults and severities follow VSG's defaults.

## Formatter gaps

The formatter enforces one layout and covers the intent of most formatter-owned rules with its
defaults. It does not yet offer these VSG policies:

* identifier and label case (`case::name`, `case::label`);
* required blank lines (`blank_line` rules that insert lines, for example before `begin` or
  around processes). Blank lines from the source are kept, collapsed to one;
* configurable alignment (`compact_alignment`, `blank_line_ends_group`, …), alignment of trailing
  comments, alignment of `<=` and `:=` across consecutive statements;
* `indent.tokens` per-construct indentation, tabs;
* keyword case per keyword group (only one case for all keywords).
