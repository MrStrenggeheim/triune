# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Bounded extraction of exact-turn execution metadata from native records."""

from __future__ import annotations

import json
import logging
import os
import stat
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


def codex_turn_execution(path: Path, turn_id: str) -> dict[str, Any] | None:
    """Read only an exact turn_context from a bounded tail of the observed rollout."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                return None
            start = max(0, info.st_size - _TAIL_BYTES)
            stream.seek(start)
            if start:
                stream.readline(_TAIL_BYTES)
            lines = stream.read(_TAIL_BYTES).splitlines()
    except OSError as exc:
        _logger.debug("Native execution metadata unavailable (%s)", type(exc).__name__)
        return None
    for line in reversed(lines):
        if b'"turn_context"' not in line:
            continue
        try:
            record = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            continue
        if not isinstance(record, dict) or record.get("type") != "turn_context":
            continue
        payload = record.get("payload")
        if not isinstance(payload, dict) or payload.get("turn_id") != turn_id:
            continue
        model = concrete_reported_model(payload.get("model"))
        if not model or len(model) > 256:
            return None
        result: dict[str, Any] = {
            "model": model,
            "source": "codex_turn_context",
            "turn_id": turn_id,
        }
        mode = payload.get("collaboration_mode")
        settings = mode.get("settings") if isinstance(mode, dict) else None
        effort = settings.get("reasoning_effort") if isinstance(settings, dict) else None
        if isinstance(effort, str) and effort.strip() and len(effort) <= 64:
            result["effort"] = effort
        return result
    return None
