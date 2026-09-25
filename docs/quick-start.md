# Quick start

## Install

```sh
pip install speja        # Linux, Windows and macOS wheels, Python 3.10+
uv tool install speja    # or
cargo install --path .    # from source, Rust 1.95 or newer
```

Standalone binaries for Linux, Windows and macOS are attached to each
[release](https://github.com/ru551n/speja/releases), with a `SHA256SUMS` file.

## Check one file

```sh
speja -f src/top.vhd
```

Violations are listed with their rule, severity and line. The exit code is 1 when anything of
error severity was reported, 0 otherwise.

## Format

```sh
speja -f src/top.vhd --fix          # rewrite the file
speja -f src/top.vhd --fix --diff   # show what would change instead
```

Formatting is idempotent: a second run changes nothing. The result is re-parsed before being
written, and must contain exactly the same tokens and comments as the input, so a file is never
changed in a way that alters what it means.

## A whole tree

```sh
speja --recursive src            # check every .vhd and .vhdl below src/
speja --recursive src --fix      # format them
```

## Configure

Put a `speja.yaml` next to your sources:

```yaml
rule:
  length_001:
    length: 100
  signal_008:
    disable: true
```

It is found automatically from each file's directory upwards, by the command line and the
editor alike. An existing VSG configuration works unchanged: rename it, or pass it with
`-c vsg.yaml`. The rules and their options are
[VSG's](https://vhdl-style-guide.readthedocs.io/en/latest/configuring.html); speja adds a few
keys of its own under a `speja:` block.

## Find bugs, not layout

```sh
speja lint --recursive src
```

```
lint_600 -- Signal 'flag' is not assigned on every path of this combinational process,
            which infers a latch
lint_601 -- Signal 'result' is assigned by 2 concurrent statements (lines 34, 38)
```

!!! important "Most lint rules need a library map"

    Without a `vhdl_ls.toml`, only 13 of the lint rules run — the rest cannot resolve names
    across files and are skipped. The run warns when this happens. See
    [Project setup](project-setup.md).

Run both layers together with `speja --recursive src --check style,lint`.

## In CI

```sh
speja --recursive src --sarif speja.sarif     # GitHub code scanning
speja --recursive src -j junit.xml             # any CI test tab
```

There is a [GitHub Action](github-action.md) and a [GitLab](gitlab-ci.md) recipe; see
[report formats](reports.md) for the rest.

## Next

* [Coming from VSG](migrating-from-vsg.md) if you have an existing VSG setup
* [Formatting](formatting.md) for what the formatter decides and how to configure it
* [Static analysis](lint.md) for what the lint layer reports and how far to trust it
* [Editors](editors.md) for format-on-save
* [CLI reference](cli.md) for every option and the exit codes
