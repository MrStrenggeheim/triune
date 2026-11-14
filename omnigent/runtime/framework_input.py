# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Register framework instructions before transporting them as native model input."""

from __future__ import annotations

import re
from typing import Any

import httpx

from omnigent.entities.communication import MessageCommunication
from omnigent.native.communication import peer_model_content

RECOVERY_INSTRUCTION = (
    "Your runner was interrupted while this task was active. "
    "Continue the existing task from its current state. "
    "Check any interrupted operation's outcome before repeating it."
)


async def register_framework_input(
    server_client: httpx.AsyncClient,
    session_id: str,
    input_id: str,
    text: str,
    label: str,
    response_id: str | None = None,
) -> list[dict[str, Any]]:
    """Persist trusted provenance before a native echo can misattribute the instruction."""
    if re.fullmatch(r"[0-9a-f]{32}", input_id) is None:
        raise ValueError("Framework input requires a stable 32-hex identity")
    origin = MessageCommunication(
        kind="system",
        message_id=input_id,
        source_agent_name="System",
        source_title=label,
        destination_conversation_id=session_id,
        delivery_state="queued",
        receipt="accepted",
    )
    content = [{"type": "input_text", "text": text}]
    response = await server_client.post(
        f"/v1/sessions/{session_id}/events",
        json={
            "type": "external_conversation_item",
            "data": {
                "item_type": "message",
                "item_data": {
                    "role": "user",
                    "content": content,
                    "communication": origin.model_dump(),
                },
                "response_id": response_id or f"framework_{input_id}",
            },
        },
        timeout=10.0,
    )
    response.raise_for_status()
    return peer_model_content(content, origin)
