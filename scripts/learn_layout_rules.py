#!/usr/bin/env python3
"""Learn which VSG layout rule reports each kind of formatting change.

Runs VSG (all phases, JSON report) and `cargo run --example layout_keys` on the same files and
counts, for each change key of speja, the VSG layout rules reported on the same line (or, for
a rule that asks for a blank line below a line, on the line before). A key maps to the rule that
accompanies it most often, if that happens often enough. Each change has a chain of keys, from
the token alone to the token in its statement and after its previous token; a more specific key
is written only where its rule differs from the one it refines. The table is written to
src/layout_rules.json.

    python scripts/learn_layout_rules.py [--vsg "uvx --from vsg==3.35.0 vsg"] FILE...
"""

from __future__ import annotations

import argparse
import collections
import functools
import json
import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def vsg_findings(
    cmd: list[str], files: list[str], jobs: int
) -> dict[tuple[str, int], set[tuple[str, bool]]]:
    """VSG's rules per (file, line), each with whether it asks for something below the line."""
    out: dict[tuple[str, int], set[tuple[str, bool]]] = collections.defaultdict(set)
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
                    below = "below" in v.get("solution", "")
                    out[(os.path.normpath(f["file_path"]), v["linenumber"])].add((v["rule"], below))
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

    # Each change has a chain of keys about its token and, for blank lines, one about the token
    # before. A rule that asks for something below a line (VSG says "below") reports on the line
    # of the token before and is learned for that chain; any other rule on the change's line is
    # learned for the token's chain.
    seen: collections.Counter[str] = collections.Counter()
    pairs: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    chains: list[list[str]] = []
    for line in keys.splitlines():
        change = json.loads(line)
        if change["keys"][0].startswith("KeywordCase"):
            continue
        file = os.path.normpath(change["file"])
        here = theirs.get((file, change["line"]), set())
        above = {r for r, below in here if r in layout and not below}
        prev = theirs.get((file, change["prev_line"]), set())
        below = {r for r, below in prev if r in layout and below}
        for chain, rules in ((change["keys"], above), (change["below"], below)):
            if chain:
                chains.append(chain)
            for key in chain:
                seen[key] += 1
                pairs[key].update(rules)

    @functools.cache
    def learn(key: str) -> str | None:
        counts = pairs.get(key)
        if not counts:
            return None
        rule, count = counts.most_common(1)[0]
        if count >= args.min_count and count / seen[key] >= args.min_share:
            return rule
        return None

    # A more specific key is kept only where it says something else than the key it refines.
    table: dict[str, str] = {}
    for chain in chains:
        inherited = None
        for key in chain:
            rule = learn(key)
            if rule is not None and rule != inherited:
                table[key] = rule
            inherited = table.get(key, inherited)
    path = ROOT / "src" / "layout_rules.json"
    path.write_text(json.dumps(table, indent=1, sort_keys=True) + "\n")
    print(f"{len(table)} of {len(seen)} change keys mapped; wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
