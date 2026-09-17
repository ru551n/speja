"""Smoke test for an installed vsg-rs wheel: ``python python/tests/smoke.py``.

Checks the console script, ``python -m vsg_rs`` and ``vsg_rs.find_vsg_rs_bin`` on the current
interpreter.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile

import vsg_rs

UNFORMATTED = "entity e is port (a : in bit); end;\n"
FIXED = "entity e is\n  port (\n    a : in    bit\n  );\nend entity e;\n"


def run(args: list[str], stdin: str = "") -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(args, input=stdin.encode(), capture_output=True, check=False)


def main() -> None:
    exe = vsg_rs.find_vsg_rs_bin()
    assert os.path.isfile(exe), exe
    assert shutil.which("vsg-rs") is not None, "vsg-rs is not on PATH"

    for cmd in ([exe], [sys.executable, "-m", "vsg_rs"]):
        version = run([*cmd, "--version"])
        assert version.returncode == 0, version
        assert version.stdout.decode().startswith("vsg-rs "), version.stdout

        fixed = run([*cmd, "--stdin", "--fix"], UNFORMATTED)
        assert fixed.returncode == 0, fixed.stderr
        assert fixed.stdout.decode() == FIXED, fixed.stdout

        broken = run([*cmd, "--stdin", "--fix"], "entity e is port (a : in bit; end;\n")
        assert broken.returncode == 1, broken
        assert broken.stdout == b"", broken.stdout

        with tempfile.TemporaryDirectory() as tmp:
            report = os.path.join(tmp, "report.json")
            lint = run([*cmd, "--stdin", "-js", report], "entity e is\nend;\n")
            assert lint.returncode == 1, lint
            with open(report) as f:
                violations = json.load(f)["files"][0]["violations"]
            rules = [v["rule"] for v in violations]
            assert rules == ["entity_015", "entity_019"], rules

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "e.vhd")
        with open(path, "w", newline="") as f:
            f.write(UNFORMATTED.replace("\n", "\r\n"))
        result = run([exe, "-f", path, "--fix"])
        assert result.returncode == 0, result.stderr
        with open(path, newline="") as f:
            fixed = f.read()
        assert fixed == FIXED.replace("\n", "\r\n"), repr(fixed)

    print(f"ok: {exe} on Python {sys.version.split()[0]} ({sys.platform})")


if __name__ == "__main__":
    main()
