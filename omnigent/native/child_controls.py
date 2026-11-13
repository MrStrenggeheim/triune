"""Versioned availability for controls owned by a native child's parent runtime."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def native_child_provider(kind: str, labels: Mapping[str, str]) -> str | None:
    """Identify mirrored children; labels alone never authorize a control."""
    if kind != "sub_agent":
        return None
    return {
        "codex-native-ui-subagent": "codex",
        "claude-code-native-ui-subagent": "claude",
    }.get(labels.get("omnigent.wrapper", ""))


def unavailable_child_capabilities(reason: str, *, state: str = "unavailable") -> dict[str, Any]:
    """Disable controls explicitly when their runtime support is unproven."""
    return {
        "version": 1,
        "state": state,
        "can_reply": False,
        "can_steer": False,
        "can_stop": False,
        "reason": reason,
        "reasons": dict.fromkeys(("reply", "steer", "stop"), reason),
    }
