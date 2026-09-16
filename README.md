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

**Status: early development.** Formatting works and is tested against a large real-world corpus.
27 structural rules and `length_001` are implemented, with transactional fixes. Expect layout
changes before 1.0.

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
  rule-order dependencies.
* **Fast.** Formatting a typical file from stdin takes a few milliseconds; parsing, formatting
  and verifying 12.6 MB of real-world VHDL takes under 3 seconds on one core
  ([performance](docs/performance.md)).

## Usage

```sh
pip install vsg-rs                     # Linux and Windows wheels, Python 3.10+ (or: uv tool install vsg-rs)
cargo install --path .                 # from source

vsg-rs fmt src/                        # format files in place
vsg-rs fmt --check src/                # CI: exit 1 if anything would change
vsg-rs fmt --diff src/foo.vhd          # show what would change
vsg-rs fmt --line-length 100 src/
cat foo.vhd | vsg-rs fmt --stdin-filename foo.vhd -   # editor integration

vsg-rs lint src/                       # report rule violations
vsg-rs check src/                      # CI: violations and unformatted files
vsg-rs check --output-format sarif src/ > vsg.sarif   # also json, junit
vsg-rs fix src/                        # apply all safe fixes, then format
vsg-rs rules --all                     # every VSG rule and how vsg-rs handles it
```

Configuration uses the VSG format (YAML or JSON). It is read from `--config FILE`, or from the
nearest `vsg-rs.yaml` / `.vsg-rs.yaml` (or `.json`):

```yaml
rule:
  length_001:
    length: 100
  process_016:
    disable: true
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
`vsg-rs fmt --stdin-filename <path> -`. On success (exit code 0) the buffer is replaced with
stdout. On failure (exit code 2) stdout is empty and stderr explains why; leave the buffer
unchanged.

## Documentation

* [Architecture](docs/architecture.md)
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
cargo run --release --example corpus -- --width 80 path/to/vhdl   # stability and overflow report
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
