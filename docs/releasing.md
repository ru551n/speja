# Releasing

speja is distributed on PyPI as `speja`. The wheels contain the `speja` executable (installed
into the environment's scripts directory, so it is on `PATH`) and a small `speja` Python module
(`python -m speja ...`, `speja.find_speja_bin()`). The wheels do not depend on the Python
version (`py3-none-<platform>`); they are tested on Python 3.10 and 3.14 (the oldest and newest supported).

```sh
pip install speja      # or: uv tool install speja / pipx install speja
speja --version
```

## Platforms

| Platform | Wheel tag | Tested in CI |
|---|---|---|
| Linux x86_64 (glibc ≥ 2.28) | `manylinux_2_28_x86_64` | Python 3.10 and 3.14 |
| Linux aarch64 (glibc ≥ 2.28) | `manylinux_2_28_aarch64` | build only |
| Linux x86_64 (musl) | `musllinux_1_2_x86_64` | build only |
| Linux aarch64 (musl) | `musllinux_1_2_aarch64` | build only |
| Windows x64 | `win_amd64` | Python 3.10 and 3.14 |
| Windows arm64 | `win_arm64` | build only (cross-compiled) |
| macOS arm64 (11.0+) | `macosx_11_0_arm64` | Python 3.10 and 3.14 |
| macOS x86_64 (10.12+) | `macosx_10_12_x86_64` | build only (cross-compiled) |
| other | sdist (needs a Rust toolchain ≥ 1.95 and network access for the git dependency) | built from sdist on Linux and Windows |

## Standalone binaries

Each GitHub release also has archives with just the `speja` executable (plus README and
licenses), and a `SHA256SUMS` file:

| Archive | Platform |
|---|---|
| `speja-vX.Y.Z-x86_64-unknown-linux-musl.tar.gz` | Linux x86_64, static |
| `speja-vX.Y.Z-aarch64-unknown-linux-musl.tar.gz` | Linux aarch64, static |
| `speja-vX.Y.Z-x86_64-pc-windows-msvc.zip` | Windows x64 |
| `speja-vX.Y.Z-aarch64-pc-windows-msvc.zip` | Windows arm64 |
| `speja-vX.Y.Z-aarch64-apple-darwin.tar.gz` | macOS arm64 |
| `speja-vX.Y.Z-x86_64-apple-darwin.tar.gz` | macOS x86_64 |

## The VSG version a release targets

Every release states it, because the rule set, the configuration keys and the report formats are
one VSG version's. Before tagging:

1. The top of `CHANGELOG.md` says **Targets VSG X.Y.Z** for the release being cut.
2. `speja --version` prints the same version (`src/vsg_cli.rs`).
3. The pinned jobs in `.github/workflows/compatibility.yml` install that version.

The `latest` job in that workflow installs whatever VSG released most recently and prints both
versions in its summary, so a new VSG release shows up here rather than in someone's pipeline.
Moving to a new VSG version is a deliberate change: the rule set differs, and a configuration
written for the older one may not load (see `scripts/migrate_vsg_config.py`).

## Workflow

`.github/workflows/release.yml`:

1. checks that the tag `vX.Y.Z` equals the version in `Cargo.toml`;
2. builds the wheels and the sdist with maturin, and the standalone binaries with cargo
   (Linux targets with `cargo zigbuild`); native binaries are run once;
3. installs each Linux x86_64, Windows x64 and macOS arm64 wheel into Python 3.10 and 3.14,
   and builds the sdist on Linux and Windows. Each installation runs `python/tests/smoke.py`
   (console script, `python -m speja`, stdin formatting, error handling, linting, fixing with
   CRLF line endings);
4. on tags only: publishes to PyPI with trusted publishing, and creates a GitHub release with
   the wheels, the sdist, the binary archives and `SHA256SUMS` attached, with build provenance
   attestations (GitHub for all files, PEP 740 on PyPI). Attestations are skipped if the repository is private,
   because GitHub does not offer them for private repositories on its Free plan.
5. on tags only, after the release exists: publishes each platform VSIX to the **VS Code
   Marketplace** and to **Open VSX**, which is the registry VSCodium, Cursor and Gitpod read.
   One target at a time, and `skipDuplicate` is set, so re-running the job after a partial
   failure uploads only what is missing.

Manual runs (`gh workflow run release.yml`) and pull requests that touch the packaging do steps
1 to 3 only.

## crates.io

speja is not on crates.io yet: crates.io does not accept git dependencies, and speja needs
`vhdl_syntax` fixes that are newer than its 0.2.0 release (see `vhdl-frontend.md`). When a
`vhdl_syntax` release contains them, switch `Cargo.toml` to that version, create an API token
on crates.io and publish with `cargo publish` (afterwards, crates.io trusted publishing can
replace the token).

## Pinned inputs

Everything the build pulls in is pinned, so a release can be reproduced and nothing changes
underneath it:

* **Actions** by commit hash, with the version in a trailing comment (Dependabot updates them).
* **Rust crates** by `Cargo.lock`; every `cargo` command in CI runs with `--locked`.
* **The parser**, `vhdl_syntax`, by git revision (see `vhdl-frontend.md`).
* **Tools** installed in CI by version: `cargo-deny`, `cargo-machete`, `cargo-llvm-cov`,
  `cargo-semver-checks`, `cargo-fuzz`, `typos`, and maturin (`maturin-version`).
* **VSG itself**, where the scripts compare against it: `uvx --from vsg==3.35.0 vsg`.

Two things stay floating on purpose: the `stable` Rust toolchain in the lint, test and build
jobs (testing against the current compiler is the point; the minimum version is pinned to 1.95
in the `msrv` job), and the runner images (`ubuntu-latest` and friends).

## One-time setup

1. On PyPI, add a *trusted publisher* for the project `speja`: owner `ru551n`, repository
   `speja`, workflow `release.yml`, environment `pypi` (a "pending publisher" can be created
   before the first upload).
2. In the GitHub repository settings, create the environment `pypi` (optionally with required
   reviewers).
3. On the **VS Code Marketplace**, create the publisher `ru551n`, then mint an Azure DevOps
   personal access token for the same account with the scope *Marketplace: Manage*, scoped to
   *All accessible organizations*, and store it as the repository secret `VSCE_PAT`. A token
   scoped to one organisation is rejected at publish time with a misleading 401.
4. On **Open VSX**, sign in with GitHub, agree to the publisher agreement, create the namespace
   `ru551n`, and store an access token as the repository secret `OPEN_VSX_PAT`. The namespace
   must exist before the first publish; the upload fails otherwise.
5. In the GitHub repository settings, create the environment `marketplace` (optionally with
   required reviewers, which is how to keep a human in front of both registries).

PyPI needs no token, because it uses trusted publishing. The two registry tokens above are the
only secrets the release needs, and both are write-only credentials for their own registry.

## Making a release

```sh
# 1. bump `version` in Cargo.toml, run `cargo check` to update Cargo.lock
# 2. commit and push to main; wait for CI
git tag -a vX.Y.Z -m "speja X.Y.Z"
git push origin vX.Y.Z
gh run watch   # follow the Release workflow
```

## Local build

```sh
uvx maturin build --release --out dist        # wheel for this machine
uvx maturin sdist --out dist
uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python dist/*.whl
PATH=.venv/bin:$PATH .venv/bin/python python/tests/smoke.py
```
