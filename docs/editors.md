# Editor integration

vsg-rs can be used from an editor in two ways:

* **Language server** (`vsg-rs lsp`): diagnostics while typing, format document, format
  selection, quick fixes and "fix all". Recommended.
* **Pipe** (`vsg-rs fmt --stdin-filename <path> -`): format-only, for editors that can run an
  external formatter.

Both use the same configuration as the command line: the nearest `vsg-rs.yaml` /
`.vsg-rs.yaml` (or `.json`) above the file, with `file_rules` applied for the file's path.

## Language server

`vsg-rs lsp` speaks the Language Server Protocol on stdin/stdout. It provides:

| Feature | LSP method |
|---|---|
| Diagnostics on open, change and save: rule violations (warning or error, `code` = rule id, `source` = `vsg-rs`) and syntax errors | `textDocument/publishDiagnostics` |
| Format document | `textDocument/formatting` |
| Format selection (whole lines; only changed lines inside the selection are edited) | `textDocument/rangeFormatting` |
| Quick fix for each violation with a safe fix | `textDocument/codeAction` (`quickfix`) |
| Apply all safe fixes, then format (same as `vsg-rs fix`) | `textDocument/codeAction` (`source.fixAll.vsg-rs`) |

Formatting a file with syntax errors returns no edits and a `window/logMessage` explaining why;
the buffer is never changed. Configuration files are re-read on every request, so edits to
`vsg-rs.yaml` apply without restarting the server. Editor formatting options (tab size and so
on) are ignored; the vsg-rs configuration decides the layout.

### VS Code

VS Code needs an extension to start a language server. Any generic LSP client extension works;
configure it to run the command `vsg-rs` with the argument `lsp` for the `vhdl` language. To
apply all safe fixes on save, add:

```json
"[vhdl]": {
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": { "source.fixAll.vsg-rs": "explicit" }
}
```

For formatting only, without a language server, an external-formatter extension such as
*Custom Local Formatters* can use the pipe mode:

```json
"customLocalFormatters.formatters": [
  { "command": "vsg-rs fmt --stdin-filename ${file} -", "languages": ["vhdl"] }
]
```

### Neovim (0.10+)

```lua
vim.api.nvim_create_autocmd("FileType", {
  pattern = "vhdl",
  callback = function(args)
    vim.lsp.start({
      name = "vsg-rs",
      cmd = { "vsg-rs", "lsp" },
      root_dir = vim.fs.root(args.buf, { "vsg-rs.yaml", ".vsg-rs.yaml", ".git" }),
    })
  end,
})
```

Format with `vim.lsp.buf.format()` (a visual selection formats that range), fix with
`vim.lsp.buf.code_action()`, or on save:

```lua
vim.lsp.buf.code_action({ context = { only = { "source.fixAll.vsg-rs" } }, apply = true })
```

### Helix

In `languages.toml`:

```toml
[language-server.vsg-rs]
command = "vsg-rs"
args = ["lsp"]

[[language]]
name = "vhdl"
auto-format = true
language-servers = [
  { name = "vsg-rs", only-features = ["format", "diagnostics", "code-action"] },
  "vhdl_ls",
]
```

Listing vsg-rs first makes it the formatter; `vhdl_ls` still provides navigation and
completion.

### Emacs (eglot)

```elisp
(with-eval-after-load 'eglot
  (add-to-list 'eglot-server-programs '(vhdl-mode . ("vsg-rs" "lsp"))))
(add-hook 'vhdl-mode-hook #'eglot-ensure)
```

Use `eglot-format-buffer` / `eglot-format` (region) and `eglot-code-actions`.

## Pipe mode

```sh
vsg-rs fmt --stdin-filename path/to/file.vhd -             # whole buffer
vsg-rs fmt --stdin-filename path/to/file.vhd --range 10:24 -   # only lines 10 to 24
```

The buffer is read from stdin. On success (exit code 0) stdout is the complete new buffer; with
`--range START:END` (1-based, inclusive) only changed lines within that range differ from the
input. On failure (exit code 2) stdout is empty and stderr explains why; leave the buffer
unchanged. `--stdin-filename` is used for configuration lookup and messages only.
