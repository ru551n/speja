# speja for VS Code

**Catch VHDL bugs as you type, not in simulation.**

speja checks and formats VHDL on every keystroke. Width mismatches, out-of-range indices and
processes that can never suspend are underlined in the editor, long before a testbench would
find them. Switch on more checks, such as latches, multiple drivers and clock-domain crossings,
with one line in `speja.yaml`.

## Lint and format

Nothing else to install: the speja server comes with the extension.

* **Finds real bugs**, not just style, with quick fixes where there is one.
* **A real formatter**: Format Document, Format Selection and format on save.
* **VSG compatible**: it runs the [VHDL Style Guide](https://vhdl-style-guide.readthedocs.io/)
  rule set and reads your existing configuration.
* **Same answer everywhere**: the editor, `speja` on the command line and your CI agree,
  because they read the same `speja.yaml`.

To make speja the VHDL formatter:

```jsonc
"[vhdl]": {
    "editor.defaultFormatter": "ru551n.speja",
    "editor.formatOnSave": true
}
```

## Configure

speja reads `speja.yaml` from the file's folder or any folder above it. It takes VSG's
configuration format, so an existing VSG configuration works as it is:

```yaml
rule:
  length_001:
    length: 100          # fold lines at 100 columns
  port_012:
    disable: true        # allow default values on ports
```

On an existing codebase the full VSG rule set can fill the Problems panel; turn off what your
project does not follow. Each finding names its rule, and
[the rule reference](https://speja.readthedocs.io/en/latest/rule-reference/) lists the options.

The bug-finding rules need to know which library each file belongs to. They read the
`vhdl_ls.toml` that [VHDL-LS](https://github.com/VHDL-LS/rust_hdl#configuration) uses; without
one, most of them are off. See
[project setup](https://speja.readthedocs.io/en/latest/project-setup/).

## Editing actions

* **Instantiate Entity**
* **Declare Signals for Port Map**
* **Declare Name Under Cursor**
* **Add Use Clause**
* **Complete Case Statement**

...and more. **speja: Show Actions...** lists them all. These build on
[VHDL-LS](https://marketplace.visualstudio.com/items?itemName=hbohlin.vhdl-ls), so install it
alongside.

## Colour

A number of popular Vim colour schemes are available as themes.

## Learn more

* [Editing VHDL in VS Code](https://speja.readthedocs.io/en/latest/vscode-editing/): every
  action, with examples.
* [What the lint rules catch](https://speja.readthedocs.io/en/latest/lint/).
* [Formatting and fixing](https://github.com/ru551n/speja/blob/HEAD/editors/vscode/docs/formatting.md)
  and [choosing a server](https://github.com/ru551n/speja/blob/HEAD/editors/vscode/docs/server-selection.md).
