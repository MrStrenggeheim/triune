# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Authoritative item replay over the existing bounded session event bus."""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import AsyncGenerator, Awaitable, Callable
from typing import Any, cast

from omnigent.entities.conversation import ConversationItem
from omnigent.runtime import inflight_text, session_stream
from omnigent.runtime.stream_queue import MAX_STREAM_BYTES
from omnigent.stores.conversation_store import ConversationStore

_REPLAY_PAGE_SIZE = 200
MAX_INITIAL_LIMIT = 200
MAX_SAFE_POSITION = (1 << 53) - 1


def saved_item_bytes(payload: dict[str, Any]) -> bytes:
    """Canonical HTTP representation shared by the reference and its exact read."""
    return json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()


def saved_event_reference(event: dict[str, Any], session_id: str) -> dict[str, Any]:
    """Keep oversized saved bodies out of either wire queue, preserving the event envelope."""
    kind = event["type"]
    consumed = kind == "session.input.consumed"
    if not consumed and kind not in {"response.output_item.done", "response.output_item.updated"}:
        return event
    fields = event["data"] if consumed else event["item"]
    item_id = fields.get("item_id" if consumed else "id")
    position = fields.get("position")
    if not isinstance(item_id, str) or not isinstance(position, int):
        return event
    # Include both transport envelopes; the SSE encoder also inserts JSON whitespace.
    if (
        len(json.dumps({"type": "session.event", "session_id": session_id, "event": event})) + 64
        <= MAX_STREAM_BYTES
    ):
        return event
    header = dict(event)
    if consumed:
        fields = dict(fields)
        body = fields.pop("data")
        header["data"] = fields
    else:
        body = header.pop("item")
    serialized = saved_item_bytes(body)
    return {
        "type": "session.item_reference",
        "item_id": item_id,
        "position": position,
        "header": header,
        "sha256": hashlib.sha256(serialized).hexdigest(),
        "byte_length": len(serialized),
    }


def validate_sync_complete(session_id: str, event: dict[str, Any]) -> None:
    """A completion queued before a mutation must not become authoritative later."""
    if (
        event.get("type") == "session.sync"
        and event.get("phase") == "complete"
        and (
            event.get("stream_epoch") != inflight_text.stream_epoch()
            or session_stream.item_revision(session_id)[1] > event["item_revision"]
        )
    ):
        raise ConnectionError("Transcript changed before recovery publication")


def valid_window_options(initial_limit: Any, window_start_position: Any) -> bool:
    """Share strict window validation between SSE and WebSocket subscriptions."""
    return (
        initial_limit is None
        or (
            isinstance(initial_limit, int)
            and not isinstance(initial_limit, bool)
            and 1 <= initial_limit <= MAX_SAFE_POSITION
        )
    ) and (
        window_start_position is None
        or (
            initial_limit is not None
            and isinstance(window_start_position, int)
            and not isinstance(window_start_position, bool)
            and 0 <= window_start_position <= MAX_SAFE_POSITION
        )
    )


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
        initial_limit: int | None = None,
        window_start_position: int | None = None,
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
        if not valid_window_options(initial_limit, window_start_position):
            raise ValueError("Invalid transcript window options")
        self.initial_limit = min(initial_limit, MAX_INITIAL_LIMIT) if initial_limit else None
        self.window_start_position = window_start_position
        self._baseline_revision = session_stream.item_revision(session_id)[0]
        self._checkpoint_revision: int | None = None
        self._checkpoint: dict[str, Any] = {}

    async def _window(
        self, highwater: int
    ) -> tuple[dict[str, Any], list[ConversationItem] | None]:
        if self.initial_limit is None:
            return {}, None
        if self.window_start_position is not None:
            await self.authorize()
            summary = await asyncio.to_thread(
                self.store.item_checkpoint,
                self.session_id,
                after_position=self.window_start_position - 1,
                through_position=highwater,
            )
            return {
                "window_start_position": self.window_start_position,
                "window_item_count": summary["item_count"],
                "has_older_items": summary["has_older_items"],
                "first_item_id": summary["first_item_id"],
            }, None
        latest: list[ConversationItem] = []
        through = highwater
        has_older = False
        while len(latest) < self.initial_limit and through >= 0:
            await self.authorize()
            page = await asyncio.to_thread(
                self.store.list_items,
                self.session_id,
                order="desc",
                limit=min(_REPLAY_PAGE_SIZE, self.initial_limit - len(latest)),
                through_position=through,
            )
            latest.extend(page.data)
            has_older = page.has_more
            if not page.has_more:
                break
            assert page.data[-1].position is not None
            through = page.data[-1].position - 1
        latest.reverse()
        self.window_start_position = latest[0].position if latest else 0
        return {
            "window_start_position": self.window_start_position,
            "window_item_count": len(latest),
            "has_older_items": has_older,
            "first_item_id": latest[0].id if latest else None,
        }, latest

    def _check_window_revision(self, revision: int) -> None:
        # Never complete an authoritative range after deletion/promotion changed membership.
        if session_stream.item_revision(self.session_id)[1] > revision:
            raise ConnectionError("Transcript window changed during recovery")

    @staticmethod
    def _fingerprint(item: dict[str, Any]) -> bytes:
        return hashlib.sha256(json.dumps(item, sort_keys=True).encode()).digest()

    async def events(self) -> AsyncGenerator[dict[str, Any], None]:
        """Read only after registration, failing closed if a replay read fails."""
        await self.authorize()
        revision, reset_revision = session_stream.item_revision(self.session_id)
        mutations = (
            session_stream.item_mutations_since(self.session_id, self.after_revision)
            if self.after_revision is not None
            else None
        )
        checkpoint = await self.checkpoint(revision)
        reset = (
            self.after_position < 0
            or self.after_epoch != inflight_text.stream_epoch()
            or self.after_revision is None
            or self.after_revision > revision
            or (self.after_revision < reset_revision and mutations is None)
            or self.after_position > checkpoint["last_position"]
        )
        window, latest = await self._window(checkpoint["last_position"])
        if window:
            self._check_window_revision(revision)
        boundary = {
            "type": "session.sync",
            "reset": reset,
            "item_revision": revision,
            "reset_revision": reset_revision,
            **checkpoint,
            **window,
            "stream_epoch": inflight_text.stream_epoch(),
        }
        yield {**boundary, "phase": "start"}
        if not reset:
            for item_id in mutations or ():
                await self.authorize()
                saved = await asyncio.to_thread(self.store.get_item, self.session_id, item_id)
                if saved is None or saved.position is None or saved.position > self.after_position:
                    continue
                if window and saved.position < window["window_start_position"]:
                    continue
                items = await self.project([saved]) if self.project is not None else [saved]
                for saved in items:
                    item = saved.to_api_dict()
                    self._replayed[saved.id] = self._fingerprint(item)
                    yield {"type": "response.output_item.done", "item": item}
        after_position = -1 if reset else self.after_position
        if window:
            after_position = max(after_position, window["window_start_position"] - 1)
        expected_count = (
            window.get("window_item_count", checkpoint["item_count"])
            if reset
            else (
                await asyncio.to_thread(
                    self.store.item_checkpoint,
                    self.session_id,
                    after_position=after_position,
                    through_position=checkpoint["last_position"],
                )
            )["item_count"]
        )
        replayed_count = 0
        if latest is not None:
            await self.authorize()
            # Persisted window rows already have canonical positions.
            selected = [item for item in latest if cast(int, item.position) > after_position]
            items = await self.project(selected) if self.project is not None else selected
            for saved in items:
                item = saved.to_api_dict()
                self._replayed[saved.id] = self._fingerprint(item)
                replayed_count += 1
                yield {"type": "response.output_item.done", "item": item}
            after_position = checkpoint["last_position"]
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
                replayed_count += 1
                yield {"type": "response.output_item.done", "item": item}
            if not page.has_more:
                break
            assert page.data[-1].position is not None
            after_position = page.data[-1].position
        self._check_window_revision(revision)
        if replayed_count != expected_count:
            raise ConnectionError("Transcript membership changed during recovery")
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
            if event.get("_requires_saved_item"):
                raise session_stream.SubscriberEventTooLargeError
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
        if (
            self.initial_limit is not None
            and self.window_start_position is not None
            and saved.position is not None
            and saved.position < self.window_start_position
        ):
            return None
        # A stale queued commit can follow a newer replayed update.
        if self.project is not None:
            [saved] = await self.project([saved])
        item = saved.to_api_dict()
        fingerprint = self._fingerprint(item)
        if self._replayed.get(item_id) == fingerprint:
            return None
        self._replayed.pop(item_id, None)
        return {**event, "item": item}
