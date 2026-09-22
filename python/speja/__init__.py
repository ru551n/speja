"""speja: a VHDL formatter and style checker with VSG-compatible rules and configuration.

The package ships the ``speja`` executable. :func:`find_speja_bin` returns its path, for
tools that want to run it without relying on ``PATH``.
"""

from __future__ import annotations

import os
import sys
import sysconfig

__all__ = ["find_speja_bin"]


def find_speja_bin() -> str:
    """Return the path of the ``speja`` executable installed with this package."""
    exe = "speja.exe" if sys.platform == "win32" else "speja"
    candidates = [
        sysconfig.get_path("scripts"),
        sysconfig.get_path("scripts", scheme=sysconfig.get_preferred_scheme("user")),
        # `pip install --target <dir>` puts scripts in `<dir>/bin`.
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin"),
    ]
    for directory in candidates:
        path = os.path.join(directory, exe)
        if os.path.isfile(path):
            return path
    raise FileNotFoundError(f"could not find {exe} in {candidates}")
