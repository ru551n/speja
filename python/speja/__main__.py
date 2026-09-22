"""``python -m speja``: run the bundled ``speja`` executable."""

from __future__ import annotations

import os
import subprocess
import sys

from speja import find_speja_bin


def main() -> int:
    exe = find_speja_bin()
    if sys.platform == "win32":
        # `exec` does not replace the process on Windows; forward the exit code instead.
        return subprocess.run([exe, *sys.argv[1:]], check=False).returncode
    os.execv(exe, [exe, *sys.argv[1:]])
    return 0  # unreachable


if __name__ == "__main__":
    sys.exit(main())
