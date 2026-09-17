# GitHub Action

`ru551n/vsg-rs` is also a GitHub Action. It downloads the vsg-rs release binary (checked
against `SHA256SUMS`), runs it with VSG's arguments, shows the findings as annotations and in
the job summary, and can upload them to GitHub code scanning.

```yaml
name: VHDL style
on: [push, pull_request]

jobs:
  vsg:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write   # only for sarif-upload
    steps:
      - uses: actions/checkout@v6
      - uses: ru551n/vsg-rs@v0.9.3
        with:
          args: -c vsg.yaml --recursive src
          sarif-upload: true
```

It runs on Linux, Windows and macOS runners (x64 and arm64).

| Input | Default | Meaning |
|---|---|---|
| `args` | `--recursive .` | vsg-rs arguments (VSG's command line); `--sarif` is added |
| `version` | the action's tag, else `latest` | vsg-rs release to download |
| `working-directory` | `.` | where vsg-rs runs, relative to the repository root |
| `annotations` | `true` | findings as annotations (GitHub shows at most 10 errors and 10 warnings per step) |
| `sarif-upload` | `false` | upload to code scanning (needs `security-events: write`) |
| `fail-on-violations` | `true` | fail the job when vsg-rs exits with 1 |
| `token` | `github.token` | token for downloading the release |

Outputs: `exit-code`, `sarif-file` (paths relative to the repository root) and `version`.

## Code scanning (SARIF)

SARIF is the standard JSON format for static-analysis results that GitHub code scanning reads.
With `sarif-upload: true` (or `vsg-rs --sarif FILE` followed by
`github/codeql-action/upload-sarif`), each violation becomes a code scanning alert:

* **Security → Code scanning** lists the alerts; they can be filtered by rule (`entity_008`,
  …) and severity, and dismissed with a reason.
* Alerts are tracked across commits: an alert that disappears is closed automatically, and a
  pull request shows only the alerts it introduces, as review annotations on the changed lines.
* A branch protection rule or ruleset can require that code scanning finds no new alerts.

Requirements: code scanning is free for public repositories; private repositories need GitHub
Advanced Security (GitHub Code Security). The job needs `security-events: write`. File paths in
the report must be relative to the repository root, which the action ensures. The uploads use
the category `vsg-rs`, so they do not replace the results of other tools such as CodeQL.

Without code scanning, the annotations and the job summary still show the findings, and the
SARIF file is available as the `sarif-file` output (for example to upload as an artifact).
