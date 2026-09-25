# Changelog

Every release says which version of VSG it targets: the rule set, the configuration and the
reports are that version's. `speja --version` prints the same thing.

## 0.14.6

**Targets VSG 3.35.**

* **`:=` in a port list lines up across port modes.** With a default on an `in` port and on an
  `out` port, the two `:=` landed one column apart after `--fix`; the padding after the mode was
  left out of the measure. The result now matches VSG.
* **Alignment findings name the rule to configure.** The spacing before `:` and `:=` in entity
  generics and ports is reported as `entity_017` and `entity_018`, in components as
  `component_017`, and in parameter lists as `procedure_410` and `procedure_411`; the `=>` of
  maps as `instantiation_010` and `procedure_call_401`; the spacing around a port mode as
  `port_007` to `port_009`. Entity generics were reported as `procedure_410`, and most of the
  rest as `format`, which no configuration reaches.
* **Syntax errors read as text**, such as `expected ')'`, not as the parser's internal names. In
  the editor and the MCP server, a missing token is one error rather than one on every line the
  parser took to recover.
* **The editor follows `speja.yaml`, the waiver file and `vhdl_ls.toml` as they change.** Open
  files were analysed again only when edited.
* **A `speja.yaml` that does not load** is reported with the parser's message first and a link
  to the line in the configuration file.
* **The editor says when there is no `vhdl_ls.toml`**, once, since most lint rules need it.
* **Format Document on a file with syntax errors says so**, instead of "already formatted".
* **Declare Name types a name assigned from a function call** by the function's return type.
* **Instantiate Entity maps a generic with a default to that default**, not to the generic's own
  name, which is not declared at the instance. The picker lists entities as `library.entity`,
  so typing both ranks the exact match first.
* **The extension README shows a `speja.yaml`**, says where it is read from, explains
  `vhdl_ls.toml`, and its links work on the Marketplace.

## 0.14.5

**Targets VSG 3.35.**

* **Installing the Claude Code plugin copies only the skill.** The plugin lives in
  `plugins/speja/`, so an install no longer downloads the whole repository.
* **The Claude Code plugin no longer registers the MCP server.** It carries only the skill, now
  named `speja` rather than `vsg`, so its tools are not loaded into every session. Register the
  server with `claude mcp add speja -- speja mcp` if you want it.
* **The MCP `lint` tool takes the project's library map.** Pass `vhdl_ls_toml` and the rules that
  resolve names across files analyse against it, instead of the nearest `vhdl_ls.toml` above the
  file, which can be a catch-all map belonging to no project. The answer's `library_map` says
  which map was used, and a named map that does not exist is an error.

## 0.14.4

**Targets VSG 3.35.**

* **Move a signal into the block or generate that uses it.** On the declaration of a signal that
  only one block or generate body uses, the editor offers *Move signal ... into ...*, also as
  *speja: Move Signal Into the Scope That Uses It*. A generate with no declarative part is given
  one, with its `begin`. One name out of `signal a, b : bit;` moves on its own.
* **`lint_790` reports a signal declared wider than it is used**, off unless asked for. In a
  `for ... generate` it says that moving it gives each iteration its own signal.
* **What *speja* means**, and how to say it, in the README.

## 0.14.3

**Targets VSG 3.35.**

* **"Declare N signals for this port map" declares before the architecture's own `begin`.** It
  used the nearest `begin` above the instance, which was a process's or a function's whenever one
  came first, and indented like the instance. Extract to constant or signal had the same fault.
* **The speja menu opens at the cursor.** It is the editor's code action widget asked for speja's
  own kind, the one menu an extension can open where the cursor is; the ordinary lightbulb does
  not show its entries. Bind `speja.showMenu` to a key to open it while typing.
* **Fix All is out of the speja menu**: it is the same edit as Format Document. It stays a
  palette command and the `source.fixAll` action for `codeActionsOnSave`.
* **The "File is not formatted" finding is on the line that will change**, and says which
  disabled rule the formatter still applies. It was on the file's last line.
* **Refactorings are returned only when asked for**, which stops a warning in the extension host
  log on every lightbulb. The editing actions also skip their work when the editor asks for a
  source action or the speja menu.
* **Completing a case with `when others` puts the new choices above it.** They went after it,
  and `others` has to be the last choice.
* **Remove Unused Use Clauses no longer offers clauses that are in use.** A `use work.pkg.all`
  was never counted as used, and names used only in an architecture below its entity did not
  count toward the entity's clauses.
* **Instantiate Entity says where an instantiation can go** before asking which entity: after
  the architecture's `begin`, outside any process. On a line that already holds code it writes
  the instance below it instead of replacing the code.
* **Declare Entity as Component writes the component before the architecture's `begin`**, not
  at the cursor line.
* **Create State Machine from Enum Type checks where it is before asking anything**, and finds
  the architecture's `begin` past any subprogram bodies, as the other declare actions do.
* **Format Document, Format Selection and Sort Library and Use Clauses report the server's
  reason** when it refuses, instead of a generic command failure. Format Selection with nothing
  selected says so, and so does Extract Selection.

## 0.14.2

**Targets VSG 3.35.**

* **Every action is a command under `speja:`**, so each can be bound to a key: Format Document,
  Format Selection, Fix All Findings, Sort Library and Use Clauses, Quick Fixes at Cursor, Declare
  Name Under Cursor, Map Missing Ports, Complete Case Statement, beside the ones that were there.
  They read `speja: Instantiate Entity...` rather than `VHDL: VHDL: Instantiate Entity`. The
  lightbulb is unchanged.
* **A speja menu.** *speja: Show Actions...*, the **speja** item in the status bar, and a
  **speja** submenu on right-click list every action in one place.
* **Add Use Clause searches every package.** A searchable list of every package's contents and
  every package by name, opening on the name under the cursor; also in the lightbulb on an
  unresolved name, after the ranked offers.
* **Too many blank lines say so.** Two blank lines where one belongs read "Add blank line above";
  they read "Reduce to 1 blank line above" now.
* **Trailing whitespace is reported on its own line.** On a blank line holding spaces, or after a
  comment, it was reported on the line above.
* **A new use-clause group is set off by a blank line** above and below, including `work`, which
  has no library clause: `use work.pkg.all;` was written directly under the `ieee` block.
* **Declarations land where they belong.** A signal goes before its own architecture's `begin`,
  past any function bodies, not another architecture's or a function's; a variable goes before
  its own process's `begin`, not a procedure's that the process declares.
* **"Declare N signals for this port map" appears where it should**: with the cursor anywhere on
  the statement, including the indentation; with a comment after an actual, which was read as
  part of it and dropped the actual; when another architecture in the file declares a signal of
  the same name; and in a file that does not analyse.

## 0.14.1

**Targets VSG 3.35.**

* **Only packages are offered as use clauses.** VHDL-LS files an entity's ports under
  `library.entity`, so an undeclared `value` or `count` was offered `use mylib.counter.all`, a use
  clause of an entity. The generic `ieee` packages are left out as well.
* **A package in the file's own library is `use work.pkg.all`**, in the lightbulb, the palette
  command and completion alike, with no library clause.
* **A package's name is not offered as a local declaration.** `clamp` is offered its use clause,
  not "Declare signal clamp" beside it.
* **No declaration where it would not help**: a type in a type position, a formal before `=>`, or
  a name in a sensitivity list other than as a signal.
* **"Declare N signals for this port map" counts only what the map names.** A port the map leaves
  out is no longer declared under its own name; "Map N missing ports" gives it an actual first.
* **Import completion is ranked and cased the way you type.** `to_uns` completes `to_unsigned`
  from NUMERIC_STD first, in lower case, where it used to offer a generic package's first; and
  nothing is imported where a name is being declared, such as a new port.
* **Import completion works mid-expression again**, `x <= to_uns`, not only on a line of its own.
* **Instantiation completion ranks first where it should and nowhere else.** The row's match text
  follows what you type (`fif`, `myl.fi`, `other.le`, `entity other.le`), so it outranks
  VHDL-LS's own instantiation rows, which would write a second label. Nothing offers to
  instantiate inside a process, and a component declared in another file is no longer offered.

## 0.14.0

**Targets VSG 3.35.**

* **Format a selection.** The language server answers `textDocument/rangeFormatting`, so
  *Format Selection* formats the lines you picked and leaves the rest of the file alone. It works
  in whole lines, as `--range` does: the document is formatted in full, only the edits inside the
  range are kept, and the partial result is re-parsed to confirm it still has no syntax error, so
  a selection cutting through a construct yields what can be applied safely rather than half a
  fold.
* **A line the formatter would change offers to format itself**, from the lightbulb, whatever it
  tripped. A badly laid out line usually breaks several layout rules at once, and clearing them
  one rule at a time is not what someone looking at the squiggle wants.
* **The added use clause goes where it belongs.** It was appended after the last context clause
  in the file, so adding `ieee.numeric_std` to a file whose `library ieee;` block is followed by
  another library left the `use` orphaned from its own `library` clause: legal VHDL, and
  unreadable. A `use` now joins the library it names, in alphabetical order among that library's
  own clauses, and a new library sorts into the order `source.organizeImports` uses, `ieee` and
  `std` first, then everything else alphabetically, then `work` last, separated from the block it
  precedes.
* **`use ieee.std_logic_1164.all` comes first.** Organizing context clauses, and inserting a use
  clause, now order the `ieee` packages the way the ecosystem writes them rather than
  alphabetically: `std_logic_1164`, then `numeric_std`, then the rest by name. Counted across
  hdl-modules, tsfpga and VUnit, that is what VHDL is written like.
* **Declarations offered where you are typing.** A name the analyser cannot resolve offers to be
  declared as a signal, a variable or a constant, chosen by the assignment operator, and the
  declaration goes in the declarative part that can hold it. Inside a generate or a block, which
  declare signals of their own, both that scope and the architecture are offered. A port map
  offers to declare every actual it names at once.
* **Instantiation as it is typed.** `i_x : ` opens the list on every entity in every library and
  every component declaration; `i_x : lib.` narrows it to one library; a bare word still
  supplies the label. Matching is the editor's own fuzzy matching against `entity lib.name`,
  the rows sort above VHDL-LS's, and a component is instantiated by bare name. The label you
  typed is not written twice.
* **Works with the VHDL-LS the Marketplace extension embeds.** That is vhdl_ls 0.80, which gives
  an instantiation's document symbol the range of its label alone, nine characters, where 0.88
  gives it the whole statement. Every feature that read the port map out of that range read
  nothing: inlay hints, signature help, "Map N missing ports", "Declare N signals for this port
  map". The statement's extent is now read from the text and the symbol is trusted only for
  where it starts.
* **The use-clause offers are ranked**, most likely wanted first and preferred: `ieee.numeric_std`
  above `numeric_bit`, the Synopsys packages last. Alphabetical had put `NUMERIC_BIT` on top.
* **An actual is what it is connected to.** A port actual is offered as a signal and nothing else,
  a generic actual as a constant and nothing else, each with the type of what it feeds.
* **A constant's default value fits its type**: `1` for a `positive`, `(others => '0')` for a
  vector, an empty tab stop for a type this cannot guess at. It was `'0'` for everything.
* **Only the name under the cursor is offered a declaration or a use clause.** On a line with two
  unresolved names, asking about one no longer offers fixes for the other.
* **The instantiation completion is labelled and no longer sorted last.** It reads
  `counter    instantiate mylib.counter`, beside the bare word VHDL-LS offers, instead of below
  everything.
* **The waiver entries are gone from the lightbulb.** Three per finding, ahead of every fix, left
  the fix itself off the bottom of the menu. The server still reads the waiver file; writing one
  is a command-line job (`--generate_waivers`) or a text editor's.
* **The type of a declaration is inferred.** An actual in a port map takes the port's type with
  generics substituted; an assignment takes the type of the name or literal on the right. Only
  what cannot be worked out is left as a placeholder to type over.
* **A use clause for a name used in an architecture goes in the entity's context clause**, which
  the architecture inherits, rather than in a second one wedged between `end entity` and
  `architecture`. A second entity in the file still gets its own.
* **A new library block gets a blank line above it.** Adding a use clause for a package in
  another library appended `library mylib;` straight under the `ieee` block, so two groups read
  as one.
* **`case my_signal` is enough.** Before `is`, before any arm, the states of an enumeration are
  offered, and accepting writes the `is`, an arm each and the `end case`. On a statement that
  already exists it fills in only the choices that are missing. A selector that is not declared,
  or is not an enumeration, still has no states to infer.
* **`speja: exclude` leaves directories alone.** Generated and vendored sources get no
  diagnostics, no quick fixes and no formatting, and a `--recursive` walk passes them by. Naming
  such a file on the command line still formats it.
* **And the fix it will not apply is still offered**, marked `(may change behaviour)`. It is
  never the preferred action and never reached by fix-all or format-on-save, which are built from
  the entry point `--fix` uses and never ask for unsafe fixes. An amber underline with no action
  was a dead end.
* **Amber for what speja will not decide.** A finding whose only fix can change what the design
  does was underlined in the same red as a missing keyword, and offered no action, because speja
  will not apply such a fix itself. `signal_007` asks for a signal's initial value to be removed,
  and that value is its power-on state. Those are warnings in the editor now: red means wrong or
  mechanically fixable, amber means the call is yours. The command line is unchanged, since its
  severities are VSG's.
* **Layout findings reach the editor.** The language server published rule violations but not the
  findings that come from comparing the source with what the formatter would write, so a
  misindented line was never underlined even though `speja` reported it on the command line and
  `--fix` changed it. The editor and the command line now report the same thing.
* **`--fix --range` no longer deletes code.** On a file where most lines are misindented, the
  source and its formatted self have almost no lines in common, and the hunks the diff produced
  paired lines that had nothing to do with each other. Applying one removed a comment and the
  statement under it, and because what was left still parsed, the check guarding partial results
  accepted it. A partial result must now fix the rest of the way to exactly the fully fixed file,
  which nothing that lost or invented code can do, and lines are matched on what they say rather
  than where they start, so re-indenting one no longer looks like an unrelated change.

## 0.13.0

**Targets VSG 3.35.**

* **The project is now called speja.** Everything the old name reached has moved with it: the
  executable is `speja`, the package on PyPI is `speja`, the configuration file is `speja.yaml`
  or `.speja.yaml`, the waiver file is `speja-waivers.yaml`, the VS Code settings and commands
  are `speja.*`, the GitHub Action is `ru551n/speja`, and the documentation is at
  speja.readthedocs.io.

    **What this asks of you.** Rename your configuration file and your waiver file, install the
    new package, and remove the old one. `pip install vsg-rs` keeps working but stops receiving
    releases at 0.12.0, and the two packages install executables of different names, so they can
    sit side by side while you move.

    **What did not change.** The rules, their ids, the configuration format, the report formats
    and the VSG compatibility are all exactly as they were in 0.12.0. `speja` accepts the same
    command line as `vsg-rs` did and produces the same output, so a pipeline only needs the name
    changed. Every release up to and including 0.12.0 was published as `vsg-rs`, and the entries
    below describe that tool under its present name.

## 0.12.0

**Targets VSG 3.35.**

* **Waive a finding from the editor.** The language server offers to waive a finding on its line,
  in its file or everywhere, asks why, and writes the entry to the project's waiver file. It also
  reads that file, so a finding the project has already accepted is no longer underlined. The file
  is `speja-waivers.yaml`, found by walking up from the source and created at the workspace root
  when a project has none; `speja.waiverFile` names it in VS Code.
* **Sort library and use clauses**, as `source.organizeImports`: `ieee` and `std` first, then
  alphabetical, then `work` last, with the `use` clauses sorted inside each library. Whole lines
  are moved and none is rewritten, so comments travel with their clauses, and nothing is offered
  where that cannot be done safely.
* **Forty-one dark colour themes in the VS Code extension**, one for each dark variant of Tokyo
  Night, Catppuccin, Kanagawa, Nightfox, Everforest, Gruvbox Material, One Dark, One Dark Pro,
  Bamboo, Torchlight and others, plus Oxocarbon, Luna, Vague, Afterglow, Moonfly, Tender, Deus,
  Dogrun, Unokai, Blue Moon, VS Code Dark+, Dracula, Koda Moss and PaperColor. Each is the
  scheme's own palette applied to the VHDL grammar and to VHDL-LS's semantic tokens, generated
  from one table that records where every colour came from.
* **Choose which speja the VS Code extension runs**: the server bundled with the extension (the
  default), `speja` from `PATH`, or an executable you name, with `speja.server.mode` and
  `speja.server.path`. Changing either restarts the server, so a local build needs only
  *speja: Restart Server*.
* **Editing actions in the VS Code extension**, built on VHDL-LS: instantiate an entity, from a
  picker or as a completion, naming its library and adding the library clause the name needs;
  declare the signals a port map needs; create a state machine from an enumeration type; add a
  library and use clause for a symbol; map missing ports; declare an entity as a component; extract
  a selection to a constant or signal; remove unused use clauses; inlay hints for port and generic
  maps; a references CodeLens on entities; signature help in a port map; and a tree of the design
  hierarchy. None of them parses VHDL: everything comes back from the language server. They need
  VHDL-LS running with a `vhdl_ls.toml`, and say so when it is not. Lint and format do not.
* **Syntax colouring in the VS Code extension**: a TextMate grammar and two themes, Gruvbox VHDL
  Dark and Light. Names are coloured from VHDL-LS's semantic tokens, so a constant, a generic and
  an enumeration literal are told apart by what the analyser resolved them to.

## 0.11.1

**Targets VSG 3.35.**

* `--fix` through a symlink writes the file the link points at, and leaves the link a link.
  It previously replaced the link with a regular file holding the formatted source, and left the
  file it pointed at unchanged.

## 0.11.0

**Targets VSG 3.35.**

* **The lint layer reports definite errors by default.** *This changes what a default run
  reports.* Every rule now states how sure it is, and only those that can show a program cannot
  do what it says run unless you ask for more. A finding from a default run is something to
  correct rather than something to weigh up, and an empty report means speja proved nothing
  rather than that it merely stayed quiet.

    Rules that report something legal VHDL allows, and that may well be meant, moved to **off
    by default**: `lint_001`, `lint_002`, `lint_004`, `lint_005`, `lint_006`, `lint_600`,
    `lint_601`, `lint_710`, `lint_711`, `lint_712`, `lint_720`, `lint_730` and `lint_750`. They
    join `lint_602`, `lint_603`, `lint_700`, `lint_713` and `lint_760`, which were already off.
    Two drivers on a resolved type are what a resolution function is for; an unused declaration
    is legal; a state nothing enters may be reserved.

    **To get the old behaviour**, ask for the classes:

    ```yaml
    rule:
      group:
        advisory:
          disable: false
        experimental:
          disable: false
    ```

    Or name a rule, as before. Nothing was removed and no rule id changed. An enabled rule still
    reports at `error` severity and still fails a build.

    The class also decides how a finding is filed: only a definite error is a SonarQube **bug**,
    so an advisory rule you switched on arrives as a code smell rather than claiming the design
    is broken. `--list_rules` prints each rule's class and whether a default run uses it, and the
    [rule reference](https://speja.readthedocs.io/en/latest/rule-reference/) is grouped by the
    same thing, and all of them read one registry, so they cannot drift apart.

* **An MCP server.** `speja mcp` answers the same questions to a coding agent that the language
  server answers to an editor, over the Model Context Protocol, from the same library entry
  points. Three tools: `lint`, `format` and `explain_rule`. `lint` and `format` take either a
  path or a buffer, and a buffer is source that is not a file yet, so an agent can check what it
  is about to write before writing it. `format` with `write` fixes a file in place and returns
  only what changed, rather than sending the file through the conversation twice. Nothing is
  written unless asked, never for source that does not parse, and never when the result equals
  the file.

* **A Claude Code plugin**, so an agent is told what the tool is for rather than having to be
  told by whoever wrote the prompt:

    ```text
    /plugin marketplace add ru551n/speja
    /plugin install speja@speja
    ```

    It carries the `vsg` skill, which says to check the files that changed rather than the tree,
    that anything a default run reports is a definite error, and that a run warning about a
    missing library map has not called the file clean. It registers the MCP server as well.
    `speja` itself still has to be on `PATH`.

* **New rules.** These report something that cannot work, and run by default:

    | Rule | Reports |
    |---|---|
    | `lint_741` | a vector compared with one of a different width, which is never equal |
    | `lint_751` | a configuration naming an architecture, or an instance, that is not declared |
    | `lint_770` | a process with no sensitivity list and no `wait`, which can never suspend |
    | `lint_771` | a function that can reach the end of its body without returning a value |
    | `lint_772` | a statement that nothing can reach |
    | `lint_780` | an index outside the declared range of the array it selects from |
    | `lint_781` | a division, `mod` or `rem` whose divisor is written as zero |
    | `lint_782` | an assignment of a value outside the declared range of its target |

    Several of these are things a simulator reports only when a run reaches the statement, and
    only then. `lint_741` is reported by nothing else at all: comparing a four-bit vector with a
    three-bit literal is legal VHDL that is always false.

    Three are advisory, and off unless asked for:

    | Rule | Reports |
    |---|---|
    | `lint_701` | a register reset by one signal used in logic reset by another |
    | `lint_702` | a register a clocked process assigns that its reset branch does not |
    | `lint_703` | a clock used on both its rising and its falling edge |

* **Five language server fixes.** Diagnostics went stale after a document closed; one project was
  shared between unrelated workspaces; an unreadable `vhdl_ls.toml` silenced most of the lint
  layer without saying so; findings after a tab were pointed at the wrong column; and a file
  reached through a symlink was analysed as though it belonged to no library.

* **A language server.** `speja lsp` serves diagnostics, quick fixes and formatting over LSP,
  from the same library the command line uses: the same parser, formatter, analysis and
  configuration, so an editor and CI cannot disagree. It is deliberately narrow and does not
  advertise completion, hover, definition, references, rename or symbols: those belong to a VHDL
  language server such as `vhdl_ls`, which it is meant to run beside. Diagnostics carry their
  related locations, quick fixes come from the fix a finding already holds, and `source.fixAll`
  applies what `--fix` would. See [the language server](docs/lsp.md).
* **A VS Code extension**, in `editors/vscode`, which launches the server and nothing else. It
  ships the server for its platform, built by the same release, so there is no version to keep in
  step. Rules and layout still come from the project's own configuration file rather than from
  editor settings.
* **Analysis runs on buffers, not only files.** `--stdin --check lint` analyses what it is given,
  in the context of the project its path belongs to, which is what lets an unsaved file be checked
  at all. The analysis layer moved into the library (`speja::analysis`), so anything that is not
  the command line can use it.
* **Findings carry their other locations as data.** A multiply driven signal points at each
  driver and a combinational loop at each signal on it, rather than listing line numbers inside a
  sentence. The console shows them under the finding, SARIF carries them as `relatedLocations`,
  and SARIF now also carries safe fixes as `fixes`.
* **`--check lint` is faster.** The style layer no longer runs when only lint was
  asked for, the cross-file index is built once for whichever layers need it, and the lint layer
  runs in the same worker processes the style layer uses.
* `lint_700` (clock domain crossings) is now **off by default**. It infers which signal is a
  clock rather than deriving it, so it cannot point at the evidence the other rules can; enable it
  with `rule: lint_700: disable: false`.
* `lint_006` described `UnassociatedContext` as "a context declared but never used". It reports a
  context clause that is not attached to any design unit, which is a different thing.
* `--sonarqube FILE` writes SonarQube's generic issue JSON. SonarQube reads SARIF too, but files
  every SARIF issue as a vulnerability; this format carries the type, so the lint layer arrives as
  a bug and style as a code smell. Severity separates what needs a person from what does not: a
  finding `--fix` repairs is `INFO`, a lint finding is `CRITICAL`. Jenkins needs nothing new:
  Warnings-NG parses the SARIF file.
* `lint_740` reports a vector assigned to one of a different width, legal VHDL that fails only
  when the design elaborates. It measures only whole objects with literal ranges, so what it
  reports is certain.
* `lint_700` reports an unsynchronised clock domain crossing: a register from one clock used in
  logic on another. A plain capture into a flop is read as a synchroniser's first stage, and
  `speja: synchronizers` names the entities a crossing may safely pass through.
* `lint_710` and `lint_711` read enumerated state machines out of the source and report a state
  nothing can enter and a state nothing can leave, the two checks a netlist is usually thought
  necessary for.
* `lint_720` reports a combinational loop: a signal that depends on itself with no register in
  the way. The cycle is found in the source, not in a netlist.
* `lint_730` reports a signal that something reads but nothing drives: no assignment, and no
  instance output. It is the first check built on a design-wide view: the run now reads every
  input for its entities and port modes, so a port map can be read as drivers and readers.
* Every finding carries its layer (`style`, `layout` or `lint`), derived from the rule id so it
  cannot disagree with what produced it. `--statistics` shows it per rule and totals per layer,
  and `--fail_on style,layout,lint` chooses which layers make the run fail while the rest are
  still reported, so a team can gate CI on the lint layer while style only informs.
* `--explain RULE` says what a rule checks, which layer runs it, whether it is fixed, and links
  to VSG's documentation for VSG's own rules.
* A second layer of rules (`docs/lint.md`). The root command stays VSG's, with the same arguments, the same
  reports and byte-identical output, and `speja lint ...` runs rules that need names resolved,
  through `vhdl_lang`. `--check style,lint` runs both in one pass.
* 58 lint rules: sensitivity lists, unused declarations, and the name, type, subprogram and
  association diagnostics `vhdl_lang` produces, each with an id and a description in
  `--list_rules`.
* Three checks of our own: `lint_600` infers a latch when a combinational process does not
  assign a signal on every path (variables included, when one is read before it is written),
  `lint_601` reports a signal driven by more than one concurrent statement, and `lint_602` and
  `lint_603` check that a registered signal carries a suffix or prefix (both off by default,
  with plain, glob or regular-expression patterns).
* `ieee` and `std` are embedded in the binary, so the lint layer resolves them with no simulator
  and no configuration. `NOTICE` credits the IEEE P1076 WG and rust_hdl sources.
* Rules that need cross-file resolution wait for a `vhdl_ls.toml`, because unresolved names make
  them meaningless. A lint run without one says how many rules did not run, every time.
* Testbench and RTL code can carry different lint rules: `speja: testbench_files` (globs) or
  `speja: testbench_libraries` (from `vhdl_ls.toml`) name the testbenches, and
  `speja: testbench: rule:` / `speja: rtl: rule:` hold a rule block each. Without either, a
  file is classified by its own shape, and `--debug` says which files and why.
* `--lint_configuration` (`-lc`) takes configuration files applied to the lint layer only.
* `compact_alignment` is implemented. With it (VSG's default) an aligned column is the narrowest
  that fits; without it a group that already agrees on a wider column keeps it.
* The `:=` of generic and port clauses is aligned after the type, as VSG does (`entity_018`); it
  was previously collapsed to one space.
* `scripts/migrate_vsg_config.py` rewrites a VSG 3.2x configuration to the rule names 3.35 uses.
* The documentation is published at <https://speja.readthedocs.io/>. It covers what speja adds
  on top of VSG; the rules, their options and the configuration file are VSG's and are linked to
  rather than repeated, so the two cannot drift apart.
* The weekly compatibility job gains a second corpus, and a comparison against whatever VSG
  released most recently.

* Waivers (`docs/waivers.md`): `--waivers FILE` accepts the violations a project has decided to
  live with, listed by rule, file glob, lines and reason. `--generate_waivers FILE` writes a
  file covering everything found now, so a rule set can be adopted on existing code in one
  command, and `--show_waived` lists what was waived instead of only counting it. Waived
  violations never affect the exit code.
* `--statistics` prints the violations per rule over all inputs, with how many files each
  affects and whether `--fix` fixes it.
* `comment_004` (`number_of_spaces`) sets the spaces before a trailing comment.
* `--range` works with files, not only with `--stdin`.
* A GitLab CI recipe (`docs/gitlab-ci.md`): code-quality report, JUnit and `--statistics`.
* More layout violations report the VSG rule id instead of `format`. The same lines are
  reported, attributed more precisely.
* A weekly job measures agreement with VSG 3.35 and writes the per-rule table to the job
  summary (`scripts/compare_vsg.py --markdown`).
* `speja: reflow_comments` re-wraps comment paragraphs to the line width (off by default; VSG
  has no such rule). Structured comments, directives and formatter-off regions are left alone.
* `FormatConfig` is `#[non_exhaustive]`: struct literals of it no longer compile outside the
  crate (build one from `FormatConfig::default()` instead), and adding an option is no longer a
  breaking change.
* The fuzzer also generates configurations, so formatting has to be stable under any settings,
  not only the default ones.

## 0.10.0

Breaking for users of the Rust library; the command line, the configuration and the GitHub
Action are unchanged.

* Internal: the rule catalog lists only the 191 rules the formatter does not own and takes the
  ids from VSG's bundled defaults; duplicated helpers in the rule modules, two identical check
  entry points and a hand-rolled recursive merge are gone; `Doc::Choice` has two alternatives
  instead of a list. No change in behaviour (identical findings on a 293-file corpus).
* The library no longer exports `rules::check_and_format`, `rules::implemented` and
  `fix_edits`, which had no users; `rules::check_for_fixes` and `rules::check_canonical` are one
  `check_unformatted`.
* Wheels are tested on Python 3.10 and 3.14 instead of all five versions; the wheel is the same
  bytes for every version.
* CI checks licences, duplicate crates and advisories (`cargo deny`), coverage, unused
  dependencies, spelling and documentation examples, compares the benchmarks with the base
  branch and reports public API changes; the formatter is fuzzed nightly.

## 0.9.6

* The GitHub Action still posts new suggestions when it may not resolve earlier ones, and warns
  that resolving review threads needs `contents: write`. The documentation's workflow
  examples grant it.

## 0.9.5

* The GitHub Action resolves its suggestion threads that no longer apply on each run (and
  reopens one when the same suggestion applies again), so only open problems stay expanded.
* The documentation's workflow examples report without code scanning, which stays optional.
* The alignment of `:` in generic, port and parameter lists (`entity_017`, `component_017`,
  `procedure_410`) and of `=>` in maps (`instantiation_010`) can be disabled, and
  `group: alignment: disable` now turns it off too.

## 0.9.4

Less noise on pull requests.

* SARIF reports combine layout findings on adjacent lines into one `format` result per block,
  naming the VSG rules involved; rule violations stay one result each.
* The GitHub Action posts layout changes as suggested changes in one review (`layout:
  suggestions`, the default) instead of code scanning alerts, keeps one summary comment per
  pull request up to date (`pr-comment`), and annotates only the lines a pull request adds or
  changes (`annotations: changed`).

## 0.9.3

* SARIF reports describe each rule (name, description and a link to VSG's documentation), so
  code scanning alerts and pull request comments show which rule was violated.
* The README explains how to use the GitHub Action.

## 0.9.2

* A GitHub Action (`uses: ru551n/speja@v0.9.2`): downloads the release binary, runs speja,
  shows findings as annotations and in the job summary, and optionally uploads them to code
  scanning. See `docs/github-action.md`.
* SARIF reports use paths relative to the working directory with `/` separators (as code
  scanning expects), and `file://` URIs for files outside it.

## 0.9.1

* The standalone binary archives on GitHub releases get build provenance attestations too
  (0.9.0 attested only the Python packages).

## 0.9.0

* VSG local rules (`-lr DIR`, `local_rules: DIR`) are supported: speja runs them with an
  installed VSG (`vsg`, or the command in `SPEJA_VSG`) with the built-in rules disabled, adds
  their findings to its report and, with `--fix`, applies their fixes before its own.
* Settings of rules speja does not know no longer cause warnings when local rules are used.
* `-oc` includes `local_rules`.
* Release artifacts get build provenance attestations now that the repository is public.

## 0.8.0

Performance.

* Several files are checked and fixed in parallel worker processes instead of threads. The
  parser's global token interner made threads contend on every token: VUnit's 222 files now
  take 0.6 s instead of 1.7 s, with 3.7 s of CPU time instead of 30 s. The cross-file
  declaration index is built by the workers too.
* `--debug` prints how long the declaration index took and how many processes were used.

## 0.7.0

Command line and distribution.

* `file_list` in the configuration is supported as in VSG: paths and glob patterns (with
  environment variables), each optionally with its own `rule` block, checked together with the
  files on the command line.
* `--recursive` checks the VHDL files in directories given as inputs.
* macOS wheels (arm64 and x86_64) on PyPI.
* pre-commit hooks `speja` and `speja-fix` (`.pre-commit-hooks.yaml`).
* A migration guide from VSG (`docs/migrating-from-vsg.md`), with CI and pre-commit setups.

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
  protected types (with the comparison against VSG: 12 findings that only speja reports, down
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
