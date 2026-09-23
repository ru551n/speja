# speja for VS Code

VHDL in VS Code: formatting, diagnostics and quick fixes from
[speja](https://github.com/ru551n/speja), editing actions such as instantiating an entity, and
syntax colouring with forty-three themes.

It is two things, and only one of them needs anything else installed:

* **Lint and format** run the speja language server, which this extension ships. What you see in
  the editor is what `speja --check style,lint` and `speja --fix` produce on the command line.
  Nothing else is required.
* **Editing actions** are built on the analysis [VHDL-LS](https://github.com/VHDL-LS/rust_hdl)
  already does. They need VHDL-LS running, with a `vhdl_ls.toml` for the workspace. See
  [what the editing actions need](#what-the-editing-actions-need).

## Lint and format

* **Diagnostics** in the Problems panel, including related locations. A multiply driven signal
  points at each driver, a combinational loop at each signal on it.
* **Quick fixes** for findings that carry one, and **Fix All** for the document.
* **Format Document**, and format on save.
* **Sort library and use clauses** as a source action: `ieee` first, then alphabetical, `work`
  last.

## Editing actions

Each one reads what it writes back from VHDL-LS. The one exception is a `case` statement being
typed, which does not analyse yet, so its enumeration is read from the declarations in the file.

* **Instantiate Entity**, from a picker or as you type: `i_x : ` lists every entity in the
  project and every component declared in the file, `i_x : lib.` one library's, matched the way
  Ctrl+P matches, with the library clause the instantiation needs.
* **Declare Signals for Port Map**, with the port's type and the generic's value substituted.
* **Create State Machine from Enum Type**.
* **Add Use Clause**, as a ranked quick fix on an unresolved name, or searching every package.
* **Inlay hints** for each port's direction and type in a port or generic map.
* **Declare signal, variable or constant** for an unresolved name, chosen by the assignment
  operator and placed in the declarative part that can hold it, including a generate's or a
  block's own, and **Declare N signals for this port map** for a whole instantiation.
* **Write the states of a `case`** as soon as `case my_signal` is on the line, and **add the
  missing when choices** to one that already exists.
* **Map missing ports**, **Declare Entity as Component**, **Extract to constant or signal**,
  **Remove Unused Use Clauses**, a references **CodeLens** on entities, and **signature help** in
  a port map.
* **VHDL Design**, a tree of every entity, through its architectures to the instances they hold.

Every action is also a command under **speja:** in the palette, so any of them can be bound to a
key, and **speja: Show Actions...** (also the **speja** item in the status bar, and the right-click
menu) lists them all. **Add Use Clause...** is a searchable list of every package's contents.

All of it is described, with examples and limits, in
[editing VHDL in VS Code](https://speja.readthedocs.io/en/latest/vscode-editing/).

## Colour

The extension contributes the `vhdl` language definition, a TextMate grammar and forty-three themes:
**Gruvbox VHDL Dark** and **Gruvbox VHDL Light**, and forty-one dark ones named for the schemes
they take their colours from, such as **Tokyo Night VHDL Night**, **Catppuccin VHDL Mocha** and
**Kanagawa VHDL Wave**. The grammar covers what VHDL-LS never
classifies (keywords, comments, strings, literals, operators); every name is coloured from its
semantic token, so a constant, a generic and an enumeration literal look different because the
analyser says they are, not because of how they are spelled.

## What the editing actions need

**VHDL-LS, running, with a `vhdl_ls.toml` for the workspace.** Install the
[VHDL-LS extension](https://marketplace.visualstudio.com/items?itemName=hbohlin.vhdl-ls) or run
`vhdl_ls` yourself. Without it:

* the editing commands report that no language server answered;
* names stay uncoloured, because the grammar leaves every identifier to VHDL-LS;
* **lint and format keep working**, since they come from the speja server.

The extension does not depend on VHDL-LS being installed, so it never installs one for you. And
`work` is not a valid library name in `vhdl_ls.toml`: the server ignores it without a word.

## speja is not a VHDL language server

Hover, go to definition, references and rename are VHDL-LS's, and the speja server does not
advertise them. The two are independent and neither requires the other; installing both gives you
the union. The editing actions above ask VHDL-LS what a name means and never answer that
themselves.

## For a coding agent, not an editor

The same binary serves the same answers over the Model Context Protocol, which is what an agent
writing VHDL in this workspace should be told:

```sh
claude mcp add speja -- speja mcp
```

```json
{ "mcpServers": { "speja": { "command": "speja", "args": ["mcp"] } } }
```

It offers `lint`, `format` and `explain_rule`, all on a buffer rather than a path, so a mistake
can be caught before the file is written. See
[the MCP server](https://speja.readthedocs.io/en/latest/mcp/).

## Getting the server

Nothing to install: the extension ships the server for your platform and uses it. To run a
different one, a system install or a local build, see
[choosing a server](docs/server-selection.md).

## Make it the VHDL formatter

Name this extension for VHDL, which also settles it if another VHDL extension offers formatting
too:

```jsonc
"[vhdl]": {
    "editor.defaultFormatter": "ru551n.speja",
    "editor.formatOnSave": true
}
```

Formatting goes through the same entry point as `speja --fix`, so saving applies the safe rule
fixes as well as the layout, and a file that does not parse is left alone. See
[formatting and fixing](docs/formatting.md) for that, for quick fixes and Fix All, for running
alongside VHDL-LS, and for troubleshooting.

## Configuring the rules

Not here. Rules, layout and severities come from the project's own `speja.yaml` (or `vsg.yaml`
passed on the command line), found from the file's directory upwards: the same file the command
line and CI read. That is deliberate: a formatting decision must not depend on which editor
someone opened the file in.

See [the speja documentation](https://speja.readthedocs.io/).
