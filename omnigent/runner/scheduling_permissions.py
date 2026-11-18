# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Read the applied execution policy of a live native turn."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import TYPE_CHECKING

from omnigent.harnesses.codex_native.side_chat import current_native_turn_id
from omnigent.native.execution_observation import codex_turn_context

if TYPE_CHECKING:
    from omnigent.harnesses.codex_native.app_server import CodexAppServerClient


async def codex_turn_has_full_access(
    client: CodexAppServerClient,
    thread_id: str,
    codex_home: str,
    expected_turn_id: str | None = None,
    *,
    mapped_child: bool = False,
) -> bool:
    """Check the loaded thread and its exact in-progress turn, never its next-turn settings."""
    response = await client.request("thread/read", {"threadId": thread_id, "includeTurns": False})
    result = response.get("result")
    thread = result.get("thread") if isinstance(result, dict) else None
    if not isinstance(thread, dict) or thread.get("id") != thread_id:
        return False
    status = thread.get("status")
    path = thread.get("path")
    if not isinstance(status, dict) or status.get("type") != "active" or not isinstance(path, str):
        return False
    rollout = Path(path).resolve()
    if not rollout.is_relative_to((Path(codex_home) / "sessions").resolve()):
        return False
    turn_id = await current_native_turn_id(client, thread_id)
    if not turn_id or (expected_turn_id and expected_turn_id != turn_id):
        return False
    context = await asyncio.to_thread(
        codex_turn_context, rollout, turn_id, max_bytes=64 * 1024 * 1024
    )
    if context is None or context.get("approval_policy") != "never":
        return False
    if context.get("sandbox_policy") != {"type": "danger-full-access"} or context.get(
        "permission_profile"
    ) not in (None, {"type": "disabled"}):
        return False
    if mapped_child:
        return True
    # The root MCP relay carries no provider thread ID. Its mode proves the caller's
    # authority only while this runtime serves a single thread.
    loaded = (await client.request("thread/loaded/list", {"limit": 2})).get("result")
    return (
        isinstance(loaded, dict)
        and loaded.get("data") == [thread_id]
        and not loaded.get("nextCursor")
    )
