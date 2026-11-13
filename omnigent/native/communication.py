# Modified for Triune.
"""Translate structured native peer origins without inspecting message text."""

import re
from typing import Any

from omnigent.entities.communication import MessageCommunication

NATIVE_INPUT_CLIENT_ID_PREFIX = "omnigent-input:"


def native_input_stable_id(client_id: object) -> str | None:
    """Decode the structured client ID echoed by Codex, never message text."""
    if not isinstance(client_id, str):
        return None
    match = re.fullmatch(r"omnigent-input:([0-9a-f]{32})", client_id)
    return match.group(1) if match else None


def peer_model_content(
    content: list[dict[str, Any]], origin: MessageCommunication | None
) -> list[dict[str, Any]]:
    """Transport source/correlation to text-only models without changing stored text."""
    if origin is None or origin.kind != "peer":
        return content
    header = (
        f"Peer message from conversation {origin.source_conversation_id}; "
        f"message_id={origin.message_id}."
    )
    if origin.reply_to_message_id:
        header += f" Reply to {origin.reply_to_message_id}."
    return [{"type": "input_text", "text": header}, *content]


def native_peer_metadata(origin: object, message_id: str) -> dict[str, object]:
    """Keep provider identities distinct from unresolved Omnigent conversation IDs."""
    if not isinstance(origin, dict) or origin.get("kind") != "peer":
        return {}
    sender = origin.get("senderAgentId") or origin.get("senderTaskId")
    task = origin.get("senderTaskId")
    return {
        "communication": MessageCommunication(
            kind="native_agent",
            message_id=message_id,
            source_agent_id=sender if isinstance(sender, str) else None,
            destination_conversation_id="",
            task_id=task if isinstance(task, str) else None,
            delivery_state="confirmed",
            receipt="transcript",
        ).model_dump()
    }
