# Editor integration

vsg-rs integrates with editors as an external formatter: the editor pipes the buffer through
`vsg-rs fmt` and replaces it with the output.

```sh
vsg-rs fmt --stdin-filename path/to/file.vhd -                 # whole buffer
vsg-rs fmt --stdin-filename path/to/file.vhd --range 10:24 -   # only lines 10 to 24
```

The buffer is read from stdin. On success (exit code 0) stdout is the complete new buffer; with
`--range START:END` (1-based, inclusive) only changed lines within that range differ from the
input. On failure (exit code 2) stdout is empty and stderr explains why; leave the buffer
unchanged. `--stdin-filename` is used for configuration lookup and messages only.

For diagnostics in an editor, use a language server such as
[vhdl_ls](https://github.com/VHDL-LS/rust_hdl) together with vsg-rs as the formatter, or run
`vsg-rs lint --output-format json -` from a generic linter integration.

## VS Code

With an extension that runs external formatters (for example *Custom Local Formatters*):

```json
"customLocalFormatters.formatters": [
  {
    "command": "vsg-rs fmt --stdin-filename ${file} -",
    "languages": ["vhdl"]
  }
]
```

Enable `"editor.formatOnSave": true` for format-on-save.

## Neovim

With [conform.nvim](https://github.com/stevearc/conform.nvim):

```lua
require("conform").setup({
  formatters = {
    vsg_rs = { command = "vsg-rs", args = { "fmt", "--stdin-filename", "$FILENAME", "-" } },
  },
  formatters_by_ft = { vhdl = { "vsg_rs" } },
  format_on_save = { timeout_ms = 1000 },
})
```

## Helix

`languages.toml`:

```toml
[[language]]
name = "vhdl"
formatter = { command = "vsg-rs", args = ["fmt", "-"] }
auto-format = true
```

## Emacs

With [apheleia](https://github.com/radian-software/apheleia):

```elisp
(with-eval-after-load 'apheleia
  (add-to-list 'apheleia-formatters '(vsg-rs "vsg-rs" "fmt" "--stdin-filename" filepath "-"))
  (add-to-list 'apheleia-mode-alist '(vhdl-mode . vsg-rs)))
```
