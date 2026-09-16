# VSG Rule Catalog (v3.35.0)

Generated from a black-box dump of every rule VSG 3.35.0 ships
(`uvx --from vsg==3.35.0 vsg -oc all_rules_config.json`, which reports each
rule's `phase` and `fixable` flag directly) cross-referenced against VSG's own
rule-group membership docs (`docs/rule_groups/*.rst`, fetched via the GitHub
API) and each rule's one-line description (fetched from `docs/*_rules.rst`).
Descriptions below are lightly paraphrased from those one-line summaries in
my own words (verb normalized, trimmed to fit the table, "This rule..."
prefix removed) — no example code or longer prose was copied.

Totals: 972 rules.
By phase: phase 1: 187, phase 2: 192, phase 3: 90, phase 4: 108, phase 5: 72, phase 6: 260, phase 7: 58, phase ?: 5
By fixable: fixable=890, unfixable=82
By proposed vsg-rs owner: formatter=711, lint-only=60, safe-fix=187, semantic=14

## Phase reference (from docs/phases.rst, own words)
1. Structural — add/remove optional VHDL elements, split/join lines
2. Whitespace — horizontal spacing between tokens
3. Vertical spacing — blank-line insertion/removal
4. Indentation — line indent level
5. Alignment — column alignment (colons, `:=`, `=>`, identifiers)
6. Capitalization — case of keywords and identifiers
7. Naming conventions / lengths — prefixes/suffixes, line/file/process length

VSG stops after the first phase with violations unless `-ap`/`--all_phases`
is passed; a rule only reports if every earlier phase was clean, which is
itself the underlying cause of several fix-order bugs in `upstream-bugs.md`.

## Rule-group -> vsg-rs owner mapping used below
- `alignment`, `blank_line`, `case`, `case::keyword`, `case::label`,
  `case::name`, `indent`, `length`, `whitespace` -> **formatter**
  (pure layout: whitespace, blank lines, indentation, column alignment,
  line/file length, single-token case conversion — no cross-reference needed)
- `structure`, `structure::optional` -> **safe-fix**
  (insert/remove an optional keyword or a required-but-absent label/name;
  syntax-local, no name resolution — *except* the handful of `structure`
  rules that turned out to need cross-reference resolution, reclassified
  `semantic` below)
- `naming` -> **lint-only** (prefix/suffix/identifier-naming conventions;
  checkable and sometimes even mechanically fixable, but fundamentally a
  style policy choice rather than a formatting or safe structural edit)
- 14 "consistent capitalization of X across an architecture/subprogram body"
  rules -> **semantic** (these need to resolve an identifier back to its one
  declaration — e.g. a generic/port declared on a component, or a variable
  declared once in a subprogram body — and are exactly the rules responsible
  for VSG-BUG-013/018/020/021/022 in `upstream-bugs.md`)

Rules with no group membership recorded in the current docs (6 rules:
context_028, context_ref_006/007/008/009, whitespace_008) were classified by
their `fixable` flag and rule-id prefix heuristics; flagged with a `*` below.

## Default options confirmed via `-rc` (own testing)

`length_001` (line length, phase 7, **unfixable**):
```
{"rule": {"length_001": {"disable": false, "fixable": false, "length": 120,
                          "phase": 7, "severity": "Warning", ...}}}
```
`length_002` (file length) defaults to `length: 2000`; `length_003` (process
length) defaults to `length: 500`. All three are permanently unfixable by
design (VSG-BUG-026) — VSG will report but never rewrap/split.

A representative casing rule (`architecture_013`, "architecture name has
proper case", phase 6, fixable):
```
{"case": "lower", "case_exceptions": [], "prefix_exceptions": [],
 "suffix_exceptions": [], "regex": "", ...}
```
Casing rules share this same option shape (`case` one of
lower/upper/(pascal|camel)Case/regex, plus 3 exception lists and a raw
`regex` override) across every `case`/`case::keyword`/`case::name` rule —
one shared classifier module, not independently reimplemented per rule, is
the fix for false positives like VSG-BUG-016/017/019.

A representative indent rule (`port_map_300`, phase 4, fixable) carries only
the *global* `indent_size`/`indent_style` (default `2`/`"spaces"`) — indent
*behavior itself* (how much to indent after which token) is not per-rule at
all; it lives in one shared `indent.tokens.<group>.<token>` map (`token`/
`after`, each `current` | integer | `"+N"` | `"-N"`), reported separately by
`-oc` under the top-level `indent` key. This single shared indent-behavior
table (rather than per-rule indent logic) is architecturally the right
pattern for vsg-rs's `formatter` owner and is one thing VSG already gets
right.

## Full rule table

| Rule ID | Description | Phase | Fixable | vsg-rs owner |
|---|---|---|---|---|

| `after_001` | Checks after x in signal assignments in clock processes. | 1 | yes | safe-fix |
| `after_002` | Checks the after keywords are aligned in a clock process. | 5 | yes | formatter |
| `after_003` | Checks the after keywords do not exist in the reset portion of a clock process. | 1 | yes | safe-fix |
| `after_500` | Checks the after keyword has proper case. | 6 | yes | formatter |
| `alias_declaration_001` | Checks the alias keyword is on its own line. | 1 | yes | safe-fix |
| `alias_declaration_100` | Checks a single space after the colon for the subtype_indication. | 2 | yes | formatter |
| `alias_declaration_101` | Checks a single space before the is keyword if the : is present. | 2 | yes | formatter |
| `alias_declaration_102` | Checks a single space after the is keyword. | 2 | yes | formatter |
| `alias_declaration_103` | Checks a single space before the designator. | 2 | yes | formatter |
| `alias_declaration_300` | Checks the indent of the alias keyword. | 4 | yes | formatter |
| `alias_declaration_500` | Checks the alias keyword has proper case. | 6 | yes | formatter |
| `alias_declaration_501` | Checks the is keyword has proper case. | 6 | yes | formatter |
| `alias_declaration_502` | Checks the alias designator has proper case. | 6 | yes | formatter |
| `alias_declaration_503` | Checks consistent capitalization of alias designators. | 6 | yes | semantic |
| `alias_declaration_600` | Checks valid prefixes on alias designators. Default prefix is *a_*. | 7 | no | lint-only |
| `alias_declaration_601` | Checks valid suffixes on alias designators. Default prefix is *_a*. | 7 | no | lint-only |
| `architecture_001` | Checks blank spaces before the architecture keyword. | 4 | yes | formatter |
| `architecture_003` | Checks a blank lines or comments above the architecture declaration. | 3 | yes | formatter |
| `architecture_004` | Checks the proper case of the architecture keyword in the architecture declaration. | 6 | yes | formatter |
| `architecture_005` | Checks the of keyword is on the same line as the architecture keyword. | 1 | yes | safe-fix |
| `architecture_006` | Checks the is keyword is on the same line as the architecture keyword. | 1 | yes | safe-fix |
| `architecture_007` | Checks spaces before the begin keyword. | 4 | yes | formatter |
| `architecture_008` | Checks spaces before the end architecture keywords. | 4 | yes | formatter |
| `architecture_009` | Checks the end keyword has proper case. | 6 | yes | formatter |
| `architecture_010` | Checks the keyword architecture in the end architecture statement. It is clearer to the reader to state what is ending. | 1 | yes | safe-fix |
| `architecture_011` | Checks the architecture name case in the end architecture statement. | 6 | yes | formatter |
| `architecture_012` | Checks a single space between end and architecture keywords. | 2 | yes | formatter |
| `architecture_013` | Checks the case of the architecture name in the architecture declaration. | 6 | yes | formatter |
| `architecture_014` | Checks the case of the entity name in the architecture declaration. | 6 | yes | formatter |
| `architecture_015` | Checks blank lines below the architecture declaration. | 3 | yes | formatter |
| `architecture_016` | Checks blank lines above the begin keyword. | 3 | yes | formatter |
| `architecture_017` | Checks a blank line below the begin keyword. | 3 | yes | formatter |
| `architecture_018` | Checks blank lines or comments above the end architecture declaration. | 3 | yes | formatter |
| `architecture_019` | Checks the proper case of the of keyword in the architecture declaration. | 6 | yes | formatter |
| `architecture_020` | Checks the proper case of the is keyword in the architecture declaration. | 6 | yes | formatter |
| `architecture_021` | Checks the proper case of the begin keyword. | 6 | yes | formatter |
| `architecture_022` | Checks a single space before the entity name in the end architecture declaration. | 2 | yes | formatter |
| `architecture_024` | Checks the architecture name in the end architecture statement. It is clearer to the reader to state which architecture the end... | 1 | yes | safe-fix |
| `architecture_025` | Checks valid names for the architecture. Typical architecture names are: RTL, EMPTY, and BEHAVE. This rule allows the user to restrict... | 7 | no | lint-only |
| `architecture_026` | Checks the colons are in the same column for all declarations in the architecture declarative part. | 5 | yes | formatter |
| `architecture_027` | Checks the alignment of inline comments in the architecture declarative part. | 5 | yes | formatter |
| `architecture_028` | Checks the architecture keyword in the end architecture has proper case. | 6 | yes | formatter |
| `architecture_029` | Checks alignment of names in alias, attribute, type, subtype, constant, signal, variable and file declarations in the architecture... | 5 | yes | formatter |
| `architecture_030` | Checks a single space between architecture and the name. | 2 | yes | formatter |
| `architecture_031` | Checks a single space between the name and the of keyword. | 2 | yes | formatter |
| `architecture_032` | Checks a single space between the of keyword and the entity_name. | 2 | yes | formatter |
| `architecture_033` | Checks a single space between the entity_name and the is keyword. | 2 | yes | formatter |
| `architecture_200` | Checks a blank line below the end architecture statement. | 3 | yes | formatter |
| `architecture_400` | Checks the colons are in the same column for all attribute specifications. | 5 | yes | formatter |
| `architecture_600` | Checks consistent capitalization of generic names in an architecture body. | 6 | yes | semantic |
| `architecture_601` | Checks consistent capitalization of port names in an architecture body. | 6 | yes | semantic |
| `array_constraint_500` | Checks the open keyword in array constraints has the proper case. | 6 | yes | formatter |
| `assert_001` | Checks indent of multiline assert statements. | 4 | yes | formatter |
| `assert_002` | Checks the report keyword is on its own line for concurrent assertion statements. | 1 | yes | safe-fix |
| `assert_003` | Checks the report keyword is on its own line for sequential assertion statements. | 1 | yes | safe-fix |
| `assert_004` | Checks the severity keyword is on its own line for concurrent assertion statements. | 1 | yes | safe-fix |
| `assert_005` | Checks the severity keyword is on its own line for sequential assertion statements. | 1 | yes | safe-fix |
| `assert_100` | Checks a single space after the assert keyword. | 2 | yes | formatter |
| `assert_101` | Checks a single space after the report keyword. | 2 | yes | formatter |
| `assert_102` | Checks a single space after the severity keyword. | 2 | yes | formatter |
| `assert_400` | Checks the alignment of the report expressions. | 4 | yes | formatter |
| `assert_500` | Checks the assert keyword has proper case. | 6 | yes | formatter |
| `assert_501` | Checks the report keyword has proper case. | 6 | yes | formatter |
| `assert_502` | Checks the severity keyword has proper case. | 6 | yes | formatter |
| `attribute_500` | Checks predefined attributes have the proper case. | 6 | yes | formatter |
| `attribute_declaration_100` | Checks a single space after the following elements: attribute keyword and colon. | 2 | yes | formatter |
| `attribute_declaration_101` | Checks at least a single space before the colon. | 2 | yes | formatter |
| `attribute_declaration_300` | Checks the indent of the attribute keyword. | 4 | yes | formatter |
| `attribute_declaration_500` | Checks the attribute keyword has proper case. | 6 | yes | formatter |
| `attribute_declaration_501` | Checks the *identifier* has proper case. | 6 | yes | formatter |
| `attribute_declaration_502` | Checks the *type_mark* has proper case. | 6 | yes | formatter |
| `attribute_specification_100` | Checks a single space after the following attribute_specification elements: attribute keyword, *attribute_designator*, of keyword and is... | 2 | yes | formatter |
| `attribute_specification_101` | Checks a single space before the is keyword. | 2 | yes | formatter |
| `attribute_specification_300` | Checks the indent of the attribute keyword. | 4 | yes | formatter |
| `attribute_specification_500` | Checks the attribute keyword has proper case. | 6 | yes | formatter |
| `attribute_specification_501` | Checks the *attribute_designator* has proper case. | 6 | yes | formatter |
| `attribute_specification_502` | Checks the of keyword has proper case. | 6 | yes | formatter |
| `attribute_specification_503` | Checks the is keyword has proper case. | 6 | yes | formatter |
| `bit_string_literal_500` | Checks the base specifier has proper case. | 6 | yes | formatter |
| `bit_string_literal_501` | Checks the bit value has proper case. The default style is :code:`upper`. | 6 | yes | formatter |
| `block_001` | Checks the block label and the block keyword are on the same line. Keeping the label and generate on the same line reduces excessive... | 1 | yes | safe-fix |
| `block_002` | Checks the existence of the is keyword. | 1 | yes | safe-fix |
| `block_003` | Checks the is keyword is on the same line as the block keyword. | 1 | yes | safe-fix |
| `block_004` | Checks the begin keyword is on its own line. | 1 | yes | safe-fix |
| `block_005` | Checks code after the begin keyword. | 1 | yes | safe-fix |
| `block_006` | Checks the end keyword is on its own line. | 1 | yes | safe-fix |
| `block_007` | Checks the block label exists in the closing of the block statement. | 1 | yes | safe-fix |
| `block_100` | Checks a single space between the following block elements: label, label colon, block keyword, guard open parenthesis, guard close... | 2 | yes | formatter |
| `block_101` | Checks a single space between the end and block keywords and label. | 2 | yes | formatter |
| `block_200` | Checks blank lines or comments above the block label. | 3 | yes | formatter |
| `block_201` | Checks a blank line below the block keyword. | 3 | yes | formatter |
| `block_202` | Checks blank lines or comments above the begin keyword. | 3 | yes | formatter |
| `block_203` | Checks a blank line below the begin keyword. | 3 | yes | formatter |
| `block_204` | Checks blank lines or comments above the end keyword. | 3 | yes | formatter |
| `block_205` | Checks a blank line below the semicolon. | 3 | yes | formatter |
| `block_300` | Checks the indent of the block label. | 4 | yes | formatter |
| `block_301` | Checks the indent of the begin keyword. | 4 | yes | formatter |
| `block_302` | Checks the indent of the end keyword. | 4 | yes | formatter |
| `block_400` | Checks the identifiers for all declarations are aligned in the block declarative region. | 5 | yes | formatter |
| `block_401` | Checks the colons are in the same column for all declarations in the block declarative part. | 5 | yes | formatter |
| `block_402` | Checks the colons are in the same column for all attribute specifications. | 5 | yes | formatter |
| `block_500` | Checks the label has proper case. | 6 | yes | formatter |
| `block_501` | Checks the block keyword has proper case. | 6 | yes | formatter |
| `block_502` | Checks the is keyword has proper case. | 6 | yes | formatter |
| `block_503` | Checks the begin keyword has proper case. | 6 | yes | formatter |
| `block_504` | Checks the end keyword has proper case. | 6 | yes | formatter |
| `block_505` | Checks the block keyword in the end block has proper case. | 6 | yes | formatter |
| `block_506` | Checks the label has proper case on the end block declaration. | 6 | yes | formatter |
| `block_600` | Checks valid suffixes on block labels. The default suffix is *_blk*. | 7 | no | lint-only |
| `block_601` | Checks valid prefixes on block labels. The default prefix is *blk_*. | 7 | no | lint-only |
| `block_comment_001` | Checks the block comment header is correct. | 1 | no | safe-fix |
| `block_comment_002` | Checks the comment_left attribute exists for all comments. | 1 | no | safe-fix |
| `block_comment_003` | Checks the block comment footer is correct. | 1 | no | safe-fix |
| `case_001` | Checks the indent of case, when, and end case keywords. | 4 | yes | formatter |
| `case_002` | Checks a single space after the case keyword. | 2 | yes | formatter |
| `case_003` | Checks a single space before the is keyword. | 2 | yes | formatter |
| `case_004` | Checks a single space after the when keyword. | 2 | yes | formatter |
| `case_005` | Checks a single space before the => operator. | 2 | yes | formatter |
| `case_006` | Checks a single space between the end and case keywords. | 2 | yes | formatter |
| `case_007` | Checks blank lines or comments above the case keyword. The default style is :code:`no_code`. | 3 | yes | formatter |
| `case_009` | Checks blank lines or comments above the end keyword. | 3 | yes | formatter |
| `case_010` | Checks a blank line below the end case keywords. | 3 | yes | formatter |
| `case_011` | Checks the alignment of multiline when statements. | 4 | yes | formatter |
| `case_012` | Checks code after the => operator. | 1 | yes | safe-fix |
| `case_014` | Checks the case keyword has proper case. | 6 | yes | formatter |
| `case_015` | Checks the is keyword has proper case. | 6 | yes | formatter |
| `case_016` | Checks the when has proper case. | 6 | yes | formatter |
| `case_017` | Checks the end keyword in the end case has proper case. | 6 | yes | formatter |
| `case_018` | Checks the case keyword has proper case in the end case. | 6 | yes | formatter |
| `case_019` | Checks labels before the case keyword. The label should be removed. The preference is to have comments above the case statement. | 1 | yes | safe-fix |
| `case_020` | Checks labels after the end case keywords. The label should be removed. The preference is to have comments above the case statement. | 1 | yes | safe-fix |
| `case_200` | Checks a blank line below the => keyword. | 3 | yes | formatter |
| `case_201` | Checks blank lines or comments above the when keyword. The default style is :code:`allow_comment`. | 3 | yes | formatter |
| `case_300` | Checks the indentation of the label. | 4 | yes | formatter |
| `case_generate_alternative_100` | Checks a single space after the when keyword. | 2 | yes | formatter |
| `case_generate_alternative_101` | Checks a single space before the => operator. | 2 | yes | formatter |
| `case_generate_alternative_500` | Checks the when keyword has proper case. | 6 | yes | formatter |
| `case_generate_statement_100` | Checks a single space after the case keyword. | 2 | yes | formatter |
| `case_generate_statement_101` | Checks a single space before the generate keyword. | 2 | yes | formatter |
| `case_generate_statement_400` | Checks the *=>* are aligned in case_generate_alternatives. | 5 | yes | formatter |
| `case_generate_statement_500` | Checks the case keyword has proper case. | 6 | yes | formatter |
| `case_generate_statement_501` | Checks the generate keyword has proper case. | 6 | yes | formatter |
| `choice_500` | Checks the others keyword has proper case. | 6 | yes | formatter |
| `comment_004` | Checks at least a single space before inline comments. | 2 | yes | formatter |
| `comment_010` | Checks the indent lines starting with comments. | 4 | yes | formatter |
| `comment_011` | Checks in-line comments and moves them to the line above. The indent of the comment will be set to the indent of the current line. | 1 | yes | safe-fix |
| `comment_012` | Checks user defined keywords in comments. | 1 | no | safe-fix |
| `comment_100` | Checks a single space after the --. | 2 | yes | formatter |
| `component_001` | Checks the indentation of the component keyword. | 4 | yes | formatter |
| `component_002` | Checks a single space after the component keyword. | 2 | yes | formatter |
| `component_003` | Checks blank lines or comments above the component declaration. The default style is :code:`no_code`. | 3 | yes | formatter |
| `component_004` | Checks the component keyword has proper case. | 6 | yes | formatter |
| `component_005` | Checks the is keyword is on the same line as the component keyword. | 1 | yes | safe-fix |
| `component_006` | Checks the is keyword has proper case. | 6 | yes | formatter |
| `component_007` | Checks a single space before the is keyword. | 2 | yes | formatter |
| `component_008` | Checks the component name has proper case in the component declaration. | 6 | yes | formatter |
| `component_009` | Checks the indent of the end component keywords. | 4 | yes | formatter |
| `component_010` | Checks the end keyword has proper case. | 6 | yes | formatter |
| `component_011` | Checks single space after the end keyword. | 2 | yes | formatter |
| `component_012` | Checks the proper case of the component name in the end component line. | 6 | yes | formatter |
| `component_013` | Checks a single space after the component keyword in the end component line. | 2 | yes | formatter |
| `component_014` | Checks the component keyword in the end component line has proper case. | 6 | yes | formatter |
| `component_016` | Checks blank lines above the end component line. | 3 | yes | formatter |
| `component_017` | Checks the alignment of the colon for each generic and port in the component declaration. Following extra configurations are supported:... | 5 | yes | formatter |
| `component_018` | Checks a blank line below the end component line. | 3 | yes | formatter |
| `component_019` | Checks comments at the end of the port and generic clauses in component declarations. These comments represent additional maintenance.... | 1 | yes | safe-fix |
| `component_020` | Checks alignment of inline comments in the component declaration. Following extra configurations are supported: *... | 5 | yes | formatter |
| `component_021` | Inserts the optional is keyword if it does not exist. | 1 | yes | safe-fix |
| `component_022` | Inserts the optional component_simple_name if it does not exist. | 1 | yes | safe-fix |
| `concurrent_001` | Checks the indent of concurrent assignments. | 4 | yes | formatter |
| `concurrent_002` | Checks a single space after the <= operator. | 2 | yes | formatter |
| `concurrent_003` | Checks alignment of multiline concurrent simple signal assignments. Successive lines should align to the space after the assignment... | 5 | yes | formatter |
| `concurrent_004` | Checks at least a single space before the <= operator. | 2 | yes | formatter |
| `concurrent_005` | Checks labels on concurrent assignments. Labels on concurrents are optional and do not provide additional information. | 1 | yes | safe-fix |
| `concurrent_006` | Checks the alignment of the <= operator over multiple consecutive lines. | 5 | yes | formatter |
| `concurrent_008` | Checks the alignment of inline comments in consecutive concurrent statements. | 5 | yes | formatter |
| `concurrent_009` | Checks alignment of multiline concurrent conditional signal statements. | 5 | yes | formatter |
| `concurrent_010` | Removes blank lines within concurrent signal assignments. | 3 | yes | formatter |
| `concurrent_011` | Checks the structure of simple and conditional concurrent statements. | 1 | yes | safe-fix |
| `concurrent_012` | Checks the structure of multiline concurrent simple signal assignments that contain arrays. | 1 | yes | safe-fix |
| `concurrent_400` | Checks the alignment the => operator in record aggregates. | 5 | yes | formatter |
| `concurrent_401` | Checks the alignment of multiline concurrent simple signal assignments that contain arrays. | 5 | yes | formatter |
| `conditional_expressions_100` | Checks a single space before the when keyword. | 2 | yes | formatter |
| `conditional_expressions_101` | Checks a single space after the when keyword. | 2 | yes | formatter |
| `conditional_expressions_102` | Checks a single space before the else keyword. | 2 | yes | formatter |
| `conditional_expressions_103` | Checks a single space after the else keyword. | 2 | yes | formatter |
| `conditional_expressions_500` | Checks the when keyword has proper case. | 6 | yes | formatter |
| `conditional_expressions_501` | Checks the else keyword has proper case. | 6 | yes | formatter |
| `conditional_waveforms_001` | Checks code after the else keyword. :code:`allow_single_line` set to :code:`no` (Default)... | 1 | yes | safe-fix |
| `conditional_waveforms_100` | Checks a single space before the when keyword. | 2 | yes | formatter |
| `conditional_waveforms_101` | Checks a single space after the when keyword. | 2 | yes | formatter |
| `conditional_waveforms_102` | Checks a single space before the else keyword. | 2 | yes | formatter |
| `conditional_waveforms_103` | Checks a single space after the else keyword. | 2 | yes | formatter |
| `conditional_waveforms_500` | Checks the when keyword has proper case. | 6 | yes | formatter |
| `conditional_waveforms_501` | Checks the else keyword has proper case. | 6 | yes | formatter |
| `constant_001` | Checks the indent of a constant declaration. | 4 | yes | formatter |
| `constant_002` | Checks the constant keyword has proper case. | 6 | yes | formatter |
| `constant_004` | Checks the constant identifier has proper case. | 6 | yes | formatter |
| `constant_005` | Checks a single space after the colon. | 2 | yes | formatter |
| `constant_006` | Checks at least a single space before the colon. | 2 | yes | formatter |
| `constant_007` | Checks the := is on the same line as the constant keyword. | 1 | yes | safe-fix |
| `constant_010` | Checks a single space before the := keyword in constant declarations. Having a space makes it clearer where the assignment occurs on the... | 2 | yes | formatter |
| `constant_012` | Checks the alignment of multiline constants that contain arrays. | 5 | yes | formatter |
| `constant_013` | Checks consistent capitalization of constant names. | 6 | yes | semantic |
| `constant_014` | Checks the indent of multiline constants that do not contain arrays. | 5 | yes | formatter |
| `constant_015` | Checks valid prefixes on constant identifiers. The default constant prefix is *c_*. | 7 | no | lint-only |
| `constant_016` | Checks the structure of multiline constants that contain arrays. | 5 | yes | safe-fix |
| `constant_017` | Checks the structure of constant constraints. | 1 | yes | safe-fix |
| `constant_100` | Checks a single space after the := assignment in constant declarations. Having a space makes it clearer where the assignment occurs on... | 2 | yes | formatter |
| `constant_101` | Checks a single space before the identifier. | 2 | yes | formatter |
| `constant_200` | Checks a blank line below a constant declaration unless there is another constant definition. | 3 | yes | formatter |
| `constant_400` | Checks the alignment of assignment keywords in constant declarations. | 5 | yes | formatter |
| `constant_600` | Checks valid suffixes on constant identifiers. The default constant suffix is *_c*. | 7 | no | lint-only |
| `constrained_array_definition_500` | Checks the array keyword has proper case. | 6 | yes | formatter |
| `constrained_array_definition_501` | Checks the of keyword has proper case. | 6 | yes | formatter |
| `context_001` | Checks the indent of the context keyword. | 4 | yes | formatter |
| `context_002` | Checks a single space between the context keyword and the context identifier. | 2 | yes | formatter |
| `context_003` | Checks blank lines or comments above the context keyword. The default style is :code:`no_code`. | 3 | yes | formatter |
| `context_004` | Checks the context keyword has proper case. | 6 | yes | formatter |
| `context_005` | Checks the context identifier is on the same line as the context keyword. | 1 | yes | safe-fix |
| `context_006` | Checks the is keyword is on the same line as the context identifier. | 1 | yes | safe-fix |
| `context_007` | Checks code after the is keyword. | 1 | yes | safe-fix |
| `context_008` | Checks the end keyword is on its own line. | 1 | yes | safe-fix |
| `context_009` | Checks the context keyword is on the same line as the end context keyword. | 1 | yes | safe-fix |
| `context_010` | Checks the context identifier is on the same line as the end context keyword. | 1 | yes | safe-fix |
| `context_011` | Checks the semicolon is on the same line as the end keyword. | 1 | yes | safe-fix |
| `context_012` | Checks the context identifier has proper case in the context declaration. | 6 | yes | formatter |
| `context_013` | Checks the is keyword has proper case in the context declaration. | 6 | yes | formatter |
| `context_014` | Checks the end keyword has proper case. | 6 | yes | formatter |
| `context_015` | Checks the context keyword has proper case in the end context declaration. | 6 | yes | formatter |
| `context_016` | Checks the context identifier has proper case in the end context declaration. | 6 | yes | formatter |
| `context_017` | Checks a single space between the context identifier and the is keyword. | 2 | yes | formatter |
| `context_018` | Checks a single space between the end keyword and the context keyword. | 2 | yes | formatter |
| `context_019` | Checks a single space between the context keyword and the context identifier. | 2 | yes | formatter |
| `context_020` | Checks the indent of the end keyword. | 4 | yes | formatter |
| `context_021` | Checks the keyword context in the end context statement. | 1 | yes | safe-fix |
| `context_022` | Checks the context name in the end context statement. | 1 | yes | safe-fix |
| `context_023` | adds a blank line below the is keyword. | 3 | yes | formatter |
| `context_024` | Checks blank lines or comments above the end keyword. The default style is :code:`no_code`. | 3 | yes | formatter |
| `context_025` | adds a blank line below the context semicolon. | 3 | yes | formatter |
| `context_028`* | Checks alignment of inline comments in the context declaration. | ? | no | lint-only |
| `context_ref_001` | Checks the indent of the context keyword. | 4 | yes | formatter |
| `context_ref_002` | Checks a single space between the context keyword and the context selected name. | 2 | yes | formatter |
| `context_ref_003` | Checks the context keyword has proper case. | 6 | yes | formatter |
| `context_ref_005` | Checks the context keyword is on its own line. | 1 | yes | safe-fix |
| `context_ref_006`* | Checks the semicolon is on the same line as the context selected name. | ? | no | lint-only |
| `context_ref_007`* | Checks code after the semicolon. | ? | no | lint-only |
| `context_ref_008`* | Checks the context selected name is on the same line as the context keyword. | ? | no | lint-only |
| `context_ref_009`* | Checks multiple selected names in a single reference. | ? | no | lint-only |
| `context_ref_500` | Checks the library name called out in the selected name has proper case. | 6 | yes | formatter |
| `context_ref_501` | Checks the context name called out in the selected name has proper case. | 6 | yes | formatter |
| `declarative_part_400` | Checks the alignment of := operator for signal, constant and variable declarations. | 5 | yes | formatter |
| `delay_mechanism_500` | Checks the transport keyword has proper case. | 6 | yes | formatter |
| `delay_mechanism_501` | Checks the inertial keyword has proper case. | 6 | yes | formatter |
| `delay_mechanism_502` | Checks the reject keyword has proper case. | 6 | yes | formatter |
| `element_association_100` | Checks a single space between the others keyword and the => in an element_association. | 2 | yes | formatter |
| `element_association_101` | Checks a single space after the => in an element_association. | 2 | yes | formatter |
| `entity_001` | Checks the indent of the entity keyword. | 4 | yes | formatter |
| `entity_002` | Checks a single space after the entity keyword. | 2 | yes | formatter |
| `entity_003` | Checks blank lines or comments above the entity keyword. | 3 | yes | formatter |
| `entity_004` | Checks the entity keyword has proper case. | 6 | yes | formatter |
| `entity_005` | Checks the is keyword is on the same line as the entity keyword. | 1 | yes | safe-fix |
| `entity_006` | Checks the is keyword has proper case in the entity declaration. | 6 | yes | formatter |
| `entity_007` | Checks a single space before the is keyword. | 2 | yes | formatter |
| `entity_008` | Checks the entity name has proper case in the entity declaration. | 6 | yes | formatter |
| `entity_009` | Checks the indent of the end keyword. | 4 | yes | formatter |
| `entity_010` | Checks the end keyword has proper case. | 6 | yes | formatter |
| `entity_011` | Checks a single space after the end keyword. | 2 | yes | formatter |
| `entity_012` | Checks the case of the entity name in the end entity statement. | 6 | yes | formatter |
| `entity_013` | Checks a single space after the entity keyword in the closing of the entity declaration. | 2 | yes | formatter |
| `entity_014` | Checks the entity keyword has proper case in the closing of the entity declaration. | 6 | yes | formatter |
| `entity_015` | Checks the keyword entity in the end entity statement. | 1 | yes | safe-fix |
| `entity_016` | Checks blank lines above the end entity keywords. | 3 | yes | formatter |
| `entity_017` | Checks the alignment of the colon for each generic and port in the entity declaration. Following extra configurations are supported: *... | 5 | yes | formatter |
| `entity_018` | Checks the alignment of := operator for each generic and port in the entity declaration. Following extra configurations are supported: *... | 5 | yes | formatter |
| `entity_019` | Checks the entity name in the end entity statement. | 1 | yes | safe-fix |
| `entity_020` | Checks alignment of inline comments in the entity declaration. Following extra configurations are supported: *... | 5 | yes | formatter |
| `entity_021` | Checks the end keyword is on its own line. | 1 | yes | safe-fix |
| `entity_022` | Checks the identifier is on the same line as the entity keyword. | 1 | yes | safe-fix |
| `entity_023` | Checks the end entity keyword is on the same line as the end keyword. | 1 | yes | safe-fix |
| `entity_024` | Checks the end entity simple name is not on its own line. | 1 | yes | safe-fix |
| `entity_025` | Checks the semicolon is not on its own line. | 1 | yes | safe-fix |
| `entity_026` | Checks code after the is keyword. | 1 | yes | safe-fix |
| `entity_027` | Checks code after the begin keyword. | 1 | yes | safe-fix |
| `entity_028` | Checks code after the semicolon. | 1 | yes | safe-fix |
| `entity_029` | Checks the begin keyword is on its own line. | 1 | yes | safe-fix |
| `entity_200` | Checks blank lines above the generic keyword in entity specifications. | 3 | yes | formatter |
| `entity_201` | Ensures no blank lines after the is keyword. | 3 | yes | formatter |
| `entity_202` | Checks blank lines above the port keyword in entity specifications. | 3 | yes | formatter |
| `entity_203` | Checks blank lines below the semicolon in entity specifications. | 3 | yes | formatter |
| `entity_300` | Checks the indent of the begin keyword. | 4 | yes | formatter |
| `entity_500` | Checks the begin keyword has proper case. | 6 | yes | formatter |
| `entity_600` | Checks consistent capitalization of generic names in entity declarations. | 6 | yes | semantic |
| `entity_specification_100` | Checks a single space after the colon. | 2 | yes | formatter |
| `entity_specification_101` | Checks at least a single space before the colon. | 2 | yes | formatter |
| `entity_specification_500` | Checks the others keyword has proper case. | 6 | yes | formatter |
| `entity_specification_501` | Checks the all keyword has proper case. | 6 | yes | formatter |
| `entity_specification_503` | Checks the *entity_class* has proper case. | 6 | yes | formatter |
| `exit_statement_300` | Checks the indent of the exit keyword. | 4 | yes | formatter |
| `exit_statement_301` | Checks the indent of the label. | 4 | yes | formatter |
| `exit_statement_500` | Checks the exit keyword has proper case. | 6 | yes | formatter |
| `exit_statement_501` | Checks the when keyword has proper case. | 6 | yes | formatter |
| `exponent_500` | Checks the e keyword has proper case. | 6 | yes | formatter |
| `external_constant_name_100` | Checks a single space after the double less than. | 2 | yes | formatter |
| `external_constant_name_101` | Checks a single space after the constant keyword. | 2 | yes | formatter |
| `external_constant_name_102` | Checks a single space before the colon. | 2 | yes | formatter |
| `external_constant_name_103` | Checks a single space after the colon. | 2 | yes | formatter |
| `external_constant_name_104` | Checks a single space before the double greater than. | 2 | yes | formatter |
| `external_constant_name_500` | Checks the constant keyword has proper case. | 6 | yes | formatter |
| `external_signal_name_100` | Checks a single space after the double less than. | 2 | yes | formatter |
| `external_signal_name_101` | Checks a single space after the signal keyword. | 2 | yes | formatter |
| `external_signal_name_102` | Checks a single space before the colon. | 2 | yes | formatter |
| `external_signal_name_103` | Checks a single space after the colon. | 2 | yes | formatter |
| `external_signal_name_104` | Checks a single space before the double greater than. | 2 | yes | formatter |
| `external_signal_name_500` | Checks the signal keyword has proper case. | 6 | yes | formatter |
| `external_variable_name_100` | Checks a single space after the double less than. | 2 | yes | formatter |
| `external_variable_name_101` | Checks a single space after the variable keyword. | 2 | yes | formatter |
| `external_variable_name_102` | Checks a single space before the colon. | 2 | yes | formatter |
| `external_variable_name_103` | Checks a single space after the colon. | 2 | yes | formatter |
| `external_variable_name_104` | Checks a single space before the double greater than. | 2 | yes | formatter |
| `external_variable_name_500` | Checks the variable keyword has proper case. | 6 | yes | formatter |
| `file_001` | Checks the indent of file declarations. | 4 | yes | formatter |
| `file_002` | Checks the file keyword has proper case. | 6 | yes | formatter |
| `file_100` | Checks a single space before the identifier. | 2 | yes | formatter |
| `file_101` | Checks a single space after the identifier. | 2 | yes | formatter |
| `file_500` | Checks the file identifier has proper case. | 6 | yes | formatter |
| `file_open_information_100` | Checks a single space before the open keyword. | 2 | yes | formatter |
| `file_open_information_101` | Checks a single space after the open keyword. | 2 | yes | formatter |
| `file_open_information_102` | Checks a single space before the is keyword. | 2 | yes | formatter |
| `file_open_information_103` | Checks a single space after the is keyword. | 2 | yes | formatter |
| `file_open_information_500` | Checks the open keyword has proper case. | 6 | yes | formatter |
| `file_open_information_501` | Checks the file open kind expression has proper case. | 6 | yes | formatter |
| `file_open_information_502` | Checks the is keyword has proper case. | 6 | yes | formatter |
| `file_type_definition_500` | Checks the file keyword has proper case. | 6 | yes | formatter |
| `file_type_definition_501` | Checks the of keyword has proper case. | 6 | yes | formatter |
| `for_generate_statement_500` | Checks the for keyword has proper case. | 6 | yes | formatter |
| `for_generate_statement_501` | Checks the generate keyword has proper case. | 6 | yes | formatter |
| `function_001` | Checks the indentation of the function keyword. | 4 | yes | formatter |
| `function_004` | Checks the begin keyword has proper case. | 6 | yes | formatter |
| `function_005` | Checks the function keyword has proper case. | 6 | yes | formatter |
| `function_006` | Checks blank lines or comments above the function keyword. | 3 | yes | formatter |
| `function_008` | Checks the indent of function parameters on multiple lines. | 4 | yes | formatter |
| `function_010` | Checks consistent capitalization of function names. | 6 | yes | semantic |
| `function_012` | Checks the colons are in the same column for all declarations in the function declarative part. | 5 | yes | formatter |
| `function_013` | Checks the end keyword has proper case. | 6 | yes | formatter |
| `function_015` | Checks the identifiers for all declarations are aligned in the function declarative part. | 5 | yes | formatter |
| `function_016` | Checks the indent of return statements in function bodies. | 4 | yes | formatter |
| `function_017` | Checks the function designator has proper case. | 6 | yes | formatter |
| `function_018` | Checks the function keyword exists in the closing of the function specification. | 1 | yes | safe-fix |
| `function_019` | Checks the structure of function specifications. | 1 | yes | safe-fix |
| `function_020` | Checks the function designator exists in the closing of the function specification. | 1 | yes | safe-fix |
| `function_100` | Checks a single space between the following function elements: function keyword, function designator, open parenthesis, close... | 2 | yes | formatter |
| `function_101` | Checks a single space between the end and function keywords and function designator. | 2 | yes | formatter |
| `function_300` | Checks the indent of the closing parenthesis if it is on its own line. | 4 | yes | formatter |
| `function_501` | Checks the return keyword has proper case. | 6 | yes | formatter |
| `function_502` | Checks the is keyword has proper case. | 6 | yes | formatter |
| `function_506` | Checks the function designator has proper case on the end function declaration. | 6 | yes | formatter |
| `function_507` | Checks that the parameter names have proper case. | 6 | yes | formatter |
| `function_508` | Checks consistent capitalization of parameter names within the subprogram body. | 6 | yes | semantic |
| `function_509` | Checks the pure keyword has proper case. | 6 | yes | formatter |
| `function_510` | Checks the parameter direction has proper case. | 6 | yes | formatter |
| `function_511` | Checks the parameter class has proper case. | 6 | yes | formatter |
| `function_512` | Checks the impure keyword has proper case. | 6 | yes | formatter |
| `function_600` | Checks valid prefixes on function designators. Default signal prefix is *f_*. | 7 | no | lint-only |
| `function_601` | Checks valid suffixes on function designators. Default signal suffix is *_f*. | 7 | no | lint-only |
| `generate_001` | Checks the indent of the generate declaration. | 4 | yes | formatter |
| `generate_002` | Checks a single space between the label and the colon. | 2 | yes | formatter |
| `generate_003` | Checks a blank line below the end generate keywords. | 3 | yes | formatter |
| `generate_004` | Checks blank lines or comments before the generate label. | 3 | yes | formatter |
| `generate_005` | Checks the generate label has proper case. | 6 | yes | formatter |
| `generate_006` | Checks the indent of the begin keyword. | 4 | yes | formatter |
| `generate_007` | Checks the indent of the end generate keyword. | 4 | yes | formatter |
| `generate_008` | Checks a single space after the end keyword. | 2 | yes | formatter |
| `generate_009` | Checks the end keyword has proper case. | 6 | yes | formatter |
| `generate_010` | Checks the generate keyword has the proper case in the end generate line. | 6 | yes | formatter |
| `generate_011` | Checks the end generate label on for, case and if generate statements. | 1 | yes | safe-fix |
| `generate_012` | Checks the end generate label has proper case. | 6 | yes | formatter |
| `generate_013` | Checks a single space after the generate keyword and the label in the end generate keywords. | 2 | yes | formatter |
| `generate_014` | Checks a single space between the colon and the for keyword. | 2 | yes | formatter |
| `generate_016` | Checks the indent of the when keyword in generate case statements. | 4 | yes | formatter |
| `generate_017` | Checks valid prefixes on generate statement labels. The default prefix is *gen_*. | 7 | no | lint-only |
| `generate_018` | Checks the indent of the end keyword in the generate statement body. | 4 | yes | formatter |
| `generate_019` | Checks the end keyword is on its own line. | 1 | yes | safe-fix |
| `generate_020` | Checks a label and the colon are on the same line. | 1 | yes | safe-fix |
| `generate_021` | Checks a label colon is on the same line as the case, if, and for keywords. | 1 | yes | safe-fix |
| `generate_400` | Checks the identifiers for all declarations are aligned in the generate declarative part in for generate statements. | 5 | yes | formatter |
| `generate_401` | Checks the colons are in the same column for all declarations in the generate declarative part in for generate statements. | 5 | yes | formatter |
| `generate_402` | Checks the identifiers for all declarations are aligned in the generate declarative part in if generate statements. | 5 | yes | formatter |
| `generate_403` | Checks the colons are in the same column for all declarations in the generate declarative part in if generate statements. | 5 | yes | formatter |
| `generate_404` | Checks the identifiers for all declarations are aligned in the generate declarative part in case generate statements. | 5 | yes | formatter |
| `generate_405` | Checks the colons are in the same column for all declarations in the generate declarative part in case generate statements. | 5 | yes | formatter |
| `generate_500` | Checks the begin keyword has the proper case. | 6 | yes | formatter |
| `generate_501` | Checks the end keyword has the proper case. | 6 | yes | formatter |
| `generate_600` | Checks valid suffixes on generate statement labels. The default suffix is *_gen*. | 7 | no | lint-only |
| `generate_601` | Checks valid prefixes on generate parameter identifiers. The default generate prefix is *gv_*. | 7 | no | lint-only |
| `generate_602` | Checks valid suffixes on generate parameter identifiers. The default generate suffix is *_gv*. | 7 | no | lint-only |
| `generic_002` | Checks the indent of the generic keyword. | 4 | yes | formatter |
| `generic_003` | Checks a single space between the generic keyword and the (. | 2 | yes | formatter |
| `generic_004` | Checks the indent of generic declarations. | 4 | yes | formatter |
| `generic_005` | Checks a single space after the colon in a generic declaration. | 2 | yes | formatter |
| `generic_006` | Checks a single space after the default assignment. | 2 | yes | formatter |
| `generic_007` | Checks the generic names have proper case. | 6 | yes | formatter |
| `generic_008` | Checks the indent of the closing parenthesis. | 4 | yes | formatter |
| `generic_009` | Checks the generic keyword has proper case. | 6 | yes | formatter |
| `generic_010` | Checks the location of the closing ")" character for the generic clause. The default location is on a line by itself. | 1 | yes | safe-fix |
| `generic_013` | Checks the generic keyword on the same line as a generic declaration. | 1 | yes | safe-fix |
| `generic_014` | Checks at least a single space before the colon. | 2 | yes | formatter |
| `generic_016` | Checks multiple generics defined on a single line. | 1 | yes | safe-fix |
| `generic_018` | Checks the generic keyword is on the same line as the (. | 1 | yes | safe-fix |
| `generic_019` | Checks blank lines before the ); of the generic declaration. | 3 | yes | formatter |
| `generic_020` | Checks valid prefixes on generic identifiers. The default generic prefix is *g_*. | 7 | no | lint-only |
| `generic_021` | Checks the semicolon is not on its own line. | 1 | yes | safe-fix |
| `generic_600` | Checks valid suffixes on generic identifiers. The default generic suffix is *_g*. | 7 | no | lint-only |
| `generic_map_001` | Checks the generic map keywords have proper case. | 6 | yes | formatter |
| `generic_map_002` | Checks generic names have proper case. | 6 | yes | formatter |
| `generic_map_003` | Checks the ( is on the same line as the map keyword. | 1 | yes | safe-fix |
| `generic_map_004` | Checks the location of the closing ")" character for the generic map. The default location is on a line by itself. | 1 | yes | safe-fix |
| `generic_map_005` | Checks if the generic map keywords and a generic assignment are on the same line. | 1 | yes | safe-fix |
| `generic_map_006` | Checks a single space between the map keyword and the (. | 2 | yes | formatter |
| `generic_map_007` | Checks a single space after the => keyword in generic maps. | 2 | yes | formatter |
| `generic_map_008` | Checks positional generics. Positional ports and generics are subject to problems when the position of the underlying component changes. | 1 | no | safe-fix |
| `generic_map_009` | Checks the map keyword is on the same line as the generic keyword. | 1 | yes | safe-fix |
| `generic_map_100` | This rules checks for whitespace before the assignment operator. | 2 | yes | formatter |
| `generic_map_101` | Checks a single space between the generic keyword and the map keyword. | 2 | yes | formatter |
| `generic_map_300` | Checks the proper indentation of the generic keyword in generic maps. | 4 | yes | formatter |
| `generic_map_301` | Checks the proper indentation of association elements in generic maps. | 4 | yes | formatter |
| `generic_map_302` | Checks the proper indentation of the closing parenthesis in generic maps. | 4 | yes | formatter |
| `generic_map_600` | Checks valid suffixes on generic identifiers in generic maps The default generic suffix is *_g*. | 7 | no | lint-only |
| `generic_map_601` | Checks valid prefixes on generic identifiers in generic maps The default generic suffix is *g_*. | 7 | no | lint-only |
| `if_001` | Checks the indent of the if keyword. | 4 | yes | formatter |
| `if_002` | Checks the boolean expression is enclosed in (). parenthesis set to 'insert' (Default) ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ | 1 | yes | safe-fix |
| `if_003` | Checks a single space between the if keyword and the (. | 2 | yes | formatter |
| `if_004` | Checks a single space between the ) and the then keyword. | 2 | yes | formatter |
| `if_005` | Checks a single space after the elsif keyword. | 2 | yes | formatter |
| `if_006` | Checks blank lines after the then keyword. | 3 | yes | formatter |
| `if_007` | Checks blank lines before the elsif keyword. | 3 | yes | formatter |
| `if_008` | Checks blank lines before the end if keywords. | 3 | yes | formatter |
| `if_009` | Checks the alignment of multiline boolean expressions. | 4 | yes | formatter |
| `if_010` | Checks blank lines before the else keyword. | 3 | yes | formatter |
| `if_011` | Checks blank lines after the else keyword. | 3 | yes | formatter |
| `if_012` | Checks the indent of the elsif keyword. | 4 | yes | formatter |
| `if_013` | Checks the indent of the else keyword. | 4 | yes | formatter |
| `if_014` | Checks the indent of the end if keyword. | 4 | yes | formatter |
| `if_015` | Checks a single space between the end if keywords. | 2 | yes | formatter |
| `if_020` | Checks the end if keyword is on its own line. | 1 | yes | safe-fix |
| `if_021` | Checks the else keyword is on its own line. | 1 | yes | safe-fix |
| `if_022` | Checks code after the else keyword. | 1 | yes | safe-fix |
| `if_023` | Checks the elsif keyword is on its own line. | 1 | yes | safe-fix |
| `if_024` | Checks code after the then keyword. | 1 | yes | safe-fix |
| `if_025` | Checks the if keyword has proper case. | 6 | yes | formatter |
| `if_026` | Checks the elsif keyword has proper case. | 6 | yes | formatter |
| `if_027` | Checks the else keyword has proper case. | 6 | yes | formatter |
| `if_028` | Checks the end keyword has proper case. | 6 | yes | formatter |
| `if_029` | Checks the then keyword has proper case. | 6 | yes | formatter |
| `if_030` | Checks a single blank line after the end if. In the case of nested if statements, the rule will be enforced on the last end if. | 3 | yes | formatter |
| `if_031` | Checks blank lines or comments above the if keyword. In the case of nested if statements, the rule will be enforced on the first if. The... | 3 | yes | formatter |
| `if_034` | Checks the if keyword in the end if has proper case. | 6 | yes | formatter |
| `if_035` | Checks the expression after the if or elsif keyword starts on the same line. | 1 | yes | safe-fix |
| `if_036` | Checks the then keyword is not on a line by itself. | 1 | yes | safe-fix |
| `if_generate_statement_300` | Checks the indent of the elsif keyword. | 4 | yes | formatter |
| `if_generate_statement_301` | Checks the indent of the else keyword. | 4 | yes | formatter |
| `if_generate_statement_500` | Checks the if keyword has proper case. | 6 | yes | formatter |
| `if_generate_statement_501` | Checks the generate keyword has proper case. | 6 | yes | formatter |
| `if_generate_statement_502` | Checks the elsif keyword has proper case. | 6 | yes | formatter |
| `if_generate_statement_503` | Checks the else keyword has proper case. | 6 | yes | formatter |
| `index_subtype_definition_500` | Checks the range keyword in index subtype definitions has the proper case. | 6 | yes | formatter |
| `instantiation_002` | Checks a single space after the colon. | 2 | yes | formatter |
| `instantiation_003` | Checks a single space before the colon. | 2 | yes | formatter |
| `instantiation_004` | Checks blank lines or comments above the instantiation. The default style is :code:`no_code`. | 3 | yes | formatter |
| `instantiation_005` | Checks the port map keywords are on their own line. | 1 | yes | safe-fix |
| `instantiation_008` | Checks the instance label has proper case. | 6 | yes | formatter |
| `instantiation_009` | Checks the component name has proper case. | 6 | yes | formatter |
| `instantiation_010` | Checks the alignment of the => operator for each generic and port in the instantiation. Following extra configurations are supported: *... | 5 | yes | formatter |
| `instantiation_012` | Checks the instantiation declaration and the generic map keywords are not on the same line. | 1 | yes | safe-fix |
| `instantiation_019` | Checks a blank line below the end of the instantiation declaration. | 3 | yes | formatter |
| `instantiation_027` | Checks the entity keyword has proper case in direct instantiations. | 6 | yes | formatter |
| `instantiation_028` | Checks the entity name has proper case in direct instantiations. | 6 | yes | formatter |
| `instantiation_029` | Checks alignment of inline comments in an instantiation. Following extra configurations are supported: *... | 5 | yes | formatter |
| `instantiation_031` | Checks the component keyword has proper case in component instantiations that use the component keyword. | 6 | yes | formatter |
| `instantiation_032` | Checks a single space after the component keyword if it is used. | 2 | yes | formatter |
| `instantiation_033` | Checks the component keyword for a component instantiation. | 1 | yes | safe-fix |
| `instantiation_034` | Checks component versus direct instantiations. component instantiation ^^^^^^^^^^^^^^^^^^^^^^^ | 1 | no | safe-fix |
| `instantiation_035` | Checks the semicolon is not on its own line. | 1 | yes | safe-fix |
| `instantiation_036` | Checks the optional architecture specification in entity instantiations. The default action is "add". | 1 | no | safe-fix |
| `instantiation_300` | Checks the proper indentation of instantiations. | 4 | yes | formatter |
| `instantiation_500` | Checks the component library name has proper case. | 6 | yes | formatter |
| `instantiation_600` | Checks valid suffixes on instantiation labels. The default suffix is *_inst*. | 7 | no | lint-only |
| `instantiation_601` | Checks valid prefixes on instantiation labels. The default prefix is *inst_*. | 7 | no | lint-only |
| `interface_incomplete_type_declaration_500` | Checks the type keyword has proper case. | 6 | yes | formatter |
| `interface_incomplete_type_declaration_501` | Checks the type name has proper case. | 6 | yes | formatter |
| `interface_incomplete_type_declaration_600` | Checks valid prefixes of type names. | 7 | no | lint-only |
| `interface_incomplete_type_declaration_601` | Checks valid suffixes of type names. | 7 | no | lint-only |
| `iteration_scheme_100` | Checks that a single space exists after the while keyword. | 2 | yes | formatter |
| `iteration_scheme_101` | Checks that a single space exists after the for keyword. | 2 | yes | formatter |
| `iteration_scheme_300` | Checks indentation of the while keyword. Proper indentation enhances comprehension. | 4 | yes | formatter |
| `iteration_scheme_301` | Checks the indentation of the for keyword. | 4 | yes | formatter |
| `iteration_scheme_500` | Checks the while keyword has proper case. | 6 | yes | formatter |
| `iteration_scheme_501` | Checks the for keyword has proper case. | 6 | yes | formatter |
| `length_001` | Checks the length of the line. | 7 | no | formatter |
| `length_002` | Checks the length of a file. | 7 | no | formatter |
| `length_003` | Checks the length of a process statement. | 7 | no | formatter |
| `library_001` | Checks the indent of the library keyword. Indenting helps in comprehending the code. | 4 | yes | formatter |
| `library_002` | Checks excessive spaces after the library keyword. | 2 | yes | formatter |
| `library_003` | Checks blank lines or comments above the library keyword. There is an additional :code:`allow_library_clause` option which can be set.... | 3 | yes | formatter |
| `library_004` | Checks the library keyword has proper case. | 6 | yes | formatter |
| `library_005` | Checks the use keyword has proper case. | 6 | yes | formatter |
| `library_006` | Checks excessive spaces after the use keyword. | 2 | yes | formatter |
| `library_007` | Checks blank lines or comments above the use declaration. The default style is :code:`no_blank_line`. | 3 | yes | formatter |
| `library_008` | Checks the indent of the use keyword. | 4 | yes | formatter |
| `library_009` | Checks alignment of comments above library use statements. | 4 | yes | formatter |
| `library_010` | Checks the library keyword is on its own line. | 1 | yes | safe-fix |
| `library_011` | Checks the use keyword is on its own line. | 1 | yes | safe-fix |
| `library_012` | Checks libraries that have been restricted by the user. | 7 | no | lint-only |
| `library_500` | Checks the logical_name in a library_clause has proper case. | 6 | yes | formatter |
| `logical_operator_500` | Checks logical operators have proper case. | 6 | yes | formatter |
| `loop_statement_001` | Checks code after the loop keyword. | 1 | yes | safe-fix |
| `loop_statement_002` | Checks the end keyword is on its own line. | 1 | yes | safe-fix |
| `loop_statement_003` | Checks the end keyword is on the same line as the end loop keyword. | 1 | yes | safe-fix |
| `loop_statement_004` | Checks the semicolon is on the same line as the end loop keyword. | 1 | yes | safe-fix |
| `loop_statement_005` | Checks the loop label and the while, for or loop keywords are on the same line. | 1 | yes | safe-fix |
| `loop_statement_006` | Checks that loop statements have a label. | 1 | no | safe-fix |
| `loop_statement_007` | Checks the end loop_statement line has a label. The closing label will be added if the opening loop_statement label exists. | 1 | yes | safe-fix |
| `loop_statement_100` | Checks that a single space exists between the end and loop keywords | 2 | yes | formatter |
| `loop_statement_101` | Checks a single space before the ending loop label if it exists. | 2 | yes | formatter |
| `loop_statement_102` | Checks a single space before the loop keyword. | 2 | yes | formatter |
| `loop_statement_103` | Checks if a label exists that a single space exists between the label and the colon. | 2 | yes | formatter |
| `loop_statement_104` | Checks if a label exists that a single space exists after the colon. | 2 | yes | formatter |
| `loop_statement_200` | Checks blank lines or comments above loop statements. The default style is :code:`no_code`. | 3 | yes | formatter |
| `loop_statement_201` | Checks blank lines below the loop keyword. | 3 | yes | formatter |
| `loop_statement_202` | Checks blank lines or comments above the end keyword. | 3 | yes | formatter |
| `loop_statement_203` | Checks blank lines below the end loop keywords. | 3 | yes | formatter |
| `loop_statement_300` | Checks the indentation of the loop keyword. | 4 | yes | formatter |
| `loop_statement_301` | Checks the indentation of the loop label if it exists. | 4 | yes | formatter |
| `loop_statement_302` | Checks the indentation of the end keyword. | 4 | yes | formatter |
| `loop_statement_500` | Checks the loop keyword has proper case. | 6 | yes | formatter |
| `loop_statement_501` | Checks the end keyword has proper case. | 6 | yes | formatter |
| `loop_statement_502` | Checks the loop keyword has proper case. | 6 | yes | formatter |
| `loop_statement_503` | Checks the proper case of the label on a loop statement. | 6 | yes | formatter |
| `loop_statement_504` | Checks the proper case of the end label on a loop statement. | 6 | yes | formatter |
| `loop_statement_600` | Checks valid prefixes on loop labels. The default prefix is *loop_*. | 7 | no | lint-only |
| `loop_statement_601` | Checks valid suffixes on loop labels. The default prefix is *_loop*. | 7 | no | lint-only |
| `loop_statement_602` | Checks valid prefixes on loop parameter identifiers. The default loop prefix is *lv_*. | 7 | no | lint-only |
| `loop_statement_603` | Checks valid suffixes on loop parameter identifiers. The default loop suffix is *_lv*. | 7 | no | lint-only |
| `next_statement_300` | Checks the indentation of the next keyword. | 4 | yes | formatter |
| `next_statement_301` | Checks the indentation of the label. | 4 | yes | formatter |
| `next_statement_500` | Checks the next keyword has proper case. | 6 | yes | formatter |
| `next_statement_501` | Checks the when keyword has proper case. | 6 | yes | formatter |
| `null_statement_300` | Checks the indentation of the null keyword. | 4 | yes | formatter |
| `null_statement_301` | Checks the indentation of the label. | 4 | yes | formatter |
| `null_statement_500` | Checks the null keyword has proper case. | 6 | yes | formatter |
| `package_001` | Checks the indent of the package declaration. | 4 | yes | formatter |
| `package_002` | Checks a single space between package and is keywords. | 2 | yes | formatter |
| `package_003` | Checks blank lines or comments above the package keyword. The default style is :code:`no_code`. | 3 | yes | formatter |
| `package_004` | Checks the package keyword has proper case. | 6 | yes | formatter |
| `package_005` | Checks the is keyword is on the same line as the package keyword. | 1 | yes | safe-fix |
| `package_006` | Checks the end keyword has proper case. | 6 | yes | formatter |
| `package_007` | Checks the package keyword on the end package declaration. | 1 | yes | safe-fix |
| `package_008` | Checks the package name has proper case on the end package declaration. | 6 | yes | formatter |
| `package_009` | Checks a single space between the end and package keywords and package name. | 2 | yes | formatter |
| `package_010` | Checks the package name has proper case in the package declaration. | 6 | yes | formatter |
| `package_011` | Checks a blank line below the package keyword. | 3 | yes | formatter |
| `package_012` | Checks blank lines or comments above the end package keyword. | 3 | yes | formatter |
| `package_013` | Checks the is keyword has proper case. | 6 | yes | formatter |
| `package_014` | Checks the package name exists on the same line as the end package keywords. | 1 | yes | safe-fix |
| `package_015` | Checks the indent of the end package declaration. | 4 | yes | formatter |
| `package_016` | Checks valid suffixes on package identifiers. The default package suffix is *_pkg*. | 7 | no | lint-only |
| `package_017` | Checks valid prefixes on package identifiers. The default package prefix is *pkg_*. | 7 | no | lint-only |
| `package_018` | Checks the package keyword in the end package has proper case. | 6 | yes | formatter |
| `package_019` | Checks the identifiers for all declarations are aligned in the package declarative region. | 5 | yes | formatter |
| `package_400` | Checks the colons are in the same column for all declarations in the package declarative part. | 5 | yes | formatter |
| `package_401` | Checks the alignment of inline comments in the package declarative part. | 5 | yes | formatter |
| `package_402` | Checks the colons are in the same column for all attribute specifications. | 5 | yes | formatter |
| `package_body_001` | Checks the is keyword is on the same line as the package keyword. | 1 | yes | safe-fix |
| `package_body_002` | Checks the optional package body keywords on the end package body declaration. | 1 | yes | safe-fix |
| `package_body_003` | Checks the package name exists in the closing of the package body declaration. | 1 | yes | safe-fix |
| `package_body_100` | Checks a single space between package, body and is keywords. | 2 | yes | formatter |
| `package_body_101` | Checks a single space between the end, package and body keywords and package name. | 2 | yes | formatter |
| `package_body_200` | Checks blank lines or comments above the package keyword. | 3 | yes | formatter |
| `package_body_201` | Checks a blank line below the package keyword. | 3 | yes | formatter |
| `package_body_202` | Checks blank lines or comments above the end keyword. | 3 | yes | formatter |
| `package_body_203` | Checks a blank line below the end package keyword. | 3 | yes | formatter |
| `package_body_300` | Checks the indent of the package body keyword. | 4 | yes | formatter |
| `package_body_301` | Checks the indent of the end package declaration. | 4 | yes | formatter |
| `package_body_400` | Checks the identifiers for all declarations are aligned in the package body declarative region. | 5 | yes | formatter |
| `package_body_401` | Checks the colons are in the same column for all declarations in the package body declarative part. | 5 | yes | formatter |
| `package_body_402` | Checks the colons are in the same column for all attribute specifications. | 5 | yes | formatter |
| `package_body_500` | Checks the package keyword has proper case. | 6 | yes | formatter |
| `package_body_501` | Checks the body keyword has proper case. | 6 | yes | formatter |
| `package_body_502` | Checks the package name has proper case in the package body declaration. | 6 | yes | formatter |
| `package_body_503` | Checks the is keyword has proper case. | 6 | yes | formatter |
| `package_body_504` | Checks the end keyword has proper case. | 6 | yes | formatter |
| `package_body_505` | Checks the package keyword in the end package body has proper case. | 6 | yes | formatter |
| `package_body_506` | Checks the body keyword in the end package body has proper case. | 6 | yes | formatter |
| `package_body_507` | Checks the package name has proper case on the end package body declaration. | 6 | yes | formatter |
| `package_body_600` | Checks valid suffixes on package body identifiers. The default package suffix is *_pkg*. | 7 | no | lint-only |
| `package_body_601` | Checks valid prefixes on package body identifiers. The default package prefix is *pkg_*. | 7 | no | lint-only |
| `package_instantiation_001` | Checks the new package identifier is on the same line as the package keyword. | 1 | yes | safe-fix |
| `package_instantiation_002` | Checks the is keyword is on the same line as the new package identifier. | 1 | yes | safe-fix |
| `package_instantiation_003` | Checks the new keyword is on the same line as the is keyword. | 1 | yes | safe-fix |
| `package_instantiation_004` | Checks the uninstantiated package name is on the same line as the new keyword. | 1 | yes | safe-fix |
| `package_instantiation_100` | Checks a single space between the package keyword and the new package identifier. | 2 | yes | formatter |
| `package_instantiation_101` | Checks a single space between the new package identifier and the is keyword. | 2 | yes | formatter |
| `package_instantiation_102` | Checks a single space between the is keyword and the new keyword. | 2 | yes | formatter |
| `package_instantiation_103` | Checks a single space between new keyword and the uninstantiated package name. | 2 | yes | formatter |
| `package_instantiation_200` | Checks blank lines or comments above the package keyword. The default style is :code:`no_code`. | 3 | yes | formatter |
| `package_instantiation_201` | Checks blank lines below the package instantiation. The default style is :code:`no_blank_line`. | 3 | yes | formatter |
| `package_instantiation_300` | Checks the indent of the package declaration. | 4 | yes | formatter |
| `package_instantiation_500` | Checks the package keyword has proper case. | 6 | yes | formatter |
| `package_instantiation_501` | Checks the instantiated package name has proper case. | 6 | yes | formatter |
| `package_instantiation_502` | Checks the is keyword has proper case. | 6 | yes | formatter |
| `package_instantiation_503` | Checks the new keyword has proper case. | 6 | yes | formatter |
| `package_instantiation_504` | Checks the uninstantiated package name has proper case. | 6 | yes | formatter |
| `package_instantiation_600` | Checks valid suffixes on package identifiers. The default package suffix is *_pkg*. | 7 | no | lint-only |
| `package_instantiation_601` | Checks valid prefixes on instantiated package identifiers. The default package prefix is *pkg_*. | 7 | no | lint-only |
| `parameter_specification_500` | Checks the parameter identifier has proper case. | 6 | yes | formatter |
| `parameter_specification_501` | Checks the in keyword has proper case. | 6 | yes | formatter |
| `port_001` | Checks a blank line above the port keyword. | 3 | yes | formatter |
| `port_002` | Checks the indent of the port keyword. | 4 | yes | formatter |
| `port_003` | Checks a single space after the port keyword and (. | 2 | yes | formatter |
| `port_004` | Checks the indent of port declarations. | 4 | yes | formatter |
| `port_007` | Checks spaces before and after the in mode keyword. | 2 | yes | formatter |
| `port_008` | Checks spaces before and after the out mode keyword. | 2 | yes | formatter |
| `port_009` | Checks spaces before and after the inout mode keyword. | 2 | yes | formatter |
| `port_010` | Checks the port names have proper case. | 6 | yes | formatter |
| `port_011` | Checks valid prefixes on port identifiers. The default port prefixes are: *i_*, *o_*, *io_*. | 7 | no | lint-only |
| `port_012` | Checks default assignments on port declarations. This rule is defaulted to not fixable and can be overridden with a configuration to... | 1 | no | safe-fix |
| `port_013` | Checks multiple ports declared on a single line. | 1 | yes | safe-fix |
| `port_014` | Checks the location of the closing ")" character for the port clause. The default location is on a line by itself. | 1 | yes | safe-fix |
| `port_015` | Checks the indent of the closing parenthesis for port clauses. | 4 | yes | formatter |
| `port_016` | Checks a port definition on the same line as the port keyword. | 1 | yes | safe-fix |
| `port_017` | Checks the port keyword has proper case. | 6 | yes | formatter |
| `port_019` | Checks the port direction has proper case. | 6 | yes | formatter |
| `port_020` | Checks at least one space before the colon. | 2 | yes | formatter |
| `port_021` | Checks the port keyword is on the same line as the (. | 1 | yes | safe-fix |
| `port_022` | Checks blank lines after the port keyword. | 3 | yes | formatter |
| `port_023` | Checks missing modes in port declarations. | 1 | no | safe-fix |
| `port_024` | Checks blank lines before the close parenthesis in port declarations. | 3 | yes | formatter |
| `port_025` | Checks valid suffixes on port identifiers. The default port suffixes are *_i*, *_o*, *_io*. | 7 | no | lint-only |
| `port_026` | Checks multiple identifiers on port declarations. Any comments are not replicated. | 1 | yes | safe-fix |
| `port_027` | Checks the semicolon is not on its own line. | 1 | yes | safe-fix |
| `port_100` | Checks at least a single space before the assignment. | 2 | yes | formatter |
| `port_101` | Checks a single space after the assignment. | 2 | yes | formatter |
| `port_600` | Checks valid prefixes on port identifiers for input ports. The default prefix is: *i_*. | 7 | no | lint-only |
| `port_601` | Checks valid prefixes on port identifiers for output ports. The default prefix is: *o_*. | 7 | no | lint-only |
| `port_602` | Checks valid prefixes on port identifiers for inout ports. The default prefix is: *io_*. | 7 | no | lint-only |
| `port_603` | Checks valid prefixes on port identifiers for buffer ports. The default prefix is: *b_*. | 7 | no | lint-only |
| `port_604` | Checks valid prefixes on port identifiers for linkage ports. The default prefix is: *l_*. | 7 | no | lint-only |
| `port_605` | Checks valid suffixes on port identifiers for input ports. The default suffix is: *_i*. | 7 | no | lint-only |
| `port_606` | Checks valid suffixes on port identifiers for output ports. The default suffix is: *_o*. | 7 | no | lint-only |
| `port_607` | Checks valid suffixes on port identifiers for inout ports. The default suffix is: *_io*. | 7 | no | lint-only |
| `port_608` | Checks valid suffixes on port identifiers for buffer ports. The default suffix is: *_b*. | 7 | no | lint-only |
| `port_609` | Checks valid suffixes on port identifiers for linkage ports. The default suffix is: *_l*. | 7 | no | lint-only |
| `port_map_001` | Checks the port map keywords have proper case. | 6 | yes | formatter |
| `port_map_002` | Checks the port names have proper case. | 6 | yes | formatter |
| `port_map_003` | Checks the "(" character is on the same line as the map keyword. | 1 | yes | safe-fix |
| `port_map_004` | Checks the location of the closing ")" character for the port map. The default location is on a line by itself. | 1 | yes | safe-fix |
| `port_map_005` | Checks a port assignment on the same line as the port map keyword. | 1 | yes | safe-fix |
| `port_map_006` | Checks a single space between the map keyword and the (. | 2 | yes | formatter |
| `port_map_007` | Checks a single space after the => operator in port maps. | 2 | yes | formatter |
| `port_map_008` | Checks positional ports. Positional ports are subject to problems when the position of the underlying component changes. | 1 | no | safe-fix |
| `port_map_009` | Checks multiple port assignments on the same line. | 1 | yes | safe-fix |
| `port_map_010` | Checks comments at the end of the port and generic assignments in instantiations. These comments represent additional maintenance. They... | 1 | yes | safe-fix |
| `port_map_011` | Checks the map keyword is on the same line as the port keyword. | 1 | yes | safe-fix |
| `port_map_100` | This rules checks for whitespace before the assignment operator. | 2 | yes | formatter |
| `port_map_101` | Checks a single space between the port keyword and the map keyword. | 2 | yes | formatter |
| `port_map_200` | Checks a blank line below the open parenthesis in a port map. | 3 | yes | formatter |
| `port_map_300` | Checks the proper indentation of the port keyword in port maps. | 4 | yes | formatter |
| `port_map_301` | Checks the proper indentation of association elements in port maps. | 4 | yes | formatter |
| `port_map_302` | Checks the proper indentation of the closing parenthesis in port maps. | 4 | yes | formatter |
| `pragma_300` | Checks the indent of pragmas. | 4 | yes | formatter |
| `pragma_400` | Checks blank lines or comments above opening pragmas. The default style is :code:`no_code`. | 3 | yes | formatter |
| `pragma_401` | Checks a blank line below opening pragmas. The default style is :code:`no_blank_line`. | 3 | yes | formatter |
| `pragma_402` | Checks blank lines or comments above closing pragmas. The default style is :code:`no_blank_line`. | 3 | yes | formatter |
| `pragma_403` | Checks a blank line below closing pragmas. The default style is :code:`require_blank_line`. | 3 | yes | formatter |
| `procedure_001` | Checks the indent of the procedure keyword. | 4 | yes | formatter |
| `procedure_002` | Checks the indent of the begin keyword. | 4 | yes | formatter |
| `procedure_003` | Checks the indent of the end keyword. | 4 | yes | formatter |
| `procedure_004` | Checks the indent of parameters. | 4 | yes | formatter |
| `procedure_005` | Checks the indent of lines between the is and begin keywords | 4 | yes | formatter |
| `procedure_006` | Checks the indent of the closing parenthesis if it is on its own line. | 4 | yes | formatter |
| `procedure_008` | Checks the end keyword has proper case. | 6 | yes | formatter |
| `procedure_010` | Checks the identifiers for all declarations are aligned in the procedure declarative part. | 5 | yes | formatter |
| `procedure_012` | Checks the procedure keyword exists in the closing of the procedure specification. | 1 | yes | safe-fix |
| `procedure_013` | Checks the structure of procedure specifications. | 1 | yes | safe-fix |
| `procedure_014` | Checks the procedure designator exists in the closing of the procedure specification. | 1 | yes | safe-fix |
| `procedure_100` | Checks a single space between the following procedure elements: procedure keyword, procedure designator, open parenthesis, close... | 2 | yes | formatter |
| `procedure_101` | Checks a single space between the end and procedure keywords and procedure designator. | 2 | yes | formatter |
| `procedure_200` | Checks blank lines or comments above the procedure keyword. | 3 | yes | formatter |
| `procedure_401` | Checks the colons are in the same column for all declarations in the procedure declarative part. | 5 | yes | formatter |
| `procedure_410` | Checks the alignment of the colon for each parameter in the procedure declaration. | 5 | yes | formatter |
| `procedure_411` | Checks the alignment of := operator for each parameter in the procedure declaration. | 5 | yes | formatter |
| `procedure_500` | Checks the procedure keyword has proper case. | 6 | yes | formatter |
| `procedure_501` | Checks the procedure designator has proper case. | 6 | yes | formatter |
| `procedure_502` | Checks the is keyword has proper case. | 6 | yes | formatter |
| `procedure_503` | Checks the begin keyword has proper case. | 6 | yes | formatter |
| `procedure_504` | Checks the end keyword has proper case. | 6 | yes | formatter |
| `procedure_506` | Checks the procedure designator has proper case on the end procedure declaration. | 6 | yes | formatter |
| `procedure_507` | Checks consistent capitalization of procedure names. | 6 | yes | semantic |
| `procedure_508` | Checks that the parameter names have proper case. | 6 | yes | formatter |
| `procedure_509` | Checks consistent capitalization of parameter names within the subprogram body. | 6 | yes | semantic |
| `procedure_510` | Checks the parameter direction has proper case. | 6 | yes | formatter |
| `procedure_511` | Checks the parameter class has proper case. | 6 | yes | formatter |
| `procedure_call_001` | Checks labels on procedure call statements. Labels on procedure calls are optional and do not provide additional information. | 1 | yes | safe-fix |
| `procedure_call_002` | Checks labels on concurrent procedure call statements. Labels on procedure calls are optional and do not provide additional information. | 1 | yes | safe-fix |
| `procedure_call_003` | Checks the structure of procedure calls. | 1 | yes | safe-fix |
| `procedure_call_100` | Checks a single space between the following block elements: label, label colon, postponed keyword and the *procedure* name. | 2 | yes | formatter |
| `procedure_call_101` | Checks a single space after the => operator in procedure calls. | 2 | yes | formatter |
| `procedure_call_300` | Checks the indent of the procedure_call label. | 4 | yes | formatter |
| `procedure_call_301` | Checks the indent of the postponed keyword if it exists.. | 4 | yes | formatter |
| `procedure_call_302` | Checks the indent of the *procedure* name. | 4 | yes | formatter |
| `procedure_call_400` | Checks the alignment of multiline procedure calls. | 5 | yes | formatter |
| `procedure_call_401` | Checks the alignment of :code:`=>` keywords in procedure calls. | 5 | yes | formatter |
| `procedure_call_500` | Checks the label has proper case. | 6 | yes | formatter |
| `procedure_call_501` | Checks the postponed keyword has proper case. | 6 | yes | formatter |
| `procedure_call_502` | Checks that the parameter names have proper case. | 6 | yes | formatter |
| `process_001` | Checks the indent of the process declaration. | 4 | yes | formatter |
| `process_002` | Checks a single space after the process keyword. | 2 | yes | formatter |
| `process_003` | Checks the indent of the begin keyword. | 4 | yes | formatter |
| `process_004` | Checks the begin keyword has proper case. | 6 | yes | formatter |
| `process_005` | Checks the process keyword has proper case. | 6 | yes | formatter |
| `process_006` | Checks the indent of the end process keywords. | 4 | yes | formatter |
| `process_007` | Checks a single space after the end keyword. | 2 | yes | formatter |
| `process_008` | Checks the end keyword has proper case. | 6 | yes | formatter |
| `process_009` | Checks the process keyword has proper case in the end process line. | 6 | yes | formatter |
| `process_010` | Checks the begin keyword is on its own line. | 1 | yes | safe-fix |
| `process_011` | Checks a blank line below the end process keyword. | 3 | yes | formatter |
| `process_012` | Checks the existence of the is keyword. | 1 | yes | safe-fix |
| `process_013` | Checks the is keyword has proper case. | 6 | yes | formatter |
| `process_014` | Checks a single space before the is keyword. | 2 | yes | formatter |
| `process_015` | Checks blank lines or comments above the process declaration. The default style is :code:`no_code`. | 3 | yes | formatter |
| `process_016` | Checks the process has a label. | 1 | no | safe-fix |
| `process_017` | Checks the process label has proper case. | 6 | yes | formatter |
| `process_018` | Checks the end process line has a label. The closing label will be added if the opening process label exists. | 1 | yes | safe-fix |
| `process_019` | Checks the end process label has proper case. | 6 | yes | formatter |
| `process_020` | Checks the indentation of multiline sensitivity lists. | 4 | yes | formatter |
| `process_021` | Checks blank lines above the begin keyword if there are no process declarative items. | 1 | yes | formatter |
| `process_022` | Checks a blank line below the begin keyword. | 3 | yes | formatter |
| `process_023` | Checks a blank line above the end process keyword. | 3 | yes | formatter |
| `process_024` | Checks a single space after the process label. | 2 | yes | formatter |
| `process_025` | Checks a single space after the colon and before the process keyword. | 2 | yes | formatter |
| `process_026` | Checks blank lines above the first declarative line, if it exists. | 3 | yes | formatter |
| `process_027` | Checks blank lines above the begin keyword if a declarative item exists. | 3 | yes | formatter |
| `process_028` | Checks the alignment of the closing parenthesis of a sensitivity list. Parenthesis on multiple lines should be in the same column. | 5 | yes | formatter |
| `process_029` | Checks the format of clock definitions in clock processes. The rule can be set to enforce event definition: if (clk'event and clk = '1')... | 1 | yes | safe-fix |
| `process_030` | Checks a single signal per line in a sensitivity list that is not the last one. The sensitivity list is required by the compiler, but... | 1 | no | safe-fix |
| `process_031` | Checks alignment of identifiers in the process declarative region. | 5 | yes | formatter |
| `process_033` | Checks the colons are in the same column for all declarations in the process declarative part. | 5 | yes | formatter |
| `process_034` | aligns inline comments between the end of the process sensitivity list and the process begin keyword. | 5 | yes | formatter |
| `process_035` | Checks the alignment of inline comments between the process begin and end process lines. | 5 | yes | formatter |
| `process_036` | Checks valid prefixes on process labels. The default prefix is *proc_*. | 7 | no | lint-only |
| `process_037` | Checks a label and the colon are on the same line. | 1 | yes | safe-fix |
| `process_038` | Checks a label colon is on the same line as the process or postponed keyword. | 1 | yes | safe-fix |
| `process_039` | Checks a postponed keyword is on the same line at the process keyword. | 1 | yes | safe-fix |
| `process_400` | Checks the alignment of the <= and := operators over consecutive sequential assignments in the process_statement_part. Following extra... | 5 | yes | formatter |
| `process_401` | Checks the colons are in the same column for all attribute specifications. | 5 | yes | formatter |
| `process_600` | Checks valid suffixes on process labels. The default suffix is *_proc*. | 7 | no | lint-only |
| `protected_type_300` | Checks the indent of the end protected type declaration. | 4 | yes | formatter |
| `protected_type_500` | Checks the protected keyword has proper case. | 6 | yes | formatter |
| `protected_type_501` | Checks the end keyword in end protected has proper case. | 6 | yes | formatter |
| `protected_type_502` | Checks the protected keyword in end protected has proper case. | 6 | yes | formatter |
| `protected_type_body_300` | Checks the indent of the end protected type body declaration. | 4 | yes | formatter |
| `protected_type_body_400` | Checks the identifiers for all declarations are aligned in the protected type body declarative region. | 5 | yes | formatter |
| `protected_type_body_401` | Checks the colons are in the same column for all declarations in the protected type body declarative part. | 5 | yes | formatter |
| `protected_type_body_402` | Checks the colons are in the same column for all attribute specifications. | 5 | yes | formatter |
| `protected_type_body_500` | Checks the protected keyword in protected body has proper case. | 6 | yes | formatter |
| `protected_type_body_501` | Checks the body keyword in protected body has proper case. | 6 | yes | formatter |
| `protected_type_body_502` | Checks the end keyword in end protected body has proper case. | 6 | yes | formatter |
| `protected_type_body_503` | Checks the protected keyword in end protected body has proper case. | 6 | yes | formatter |
| `protected_type_body_504` | Checks the body keyword in end protected body has proper case. | 6 | yes | formatter |
| `range_001` | Checks the case of the downto keyword. | 6 | yes | formatter |
| `range_002` | Checks the case of the to keyword. | 6 | yes | formatter |
| `range_constraint_500` | Checks the range keyword in range constraints has the proper case. | 6 | yes | formatter |
| `record_type_definition_001` | Checks the location of the record keyword. The default location is not on a line by itself. | 1 | yes | safe-fix |
| `record_type_definition_002` | Checks code after the record keyword. | 1 | yes | safe-fix |
| `record_type_definition_003` | Checks the end keyword is on its own line. | 1 | yes | safe-fix |
| `record_type_definition_004` | Checks the is keyword is on the same line as the record keyword. | 1 | yes | safe-fix |
| `record_type_definition_005` | Checks the optional simple name in the end record statement. | 1 | yes | safe-fix |
| `record_type_definition_006` | Checks the optional simple name is on the same line as the record keyword. | 1 | yes | safe-fix |
| `record_type_definition_007` | Checks the semicolon is on the same line as the record keyword. | 1 | yes | safe-fix |
| `record_type_definition_100` | Checks a single space after the end keyword. | 2 | yes | formatter |
| `record_type_definition_101` | Checks a single space before the simple name. | 2 | yes | formatter |
| `record_type_definition_200` | Checks blank lines below the record keyword. | 3 | yes | formatter |
| `record_type_definition_201` | Checks blank lines above the end keyword. | 3 | yes | formatter |
| `record_type_definition_300` | Checks the indent of the record keyword if it is on its own line. | 4 | yes | formatter |
| `record_type_definition_301` | Checks the indent of the end keyword. | 4 | yes | formatter |
| `record_type_definition_500` | Checks the proper case of the record keyword. | 6 | yes | formatter |
| `record_type_definition_501` | Checks the proper case of the end keyword. | 6 | yes | formatter |
| `record_type_definition_502` | Checks the proper case of the end record keyword. | 6 | yes | formatter |
| `report_statement_001` | Removes labels on report_statement_statements. | 1 | yes | safe-fix |
| `report_statement_002` | Checks the severity keyword is on its own line. | 1 | yes | safe-fix |
| `report_statement_100` | Checks a single space after the report keyword. | 2 | yes | formatter |
| `report_statement_101` | Checks a single space after the severity keyword. | 2 | yes | formatter |
| `report_statement_300` | Checks indent of multiline report statements. | 4 | yes | formatter |
| `report_statement_400` | Checks the alignment of the report expressions. alignment set to 'report' (Default) ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ | 4 | yes | formatter |
| `report_statement_500` | Checks the report keyword has proper case. | 6 | yes | formatter |
| `report_statement_501` | Checks the severity keyword has proper case. | 6 | yes | formatter |
| `reserved_001` | Checks VHDL reserved words being used as identifiers and names. | 1 | no | safe-fix |
| `return_statement_300` | Checks the indentation of the return keyword. | 4 | yes | formatter |
| `return_statement_301` | Checks the indentation of the label. | 4 | yes | formatter |
| `return_statement_500` | Checks the return keyword has proper case. | 6 | yes | formatter |
| `selected_assignment_001` | Checks the with keyword is on the same line as the expression. | 1 | yes | safe-fix |
| `selected_assignment_002` | Checks the select keyword is on the same line as the expression. | 1 | yes | safe-fix |
| `selected_assignment_003` | Checks the select keyword is on the same line as the target. | 1 | yes | safe-fix |
| `selected_assignment_004` | Checks the assignment is on the same line as the target. | 1 | yes | safe-fix |
| `selected_assignment_005` | Checks code after the assignment. | 1 | yes | safe-fix |
| `selected_assignment_006` | Checks code after the force keyword. | 1 | yes | safe-fix |
| `selected_assignment_007` | Checks code after the force mode keywords in and out. | 1 | yes | safe-fix |
| `selected_assignment_008` | Checks code after the guarded keyword. | 1 | yes | safe-fix |
| `selected_assignment_009` | Checks code after the delay mechanism keywords transport and inertial. | 1 | yes | safe-fix |
| `selected_assignment_010` | Checks the when keyword is on the same line as the expression or waveform. | 1 | yes | safe-fix |
| `selected_assignment_011` | Checks the choice is on the same line as the when keyword. | 1 | yes | safe-fix |
| `selected_assignment_012` | Checks code after the comma in choices. | 1 | yes | safe-fix |
| `selected_assignment_100` | Checks a single space after the with keyword. | 2 | yes | formatter |
| `selected_assignment_101` | Checks a single space before the select keyword. | 2 | yes | formatter |
| `selected_assignment_102` | Checks a single space after the select keyword. | 2 | yes | formatter |
| `selected_assignment_103` | Checks a single space before the assignment. | 2 | yes | formatter |
| `selected_assignment_104` | Checks a single space after the assignment. | 2 | yes | formatter |
| `selected_assignment_105` | Checks a single space after the force keyword. | 2 | yes | formatter |
| `selected_assignment_106` | Checks a single space before the when keyword. | 2 | yes | formatter |
| `selected_assignment_107` | Checks a single space after the when keyword. | 2 | yes | formatter |
| `selected_assignment_300` | Checks the indent of the with keyword. | 4 | yes | formatter |
| `selected_assignment_400` | Checks the alignment of multiline selected assignment statements. | 5 | yes | formatter |
| `selected_assignment_500` | Checks the with keyword has proper case. | 6 | yes | formatter |
| `selected_assignment_501` | Checks the select keyword has proper case. | 6 | yes | formatter |
| `selected_assignment_502` | Checks the force keyword has proper case. | 6 | yes | formatter |
| `selected_assignment_503` | Checks the when keyword has proper case. | 6 | yes | formatter |
| `sequential_001` | Checks the indent of sequential statements. | 4 | yes | formatter |
| `sequential_002` | Checks a single space after the <= operator. | 2 | yes | formatter |
| `sequential_003` | Checks at least a single space before the <= operator. | 2 | yes | formatter |
| `sequential_004` | Checks the alignment of multiline sequential statements. | 5 | yes | formatter |
| `sequential_006` | Checks comments within multiline sequential statements. | 2 | no | safe-fix |
| `sequential_007` | Checks code after a sequential assignment. | 1 | yes | safe-fix |
| `sequential_008` | Checks the structure of simple and conditional sequential signal assignments. | 1 | yes | safe-fix |
| `sequential_009` | Checks the structure of multiline simple sequential signal assignments that contain arrays. | 1 | yes | safe-fix |
| `sequential_400` | Checks the alignment the => operator in record aggregates. | 5 | yes | formatter |
| `sequential_401` | Checks alignment of multiline sequential conditional signal assignments. | 5 | yes | formatter |
| `sequential_402` | Checks the alignment of multiline simple sequential signal assignments that contain arrays. | 5 | yes | formatter |
| `shift_operator_500` | Checks shift operators have proper case. | 6 | yes | formatter |
| `signal_001` | Checks the indent of signal declarations. | 4 | yes | formatter |
| `signal_002` | Checks the signal keyword has proper case. | 6 | yes | formatter |
| `signal_004` | Checks the signal name has proper case. | 6 | yes | formatter |
| `signal_005` | Checks a single space after the colon. | 2 | yes | formatter |
| `signal_006` | Checks at least a single space before the colon. | 2 | yes | formatter |
| `signal_007` | Checks default assignments in signal declarations. | 1 | no | safe-fix |
| `signal_008` | Checks valid prefixes on signal identifiers. Default signal prefix is *s_*. | 7 | no | lint-only |
| `signal_012` | Checks multiple signal declarations on a single line are column aligned. This rule will only cover two signals on a single line. | 5 | yes | formatter |
| `signal_014` | Checks consistent capitalization of signal names. | 6 | yes | semantic |
| `signal_015` | Checks multiple signal names defined in a single signal declaration. By default, this rule will only flag more than two signal declarations. | 1 | yes | safe-fix |
| `signal_017` | Checks the structure of signal constraints. | 1 | yes | safe-fix |
| `signal_100` | Checks a single space before the identifier. | 2 | yes | formatter |
| `signal_101` | Checks a single space before the default assignment token. | 2 | yes | formatter |
| `signal_102` | Checks a single space after the default assignment token. | 2 | yes | formatter |
| `signal_200` | Checks a blank line below a signal declaration unless there is another signal definition. | 3 | yes | formatter |
| `signal_400` | Checks alignment of multiline constraints in signal declarations. | 5 | yes | formatter |
| `signal_600` | Checks valid suffixes on signal identifiers. Default signal suffix is *_s*. | 7 | no | lint-only |
| `source_file_001` | Checks the existence of the source file passed to VSG. | 1 | no | safe-fix |
| `subprogram_body_201` | Checks a blank line below the is keyword. This rule allows the begin keyword to occupy the blank line: function overflow (a: integer)... | 3 | yes | formatter |
| `subprogram_body_202` | Checks blank lines above the begin keyword. This rule allows the is keyword to occupy the blank line: function overflow (a: integer)... | 3 | yes | formatter |
| `subprogram_body_203` | Checks a blank line below the begin keyword. | 3 | yes | formatter |
| `subprogram_body_204` | Checks blank lines above the end keyword. | 3 | yes | formatter |
| `subprogram_body_205` | Checks a blank line below the end of the function declaration. | 3 | yes | formatter |
| `subprogram_body_400` | Checks the alignment of the <= and := operators over consecutive sequential assignments in subprogram bodies. Following extra... | 5 | yes | formatter |
| `subprogram_body_401` | Checks the colons are in the same column for all attribute specifications. | 5 | yes | formatter |
| `subprogram_instantiation_001` | Checks the new subprogram identifier is on the same line as the procedure keyword. | 1 | yes | safe-fix |
| `subprogram_instantiation_002` | Checks the new subprogram identifier is on the same line as the function keyword. | 1 | yes | safe-fix |
| `subprogram_instantiation_003` | Checks the is keyword is on the same line as the new subprogram identifier. | 1 | yes | safe-fix |
| `subprogram_instantiation_004` | Checks the new keyword is on the same line as the is keyword. | 1 | yes | safe-fix |
| `subprogram_instantiation_005` | Checks the uninstantiated subprogram name is on the same line as the new keyword. | 1 | yes | safe-fix |
| `subprogram_instantiation_100` | Checks a single space between the procedure keyword and the new subprogram identifier. | 2 | yes | formatter |
| `subprogram_instantiation_101` | Checks a single space between the function keyword and the new subprogram identifier. | 2 | yes | formatter |
| `subprogram_instantiation_102` | Checks a single space between the new subprogram identifier and the is keyword. | 2 | yes | formatter |
| `subprogram_instantiation_103` | Checks a single space between the is keyword and the new keyword. | 2 | yes | formatter |
| `subprogram_instantiation_104` | Checks a single space between new keyword and the uninstantiated subprogram name. | 2 | yes | formatter |
| `subprogram_instantiation_500` | Checks the instantiated package name has proper case. | 6 | yes | formatter |
| `subprogram_instantiation_501` | Checks the is keyword has proper case. | 6 | yes | formatter |
| `subprogram_instantiation_502` | Checks the new keyword has proper case. | 6 | yes | formatter |
| `subprogram_instantiation_503` | Checks the uninstantiated subprogram name has proper case. | 6 | yes | formatter |
| `subprogram_kind_500` | Checks that the procedure keyword in subprogram kinds has the proper case. | 6 | yes | formatter |
| `subprogram_kind_501` | Checks that the function keyword in subprogram kinds has the proper case. | 6 | yes | formatter |
| `subtype_001` | Checks indentation of the subtype keyword. | 4 | yes | formatter |
| `subtype_002` | Checks consistent capitalization of subtype names. | 6 | yes | semantic |
| `subtype_004` | Checks valid prefixes in subtype identifiers. The default new subtype prefix is *st_*. | 7 | no | lint-only |
| `subtype_005` | Checks the identifier is on the same line as the subtype keyword. | 1 | yes | safe-fix |
| `subtype_006` | Checks the is keyword is on the same line as the identifier. | 1 | yes | safe-fix |
| `subtype_100` | Checks a single space before the identifier. | 2 | yes | formatter |
| `subtype_101` | Checks a single space before the is keyword. | 2 | yes | formatter |
| `subtype_102` | Checks a single space after the is keyword. | 2 | yes | formatter |
| `subtype_200` | Checks a blank line below a subtype declaration unless there is another subtype declaration. | 3 | yes | formatter |
| `subtype_201` | Checks blank lines or comments above the subtype declaration. | 3 | yes | formatter |
| `subtype_202` | Checks a blank line below the subtype declaration. | 3 | yes | formatter |
| `subtype_500` | Checks the subtype keyword has proper case. | 6 | yes | formatter |
| `subtype_501` | Checks the identifier has proper case. | 6 | yes | formatter |
| `subtype_502` | Checks the is keyword has proper case. | 6 | yes | formatter |
| `subtype_600` | Checks valid suffixes in subtype identifiers. The default new subtype suffix is *_st*. | 7 | no | lint-only |
| `type_001` | Checks the indent of the type declaration. | 4 | yes | formatter |
| `type_002` | Checks the type keyword has proper case. | 6 | yes | formatter |
| `type_004` | Checks the type identifier has proper case. | 6 | yes | formatter |
| `type_005` | Checks the indent of multiline enumerated types. | 4 | yes | formatter |
| `type_006` | Checks a single space before the is keyword. | 2 | yes | formatter |
| `type_007` | Checks a single space after the is keyword. | 2 | yes | formatter |
| `type_008` | Checks the closing parenthesis of multiline enumerated types is on its own line. | 1 | yes | safe-fix |
| `type_009` | Checks an enumerate type after the open parenthesis on multiline enumerated types. | 1 | yes | safe-fix |
| `type_010` | Checks blank lines or comments above the type declaration. | 3 | yes | formatter |
| `type_011` | Checks a blank line below the type declaration. | 3 | yes | formatter |
| `type_012` | Checks the indent of record elements in record type declarations. | 4 | yes | formatter |
| `type_013` | Checks the is keyword in type definitions has proper case. | 6 | yes | formatter |
| `type_014` | Checks consistent capitalization of type names. | 6 | yes | semantic |
| `type_015` | Checks valid prefixes in user defined type identifiers. The default new type prefix is *t_*. | 7 | no | lint-only |
| `type_016` | Checks the indent of the closing parenthesis on multiline types. | 4 | yes | formatter |
| `type_017` | Checks the identifier is on the same line as the type keyword. | 1 | yes | safe-fix |
| `type_018` | Checks the is keyword is on the same line as the identifier. | 1 | yes | safe-fix |
| `type_100` | Checks a single space before the identifier. | 2 | yes | formatter |
| `type_200` | Checks a blank line below a type declaration unless there is another type declaration. | 3 | yes | formatter |
| `type_400` | Checks the colons are in the same column for all elements in the block declarative part. | 5 | yes | formatter |
| `type_500` | Checks enumerate types have proper case. | 6 | yes | formatter |
| `type_501` | Checks consistent capitalization of enumerated types. | 6 | yes | semantic |
| `type_600` | Checks valid suffixes in user defined type identifiers. The default new type suffix is *_t*. | 7 | no | lint-only |
| `type_mark_500` | Checks that the type marks without declarations in the current file have proper case. | 6 | yes | formatter |
| `unbounded_array_definition_500` | Checks the array keyword has proper case. | 6 | yes | formatter |
| `unbounded_array_definition_501` | Checks the of keyword has proper case. | 6 | yes | formatter |
| `use_clause_001` | Checks packages that have been restricted by the user. | 7 | no | lint-only |
| `use_clause_500` | Checks the library name called out in the selected name has proper case. | 6 | yes | formatter |
| `use_clause_501` | Checks the package name called out in the selected name has proper case. | 6 | yes | formatter |
| `use_clause_502` | Checks the item name called out in the selected name has proper case. | 6 | yes | formatter |
| `use_clause_503` | Checks the all keyword called out in the selected name has proper case. | 6 | yes | formatter |
| `variable_001` | Checks the indent of variable declarations. | 4 | yes | formatter |
| `variable_002` | Checks the variable keyword has proper case. | 6 | yes | formatter |
| `variable_004` | Checks the variable name has proper case. | 6 | yes | formatter |
| `variable_005` | Checks there is a single space after the colon. | 2 | yes | formatter |
| `variable_006` | Checks at least a single space before the colon. | 2 | yes | formatter |
| `variable_007` | Checks default assignments in variable declarations. | 1 | no | safe-fix |
| `variable_011` | Checks consistent capitalization of variable names. | 6 | yes | semantic |
| `variable_012` | Checks valid prefixes on variable identifiers. The default variable prefix is *v_*. | 7 | no | lint-only |
| `variable_015` | Checks multiple (shared) variable names defined in a single (shared) variable declaration. By default, this rule will only flag more... | 1 | yes | safe-fix |
| `variable_017` | Checks the structure of variable constraints. | 1 | yes | safe-fix |
| `variable_100` | Checks a single space before the identifier. | 2 | yes | formatter |
| `variable_101` | Checks a single space after the shared keyword. | 2 | yes | formatter |
| `variable_102` | Checks a single space before the assignment. | 2 | yes | formatter |
| `variable_103` | Checks a single space after the assignment. | 2 | yes | formatter |
| `variable_400` | Checks alignment of multiline constraints in variable declarations. | 5 | yes | formatter |
| `variable_500` | Checks that the keyword shared has proper case. | 6 | yes | formatter |
| `variable_600` | Checks valid suffix on variable identifiers. The default variable suffix is *_v*. | 7 | no | lint-only |
| `variable_assignment_001` | Checks the indent of a variable assignment. | 4 | yes | formatter |
| `variable_assignment_002` | Checks a single space after the assignment. | 2 | yes | formatter |
| `variable_assignment_003` | Checks at least a single space before the assignment. | 2 | yes | formatter |
| `variable_assignment_004` | Checks the alignment of multiline variable assignments. | 5 | yes | formatter |
| `variable_assignment_006` | Checks comments in multiline variable assignments. | 2 | no | safe-fix |
| `variable_assignment_007` | Checks the structure of simple and conditional variable assignments. | 1 | yes | safe-fix |
| `variable_assignment_008` | Checks the structure of multiline variable assignments that contain arrays. | 1 | yes | safe-fix |
| `variable_assignment_400` | Checks alignment of multiline conditional variable assignments. | 5 | yes | formatter |
| `variable_assignment_401` | Checks the alignment of multiline variable assignments that contain arrays. | 5 | yes | formatter |
| `wait_001` | Checks indentation of the wait keyword. Proper indentation enhances comprehension. | 4 | yes | formatter |
| `wait_300` | Checks indentation of the label. Proper indentation enhances comprehension. | 4 | yes | formatter |
| `wait_500` | Checks the wait keyword has proper case. | 6 | yes | formatter |
| `wait_501` | Checks the on keyword has proper case. | 6 | yes | formatter |
| `wait_502` | Checks the until keyword has proper case. | 6 | yes | formatter |
| `wait_503` | Checks the for keyword has proper case. | 6 | yes | formatter |
| `when_001` | Checks the else keyword is not at the beginning of a line. The else should be at the end of the preceding line. | 1 | yes | safe-fix |
| `whitespace_001` | check for trailing spaces. | 1 | yes | formatter |
| `whitespace_002` | will check for the existence of tabs in the middle of a line. | 1 | yes | formatter |
| `whitespace_003` | Checks spaces before semicolons. | 2 | yes | formatter |
| `whitespace_004` | Checks spaces before commas. | 2 | yes | formatter |
| `whitespace_005` | Checks spaces after an open parenthesis. Spaces before numbers are ignored. This can be disabled by setting the... | 2 | yes | formatter |
| `whitespace_006` | Checks spaces before a close parenthesis. | 2 | yes | formatter |
| `whitespace_007` | Checks spaces after a comma. | 2 | yes | formatter |
| `whitespace_008`* | has been deprecated and replaced with rule `index_constraint_100 <index_constraint_rules.html#index_constraint-100>`_. | 2 | yes | formatter |
| `whitespace_010` | Checks spaces before and after the concatenate (&) operator. | 2 | yes | formatter |
| `whitespace_011` | Checks at least a single space before and after math operators +, -, /, * and . | 2 | yes | formatter |
| `whitespace_013` | Checks at least a single space before and after logical operators. | 2 | yes | formatter |
| `whitespace_100` | Checks at least a single space before and after relational operators. | 2 | yes | formatter |
| `whitespace_101` | Checks at least a single space before and after logical operators. | 2 | yes | formatter |
| `whitespace_200` | Enforces a maximum number of consecutive blank lines. | 3 | yes | formatter |
