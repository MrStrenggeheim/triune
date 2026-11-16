# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Shared child identity and task projection, independent of transport and UI."""

import re

from omnigent.entities import Conversation


def short_task(prompt: str) -> str | None:
    """Accept a short parent-provided heading; semantic naming handles full instructions."""
    lines = prompt.strip().splitlines()
    if not lines or (len(lines) > 1 and lines[1].strip()):
        return None
    heading = lines[0].strip().lstrip("# ").rstrip(".: ")
    if len(heading) > 60 or len(heading.split()) > 9:
        return None
    if re.match(
        r"(?i)^(please|you|do|work|implement|fix|update|read|inspect|check|review)\b", heading
    ):
        return None
    return display_task_summary(heading)


def display_task_summary(summary: str | None) -> str | None:
    """Format identifier-like adapter labels without changing authored summaries."""
    if not summary or re.fullmatch(r"[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+", summary) is None:
        return summary[:1].upper() + summary[1:] if summary else None
    words = summary.split("_")
    if not words[0].isupper():
        words[0] = words[0][:1].upper() + words[0][1:].lower()
    return " ".join(
        word if index == 0 or word.isupper() else word.lower() for index, word in enumerate(words)
    )


def meaningful_task_summary(value: str | None) -> str | None:
    """A pending display label cannot override a completed semantic summary."""
    if not value or len(value.strip()) > 80 or len(value.strip().splitlines()) != 1:
        return None
    if value.strip().casefold() in {"delegated task", "sub-agent", "subagent", "agent"}:
        return None
    return value


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
    summary = display_task_summary(
        meaningful_task_summary(labels.get("omnigent.subagent.task_summary"))
        or meaningful_task_summary(labels.get("omnigent.codex_native.task_name"))
        or meaningful_task_summary(child.task_summary)
        or meaningful_task_summary(labels.get("omnigent.claude_native.description"))
        or (short_task(prompt) if prompt else None)
    )
    metadata = {
        "agent_name": native_name or role or "Agent",
        "agent_name_source": "native" if native_name else "role" if role else "unknown",
    }
    for key, value in (
        ("agent_role", role),
        ("task_summary", summary),
        (
            "card_summary",
            meaningful_task_summary(labels.get("omnigent.subagent.card_summary"))
            or meaningful_task_summary(child.task_summary),
        ),
        ("task_input", prompt),
        ("native_thread_id", labels.get("omnigent.codex_native.subagent_thread_id")),
        ("native_task_id", labels.get("omnigent.claude_native.subagent_id")),
        (
            "dispatch_id",
            labels.get("omnigent.subagent.dispatch_id")
            or labels.get("omnigent.codex_native.collab_tool_call_id")
            or labels.get("omnigent.claude_native.tool_use_id"),
        ),
    ):
        if value:
            metadata[key] = value
    return metadata
