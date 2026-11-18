# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Bounded extraction of exact-turn execution metadata from native records."""

from __future__ import annotations

import json
import logging
import os
import stat
import time
from pathlib import Path
from typing import Any

from omnigent.models.model_metadata import concrete_reported_model

_logger = logging.getLogger(__name__)
_TAIL_BYTES = 2 * 1024 * 1024


def claude_execution(message: object) -> dict[str, Any] | None:
    """Claude's assistant response reports its model; missing effort stays unknown."""
    if not isinstance(message, dict):
        return None
    model = concrete_reported_model(message.get("model"))
    if not model or len(model) > 256:
        return None
    return {"model": model, "source": "claude_response"}


def codex_turn_context(path: Path, turn_id: str, *, max_bytes: int) -> dict[str, Any] | None:
    """Find an exact native turn record, scanning backwards with bounded time and memory."""
    deadline = time.monotonic() + 1.5
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                return None
            end = info.st_size
            oldest = max(0, end - max_bytes)
            suffix: bytes | None = b""
            while end > oldest and time.monotonic() < deadline:
                start = max(oldest, end - 256 * 1024)
                stream.seek(start)
                lines: list[bytes | None] = list(stream.read(end - start).split(b"\n"))
                last = lines[-1] or b""
                lines[-1] = (
                    last + suffix
                    if suffix is not None and len(last) + len(suffix) <= _TAIL_BYTES
                    else None
                )
                # A record crossing chunk boundaries belongs to the preceding chunk.
                suffix = lines.pop(0) if start else b""
                for line in reversed(lines):
                    if not line or b'"turn_context"' not in line:
                        continue
                    try:
                        record = json.loads(line)
                    except (ValueError, UnicodeDecodeError):
                        continue
                    if not isinstance(record, dict) or record.get("type") != "turn_context":
                        continue
                    payload = record.get("payload")
                    if isinstance(payload, dict) and payload.get("turn_id") == turn_id:
                        return payload
                end = start
    except OSError as exc:
        _logger.debug("Native execution metadata unavailable (%s)", type(exc).__name__)
    return None


def codex_turn_execution(path: Path, turn_id: str) -> dict[str, Any] | None:
    """Read the model and effort reported for this exact turn."""
    payload = codex_turn_context(path, turn_id, max_bytes=_TAIL_BYTES)
    if payload is None:
        return None
    model = concrete_reported_model(payload.get("model"))
    if not model or len(model) > 256:
        return None
    result: dict[str, Any] = {"model": model, "source": "codex_turn_context", "turn_id": turn_id}
    mode = payload.get("collaboration_mode")
    settings = mode.get("settings") if isinstance(mode, dict) else None
    effort = settings.get("reasoning_effort") if isinstance(settings, dict) else None
    if isinstance(effort, str) and effort.strip() and len(effort) <= 64:
        result["effort"] = effort
    return result
