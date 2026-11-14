# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Shared shell identity, bounded captured output and truthful action routes."""

from __future__ import annotations

from urllib.parse import quote

from omnigent.entities.session_resources import terminal_resource_id
from omnigent.harness_aliases import NATIVE_HARNESSES, is_native_harness, native_terminal_name
from omnigent.inner.terminal import _strip_ansi
from omnigent.terminals.history import bounded_output
from omnigent.util.json_types import JsonObject

MAX_SHELL_RESOURCES = 100
MAX_OUTPUT_PREVIEW_CHARS = 512
SHELL_SOURCES = frozenset({"codex_native", "claude_native", "registered_terminal"})
ENDED_SHELL_STATUSES = frozenset(
    {"completed", "failed", "declined", "stopped", "killed", "exited"}
)
_PRIMARY_AGENT_TERMINAL_IDS = frozenset(
    terminal_resource_id(name, "main")
    for name in (
        "tui",
        *(native_terminal_name(harness) for harness in NATIVE_HARNESSES),
    )
    if name
)


def is_agent_terminal_resource(terminal_id: str | None, resource_role: str | None = None) -> bool:
    """Exclude agent roles and reserved primary slots independently of lifecycle ownership."""
    return (
        terminal_id in _PRIMARY_AGENT_TERMINAL_IDS
        or resource_role == "omnigent-repl"
        or is_native_harness(resource_role)
    )


def shell_resource_path(session_id: str, source: str, resource_id: str) -> str:
    """Address an opaque resource without converting its identity to a process id."""
    if source not in SHELL_SOURCES or not session_id or not resource_id:
        raise ValueError("A shell resource needs a session, known source and stable id")
    base = f"/v1/sessions/{quote(session_id, safe='')}/resources"
    return f"{base}/shells/{source}/{quote(resource_id, safe='')}"


def shell_output_preview(output: str | None) -> str | None:
    """Return the last captured nonempty line, with shared redaction and limits."""
    captured = bounded_output(output)
    if not captured:
        return None
    lines = _strip_ansi(captured).splitlines()
    return next(
        (line.strip()[-MAX_OUTPUT_PREVIEW_CHARS:] for line in reversed(lines) if line.strip()),
        None,
    )


def shell_resource_fields(
    *,
    source: str,
    resource_id: str,
    session_id: str | None,
    output: str | None = None,
    can_stop: bool = False,
    stop_disabled_reason: str | None = None,
) -> JsonObject:
    """Publish explicit routes; callers must prove controls against the owning runtime."""
    route = shell_resource_path(session_id, source, resource_id) if session_id else None
    fields: JsonObject = {
        "session_id": session_id,
        "source": source,
        "resource_id": resource_id,
        "output_preview": shell_output_preview(output),
        "resource_url": route,
        "can_open": route is not None,
        "can_stop": can_stop and route is not None,
        "stop_disabled_reason": None if can_stop and route else stop_disabled_reason,
        "stop_url": None,
        "stop_method": None,
    }
    if can_stop and route:
        fields["stop_url"] = f"{route}/stop"
        fields["stop_method"] = "POST"
    return fields
