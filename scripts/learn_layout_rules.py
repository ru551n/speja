#!/usr/bin/env python3
"""Learn which VSG layout rule reports each kind of formatting change.

Runs VSG (all phases, JSON report) and `cargo run --example layout_keys` on the same files and
counts, for each change key of speja, the VSG layout rules reported on the same line. A key
maps to the rule that accompanies it most often, if that happens often enough. The table is
written to src/layout_rules.json.

    python scripts/learn_layout_rules.py [--vsg "uvx --from vsg==3.35.0 vsg"] FILE...
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def vsg_findings(cmd: list[str], files: list[str], jobs: int) -> dict[tuple[str, int], set[str]]:
    out: dict[tuple[str, int], set[str]] = collections.defaultdict(set)
    for start in range(0, len(files), 50):
        with tempfile.TemporaryDirectory() as tmp:
            report = os.path.join(tmp, "r.json")
            subprocess.run(
                [*cmd, "-f", *files[start : start + 50], "-ap", "-p", str(jobs), "-js", report],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            if not os.path.exists(report):
                continue
            for f in json.loads(Path(report).read_text())["files"]:
                for v in f["violations"]:
                    out[(os.path.normpath(f["file_path"]), v["linenumber"])].add(v["rule"])
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vsg", default="uvx --from vsg==3.35.0 vsg")
    parser.add_argument("--jobs", type=int, default=os.cpu_count() or 4)
    parser.add_argument("--min-count", type=int, default=3)
    parser.add_argument("--min-share", type=float, default=0.5)
    parser.add_argument("files", nargs="+")
    args = parser.parse_args()
    files = sorted({os.path.normpath(os.path.abspath(f)) for f in args.files})

    listing = subprocess.run(
        ["cargo", "run", "-q", "--release", "--", "--list_rules"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    layout = {
        line.split()[0] for line in listing.splitlines() if line.split()[1:2] == ["formatter"]
    }

    theirs = vsg_findings(shlex.split(args.vsg), files, args.jobs)
    keys = subprocess.run(
        ["cargo", "run", "-q", "--release", "--example", "layout_keys", "--", *files],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout

    seen: collections.Counter[str] = collections.Counter()
    pairs: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    for line in keys.splitlines():
        change = json.loads(line)
        key = change["key"]
        if key.startswith("KeywordCase"):
            continue
        seen[key] += 1
        for rule in theirs.get((os.path.normpath(change["file"]), change["line"]), ()):
            if rule in layout:
                pairs[key][rule] += 1

    table = {}
    for key, counts in sorted(pairs.items()):
        rule, count = counts.most_common(1)[0]
        if count >= args.min_count and count / seen[key] >= args.min_share:
            table[key] = rule
    path = ROOT / "src" / "layout_rules.json"
    path.write_text(json.dumps(table, indent=1, sort_keys=True) + "\n")
    print(f"{len(table)} of {len(seen)} change keys mapped; wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
