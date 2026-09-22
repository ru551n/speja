# Migrating from VSG

speja takes VSG 3.35's arguments and configuration files, so most setups only change the
command name from `vsg` to `speja`. This page lists what to check. The details are in
[compatibility](compatibility.md).

## 1. Install

```sh
pip install speja        # or: uv tool install speja, or a binary from the GitHub release
speja --version
```

## 2. Check without fixing

Run your usual command with `speja` in place of `vsg`:

```sh
speja -f $(git ls-files '*.vhd' '*.vhdl') -c vsg.yaml -of summary
```

Differences to expect:

* **More findings in one run.** VSG stops at the first phase with violations; speja has one
  phase and reports everything. `-fp` and `-ap` are accepted and have no effect.
* **Layout findings.** Every place where `--fix` would change the layout is reported, under
  the VSG rule for that kind of change, or as `format` when no VSG rule covers it.
* **Configuration warnings.** Settings speja does not support (some `indent.tokens` details)
  are reported as warnings on stderr.
* **Local rules** (`-lr`, `local_rules`) still need VSG: keep it installed, or point
  `SPEJA_VSG` at it (for example `uvx --from vsg==3.35.0 vsg`).

`scripts/compare_vsg.py` in this repository compares the findings of both tools per rule on
your files.

## 3. Fix once, in its own commit

speja formats each file into one canonical layout, which differs from VSG's output in places
(for example how long lines are folded). Apply it once, commit it separately and let `git
blame` skip that commit:

```sh
speja -f $(git ls-files '*.vhd' '*.vhdl') -c vsg.yaml --fix
git commit -am "Format VHDL with speja"
git rev-parse HEAD >> .git-blame-ignore-revs
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

`--fix` applies the fixes VSG applies by default and formats the file; a second run changes
nothing. Fixes VSG does not apply by default (such as adding a missing port mode) need
`--unsafe_fixes` or `fixable: true` in the rule's configuration. Use `--diff` to review
changes first. Files with syntax errors are never changed.

## 4. Update CI

The exit code, `-j` (JUnit), `-js` (JSON) and `--quality_report` (GitLab) work as in VSG.
On GitHub, the speja action shows findings as annotations and can upload them to code
scanning ([GitHub Action](github-action.md)):

```yaml
- uses: ru551n/speja@v0.14.0
  with:
    args: -c vsg.yaml --recursive src
```

Instead of listing files, use `file_list` in the configuration (as in VSG) or
`speja --recursive src`. On GitLab, see [GitLab CI](gitlab-ci.md).

## 5. pre-commit

With the wheels from PyPI (no Rust toolchain needed):

```yaml
repos:
  - repo: local
    hooks:
      - id: speja
        name: speja
        entry: speja --fix -c vsg.yaml
        language: python
        additional_dependencies: [speja==0.14.0]
        files: \.(vhd|vhdl)$
        require_serial: true
```

Or from this repository, which builds speja from source (hooks `speja` to check and
`speja-fix` to fix):

```yaml
repos:
  - repo: https://github.com/ru551n/speja
    rev: v0.14.0
    hooks:
      - id: speja-fix
        args: [-c, vsg.yaml]
```

## 6. Editors

Pipe the buffer through `speja --stdin --fix --stdin_filename <path>`; see
[editor integration](editors.md).

## Things that stay the same

* Configuration files (YAML or JSON), `-c` with several files, `file_rules`, `file_list`,
  `rule.global`, groups, per-rule options, `disable`, `severity` and `fixable`.
* `-- vsg_off` / `-- vsg_on` comments, `-rc`, `-oc`, `--fix_only`, `-b`, `--style`.
* Rule ids and solution texts.
