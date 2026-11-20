"""Versioned availability for controls owned by a native child's parent runtime."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from omnigent.util.session_lifecycle import CLOSED_LABEL_KEY

if TYPE_CHECKING:
    from omnigent.entities import Conversation

# Carries the server's child row on a capability probe so the parent runner
# need not page through every sibling to find it.
NATIVE_CHILD_HEADER = "X-Omnigent-Native-Child"
_MAPPING_LABELS = (
    "omnigent.wrapper",
    CLOSED_LABEL_KEY,
    "omnigent.codex_native.subagent_thread_id",
)


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


def native_child_mapping(child: Conversation) -> str:
    """Encode the fields a parent runner checks before probing one native child."""
    return json.dumps(
        {
            "id": child.id,
            "parent_session_id": child.parent_conversation_id,
            "kind": child.kind,
            "title": child.title,
            "tool": child.sub_agent_name,
            "labels": {key: child.labels[key] for key in _MAPPING_LABELS if key in child.labels},
        }
    )
