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
FORMATTED = "entity e is\n  port (\n    a : in    bit\n  );\nend;\n"


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

        formatted = run([*cmd, "fmt", "--stdin-filename", "e.vhd", "-"], UNFORMATTED)
        assert formatted.returncode == 0, formatted.stderr
        assert formatted.stdout.decode() == FORMATTED, formatted.stdout

        broken = run([*cmd, "fmt", "-"], "entity e is port (a : in bit; end;\n")
        assert broken.returncode == 2, broken
        assert broken.stdout == b"", broken.stdout

        lint = run([*cmd, "lint", "--output-format", "json", "-"], "entity e is\nend;\n")
        assert lint.returncode == 1, lint
        rules = [d["rule"] for d in json.loads(lint.stdout)]
        assert rules == ["entity_015", "entity_019"], rules

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "e.vhd")
        with open(path, "w", newline="") as f:
            f.write(UNFORMATTED.replace("\n", "\r\n"))
        result = run([exe, "fix", path])
        assert result.returncode == 0, result.stderr
        with open(path, newline="") as f:
            fixed = f.read()
        expected = "entity e is\n  port (\n    a : in    bit\n  );\nend entity e;\n"
        assert fixed == expected.replace("\n", "\r\n"), repr(fixed)

    print(f"ok: {exe} on Python {sys.version.split()[0]} ({sys.platform})")


if __name__ == "__main__":
    main()
