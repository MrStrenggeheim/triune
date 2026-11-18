# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Read this installed release's transcript mode at authenticated socket admission."""

from __future__ import annotations

import os
import re
import stat
from pathlib import Path

_MODES = {"1", "canary", "2"}


def _installed_commit() -> str | None:
    try:
        from omnigent._build_info import COMMIT_SHA
    except ImportError:
        return None
    return COMMIT_SHA


def transcript_feed_mode() -> str:
    """A configured but unusable release-specific override must never promote another build."""
    override = os.environ.get("TRIUNE_TRANSCRIPT_FEED_MODE_FILE")
    if override is None:
        mode = os.environ.get("TRIUNE_TRANSCRIPT_FEED", "canary")
        return mode if mode in _MODES else "1"
    path = Path(override)
    commit = _installed_commit()
    if not commit or not re.fullmatch("[0-9a-f]{40}", commit):
        return "1"
    if not path.is_absolute() or path.name != f"{commit}.mode":
        return "1"
    try:
        descriptor = os.open(
            path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
        )
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                return "1"
            value = os.read(descriptor, 16)
        finally:
            os.close(descriptor)
    except OSError:
        return "1"
    return {b"1": "1", b"canary": "canary", b"2": "2"}.get(value.removesuffix(b"\n"), "1")
