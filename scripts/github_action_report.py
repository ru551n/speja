#!/usr/bin/env python3
"""Post-process vsg-rs's SARIF report in the GitHub Action (`action.yml`).

    github_action_report.py SARIF WORKING_DIRECTORY ANNOTATIONS

Makes the file paths relative to the repository root (vsg-rs runs in WORKING_DIRECTORY),
prints findings as workflow annotations if ANNOTATIONS is `true`, and writes a summary per
rule to the job summary.
"""

from __future__ import annotations

import collections
import json
import os
import posixpath
import sys


def main() -> int:
    path, workdir, annotations = sys.argv[1], sys.argv[2], sys.argv[3] == "true"
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    prefix = posixpath.normpath(workdir.replace("\\", "/"))
    results = doc["runs"][0]["results"]
    for result in results:
        location = result["locations"][0]["physicalLocation"]["artifactLocation"]
        uri = location["uri"]
        if not uri.startswith("file://"):
            uri = posixpath.normpath(posixpath.join(prefix, uri))
        location["uri"] = uri
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1)

    if annotations:
        for result in results:
            location = result["locations"][0]["physicalLocation"]
            level = "warning" if result["level"] == "warning" else "error"
            message = result["message"]["text"].replace("%", "%25").replace("\n", "%0A")
            line = location["region"]["startLine"]
            print(
                f"::{level} file={location['artifactLocation']['uri']},line={line},"
                f"title={result['ruleId']}::{message}"
            )

    counts: collections.Counter[tuple[str, str]] = collections.Counter(
        (r["ruleId"], r["level"]) for r in results
    )
    files = {r["locations"][0]["physicalLocation"]["artifactLocation"]["uri"] for r in results}
    lines = [
        "## vsg-rs",
        "",
        f"{len(results)} violation(s) in {len(files)} file(s).",
    ]
    if counts:
        lines += ["", "| Rule | Severity | Count |", "|---|---|---|"]
        lines += [
            f"| `{rule}` | {level} | {count} |"
            for (rule, level), count in sorted(counts.items(), key=lambda x: (-x[1], x[0]))
        ]
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
