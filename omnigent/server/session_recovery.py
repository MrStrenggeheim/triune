"""Authoritative item replay over the existing bounded session event bus."""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import AsyncGenerator, Awaitable, Callable
from typing import Any

from omnigent.entities.conversation import ConversationItem
from omnigent.runtime import inflight_text, session_stream
from omnigent.stores.conversation_store import ConversationStore

_REPLAY_PAGE_SIZE = 200


class SessionRecovery:
    """Replace canonical membership on resume; retain all non-item state frames."""

    def __init__(
        self,
        store: ConversationStore,
        session_id: str,
        authorize: Callable[[], Awaitable[None]],
        *,
        enabled: bool,
        after_position: int = -1,
        after_revision: int | None = None,
        stream_epoch: str | None = None,
        project: Callable[[list[ConversationItem]], Awaitable[list[ConversationItem]]]
        | None = None,
    ) -> None:
        self.store = store
        self.project = project
        self.session_id = session_id
        self.authorize = authorize
        self.enabled = enabled
        self._replayed: dict[str, bytes] = {}
        self._in_replay = False
        self.after_position = after_position
        self.after_revision = after_revision
        self.after_epoch = stream_epoch
        self._baseline_revision = session_stream.item_revision(session_id)[0]
        self._checkpoint_revision: int | None = None
        self._checkpoint: dict[str, Any] = {}

    @staticmethod
    def _fingerprint(item: dict[str, Any]) -> bytes:
        return hashlib.sha256(json.dumps(item, sort_keys=True).encode()).digest()

    async def events(self) -> AsyncGenerator[dict[str, Any], None]:
        """Read only after registration, failing closed if a replay read fails."""
        await self.authorize()
        revision, reset_revision = session_stream.item_revision(self.session_id)
        checkpoint = await self.checkpoint(revision)
        reset = (
            self.after_position < 0
            or self.after_epoch != inflight_text.stream_epoch()
            or self.after_revision is None
            or self.after_revision > revision
            or self.after_revision < reset_revision
            or self.after_position > checkpoint["last_position"]
        )
        boundary = {
            "type": "session.sync",
            "reset": reset,
            "item_revision": revision,
            "reset_revision": reset_revision,
            **checkpoint,
            "stream_epoch": inflight_text.stream_epoch(),
        }
        yield {**boundary, "phase": "start"}
        after_position = -1 if reset else self.after_position
        while after_position < checkpoint["last_position"]:
            await self.authorize()
            page = await asyncio.to_thread(
                self.store.list_items,
                self.session_id,
                limit=_REPLAY_PAGE_SIZE,
                after_position=after_position,
                through_position=checkpoint["last_position"],
            )
            items = await self.project(page.data) if self.project is not None else page.data
            for saved in items:
                item = saved.to_api_dict()
                self._replayed[saved.id] = self._fingerprint(item)
                yield {"type": "response.output_item.done", "item": item}
            if not page.has_more:
                break
            assert page.data[-1].position is not None
            after_position = page.data[-1].position
        self._baseline_revision = revision
        yield {**boundary, "phase": "complete"}

    async def checkpoint(self, revision: int) -> dict[str, Any]:
        """Read body-free DB summary once per changed revision, never on idle ticks."""
        if revision != self._checkpoint_revision:
            self._checkpoint = await asyncio.to_thread(self.store.item_checkpoint, self.session_id)
            self._checkpoint_revision = revision
        return self._checkpoint

    async def prepare(self, event: dict[str, Any]) -> dict[str, Any] | None:
        """Add canonical metadata and dedup replay overlap without losing mutations."""
        event_type = event.get("type")
        if event_type == "session.sync":
            self._in_replay = event.get("phase") == "start"
            return event
        if self._in_replay:
            return event
        if event_type == "session.heartbeat":
            await self.authorize()
            revision, reset_revision = session_stream.item_revision(self.session_id)
            return {
                **event,
                **await self.checkpoint(revision),
                "item_revision": revision,
                "reset_revision": reset_revision,
                "stream_epoch": inflight_text.stream_epoch(),
                "reconcile_required": self.enabled and revision != self._baseline_revision,
            }
        if event_type not in {
            "response.output_item.done",
            "response.output_item.updated",
            "session.input.consumed",
        }:
            return event
        consumed = event_type == "session.input.consumed"
        payload = event.get("data" if consumed else "item")
        if not isinstance(payload, dict):
            return event
        item_id = payload.get("item_id" if consumed else "id")
        if not isinstance(item_id, str):
            return event
        saved = await asyncio.to_thread(self.store.get_item, self.session_id, item_id)
        if saved is None:
            # A reset replay must not resurrect a removed item from the queued tail.
            return (
                None
                if self.enabled
                and (payload.get("position") is not None or event_type == "session.input.consumed")
                else event
            )
        if consumed:
            return {
                **event,
                "data": {
                    **payload,
                    "position": saved.position,
                    "type": saved.type,
                    "data": saved.data.model_dump(),
                    "created_by": saved.created_by,
                },
            }
        # A stale queued commit can follow a newer replayed update.
        if self.project is not None:
            [saved] = await self.project([saved])
        item = saved.to_api_dict()
        fingerprint = self._fingerprint(item)
        if self._replayed.get(item_id) == fingerprint:
            return None
        self._replayed.pop(item_id, None)
        return {**event, "item": item}
