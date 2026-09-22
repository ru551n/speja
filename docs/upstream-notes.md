# Upstream notes

Working notes on the two projects speja depends on behaviourally: VSG, which it is compatible
with, and `vhdl_syntax`, which parses for it. These are maintainer notes, not user documentation.

## VSG behaviour

speja treats VSG as a black-box reference: behaviour is established by running it, never by
reading its source. Where VSG's behaviour looks like a defect, speja reproduces the documented
rule rather than the defect, and the difference is recorded in
[intentional differences](compatibility.md).

Reproducers for the cases that matter live in `tests/regressions.rs`, which is the version that
cannot go stale: if VSG changes, the test fails. Prose about individual upstream issues is kept in
the git history rather than here, because it dated faster than it was useful.

## Parser limitations

What `vhdl_syntax` cannot yet parse, and what speja therefore cannot check or format, is recorded
in [VHDL frontend](vhdl-frontend.md) alongside the measured parse-failure rate. That page is the
single place for it.

## Why the parser is pinned to a git revision

`Cargo.toml` depends on `vhdl_syntax` by git revision rather than by a crates.io version, because
speja needs fixes newer than the published 0.2.0. This is why speja is not itself on crates.io:
crates.io does not accept git dependencies. The pin is expected to become a version requirement
once upstream publishes a release containing them.
