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
Linting and fixing are being built. Expect layout changes before 1.0.

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
* **Fast.** Parsing, formatting and verifying about 12 MB of VHDL takes under 5 seconds on one
  core.

## Usage

```sh
cargo install --path .

vsg-rs fmt src/                        # format files in place
vsg-rs fmt --check src/                # CI: exit 1 if anything would change
vsg-rs fmt --diff src/foo.vhd          # show what would change
vsg-rs fmt --line-length 100 src/
cat foo.vhd | vsg-rs fmt --stdin-filename foo.vhd -   # editor integration
```

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
