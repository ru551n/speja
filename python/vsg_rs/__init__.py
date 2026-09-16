"""vsg-rs: a VHDL formatter and style checker with VSG-compatible rules and configuration.

The package ships the ``vsg-rs`` executable. :func:`find_vsg_rs_bin` returns its path, for
tools that want to run it without relying on ``PATH``.
"""

from __future__ import annotations

import os
import sys
import sysconfig

__all__ = ["find_vsg_rs_bin"]


def find_vsg_rs_bin() -> str:
    """Return the path of the ``vsg-rs`` executable installed with this package."""
    exe = "vsg-rs.exe" if sys.platform == "win32" else "vsg-rs"
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
