# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Shared child identity and task projection, independent of transport and UI."""

from omnigent.entities import Conversation
from omnigent.entities.conversation import synthesize_conversation_title


def short_task(prompt: str) -> str | None:
    """Use the recorded delegation input, never inherited conversation history."""
    return synthesize_conversation_title([{"type": "input_text", "text": prompt}], limit=120)


def child_metadata(child: Conversation) -> dict[str, str]:
    """Separate native names, roles, task summaries and full input."""
    labels = child.labels
    native_name = labels.get("omnigent.codex_native.agent_nickname") or labels.get(
        "omnigent.claude_native.agent_name"
    )
    role = (
        labels.get("omnigent.codex_native.agent_role")
        or labels.get("omnigent.antigravity_native.agent_role")
        or child.sub_agent_name
    )
    title = child.title or ""
    if not role and ":" in title and not title.startswith("codex-native-ui-subagent:"):
        role = title.split(":")[1] if title.startswith("ui:") else title.rpartition(":")[0]
    prompt = labels.get("omnigent.codex_native.prompt") or labels.get(
        "omnigent.claude_native.prompt"
    )
    summary = (
        child.task_summary
        or labels.get("omnigent.claude_native.description")
        or (short_task(prompt) if prompt else None)
    )
    metadata = {
        "agent_name": native_name or role or "Agent",
        "agent_name_source": "native" if native_name else "role" if role else "unknown",
    }
    for key, value in (
        ("agent_role", role),
        ("task_summary", summary),
        ("task_input", prompt),
        ("native_thread_id", labels.get("omnigent.codex_native.subagent_thread_id")),
        ("native_task_id", labels.get("omnigent.claude_native.subagent_id")),
        (
            "dispatch_id",
            labels.get("omnigent.codex_native.collab_tool_call_id")
            or labels.get("omnigent.claude_native.tool_use_id"),
        ),
    ):
        if value:
            metadata[key] = value
    return metadata
