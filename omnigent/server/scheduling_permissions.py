# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Ask the calling session's assigned runner for its current execution authority."""

from __future__ import annotations

import logging
from urllib.parse import quote

import httpx

from omnigent.entities import Conversation
from omnigent.native.child_controls import (
    NATIVE_CHILD_HEADER,
    native_child_mapping,
    native_child_provider,
)
from omnigent.policies.builtins.safety import SCHEDULED_TASK_APPROVAL_TOOLS
from omnigent.runner.routing import RunnerRouter
from omnigent.spec.types import Phase

_logger = logging.getLogger(__name__)


async def scheduling_full_access(
    conversation: Conversation, phase: Phase, tool: str | None, runner_router: RunnerRouter | None
) -> bool:
    if phase != Phase.TOOL_CALL or tool not in SCHEDULED_TASK_APPROVAL_TOOLS:
        return False
    from omnigent.server.routes._sessions.helpers import _get_runner_client

    session_id = conversation.id
    child = native_child_provider(conversation.kind, conversation.labels)
    owner_id = conversation.parent_conversation_id if child else session_id
    if not owner_id or not conversation.runner_id:
        return False
    client = await _get_runner_client(owner_id, runner_router)
    if client is None:
        return False
    path = f"/v1/sessions/{quote(owner_id, safe='')}"
    headers = {}
    if child:
        path += f"/native-children/{quote(session_id, safe='')}"
        headers[NATIVE_CHILD_HEADER] = native_child_mapping(conversation)
    try:
        response = await client.get(
            f"{path}/current-turn/scheduling-permissions", headers=headers, timeout=3
        )
        if response.status_code != 200:
            return False
        result = response.json()
    except (httpx.HTTPError, ValueError, OSError):
        _logger.info("Scheduling permission unavailable for %s", session_id, exc_info=True)
        return False
    return isinstance(result, dict) and (
        result.get("session_id") == session_id
        and result.get("runner_id") == conversation.runner_id
        and result.get("full_access") is True
    )
