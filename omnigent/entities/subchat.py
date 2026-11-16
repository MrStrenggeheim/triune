# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Presentation and first-question policy for durable, human-created subchats."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

SUBCHAT_POLICY_LABEL = "omnigent.subchat.conversation_id"
SUBCHAT_HISTORY_LABEL = "omnigent.subchat.inherited_last_item_id"
QUOTE_SUBCHAT_HISTORY_LABEL = "omnigent.subchat.quote_source_item_id"
SUBCHAT_LABEL_KEYS = frozenset(
    {SUBCHAT_POLICY_LABEL, SUBCHAT_HISTORY_LABEL, QUOTE_SUBCHAT_HISTORY_LABEL}
)


def is_durable_subchat(conversation_id: str, labels: Mapping[str, str]) -> bool:
    return labels.get(SUBCHAT_POLICY_LABEL) == conversation_id


def subchat_question_content(content: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Exclude captured context and Markdown quotes from the naming question."""
    result = []
    for block in content:
        if (
            not isinstance(block, dict)
            or block.get("type") != "input_text"
            or not isinstance(block.get("text"), str)
        ):
            continue
        text = re.sub(
            r"\[Chat context snapshot\].*?\[/Chat context snapshot\]",
            "",
            block["text"],
            flags=re.DOTALL,
        )
        text = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith(">"))
        if text.strip():
            result.append({"type": "input_text", "text": text.strip()})
    return result
