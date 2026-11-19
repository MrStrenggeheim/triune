"""After-turn admission using the existing durable startup-input dispatcher.

SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any
from uuid import uuid4

from fastapi import HTTPException
from starlette.datastructures import Headers

from omnigent.db.db_models import current_workspace_id, workspace_scope
from omnigent.entities.conversation import Conversation
from omnigent.errors import OmnigentError
from omnigent.release_admission import defer_during_update
from omnigent.runtime import pending_elicitations, session_stream
from omnigent.server.message_queue_store import MessageQueueStore
from omnigent.server.schemas import SessionEventInput
from omnigent.server.startup_inputs import ManagedStartupInputs, StartupInputContext, input_content
from omnigent.stores.conversation_store import (
    PENDING_INPUT_RESPONSE_ID,
    RETAINED_STARTUP_RESPONSE_ID,
)

_logger = logging.getLogger(__name__)


def execution_scope(conv: Conversation) -> dict[str, Any]:
    return {
        "host_id": conv.host_id,
        "agent_id": conv.agent_id,
        "workspace": conv.workspace,
        "workspace_revision": (conv.workspace_transition or {}).get("id"),
        "reasoning_effort": conv.reasoning_effort,
        "model_override": conv.model_override,
        "harness_override": conv.harness_override,
    }


class DurableMessageQueue:
    def __init__(self, startup: ManagedStartupInputs) -> None:
        self.startup = startup
        self.store = MessageQueueStore(startup.conversations.storage_location)
        self.authorize: Any = None
        self._observers: dict[tuple[int, str], asyncio.Task[None]] = {}
        self._status_generations: dict[tuple[int, str], object] = {}
        self._closing = False

    def begin_status(self, session_id: str) -> object:
        """Capture publication order before lifecycle forwarding can await another request."""
        generation = object()
        self._status_generations[(current_workspace_id(), session_id)] = generation
        return generation

    async def enqueue(self, app: Any, session_id: str, entry: dict[str, Any]) -> None:
        from omnigent.server.routes._sessions.common import (
            _session_active_response_cache,
            _session_status_cache,
        )

        conv = await asyncio.to_thread(self.startup.conversations.get_conversation, session_id)
        if conv is None:
            raise ValueError("Chat no longer exists")
        status = _session_status_cache.get(session_id, conv.live_status)
        turn = _session_active_response_cache.get(session_id)

        def accept(state: dict[str, Any], _: Any) -> None:
            existing = next(
                (m for m in state["messages"] if m["stableId"] == entry["stableId"]), None
            )
            if existing:
                if any(existing.get(k) != entry.get(k) for k in ("event", "author", "scope")):
                    raise ValueError("This input id already belongs to a different queued message")
                return
            if len(state["messages"]) >= 100:
                raise ValueError("Queue has reached its 100-message limit")
            if not state["messages"] and not state["inflight"]:
                state["turn"] = turn or state.get("turn")
                state["ready"] = status == "idle" and not conv.pending_elicitation_count
            state["messages"].append(entry)

        await asyncio.to_thread(self.store.mutate, session_id, "enqueue", accept)
        self.watch(app, session_id)
        await self.recover(app, session_id)

    async def status(
        self,
        app: Any,
        session_id: str,
        status: str,
        response_id: str | None,
        *,
        generation: object | None = None,
    ) -> None:
        key = (current_workspace_id(), session_id)
        generation = generation if generation is not None else self.begin_status(session_id)

        def observe(state: dict[str, Any], _: Any) -> bool:
            if self._closing or self._status_generations.get(key) is not generation:
                return False
            if status == "running":
                if response_id and response_id == state.get("turn") and state.get("ended"):
                    return False
                turn = (
                    response_id
                    or (uuid4().hex if state.get("ended") else state.get("turn"))
                    or uuid4().hex
                )
                if turn != state.get("turn") or state.get("ended"):
                    state["turn"] = turn
                    state["ended"] = False
                    state["ready"] = False
                    if response_id != state.get("selected_turn"):
                        state.pop("selected_turn", None)
            elif status == "idle":
                if state.get("selected_turn") and response_id == state["selected_turn"]:
                    return False
                # Duplicate/stale completion and transcript inactivity cannot mint admission.
                control = response_id is not None and response_id == state.get("control_turn")
                if (state.get("ended") and not control) or (
                    response_id and state.get("turn") not in (None, response_id) and not control
                ):
                    return False
                state["turn"] = response_id or state.get("turn")
                state["ended"] = True
                state["ready"] = True
                if control:
                    state.pop("control_turn", None)
            elif status == "failed":
                if (state.get("selected_turn") and response_id == state["selected_turn"]) or (
                    response_id
                    and state.get("turn") not in (None, response_id)
                    and response_id != state.get("control_turn")
                ):
                    return False
                state["ready"] = False
                state["ended"] = True
                if response_id == state.get("control_turn"):
                    state.pop("control_turn", None)
                for message in state["messages"]:
                    if message["stableId"] != state["inflight"]:
                        message["error"] = "Previous turn failed. Review and retry this message."

            return True

        try:
            applied = await asyncio.to_thread(
                self.store.mutate, session_id, "turn_status", observe, create=False
            )
        finally:
            if self._status_generations.get(key) is generation:
                self._status_generations.pop(key, None)
        if applied and status == "idle":
            await self.recover(app, session_id)

    def watch(self, app: Any, session_id: str) -> None:
        key = (current_workspace_id(), session_id)
        if self._closing or key in self._observers:
            return

        async def observe() -> None:
            try:
                async for event in session_stream.subscribe(session_id, internal=True):
                    kind = event.get("type")
                    if not isinstance(kind, str):
                        continue
                    compaction = kind.startswith("response.compaction.")
                    if not compaction and kind not in {
                        "response.created",
                        "response.in_progress",
                        "response.cancelled",
                        "response.incomplete",
                        "response.completed",
                        "response.failed",
                        "session.status",
                    }:
                        continue
                    state = await asyncio.to_thread(self.store.read, session_id)
                    if not state["messages"] and not state.get("control_turn"):
                        return
                    if compaction:
                        await self.compaction_status(app, session_id, kind.rsplit(".", 1)[-1])
                        state = await asyncio.to_thread(self.store.read, session_id)
                        if not state["messages"] and not state.get("control_turn"):
                            return
                        continue
                    # Native terminal completion is admitted by routes_events, not PTY idle.
                    conv = await asyncio.to_thread(
                        self.startup.conversations.get_conversation, session_id
                    )
                    if conv is None:
                        continue
                    from omnigent.server.routes._sessions.orchestration import (
                        _is_native_terminal_session,
                    )

                    if _is_native_terminal_session(conv):
                        continue
                    response = event.get("response") or {}
                    response_id = response.get("id") or event.get("response_id")
                    if kind in {"response.created", "response.in_progress"}:
                        await self.status(app, session_id, "running", response_id)
                    elif kind == "response.completed":
                        await self.status(app, session_id, "idle", response_id)
                    elif kind in {
                        "response.failed",
                        "response.cancelled",
                        "response.incomplete",
                    } or (kind == "session.status" and event.get("status") == "failed"):
                        await self.status(app, session_id, "failed", response_id)
                    state = await asyncio.to_thread(self.store.read, session_id)
                    if not state["messages"] and not state.get("control_turn"):
                        return
            except asyncio.CancelledError:
                raise
            except Exception:
                _logger.exception("Unable to observe queued turns for %s", session_id)
            finally:
                if self._observers.get(key) is asyncio.current_task():
                    self._observers.pop(key, None)

        self._observers[key] = asyncio.create_task(observe(), name=f"queued-turn-{session_id}")

    async def retire_if_empty(self, app: Any, session_id: str) -> None:
        """Detach an empty queue, retaining observation if enqueue races cancellation."""
        state = await asyncio.to_thread(self.store.read, session_id)
        if state["messages"] or state.get("control_turn"):
            return
        key = (current_workspace_id(), session_id)
        task = self._observers.get(key)
        if task is None or task is asyncio.current_task():
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        if self._observers.get(key) is task:
            self._observers.pop(key, None)
        state = await asyncio.to_thread(self.store.read, session_id)
        if state["messages"] or state.get("control_turn"):
            self.watch(app, session_id)

    async def preflight(self, session_id: str, message: dict[str, Any]) -> str | None:
        conv = await asyncio.to_thread(self.startup.conversations.get_conversation, session_id)
        if conv is None or execution_scope(conv) != message["scope"]:
            return "Execution scope changed. Edit and review this queued message."
        if conv.workspace_transition and conv.workspace_transition.get("blocked"):
            return "Workspace change is pending. Review this queued message."
        if conv.pending_elicitation_count or pending_elicitations.count_for(session_id):
            return "An unanswered question or approval is pending. Retry after resolving it."
        try:
            if self.authorize is None:
                raise ValueError("Queue authorization is unavailable")
            await self.authorize(message["author"], session_id)
        except (OmnigentError, HTTPException, ValueError):
            return "Queue author no longer has permission to send. Review this message."
        return None

    async def hold(self, session_id: str, stable_id: str, error: str) -> None:
        def change(state: dict[str, Any], _: Any) -> None:
            for message in state["messages"]:
                if message["stableId"] == stable_id:
                    message["error"] = error

        await asyncio.to_thread(self.store.mutate, session_id, "hold", change)

    @defer_during_update()
    async def recover(self, app: Any, session_id: str) -> None:
        if self._closing:
            return
        state = await asyncio.to_thread(self.store.read, session_id)
        if not state["messages"]:
            await self.retire_if_empty(app, session_id)
            return
        self.watch(app, session_id)
        inflight = state.get("inflight")
        if inflight:
            item = await asyncio.to_thread(
                self.startup.conversations.get_item, session_id, inflight
            )
            if item is not None and item.response_id == RETAINED_STARTUP_RESPONSE_ID:
                await self.hold(
                    session_id,
                    inflight,
                    "Startup stopped. Restore the saved input to send it again.",
                )
                return
            if item is not None and item.response_id != PENDING_INPUT_RESPONSE_ID:

                def consumed(state: dict[str, Any], _: Any) -> None:
                    if state["inflight"] == inflight:
                        state["messages"] = [
                            m for m in state["messages"] if m["stableId"] != inflight
                        ]
                        state["inflight"] = None

                await asyncio.to_thread(self.store.mutate, session_id, "receipt", consumed)
                state = await asyncio.to_thread(self.store.read, session_id)
            elif item is not None and item.status in {"incomplete", "failed"}:
                if item.status == "failed":
                    await self.hold(
                        session_id, inflight, "Delivery failed. Review and retry this message."
                    )
                return
        if not state["messages"]:
            await self.retire_if_empty(app, session_id)
            return
        message = next(
            (m for m in state["messages"] if m["stableId"] == state.get("inflight")),
            state["messages"][0],
        )
        if message.get("error"):
            return
        error = await self.preflight(session_id, message)
        if error:
            await self.hold(session_id, message["stableId"], error)
            return
        conv = await asyncio.to_thread(self.startup.conversations.get_conversation, session_id)
        if conv is not None and conv.host_id and self.startup.hosts.get(conv.host_id) is None:
            return

        def claim(state: dict[str, Any], _: Any) -> bool:
            if state.get("inflight"):
                return state["inflight"] == message["stableId"]
            if (
                not state.get("ready")
                or not state["messages"]
                or state["messages"][0]["stableId"] != message["stableId"]
            ):
                return False
            if state["messages"][0].get("error"):
                return False
            state["inflight"] = message["stableId"]
            state["ready"] = False
            if message.get("command") == "compact":
                state["control_turn"] = f"compact:{message['stableId']}"
                state["turn"] = state["control_turn"]
                state["ended"] = False
            return True

        if not await asyncio.to_thread(self.store.mutate, session_id, "claim", claim):
            return
        try:
            item = await asyncio.to_thread(
                self.startup.conversations.get_item, session_id, message["stableId"]
            )
            if item is None:
                try:
                    item = await self.startup.enqueue(
                        session_id,
                        SessionEventInput.model_validate(message["event"]),
                        user_id=message["author"],
                        headers=Headers(message.get("headers", {})),
                        first=False,
                    )
                except OmnigentError:
                    # Another replica may have submitted and committed the same input.
                    item = await asyncio.to_thread(
                        self.startup.conversations.get_item, session_id, message["stableId"]
                    )
                    if item is None:
                        raise
            expected_author = None if message["author"] == "local" else message["author"]
            item_author = None if item.created_by == "local" else item.created_by
            if (
                item_author != expected_author
                or input_content(item) != message["event"]["data"]["content"]
            ):
                raise ValueError("Input identity belongs to a different message")
            if item.response_id == RETAINED_STARTUP_RESPONSE_ID:
                await self.hold(
                    session_id,
                    message["stableId"],
                    "Startup stopped. Restore the saved input to send it again.",
                )
            elif item.response_id != PENDING_INPUT_RESPONSE_ID:
                await self.recover(app, session_id)
            elif item.status == "in_progress":
                self.startup.schedule_delivery(app, session_id, item)
        except Exception as exc:
            await self.hold(session_id, message["stableId"], f"Delivery failed: {str(exc)[:300]}")
            _logger.exception("Unable to admit queued message for %s", session_id)

    async def compaction_status(self, app: Any, session_id: str, status: str) -> None:
        state = await asyncio.to_thread(self.store.read, session_id)
        token = state.get("control_turn")
        if token:
            await self.status(
                app,
                session_id,
                {"in_progress": "running", "completed": "idle", "failed": "failed"}[status],
                token,
            )

    async def recover_all(self, app: Any) -> None:
        """One startup scan; host recovery continues through ManagedStartupInputs."""
        for workspace_id, session_id in await asyncio.to_thread(self.store.session_ids):
            with workspace_scope(workspace_id):
                await self.recover(app, session_id)

    async def shutdown(self) -> None:
        self._closing = True
        tasks = list(self._observers.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._observers.clear()
        self._status_generations.clear()


class QueuedStartupInputs(ManagedStartupInputs):
    """Use the existing host-reconnect/startup recovery worker for queued inputs too."""

    def __init__(self, conversations: Any, hosts: Any) -> None:
        super().__init__(conversations, hosts)
        self.message_queue = DurableMessageQueue(self)

    @defer_during_update(False)
    async def _recover_session(self, app: Any, session_id: str, connection: Any) -> bool:
        await self.message_queue.recover(app, session_id)
        return await super()._recover_session(app, session_id, connection)

    @defer_during_update()
    async def _deliver(self, app: Any, session_id: str, item: Any) -> Any:
        if self._closing:
            return None
        state = await asyncio.to_thread(self.message_queue.store.read, session_id)
        queued = next((m for m in state["messages"] if m["stableId"] == item.id), None)
        if queued:
            error = await self.message_queue.preflight(session_id, queued)
            if error or queued.get("error"):
                await self.message_queue.hold(session_id, item.id, error or queued["error"])
                await asyncio.to_thread(
                    self.conversations.transition_pending_input,
                    session_id,
                    item.id,
                    expected="in_progress",
                    status="failed",
                )
                return None
        if queued and queued.get("command") == "compact":
            return await self._deliver_compact(app, session_id, item, queued)
        result = await super()._deliver(app, session_id, item)
        if queued:
            await self.message_queue.recover(app, session_id)
        return result

    async def _deliver_compact(
        self, app: Any, session_id: str, item: Any, queued: dict[str, Any]
    ) -> Any:
        """Control admission shares the native input CAS; uncertain controls are never replayed."""
        from omnigent.runtime import pending_inputs
        from omnigent.server.routes._sessions.helpers import (
            _build_new_item,
            _publish_input_consumed,
        )

        key = (current_workspace_id(), session_id)
        task = asyncio.current_task()
        assert task is not None
        if key in self._deliveries and self._deliveries[key] is not task:
            return None
        self._deliveries[key] = task
        context = StartupInputContext(
            app, Headers(queued.get("headers", {})), item.created_by, item.id
        )
        try:
            if self.dispatch is None or not await context.claim(self.conversations, session_id):
                return None
            result = await self.dispatch(
                context, session_id, SessionEventInput(type="compact", data={})
            )
            event = SessionEventInput(
                type="slash_command",
                data={"kind": "command", "agent": "pending", "name": "compact", "arguments": ""},
            )
            receipt = _build_new_item(
                event, f"queue_control_{item.id}", created_by=item.created_by
            ).model_copy(update={"stable_id": item.id, "replaces_pending_id": item.id})
            [saved] = await asyncio.to_thread(self.conversations.append, session_id, [receipt])
            _publish_input_consumed(
                session_id,
                saved,
                cleared_pending_id=pending_inputs.make_pending_id(session_id, item.id),
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self.message_queue.hold(
                session_id,
                item.id,
                "Compaction delivery could not be confirmed. Check the CLI before retrying.",
            )
            _logger.exception("Unable to deliver queued compact for %s: %s", session_id, exc)
            return None
        finally:
            if self._deliveries.get(key) is task:
                self._deliveries.pop(key, None)
        await self.message_queue.recover(app, session_id)
        return result

    async def shutdown(self) -> None:
        self._closing = True
        await self.message_queue.shutdown()
        await super().shutdown()
