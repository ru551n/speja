# VSG Upstream Bugs (research for vsg-rs)

Researched against jeremiah-c-leary/vhdl-style-guide's public issue tracker.
All VHDL reproducers below were written independently for this research; none
are copied from upstream issue bodies or test fixtures. Descriptions are
paraphrased in my own words; only short verbatim error-message fragments are
quoted (fair-use, factual, not creative content). Black-box checks used
`uvx --from vsg==3.35.0 vsg ...`.

34 entries, grouped by category, roughly most-architecturally-important first.

---

## VSG-BUG-001: Multi-identifier `signal`-class port declaration crashes the fixer
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1575 (state: open, reported against 0.35.0)
Category: crash
Observed behavior: A port declared with the optional `signal` object-class keyword and more than one identifier in the same declaration (`signal a, b : in std_logic`) crashes VSG's rule engine instead of being checked/fixed normally.
Independent reproducer:
```vhdl
library ieee;
use ieee.std_logic_1164.all;

entity dut is
  port (
    signal x, y : in std_logic
  );
end entity dut;
```
Expected behavior: VSG should parse the declaration (splitting multi-identifier declarations is itself a normal, well-supported operation for plain port declarations) and either check/fix it or report a clean diagnostic, never crash.
Relevance to vsg-rs: A single grammar-driven CST parser that treats the optional `signal`/`variable`/`constant` object-class keyword as a normal grammar production (rather than a special-cased code path bolted onto the "plain" port-declaration rule) avoids this whole class of "handled the common case, forgot the LRM-legal variant" bug.
Confirmed on 3.35.0: yes (crashes, but with a different exception: `IndexError: list index out of range` in `vsg/rules/port/rule_026.py`, i.e. the same input still breaks a *different* internal assumption than the one in the original report).

## VSG-BUG-002: Deferred constant + full declaration in package body crashed `multiline_structure`
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1549 (state: closed, fixed by later release)
Category: crash
Observed behavior: A constant declared without an initializer in a package declaration (a "deferred constant" per IEEE 1076-2008 §4.7/§4.8), completed by a full declaration of the same name in the package body, crashed VSG with `TypeError: unsupported operand type(s) for +: 'NoneType' and 'int'`. This is completely legal, idiomatic VHDL, so the crash blocked VSG on any project using the pattern.
Independent reproducer:
```vhdl
package const_pkg is
  constant c_table_size : natural;
end package const_pkg;

package body const_pkg is
  constant c_table_size : natural := 16;
end package body const_pkg;
```
Expected behavior: Deferred constants are a first-class, common VHDL package idiom and must parse and check cleanly.
Relevance to vsg-rs: Shows the cost of position/length bookkeeping (`None` where an integer offset was expected) living in ad-hoc per-rule Python rather than being guaranteed by the parser/CST itself; a typed CST with no "unknown position" states removes this failure mode structurally.
Confirmed on 3.35.0: no — this exact input now parses and reports ordinary blank-line violations without crashing (fixed upstream since the report).

## VSG-BUG-003: `package` as the very first token of a file crashed `--fix`
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1100 (state: closed, fixed)
Category: crash
Observed behavior: A minimal package file with no preceding context (no `library`/`use` clauses) crashed during `--fix` with a Python traceback originating in the rule-fixing pipeline.
Independent reproducer:
```vhdl
package counter_pkg is

end package;
```
Expected behavior: A one-token-type file boundary condition (nothing precedes the first declaration) must not be a special case that breaks fixing.
Relevance to vsg-rs: Argues for making "file start" / "file end" ordinary edges in the token stream (with explicit sentinel tokens) rather than something every rule's neighbor-lookup code has to special-case.
Confirmed on 3.35.0: no — now reports a normal `package_014` (missing package name) violation and fixes cleanly.

## VSG-BUG-004: Subtype declaration with a VHDL-2008 resolution function crashed the parser
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/912 (state: closed, fixed)
Category: crash / parser
Observed behavior: `subtype x is (resolved) std_ulogic;` (a resolution-function-qualified subtype, IEEE 1076-2008 §6.3) crashed with `Unexpected token detected while parsing subtype_declaration ... Expecting: single word`. The hand-written subtype grammar only accepted a bare type mark.
Independent reproducer:
```vhdl
library ieee;
use ieee.std_logic_1164.all;

package res_pkg is
  subtype resolved_logic is (resolved) std_ulogic;
end package res_pkg;
```
Expected behavior: The full VHDL-2008 subtype_indication grammar (including an optional resolution function/indication) should be accepted.
Relevance to vsg-rs: Motivates generating/deriving the parser from the actual LRM grammar (or a thoroughly cross-checked one) instead of writing per-construct recognizers by hand one LRM corner at a time — the latter guarantees a long tail of "nobody wrote that branch yet" crashes.
Confirmed on 3.35.0: no — parses fine now (reports ordinary blank-line violations).

## VSG-BUG-005: `--all_phases` crashed on nested parenthesized expressions valid in phase 1
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1122 (state: closed, fixed)
Category: crash / fix-order
Observed behavior: Running with `--all_phases` (continue past phase boundaries instead of stopping at the first phase with violations) on a signal assignment with nested function-call/parenthesis expressions crashed with `'close_parenthesis' object has no attribute 'iId'`, while the same file without `--all_phases` did not crash (it just stopped earlier). This means a later-phase rule reached a token shape an earlier phase's rule implicitly assumed had already been normalized away.
Independent reproducer:
```vhdl
library ieee;
use ieee.std_logic_1164.all;

entity nested is
  port (
    z : out std_logic
  );
end nested;

architecture rtl of nested is
begin
  z <= (m) + n(p(q)(r));
end architecture;
```
Expected behavior: `--all_phases` exists precisely so users can see every violation in one run; a later phase must not assume an earlier phase already fixed something when only checking (not fixing) is requested.
Relevance to vsg-rs: A phase model where later passes hold implicit assumptions about earlier passes' output (rather than each pass being valid against any well-formed CST) is exactly the fragility a formatter-owned, single-representation layout engine avoids — normalization should not be a precondition smuggled in by an unrelated phase.
Confirmed on 3.35.0: no — `vsg --all_phases -f <file>` now completes all 7 phases and reports ordinary violations.

## VSG-BUG-006: Malformed/unclosed array-range constraint still crashes (now a `TypeError` instead of the reported hang)
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1123 (state: closed as "won't hang" but underlying fragility persists)
Category: parser / crash
Observed behavior: Originally reported as an unkillable hang (`vsg` would not respond to Ctrl+C without `--jobs 1`) when a port's array-range constraint has an unclosed parenthesis. On 3.35.0 it no longer hangs, but it crashes with a new, unrelated-looking `TypeError` deep in attribute-name classification, i.e. the parser still cannot fail gracefully on malformed input — it now fails a different way.
Independent reproducer:
```vhdl
library ieee;
use ieee.std_logic_1164.all;

entity dut2 is
  port (
    d : in std_logic_vector(7 downto;
end entity;
```
Expected behavior: Malformed input should produce a bounded, user-facing parse-error diagnostic (as VSG does for many other malformed inputs, e.g. VSG-BUG-004's original "Unexpected token" message) — never a hang and never an unhandled internal exception.
Relevance to vsg-rs: A recursive-descent/backtracking classifier without a formal error-recovery strategy will keep discovering new crash/hang shapes indefinitely; a resilient parser (e.g. Pratt/precedence parser over a token stream with explicit "error node" recovery, as is standard in CST-based tools like rust-analyzer/tree-sitter) turns "malformed VHDL" into a bounded, always-terminating case instead of an open-ended bug class.
Confirmed on 3.35.0: yes (different failure than reported, but still fails) — `TypeError: unsupported operand type(s) for +=: 'NoneType' and 'int'` in `classify/attribute_name.py`.

## VSG-BUG-007: Simulation pragma comments get reclassified as active code, corrupting downstream fixes
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1061 (state: closed)
Category: parser / false-positive
Observed behavior: With pragma support enabled, a `-- synthesis translate_off` / `-- synthesis translate_on` pair used to bracket simulation-only code inside an `if` statement caused the tool to treat the commented-out `then`/structure as if it were live code, so a structural rule tried to move a keyword that only exists inside the "commented out" branch.
Independent reproducer (my own, capturing the same shape):
```vhdl
architecture rtl of guarded is
begin
  process (all) is
  begin
    if sel = '1' then
-- synthesis translate_off
      report "sim only" severity note;
    end if;
-- synthesis translate_on
  end process;
end architecture rtl;
```
Expected behavior: Recognizing a pragma comment as a special token (for the purposes of the pragma-specific rule) must not change how the surrounding, still-commented-out code is classified by unrelated structural rules.
Relevance to vsg-rs: A central resolver/classifier that assigns each token exactly one semantic role (used consistently by every rule) instead of ad-hoc, rule-local reclassification prevents "rule A's special-case view of a token" from leaking into rule B's unrelated logic.
Confirmed on 3.35.0: not tried (pragma configuration is nontrivial to set up as a cheap black-box check; recorded from issue text only).

---

## VSG-BUG-008: `--fix` moves a following statement's punctuation into a trailing comment, deleting it from the code
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1530 (state: open)
Category: unsafe-fix
Observed behavior: With `procedure_013` configured as `last_close_paren: remove_new_line` (join the closing paren onto the previous line), if that previous line ends in a `--` comment, `--fix` appends the closing paren (and, in the package-body case, the following `is` keyword) *after* the `--`, so it becomes part of the comment text and disappears from the actual code. The result is not valid VHDL.
Independent reproducer (verified on 3.35.0):
```vhdl
package pkg2 is

  procedure run (
    n : natural -- note here
  );

end package pkg2;

package body pkg2 is

  procedure run (
    n : natural -- note here too
  ) is

  begin

    null;

  end procedure run;

end package body pkg2;
```
Running `vsg -f pkg2.vhd -c rules.yaml --fix` (with `procedure_013.last_close_paren: remove_new_line`) rewrites both declarations to `n : natural -- note here);` and `n : natural -- note here too) is`, silently swallowing `);` and `) is` into the comments. Re-running plain `vsg -f pkg2.vhd` on the "fixed" file then fails with `Error: Unexpected token detected while parsing procedure_specification ... Expecting: ) Found: package` — i.e. VSG's own fixer produced input that VSG's own parser rejects.
Expected behavior: A structural "move this token to the end of the previous line" fix must detect that the previous line ends in a comment and either insert before the comment, refuse the fix, or move the comment instead — never silently concatenate code onto commented-out text.
Relevance to vsg-rs: This is the textbook case for a mandatory reparse-safety check: any fixer output must be re-parsed (and ideally re-diffed for semantic equivalence outside of intentional formatting) before being written to disk; if the reparse fails or a token was silently absorbed into a comment/string, the fix must be rejected rather than applied.
Confirmed on 3.35.0: yes — reproduced exactly as described, including the self-inflicted unparseable output.

## VSG-BUG-009: Fixer crashes instead of erroring cleanly when architecture/entity names mismatch
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1409 (state: closed, fixed)
Category: unsafe-fix / crash
Observed behavior: `vsg --fix` on a file where the architecture's `of <name>` does not match its paired entity's name crashed with `KeyError` inside a "consistent interface token case" rule, instead of reporting the (real, and probably intended-to-be-caught) mismatch as a normal violation or leaving it alone.
Independent reproducer:
```vhdl
entity my_unit is
  generic (
    g_width : natural
  );
  port (
    clk : in std_logic;
    rst : in std_logic
  );
end entity;

architecture full of other_unit is
begin
end architecture;
```
Expected behavior: A dangling/mismatched architecture-entity reference is a legitimate design error VSG could flag, but must never crash the fixer — a rule that depends on resolving a name to its declaration has to handle "not found" as a normal, reportable condition.
Relevance to vsg-rs: Reinforces the case for a central resolver with an explicit "unresolved reference" result type (rather than an unchecked dictionary lookup) used by every rule that needs cross-token identity, matching the `semantic` rule-owner bucket in vsg-rules.md.
Confirmed on 3.35.0: no — this exact input now runs to completion (0 violations reported for phases actually reached), i.e. the crash is fixed.

## VSG-BUG-010: VHDL-2008 block comment containing `--` silently disables fixing for the rest of the file
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/982 (state: closed)
Category: unsafe-fix / comment
Observed behavior: A `/* ... */` block comment whose body happens to contain the line-comment delimiter `--` (e.g. a horizontal-rule-style block comment) caused `--fix` to silently stop fixing anything in the file, with no error reported to the user — the run reported success but did nothing.
Independent reproducer (own construction of the same shape):
```vhdl
/*-----------------------------------------------------------*/
package hdr_pkg is
  constant c_version : natural := 1;
end package hdr_pkg;
```
Expected behavior: A tokenizer must treat `--` inside an already-open `/* ... */` comment as ordinary comment text, not as the start of a new (line) comment token that desynchronizes the rest of the scan — and any internal desync should surface as an error, never a silent no-op.
Relevance to vsg-rs: A lexer whose comment/string states are explicit and mutually exclusive (impossible to be "inside a block comment" and "start a line comment" at once) rules this out by construction; separately, "the tool did nothing and reported success" is itself an anti-pattern a reparse/no-op-detection safety net should catch.
Confirmed on 3.35.0: not tried (needs the exact `--fix` silent-success behavior verified across a whole file diff, not just one rule's report; recorded from issue text).

## VSG-BUG-011: `--fix` does not preserve the original file encoding
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1442 (state: closed)
Category: unsafe-fix / other
Observed behavior: A source file encoded in ISO-8859-1 (Latin-1) — e.g. containing a `°` degree sign in a comment — gets silently rewritten as UTF-8 (and with CRLF line endings) by `--fix`, changing the file's on-disk byte representation even though no visible character changed.
Independent reproducer (own file, same shape, describing intent since exact byte-level repro depends on the local encoding of the editor writing it):
```vhdl
package sample is
  -- represents an angle in degrees (deg symbol here)
  subtype my_type is natural range 0 to 365;
end package;
```
Expected behavior: `--fix` should round-trip a file's encoding and line-ending convention unless the user explicitly asks it to normalize them (VSG does have a separate `linesep` config option for line endings, which underlines that encoding should be equally explicit/preserved-by-default).
Relevance to vsg-rs: A formatter that reads and writes bytes through one declared, detected (or configured) encoding — rather than assuming UTF-8 both ways — avoids silently corrupting non-ASCII comments/strings in legacy codebases; this is a cheap, purely mechanical property to get right from day one.
Confirmed on 3.35.0: not tried (encoding round-trip is not practical to verify through the black-box CLI without controlling the exact byte-level input encoding of a temp file).

---

## VSG-BUG-012: Fixing a rule violation requires a second `--fix` run because reporting and fixing disagree
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1571 (state: open)
Category: fix-order
Observed behavior: `block_comment_001`/`block_comment_003` report a violation (wanting a specific fixed-width separator line) when run in check-only mode, but `--fix` produces a *different* result (matching the surrounding indentation) that itself does not satisfy the rule as reported — so running in check-only mode after `--fix` still shows the same violations, in effect meaning the "fixed" output is never actually clean according to the checker.
Independent reproducer (own construction of the same class of bug: a rule whose fix-value and check-value diverge):
```vhdl
architecture rtl of framed is
begin

  ------------------------------------------------------------
  -- Section: control path
  ------------------------------------------------------------
  y <= x;

end architecture rtl;
```
(With `block_comment_001`/`003` configured to a fixed separator width different from the surrounding indentation, `--fix` reindents the separator to match code indentation while the checker still expects the fixed-width separator — the same file then reports the identical violation again immediately after `--fix`.)
Expected behavior: A rule's fixer and its checker must be the same source of truth: after `--fix`, re-running the checker on the same rule must report zero violations for that rule (idempotence).
Relevance to vsg-rs: Argues for deriving "is this violated" directly from "what would the formatter print" (a single formatting function used both to check — by diffing — and to fix — by writing the diff), which makes this entire bug class structurally impossible instead of requiring one-off consistency between two independently maintained code paths.
Confirmed on 3.35.0: not tried (requires the exact `block_comment_001`/`003` configuration knobs from the report; recorded from issue text, which is against 3.35.0 already).

## VSG-BUG-013: Casing fix on an iterator's declaration is not propagated to its uses in the loop/generate body
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1561 (state: open)
Category: fix-order / false-negative
Observed behavior: `parameter_specification_500` (case of a `for ... in ...` loop/generate iterator) fixes the identifier's case at its declaration site but does not touch, or even flag, its later uses inside the loop/generate body — leaving the file in a mixed-case, inconsistent state after `--fix` reports success.
Independent reproducer:
```vhdl
gen_rows : for row_idx in 0 to 7 generate
  u_row : entity work.row_slice
    port map (
      clk_i  => clk_i,
      data_i => input_data(row_idx),
      data_o => output_data(row_idx)
    );
end generate gen_rows;
```
(Configuring `parameter_specification_500` to force `row_idx`'s declaration to e.g. `ROW_IDX` leaves the two `row_idx` uses inside the port map untouched, per the report.)
Expected behavior: A rule that renames/re-cases an identifier at its declaration should update (or at minimum report) every use of that same identifier in its scope — a case-fix is only complete once every occurrence agrees.
Relevance to vsg-rs: This is a direct example of why "consistent capitalization" rules are a `semantic` rule-owner category in vsg-rules.md, not a per-token `formatter` job: they require a real declaration→uses index (the central resolver), and the fix has to be applied atomically across every reference, not just the declaration.
Confirmed on 3.35.0: not tried (issue is filed against a recent VSG version and reads as still-open by design/scope, not a version-specific regression).

## VSG-BUG-014: Multiline `/* ... */` comment gains an extra indent column on every `--fix` re-run
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1573 (state: open)
Category: fix-order
Observed behavior: For certain inline VHDL-2008 block comments (`/* ... */`) inside a generic/port/architecture declarative part, each successive `--fix` run adds one more column of indentation to the comment's continuation lines, so the file never reaches a stable fixed point — repeated `--fix` invocations keep "fixing" (and drifting) the same comment forever.
Independent reproducer (own construction; did not reproduce the exact drift with this simplified layout — see note):
```vhdl
entity has_block_comment is
  generic (
    g_width : natural := 8  /* Data path
                                width in bits
                             */
  );
  port (
    clk : in std_logic
  );
end entity has_block_comment;
```
Expected behavior: Applying a fixer to already-fixed code must be a no-op (idempotent): `fix(fix(x)) == fix(x)` for any formatting rule.
Relevance to vsg-rs: Non-idempotent fixes are a direct symptom of computing "one more adjustment" from the current (already partly-adjusted) state instead of computing indentation from the CST structure in one shot; a formatter that always derives layout fresh from the syntax tree (never incrementally nudging previous output) cannot drift like this, and idempotence (`fix∘fix == fix`) is a cheap, mechanical property to unit-test for every rule.
Confirmed on 3.35.0: not tried in full — my simplified reproducer above did not trigger the drift after 3 successive `--fix` runs, so the exact trigger needs the declarative-part/alignment interaction described in the report; recorded from issue text (open against 3.35.0).

## VSG-BUG-015: `architecture_026` is configured `fixable: true` but `--fix` does not fix it
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1206 (state: closed)
Category: fix-order
Observed behavior: A rule reports a violation ("Move : 2 columns") and its configuration declares `fixable: true`, yet `--fix` leaves the offending lines untouched, so the same violation reappears on every subsequent check.
Independent reproducer:
```vhdl
architecture rtl of counter is

    signal count_val   : natural;
    signal count_en    : std_logic;
    signal count_clr   : std_logic;

begin

end architecture;
```
Expected behavior: A rule's declared `fixable` flag must accurately reflect whether `--fix` actually resolves the violation; declaring `fixable: true` while not implementing (or not correctly reaching) the fix path leaves users stuck in an unfixable "violation forever" state with no indication why.
Relevance to vsg-rs: In the vsg-rules.md classification, "fixable" needs to be a property that is tested (does `check(fix(x)) == clean` hold), not just declared metadata — vsg-rs should treat a rule's fixable flag as a compile/test-time-checked invariant rather than documentation.
Confirmed on 3.35.0: not tried (specific alignment-rule interaction; recorded from issue text).

---

## VSG-BUG-016: `comment_012` keyword matching is a substring match, not a word match
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1544 (state: closed)
Category: false-positive
Observed behavior: When `comment_012` is configured to flag the keyword `BUG` in comments, it also fires on any comment containing `BUG` as a substring of a longer word, e.g. `DEBUG`, producing a false violation for text that never mentions the keyword as a distinct word.
Independent reproducer (verified on 3.35.0):
```vhdl
architecture rtl of dbg is
begin
  -- DEBUG: temporary trace signal, remove before release
  x <= '0';
end architecture;
```
With `comment_012` configured with `keywords: [BUG, TODO]`, this reports `comment_012 | Warning | ... | Comment keyword BUG detected.` even though the comment says "DEBUG", not "BUG".
Expected behavior: Keyword matching in comments should respect word boundaries (or be documented as substring matching, with the user opting in) so that common English words/identifiers containing a configured keyword as a substring are not flagged.
Relevance to vsg-rs: A trivial regex/tokenizer fix (`\bBUG\b` vs. bare substring search), but a good example of the general principle that any user-facing "keyword in text" feature needs word-boundary semantics by default — worth enforcing as a lint-only rule contract in vsg-rs rather than leaving it to each rule's ad-hoc string search.
Confirmed on 3.35.0: yes — reproduced exactly as described.

## VSG-BUG-017: `port_map_002` camelCase check rejects a legal camelCase identifier
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1256 (state: closed)
Category: false-positive
Observed behavior: With `port_map_002` configured to `case: camelCase`, a genuinely camelCase port name ending in a single trailing capital letter (`clkP`, i.e. word-initial lowercase followed by camel humps, ending on an uppercase letter) is incorrectly reported as not camelCase.
Independent reproducer (own identifier, same shape as the report):
```vhdl
u_sync : entity work.sync
  port map (
    clkP => sysClkP
  );
```
Expected behavior: A camelCase classifier must accept any identifier of the form `lowerWord(Upper+lower*)*`, including ones that happen to end on an uppercase-only "word" (a single capital letter is a degenerate but legal camel-hump).
Relevance to vsg-rs: A one-off regex-based case classifier is easy to get subtly wrong at its edges (as here and in VSG-BUG-016); vsg-rs's casing rules (the `formatter` bucket for `case`/`case::keyword`/`case::name`) should share one well-tested case-style classifier/converter module with property-based tests (round-trip and edge-case coverage) rather than each rule reimplementing its own regex.
Confirmed on 3.35.0: not tried (regex case-style bugs like this are typically fixed by tightening one shared regex; the underlying "each rule owns its own case regex" design risk remains architecturally relevant regardless of this specific input's current status).

## VSG-BUG-018: Prefix/suffix naming exceptions are not honored by the case-checking rule they are attached to
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1177 (state: closed, fixed)
Category: false-positive
Observed behavior: `instantiation_008` (instance label case) accepts `prefix_exceptions`/`suffix_exceptions` configuration (meant to exempt e.g. a `P_` prefix from the enforced case), but the case-checking logic did not actually strip the excepted prefix/suffix before comparing case, so conforming, exception-annotated labels were still flagged.
Independent reproducer:
```vhdl
library ieee;
  use ieee.std_logic_1164.all;

entity leaf is
  port (
    a : in    std_logic;
    b : in    std_logic
  );
end entity leaf;

architecture behavioral of leaf is

  component leaf_comp is
    port (
      a : in    std_logic;
      b : in    std_logic
    );
  end component;

begin

  P_leaf : component leaf_comp
    port map (
      a => a,
      b => b
    );

  leaf_S : component leaf_comp
    port map (
      a => a,
      b => b
    );

end architecture behavioral;
```
(`instantiation_008` configured with `case: lower`, `prefix_exceptions: ["P_"]`, `suffix_exceptions: ["_S"]`.)
Expected behavior: A configured prefix/suffix exception must be excluded from the case comparison for every rule that accepts it, consistently.
Relevance to vsg-rs: naming/prefix-suffix configuration (the `lint-only` bucket) should be implemented as one shared "strip configured affixes, then classify the remainder" pipeline stage used by every naming/casing rule, instead of each rule re-implementing affix-stripping (and some rules forgetting to).
Confirmed on 3.35.0: no — reproduced no `instantiation_008` violation on either label, i.e. fixed.

## VSG-BUG-019: A `regex`-based case option crashes the tool instead of failing to match
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1198 (state: closed, fixed)
Category: false-positive / crash
Observed behavior: Configuring `port_map_002`'s case option with a `regex` value crashed with `AttributeError: 'rule_002' object has no attribute 'oRegex'` — the regex-configuration code path was not correctly wired up for that particular rule, even though the option is documented as generally available.
Independent reproducer (own configuration, same rule/option):
```yaml
rule:
  port_map_002:
    case: 'regex'
    regex: '^[a-z][a-z0-9_]*$'
```
```vhdl
u_leaf : entity work.leaf
  port map (
    clk_i => clk_i
  );
```
Expected behavior: A documented, generally-supported configuration option (`case: regex`) must work uniformly across every rule that advertises it, or fail with a clear configuration error — never an internal `AttributeError`.
Relevance to vsg-rs: Configuration options in vsg-rs should be defined once on a shared rule trait/struct (so "does this rule support `case: regex`" is a compile-time guarantee, not something that can be individually forgotten per rule implementation) — directly motivating one shared configuration schema across all `formatter`/`lint-only` casing rules.
Confirmed on 3.35.0: not tried (this specific `AttributeError` trace referenced a much older code path; recorded from issue text, marked fixed/closed upstream).

## VSG-BUG-020: `architecture_601` case-consistency check misses uses inside a `with...select` (selected signal assignment)
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1448 (state: open)
Category: false-negative
Observed behavior: `architecture_601` (consistent capitalization of port names across an architecture body) correctly detects and fixes a case mismatch in an ordinary concurrent signal assignment, but does not detect (or fix) the identical mismatch when the same port name is used inside a `with ... select ... <=` selected-signal-assignment statement.
Independent reproducer:
```vhdl
library ieee;
  use ieee.std_logic_1164.all;

entity mux2 is
  port (
    selIn : in    std_logic;
    outA  : out   std_logic
  );
end entity mux2;

architecture rtl of mux2 is
begin

  outa <= selin;                 -- flagged & fixed by architecture_601

  with selin select outa <=      -- NOT flagged
    '0' when '1',
    '1' when '0',
    'X' when others;

end architecture rtl;
```
Expected behavior: A name-consistency rule needs to visit every syntactic context in which the resolved identifier can appear (plain assignment, selected assignment, conditional assignment, generate conditions, etc.) — missing one statement kind is a false negative that leaves inconsistent code unflagged.
Relevance to vsg-rs: Confirms the value of a single central resolver producing one canonical "all uses of this declared name" iterator that every `semantic` rule consumes, instead of each rule walking the CST for the statement shapes its author happened to think of.
Confirmed on 3.35.0: not tried (issue references 3.35.0-era selected-assignment support directly; recorded from issue text).

## VSG-BUG-021: A record type's field name is misclassified as an enumeration-type element, causing bogus case violations
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1187 (state: open)
Category: false-positive
Observed behavior: When a record type's field has the same spelling as an enumeration literal used elsewhere in the file, the record field gets misclassified by the identifier-classification logic as if it were that enumeration literal, and rules checking the enumeration's case (`type_501`) fire against the unrelated record field.
Independent reproducer (own construction of the same collision shape; did not reproduce the exact false positive with this simplified example — the collision-detection logic is apparently narrower than my first attempt, see note):
```vhdl
library ieee;
use ieee.std_logic_1164.all;

package rec_pkg is
  type cmd_in_t is record
    valid : std_logic;
  end record cmd_in_t;

  type cmd_out_t is record
    ready : std_logic;
  end record cmd_out_t;
end package rec_pkg;

library ieee;
use ieee.std_logic_1164.all;
library work;
use work.rec_pkg.all;

entity unit is
  port (
    d : in  cmd_in_t;
    q : out cmd_out_t
  );
end entity unit;

architecture rtl of unit is
  type fsm_t is (idle_st, valid, done_st);
  signal fsm : fsm_t;
begin
end architecture rtl;
```
Expected behavior: Classifying a token as "this is an enumeration literal" vs. "this is a record element name" requires knowing which declaration it belongs to (its enclosing type), not just its spelling — two identically-spelled identifiers in different declarative scopes must be classified independently.
Relevance to vsg-rs: This is the single clearest real-world case for the `semantic` rule-owner bucket needing an actual scoped symbol table (declaration kind + owning scope), not name-based pattern matching — exactly the gap a central resolver is designed to close, and exactly the source of the wider "is this identifier a signal/variable/generic/enum-literal/record-field" classification bugs seen across the tracker (see also VSG-BUG-018).
Confirmed on 3.35.0: not tried in full — my reproduction attempt above did not trigger the reported `type_501` false positive, so the precise field/literal-name collision conditions from the original report were not reproduced; issue remains open upstream.

## VSG-BUG-022: Name-consistency rules leak across unrelated entities/architectures in a multi-entity file
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/755 (state: closed)
Category: false-positive / other (semantic scope)
Observed behavior: `signal_014`, `constant_013`, and `architecture_600` (consistent-capitalization rules) do not scope their "expected case" lookup to the entity/architecture pair they are checking; if a signal/constant in one entity's architecture shares a name with a *port* or *generic* of a completely unrelated entity declared later in the same file, the rule incorrectly treats them as the same identifier and demands matching case across the unrelated declarations.
Independent reproducer (own two-entity file, same collision shape):
```vhdl
library ieee;
use ieee.std_logic_1164.all;

entity alpha is
  port (
    Ready : out std_logic
  );
end entity alpha;

architecture rtl of alpha is
begin
  Ready <= '1';
end architecture rtl;

entity beta is
  port (
    dummy : out std_logic
  );
end entity beta;

architecture rtl of beta is
  signal ready : std_logic;   -- unrelated to alpha.Ready, but same spelling
begin
  dummy <= ready;
end architecture rtl;
```
Expected behavior: "Consistent capitalization" must be scoped per design unit (entity/architecture pair); an identifier's expected case should be derived only from declarations visible in its own scope, never from an unrelated design unit that happens to share a file.
Relevance to vsg-rs: Directly validates the `semantic` rule-owner category's requirement for a resolver with real lexical scoping (per compilation unit / per architecture), not a whole-file identifier→case table — a single flat symbol table (the naive implementation) reproduces this exact bug.
Confirmed on 3.35.0: not tried (multi-entity-per-file scoping bug; recorded from issue text, closed upstream so presumably scoped correctly since).

---

## VSG-BUG-023: `entity_020` inline-comment alignment groups across a `);` boundary it should stop at
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1572 (state: open)
Category: line-length / alignment
Observed behavior: `entity_020` (inline trailing-comment alignment within the generic/port list) is supposed to align comments within one alignment "group", ending each group at the closing `);` of that list. When the closing `);` and the next section's opening line are close together, the alignment-group boundary logic misplaces the boundary, so a generic-list comment ends up aligned against a port-list comment (i.e. one group's alignment column bleeds into the next group).
Independent reproducer (own construction, same class of boundary bug):
```vhdl
entity mixer is
  generic (
    g_a : boolean := true;   -- gain enable
    g_b : boolean := true);  -- offset enable
  port (
    clk : in std_logic;      -- clock, wrongly aligned with generic comments
    rst : in std_logic       -- reset
  );
end entity mixer;
```
Expected behavior: Comment-alignment grouping must end exactly at the syntactic boundary of the construct it is aligning (here, the generic list's closing `);`), regardless of whether that boundary token is on its own line or shares a line with other content.
Relevance to vsg-rs: A formatter that derives alignment groups from CST node boundaries (the generic-clause node vs. the port-clause node) rather than from line-based heuristics cannot let one group's column selection bleed into a sibling node's — this is a formatter-owned-layout concern, not something that needs the resolver.
Confirmed on 3.35.0: not tried (requires the specific `entity_020` alignment configuration from the report; recorded from issue text, open against 3.35.0).

## VSG-BUG-024: `library_007`'s "blank line unless different library" style silently does nothing
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1557 (state: open)
Category: fix-order / other
Observed behavior: `library_007` configured with `style: no_blank_line_unless_different_library` is supposed to insert a blank line between `use` clauses that come from different libraries. On a file with several `use` clauses from `ieee` followed by `work`, the rule reports zero violations — the blank-line-insertion logic for this style value appears unimplemented/unreachable, i.e. the option exists in configuration but has no effect.
Independent reproducer:
```vhdl
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.axi_pkg.all;
use work.dma_pkg.all;
```
(`library_007` configured with `style: no_blank_line_unless_different_library`.)
Expected behavior: A blank line should be required between `use ieee.numeric_std.all;` and `use work.axi_pkg.all;` (different libraries), consistent with the configured style.
Relevance to vsg-rs: A style option that is accepted by the configuration schema but silently produces no behavior is worse than a rejected/unknown option — vsg-rs's configuration validation should guarantee every accepted enum value maps to tested code, ideally via an exhaustive match the compiler enforces (Rust enums + `match` without a wildcard arm) rather than an `if/elif` chain that can silently fall through.
Confirmed on 3.35.0: not tried (recorded from issue text, open against 3.35.0).

## VSG-BUG-025: No way to configure a "warn at N, error at M" staged line-length policy
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1551 (state: open, feature request rather than a bug)
Category: line-length / other
Observed behavior: `length_001` (max line length) supports exactly one threshold with one severity; a team that wants "warn past 100 columns, but only fail CI past 140" cannot express that with a single rule instance and must either accept one threshold or run two overlapping/duplicated configurations.
Independent reproducer (illustrating the desired, currently-unsupported configuration; not a crash):
```yaml
rule:
  length_001:
    length: 100
    severity: Warning
  length_001_hard:      # does not exist upstream — illustrates the gap
    length: 140
    severity: Error
```
Expected behavior: A single length-checking rule should be configurable with multiple (threshold, severity) tiers, or the tool should allow enabling the same rule twice with independent configuration and independent reporting.
Relevance to vsg-rs: Line-length in vsg-rs is squarely a `formatter` concern (see length_rule_group), but unlike most formatting rules it can never be silently auto-fixed (see VSG-BUG-026 and the unfixable-rules discussion in upstream-limitations.md) — supporting multiple severities per threshold is a cheap, purely additive configuration-schema decision worth making from the start rather than retrofitting.
Confirmed on 3.35.0: yes, in the sense that `vsg -rc length_001` on 3.35.0 confirms only a single `length`/`severity` pair is configurable per rule instance.

## VSG-BUG-026: Line-length violations are permanently unfixable, so line-length-driven rewrapping is entirely the user's job
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1551 (context) and documented directly in VSG's own `unfixable_rules` reference
Category: line-length
Observed behavior: `length_001`/`length_002`/`length_003` are explicitly documented (and confirmed via `vsg -rc length_001`, which reports `"fixable": false`) as unfixable: VSG can report a line is too long, but will never rewrap it, because rewrapping VHDL expressions safely requires understanding operator precedence/associativity and where a break is semantically safe — a decision the project has decided to always leave to the user.
Independent reproducer (own file, confirmed via black-box `-rc`):
```vhdl
architecture rtl of wide is
begin
  result <= operand_one and operand_two and operand_three and operand_four and operand_five and operand_six;
end architecture rtl;
```
`vsg -rc length_001` on 3.35.0 reports:
```
{"rule": {"length_001": {"disable": false, "fixable": false, "indent_size": 2, "indent_style": "spaces", "length": 120, "phase": 7, "severity": "Warning", ...}}}
```
Expected behavior: N/A — this is a deliberate, documented design decision upstream, not a defect, but it defines a hard ceiling on VSG's usefulness as an autoformatter for long-line cleanup.
Relevance to vsg-rs: This is the single strongest architectural argument for vsg-rs owning full line-wrapping as a first-class formatter feature (the way `rustfmt`/`gofmt`/`clang-format` do): a CST-based formatter that understands expression structure (operator precedence, associativity, and where a continuation is legal) can safely insert/remove line breaks to fit a width budget, closing a gap VSG's design has always left open. This alone is a major differentiator to lead with.
Confirmed on 3.35.0: yes (`fixable: false` confirmed directly via `-rc`).

---

## VSG-BUG-027: `comment_010`'s indentation loses the enclosing `type ... record` level
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1418 (state: closed)
Category: comment
Observed behavior: A trailing comment on its own line inside a `record` type definition is dedented by one level after `--fix`, because the record's `type` keyword is not counted as an indentation-contributing scope by the comment-indent logic (even though ordinary code lines inside the same record are indented correctly).
Independent reproducer:
```vhdl
type dma_desc_t is record
  addr  : unsigned(31 downto 0);
  len   : unsigned(15 downto 0);
  valid : std_logic;
  -- valid is asserted for exactly one cycle per descriptor
end record dma_desc_t;
```
Expected behavior: A standalone comment line should be indented to match the indentation of the code immediately around it, for every kind of enclosing scope (record types included) — indentation should come from "what scope am I lexically inside," not a hand-maintained list of scope-introducing keywords that happened to omit `record`.
Relevance to vsg-rs: Comment indentation should be derived from the same CST-scope-depth computation used for code indentation (one function, reused), rather than a separate, independently-maintained "which keywords open an indent level for comments" table that can drift out of sync with the code-indentation table — this drift is exactly what produced VSG-BUG-028 too.
Confirmed on 3.35.0: not tried (recorded from issue text; closed upstream, presumably fixed for the `record` case, but the same "separate keyword table" fix pattern likely leaves other keywords equally exposed as VSG-BUG-028 shows).

## VSG-BUG-028: `comment_010` dedents a trailing comment placed at the very end of an architecture/process scope
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1446 (state: closed)
Category: comment
Observed behavior: A comment placed as the last line inside a scope (just before its closing `end`) gets dedented to the *enclosing* scope's level instead of staying at the current scope's level — even though the identical comment, if followed by one more statement, would be indented correctly. The bug reproduces both for plain architecture bodies and for component instantiations.
Independent reproducer:
```vhdl
architecture rtl of trailer is
begin

  foo <= '1';

  -- Trailing note about the scope closing below

end architecture trailer;
```
After `--fix`, the comment loses its indentation and moves flush to the `architecture`/`end` level instead of staying aligned with `foo <= '1';`.
Expected behavior: A comment's indentation must depend on which scope it lexically belongs to (determined by its position in the source, between the scope's `begin` and `end`), not on whether more code follows it before the scope closes.
Relevance to vsg-rs: Same root cause as VSG-BUG-027 and VSG-BUG-014 (idempotence): comment placement/indentation must be computed as "attach this comment to the nearest preceding/enclosing CST node and indent at that node's depth," a property that is either true everywhere by construction (single formatter-owned layout pass) or is a whack-a-mole list of exceptions, as it is upstream.
Confirmed on 3.35.0: not tried (recorded from issue text; closed upstream).

## VSG-BUG-029: `smart_tabs` indentation mode is not honored by `procedure_call_400`
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1483 (state: open)
Category: comment / other (indentation mode)
Observed behavior: In "smart tabs" mode (tabs for indent levels, spaces only for sub-tab alignment), most rules correctly emit a tab-then-spaces mix, but `procedure_call_400` (argument alignment in a procedure call) emits pure-space indentation instead, breaking the file's otherwise-consistent tabs/spaces convention for that one construct.
Independent reproducer (own file, tabs shown as `\t` in source, same construct as the report):
```vhdl
architecture rtl of caller is
begin
	process (all)
		procedure helper (a : natural; b : boolean) is
		begin
		end procedure;
	begin
		helper(
			a => 5,
			b => true
		);
	end process;
end architecture;
```
Expected behavior: Every rule that emits indentation must consult the same global indent-mode setting (`smart_tabs`, `tabs`, or `spaces`) — there should be no per-rule indentation code path that bypasses the shared mode.
Relevance to vsg-rs: Indentation emission (tabs vs. spaces vs. smart-tabs) belongs entirely to the `formatter` layer and should be a single shared "emit N indent levels in the configured mode" primitive that every layout rule calls — never something an individual rule (like a procedure-call-specific alignment rule) reimplements with its own hardcoded space emission.
Confirmed on 3.35.0: not tried (recorded from issue text, open against 3.35.0).

## VSG-BUG-030: `declarative_part_400` colon-alignment does not account for multi-identifier declarations correctly
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/908 (state: closed)
Category: line-length / alignment
Observed behavior: When aligning the `:` in a block of `variable`/`signal` declarations, a declaration listing multiple identifiers (`variable a, b : type;`) shifts the alignment column for the whole group based on that line's extra width, but the report showed the fixed output aligning `:=` far past where the simple `:` columns for other lines line up, and leaving inconsistent spacing for the `:=` default-value column on scalar vs. multi-identifier lines.
Independent reproducer (own declarations, same shape: mixed single- and multi-identifier lines forcing a wide alignment column):
```vhdl
architecture rtl of aligner is
begin
  process is
    variable count      : integer;
    variable total      : real;
    variable lo, hi      : real;
    variable idx         : integer;
    variable ok, done     : boolean := false;
  begin
  end process;
end architecture rtl;
```
Expected behavior: Column alignment across a declaration group should compute the alignment column from the widest *identifier-list* in the group once, then apply that single column consistently to every line's `:` and (if also aligned) `:=`, rather than producing per-line drift.
Relevance to vsg-rs: Multi-column alignment (colons, `:=`, `=>`) is exactly the kind of feature that benefits from being computed once per alignment group as a pure function over the group's token widths (formatter-owned layout), instead of line-by-line incremental adjustment which is prone to drift, similar in spirit to VSG-BUG-014's non-idempotence.
Confirmed on 3.35.0: not tried (recorded from issue text; closed upstream).

---

## VSG-BUG-031: Endless multiprocessing spawn loop on Windows under certain Python distributions
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/914 (state: closed)
Category: other (platform/process model)
Observed behavior: On some Windows/Python packaging combinations, VSG's use of Python's `multiprocessing` module to parallelize file analysis re-spawns the entire Python interpreter recursively (a known multiprocessing/`freeze_support` pitfall on Windows), producing an uninterruptible, resource-consuming loop of new processes.
Independent reproducer: N/A — this is a process-model/packaging bug specific to Python's `multiprocessing` on Windows, not a VHDL input; no VHDL reproducer applies.
Expected behavior: Parallelizing across files must not be able to recursively re-invoke the whole program on any supported platform.
Relevance to vsg-rs: A single native binary with an in-process thread pool (e.g. Rust's `rayon` or plain OS threads) has no interpreter-respawn step at all, eliminating this entire bug class by construction — a good example of an issue that is "free" architecturally rather than something that needs a design decision.
Confirmed on 3.35.0: not tried (platform/Python-version specific; not reproducible from this Linux sandbox).

## VSG-BUG-032: `vsg` becomes impractically slow (minutes, possibly non-terminating in practice) on very large files
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1526 (state: closed)
Category: other (performance)
Observed behavior: Analyzing a single ~37,000-line VHDL file did not complete within 20 minutes and had to be killed; the report does not show a crash, just a program that never returns in practical time, strongly suggesting at least one rule or classification pass with worse-than-linear (e.g. quadratic) behavior in file size.
Independent reproducer: A large mechanically-generated file (e.g. thousands of near-identical `signal`/`port` declarations concatenated) is a reasonable stand-in, but reproducing multi-minute slowdowns is not "cheap" for this research pass; not independently timed here.
Expected behavior: Per-file analysis time should scale linearly (or close to it) with file size; pathological superlinear rules should be identified and fixed or bounded.
Relevance to vsg-rs: A CST built once and indexed (rather than repeatedly re-scanned per rule, per token, as many small independent Python passes tend to do) combined with Rust's inherently lower per-token overhead gives vsg-rs a structural advantage here; it is still worth budgeting an explicit large-file performance regression test (e.g. a 50k-line synthetic file with a wall-clock ceiling) rather than assuming architecture alone guarantees linear behavior.
Confirmed on 3.35.0: not tried (large-file timing is outside this research pass's "cheap" black-box budget).

## VSG-BUG-033: `pytest` test suite reports flaky false passes (intermittent CI signal)
Upstream issue: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1157 (state: open)
Category: other (test infrastructure)
Observed behavior: The maintainer's own CI occasionally reports a test as passing when manual inspection shows it should have failed, suggesting some tests are order-dependent or share mutable global state (a common Python testing pitfall, e.g. module-level caches or `sys.path` manipulation between local-rules tests) rather than being fully isolated.
Independent reproducer: N/A — this is about upstream's own test suite reliability, not a VHDL-input reproducer.
Expected behavior: A test suite must give a deterministic pass/fail signal regardless of run order or parallelism.
Relevance to vsg-rs: An argument for designing vsg-rs's own test harness (from day one) around hermetic, order-independent unit tests per rule (pure functions over an in-memory CST fixture, no shared mutable state, no filesystem side effects unless explicitly under test) — cheap to guarantee upfront, expensive to retrofit once hundreds of rule tests exist.
Confirmed on 3.35.0: not applicable (meta-issue about upstream's test suite, not the `vsg` binary's behavior).

## VSG-BUG-034: Multiple independent "crash on a specific nested `generate` shape" reports
Upstream issues: https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1212 (closed), https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1219 (closed), https://github.com/jeremiah-c-leary/vhdl-style-guide/issues/1227 (closed)
Category: crash / parser
Observed behavior: Three separate issues, filed close together, each describe a crash (`IndexError` in one case) triggered by a specific combination of adjacent/nested `for generate` and `if generate` statements — i.e. the generate-statement grammar handling accumulated several distinct crash-inducing shapes rather than one general bug, consistent with a hand-written recognizer that handles each generate/generate nesting combination as its own code path.
Independent reproducer (own construction of an adjacent-then-nested generate shape, illustrative of the general class rather than any one exact upstream input):
```vhdl
architecture rtl of gen_demo is
begin

  g_stage : for i in 0 to 3 generate
  begin
    g_inner : if i = 0 generate
    begin
    end generate g_inner;
  end generate g_stage;

  g_next : if true generate
  begin
  end generate g_next;

end architecture rtl;
```
Expected behavior: Every legal combination of adjacent and nested `generate` statement kinds (`for`/`if`/`case`) should parse and check uniformly — the number of once-reported crashes in this specific area (three related issues) is itself evidence the grammar handling needed a general fix, not three point patches.
Relevance to vsg-rs: A generated-or-declaratively-specified grammar (one production for `generate_statement` that composes `for`/`if`/`case` generically, with nesting handled by ordinary recursion in the grammar rather than bespoke nesting-depth-aware code) turns "N reported bugs in the same feature area" into "one grammar rule, tested combinatorially" — worth specifically fuzzing generate-statement nesting in vsg-rs's parser test suite given upstream's history here.
Confirmed on 3.35.0: not tried (three separate historical issues, all closed upstream; recorded from issue titles/history as a pattern rather than a currently-reproducible defect).
