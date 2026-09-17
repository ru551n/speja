# vsg-rs

A fast Rust-native VHDL formatter and style checker with VSG-compatible rules and configuration.

> **vsg-rs is an independent Rust implementation of a VHDL formatter and style checker that
> aims for compatibility with the rules and configuration of the VHDL Style Guide (VSG). It is not
> affiliated with, endorsed by, or maintained by the VHDL Style Guide project or its
> maintainers.**
>
> vsg-rs was inspired by the [VHDL Style Guide (VSG)](https://github.com/jeremiah-c-leary/vhdl-style-guide)
> project by Jeremiah Leary and contributors. vsg-rs contains no VSG code; VSG is used only as a
> behavioural reference.

**Status: beta.** Formatting is tested against a corpus of more than 11,000 real-world files.
192 VSG rules are implemented as lint rules with fixes (structure, identifier case, naming,
comments, `length_001`), and the other 779 layout rules are covered by the formatter's policy
(blank lines, alignment, keyword case, indentation). Expect layout changes before 1.0.

## Why

* **A real formatter.** Formatting is not "run the lint rules and apply their fixes". Source is
  parsed once into a lossless syntax tree and printed in one canonical layout, like rustfmt or
  Black. Running it twice changes nothing.
* **Long lines are folded, not just reported.** `length_001` becomes a formatter capability:
  calls, maps, aggregates, expressions, conditions, declarations and assignments fold at
  structural boundaries (see [docs/line-folding.md](docs/line-folding.md)).
* **Safe for format-on-save.** Every result is re-parsed and checked to contain exactly the same
  tokens and comments before it is used. Files with syntax errors are left untouched. In pipe
  mode, stdout carries nothing but the formatted source.
* **No fix phases.** No `--fix` runs that must be repeated until they converge, and no
  rule-order dependencies. Fixes that could change behaviour are only applied on request
  (`--unsafe_fixes`).
* **Fast.** Formatting a typical file from stdin takes a few milliseconds; parsing, formatting
  and verifying real-world VHDL runs at about 3.4 MB/s on one core, and files are processed in
  parallel ([performance](docs/performance.md)).

## Usage

`vsg-rs` takes the same arguments as VSG's `vsg` command:

```sh
pip install vsg-rs                     # Linux and Windows wheels, Python 3.10+ (or: uv tool install vsg-rs)
cargo install --path .                 # from source

vsg-rs -f src/*.vhd                    # report violations (exit 1 if there are errors)
vsg-rs -f src/*.vhd --fix              # fix them and format the files
vsg-rs -f src/*.vhd -c vsg.yaml -of summary -js report.json -j junit.xml
vsg-rs -rc entity_015                  # configuration of a rule
vsg-rs -oc all.json                    # the effective configuration
```

There is one difference: VSG's phases are gone. All violations are reported at once and `--fix`
fixes everything in one run (`-fp` and `-ap` are accepted and have no effect).

`--fix` applies the fixes VSG applies by default and formats the file. vsg-rs adds these options:

| Option | Meaning |
|---|---|
| `--unsafe_fixes` | with `--fix`, also apply fixes VSG does not apply by default (they may change behaviour or remove information) |
| `--diff` | with `--fix`, print a unified diff instead of changing files |
| `--stdin_filename PATH` | name of the `--stdin` input, for configuration lookup and reports |
| `--range START:END` | with `--stdin --fix`, change only these lines (editors) |
| `--sarif FILE` | SARIF 2.1.0 report for code scanning |
| `--list_rules` | every VSG rule and how vsg-rs handles it |

Configuration uses the VSG format (YAML or JSON), passed with `-c`. Without `-c`, the nearest
`vsg-rs.yaml` / `.vsg-rs.yaml` (or `.json`) next to the input or in a parent directory is used:

```yaml
rule:
  length_001:
    length: 100
  process_016:
    disable: true
  group:
    case::name:
      case: lower
indent:
  tokens:
    case_statement_alternative:
      when_keyword: {after: current, token: current}
file_rules:
  legacy/**/*.vhd:
    rule:
      length_001:
        disable: true
```

Formatting can be switched off for a region with `-- vsg-rs: fmt off` / `-- vsg-rs: fmt on`;
VSG's `-- vsg_off [rule ...]` / `-- vsg_on` comments suppress rules.

### Editor integration

Configure your editor to pipe the buffer through
`vsg-rs --stdin --fix --stdin_filename <path>` (add `--range START:END` to format selected
lines). With exit code 0 the buffer is replaced with stdout; otherwise stdout is empty, stderr
explains why, and the buffer should be left unchanged. See [docs/editors.md](docs/editors.md)
for VS Code, Neovim, Helix and Emacs setups.

## Documentation

* [Architecture](docs/architecture.md)
* [Editor integration](docs/editors.md)
* [Formatting](docs/formatting.md), [line folding](docs/line-folding.md) and its
  [coverage matrix](docs/line-folding-coverage.md)
* [VHDL frontend](docs/vhdl-frontend.md) (why `vhdl_syntax`)
* [Compatibility with VSG](docs/compatibility.md) and [rule status](docs/rule-status.md)
* [Performance](docs/performance.md)
* [Releasing](docs/releasing.md) (Python package, platforms, release workflow)
* [VSG configuration model](docs/vsg-config.md), [VSG rule catalog](docs/vsg-rules.md)
* [Known VSG bugs](docs/upstream-bugs.md) and [limitations](docs/upstream-limitations.md) that
  vsg-rs is designed to avoid

## Development

```sh
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
cargo run --release --example corpus -- --width 80 path/to/vhdl   # stability and overflow report (FIX=1 / FIX=unsafe)
UPDATE_EXPECT=1 cargo test --test golden                           # re-bless golden files (review the diff)
```

## License

vsg-rs is licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or
[MIT license](LICENSE-MIT), at your option. Third-party dependencies are listed in
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md). The VHDL parser, `vhdl_syntax`
from the rust_hdl project, is MPL-2.0 and is used as an unmodified dependency.

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in
vsg-rs, as defined in the Apache-2.0 license, shall be dual licensed as above, without any
additional terms or conditions.
