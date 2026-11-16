"""Authorized durable follow-up queue operations.

SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from omnigent.server.auth import LEVEL_EDIT, LEVEL_READ
from omnigent.server.message_queue import DurableMessageQueue, execution_scope
from omnigent.server.queue_attachments import require_queue_file_visible
from omnigent.server.routes._auth_helpers import require_access_and_level, require_user
from omnigent.server.schemas import SessionEventInput


class QueuedInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    command: Literal["compact"] | None = None
    queueId: str = Field(min_length=1, max_length=128)
    stableId: str = Field(pattern=r"^[0-9a-f]{32}$")
    text: str = Field(max_length=1_000_000)
    replyDraft: dict[str, Any] | None = None
    fileMetadata: list[dict[str, Any]] | None = None
    event: SessionEventInput
    hostId: str | None = None
    workspaceRoot: str | None = None
    workspaceRevision: str | None = None
    agentId: str | None = None
    requiresRetry: bool = False


class MoveInput(BaseModel):
    beforeQueueId: str | None = None


def create_message_queue_router(
    queue: DurableMessageQueue,
    *,
    auth_provider: Any,
    permission_store: Any,
    file_store: Any,
) -> APIRouter:
    router = APIRouter(prefix="/sessions/{session_id}/queued-messages")
    conversations = queue.startup.conversations

    async def authorize(user: str | None, session_id: str, level: int = LEVEL_EDIT) -> Any:
        return await require_access_and_level(
            user, session_id, level, permission_store, conversations
        )

    queue.authorize = authorize

    async def actor(request: Request, session_id: str, level: int = LEVEL_EDIT) -> str | None:
        user = require_user(request, auth_provider)
        await authorize(user, session_id, level)
        return user

    async def response(session_id: str, user: str | None) -> dict[str, Any]:
        state = await asyncio.to_thread(queue.store.read, session_id)
        return {
            "data": [
                {
                    **{k: v for k, v in item.items() if k not in {"headers", "scope"}},
                    "serverState": "accepted",
                    "deliveryError": item.get("error"),
                    "requiresRetry": bool(item.get("error")),
                    "dispatching": item["stableId"] == state.get("inflight"),
                }
                for item in state["messages"]
                if item["author"] == user
            ]
        }

    @router.get("")
    async def list_queue(request: Request, session_id: str) -> dict[str, Any]:
        user = await actor(request, session_id, LEVEL_READ)
        await queue.recover(request.app, session_id)
        return await response(session_id, user)

    async def entry(
        request: Request, session_id: str, body: QueuedInput, author: str | None
    ) -> dict[str, Any]:
        event = body.event
        if (
            event.type != "message"
            or event.data.get("role") != "user"
            or event.created_by is not None
        ):
            raise HTTPException(400, "Only user messages can be queued")
        if event.data.get("communication") or event.data.get("origin"):
            raise HTTPException(400, "Queue messages cannot claim another input origin")
        if event.data.get("stable_id") != body.stableId:
            raise HTTPException(400, "Queue identity must match the input identity")
        content = event.data.get("content")
        if not isinstance(content, list) or not content:
            raise HTTPException(400, "Queue a message or attachment")
        text: list[str] = []
        for block in content:
            if not isinstance(block, dict) or block.get("type") not in {
                "input_text",
                "input_file",
                "input_image",
            }:
                raise HTTPException(400, "Unsupported queued content")
            if block["type"] == "input_text":
                if not isinstance(block.get("text"), str):
                    raise HTTPException(400, "Invalid queued text")
                text.append(block["text"])
            else:
                file_id = block.get("file_id")
                stored = (
                    await asyncio.to_thread(file_store.get, file_id, session_id)
                    if isinstance(file_id, str)
                    else None
                )
                if stored is not None:
                    require_queue_file_visible(stored, author)
                if stored is None or stored.session_id != session_id:
                    raise HTTPException(
                        400, "Upload every attachment to this chat before queueing"
                    )
        if body.command and (
            body.text.strip() != "/compact"
            or any(block["type"] != "input_text" for block in content)
        ):
            raise HTTPException(400, "Queued compact must contain only /compact")
        if "\n".join(text) != body.text:
            raise HTTPException(400, "Queue preview must match the full message text")
        conv = await asyncio.to_thread(conversations.get_conversation, session_id)
        if conv is None:
            raise HTTPException(404, "Chat no longer exists")
        scope = execution_scope(conv)
        error = "Review and retry this saved draft." if body.requiresRetry else None
        if (
            (body.hostId is not None and body.hostId != scope["host_id"])
            or (body.workspaceRoot is not None and body.workspaceRoot != scope["workspace"])
            or (
                body.workspaceRevision is not None
                and body.workspaceRevision != scope["workspace_revision"]
            )
            or (body.agentId is not None and body.agentId != scope["agent_id"])
        ):
            error = "Execution scope changed. Edit and review this queued message."
        return {
            **body.model_dump(exclude={"event", "requiresRetry"}),
            "event": event.model_dump(),
            "author": author,
            "scope": scope,
            "headers": {
                "x-omnigent-background-session-titles": request.headers.get(
                    "x-omnigent-background-session-titles", "off"
                )
            },
            "error": error,
        }

    @router.post("", status_code=201)
    async def enqueue(request: Request, session_id: str, body: QueuedInput) -> dict[str, Any]:
        user = await actor(request, session_id)
        saved = await entry(request, session_id, body, user)
        try:
            await queue.enqueue(request.app, session_id, saved)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        return await response(session_id, user)

    async def mutate(
        request: Request,
        session_id: str,
        queue_id: str,
        action: str,
        before: str | None = None,
        replacement: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        user = await actor(request, session_id)
        existing = await asyncio.to_thread(queue.store.read, session_id)
        selected = next((m for m in existing["messages"] if m["queueId"] == queue_id), None)
        reset_failed = False
        if (
            selected
            and selected["author"] == user
            and selected["stableId"] == existing.get("inflight")
        ):
            pending = await asyncio.to_thread(
                conversations.get_item, session_id, selected["stableId"]
            )
            if pending is not None and pending.status == "failed":
                reset_failed = await asyncio.to_thread(
                    conversations.transition_pending_input,
                    session_id,
                    selected["stableId"],
                    expected="failed",
                    status="in_progress" if action == "send" else None,
                )

        def change(state: dict[str, Any], _: Any) -> None:
            item = next((m for m in state["messages"] if m["queueId"] == queue_id), None)
            if item is None:
                if action == "delete":
                    return
                raise HTTPException(409, "Queued message already left the queue")
            if item["author"] != user:
                raise HTTPException(403, "Only the original author can change a queued message")
            if state.get("inflight") == item["stableId"] and reset_failed:
                state["inflight"] = None
            if state.get("inflight") == item["stableId"]:
                # An unsubmitted failure may be retried; an uncertain native submission may not.
                if action != "send" or not item.get("error"):
                    raise HTTPException(
                        409, "Delivery is already in progress; wait for its receipt"
                    )
                raise HTTPException(409, "Check the uncertain delivery before retrying")
            if action == "send":
                if state.get("inflight"):
                    raise HTTPException(409, "Another queued delivery is in progress")
                item["error"] = None
                state["messages"].remove(item)
                state["messages"].insert(0, item)
                state["ready"] = True
                state["selected_turn"] = state.get("turn")
            elif action == "edit":
                assert replacement is not None
                if replacement["stableId"] != item["stableId"]:
                    raise HTTPException(409, "An edit must retain the input identity")
                item.update(replacement)
            elif action == "delete":
                state["messages"].remove(item)
            elif action == "move":
                target = next((m for m in state["messages"] if m["queueId"] == before), None)
                if before is not None and (target is None or target["author"] != user):
                    raise HTTPException(409, "Reorder target no longer exists")
                if target is item:
                    return
                own = [
                    message
                    for message in state["messages"]
                    if message["author"] == user and message is not item
                ]
                own.insert(own.index(target) if target else len(own), item)
                ordered = iter(own)
                state["messages"] = [
                    next(ordered) if message["author"] == user else message
                    for message in state["messages"]
                ]

        await asyncio.to_thread(queue.store.mutate, session_id, action, change)
        if action == "send":
            await queue.recover(request.app, session_id)
        elif action == "delete":
            await queue.retire_if_empty(request.app, session_id)
        return await response(session_id, user)

    @router.delete("/{queue_id}")
    async def remove(request: Request, session_id: str, queue_id: str) -> dict[str, Any]:
        return await mutate(request, session_id, queue_id, "delete")

    @router.patch("/{queue_id}")
    async def edit(
        request: Request, session_id: str, queue_id: str, body: QueuedInput
    ) -> dict[str, Any]:
        user = await actor(request, session_id)
        return await mutate(
            request,
            session_id,
            queue_id,
            "edit",
            replacement=await entry(request, session_id, body, user),
        )

    @router.post("/{queue_id}/move")
    async def move(
        request: Request, session_id: str, queue_id: str, body: MoveInput
    ) -> dict[str, Any]:
        return await mutate(request, session_id, queue_id, "move", body.beforeQueueId)

    @router.post("/{queue_id}/send")
    async def send(request: Request, session_id: str, queue_id: str) -> dict[str, Any]:
        return await mutate(request, session_id, queue_id, "send")

    return router
