# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Authoritative item replay over the existing bounded session event bus."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
from collections.abc import AsyncGenerator, Awaitable, Callable
from typing import Any, Literal, cast

from pydantic import BaseModel

from omnigent.entities.branch import ConversationBranch
from omnigent.entities.conversation import ConversationItem
from omnigent.runtime import inflight_text, session_stream
from omnigent.runtime.stream_queue import MAX_STREAM_BYTES
from omnigent.stores.conversation_store import ConversationStore
from omnigent.stores.conversation_store.transcript_journal import TranscriptJournal


class SnapshotPage(BaseModel):
    """Negotiated WebSocket batch; rows use the ordinary saved-item parser."""

    type: Literal["session.snapshot_page"]
    items: list[dict[str, Any]]


_SNAPSHOT_MARKER = object()
_SNAPSHOT_PAGE_BYTES = 256 * 1024
_SNAPSHOT_PAGE_ROWS = 32


def is_snapshot_page(event: dict[str, Any]) -> bool:
    return event.get("_snapshot_marker") is _SNAPSHOT_MARKER


_REPLAY_PAGE_SIZE = 200
MAX_INITIAL_LIMIT = 200
MAX_SAFE_POSITION = (1 << 53) - 1


def saved_item_bytes(payload: dict[str, Any]) -> bytes:
    """Canonical HTTP representation shared by the reference and its exact read."""
    return json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()


def saved_event_reference(
    event: dict[str, Any], session_id: str, *, feed_v2: bool = False
) -> dict[str, Any]:
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
    if feed_v2 and not consumed and body.get("type") == "function_call_output":
        # Preserve row identity and call linkage while its immutable body loads separately.
        header["tool_output"] = {
            key: body[key]
            for key in ("id", "position", "type", "status", "created_at", "response_id", "call_id")
            if key in body
        }
    serialized = saved_item_bytes(body)
    return {
        "type": "session.item_reference",
        "item_id": item_id,
        "position": position,
        "header": header,
        "sha256": hashlib.sha256(serialized).hexdigest(),
        "byte_length": len(serialized),
    }


def feed_epoch() -> str:
    return "feed2:" + inflight_text.stream_epoch()


def validate_sync_complete(session_id: str, event: dict[str, Any]) -> None:
    """A completion queued before a mutation must not become authoritative later."""
    if event.get("type") != "session.sync" or event.get("phase") != "complete":
        return
    epoch = event.get("stream_epoch")
    if epoch == feed_epoch():
        if session_stream.item_revision(session_id)[1] > event["_publication_revision"]:
            raise ConnectionError("Transcript changed before recovery publication")
    elif epoch != inflight_text.stream_epoch() or (
        session_stream.item_revision(session_id)[1] > event["item_revision"]
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
        journal: TranscriptJournal | None = None,
        branch: ConversationBranch | None = None,
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
        self.journal = journal
        self.branch = branch
        self.epoch = feed_epoch() if journal is not None else inflight_text.stream_epoch()
        self._replayed: dict[str, bytes] = {}
        self._replayed_native_messages: set[str] = set()
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
        """Batch bounded v2 replay rows while preserving sync and reference boundaries."""
        rows: list[dict[str, Any]] = []
        size = 0
        async with contextlib.aclosing(self._events()) as events:
            async for event in events:
                item = (
                    event.get("item")
                    if (self.journal is not None and event["type"] == "response.output_item.done")
                    else None
                )
                if (
                    item is not None
                    and item.get("type") == "message"
                    and item.get("role") == "assistant"
                ):
                    message_id = item.get("stream_message_id")
                    if isinstance(message_id, str) and message_id:
                        self._replayed_native_messages.add(message_id)
                cost = len(json.dumps(item)) if item is not None else 0
                if rows and (
                    item is None
                    or len(rows) >= _SNAPSHOT_PAGE_ROWS
                    or size + cost > _SNAPSHOT_PAGE_BYTES
                ):
                    yield {
                        "type": "session.snapshot_page",
                        "items": rows,
                        "_snapshot_marker": _SNAPSHOT_MARKER,
                    }
                    rows, size = [], 0
                if item is None or cost > _SNAPSHOT_PAGE_BYTES:
                    yield event
                else:
                    rows.append(item)
                    size += cost
        if rows:
            yield {
                "type": "session.snapshot_page",
                "items": rows,
                "_snapshot_marker": _SNAPSHOT_MARKER,
            }

    async def _events(self) -> AsyncGenerator[dict[str, Any], None]:
        """Read only after registration, failing closed if a replay read fails."""
        await self.authorize()
        process_revision = session_stream.item_revision(self.session_id)[0]
        if self.journal is not None:
            changes = await asyncio.to_thread(self.journal.changes, self.session_id, -1)
            revision = changes[-1].revision if changes else 0
            # The retained floor is a reset boundary for cursors older than the log.
            reset_revision = max(
                [changes[0].revision - 1 if changes else 0]
                + [c.revision for c in changes if c.resets_window]
            )
            mutations = (
                tuple(
                    dict.fromkeys(c.item_id for c in changes if c.revision > self.after_revision)
                )
                if self.after_revision is not None and self.after_revision >= reset_revision
                else None
            )
        else:
            revision, reset_revision = session_stream.item_revision(self.session_id)
            mutations = (
                session_stream.item_mutations_since(self.session_id, self.after_revision)
                if self.after_revision is not None
                else None
            )
        checkpoint = await self.checkpoint(revision)
        reset = (
            self.after_position < 0
            or self.after_epoch != self.epoch
            or self.after_revision is None
            or self.after_revision > revision
            or (self.after_revision < reset_revision and mutations is None)
            or self.after_position > checkpoint["last_position"]
        )
        window, latest = await self._window(checkpoint["last_position"])
        if window:
            self._check_window_revision(process_revision if self.journal is not None else revision)
        boundary = {
            "type": "session.sync",
            "reset": reset,
            "item_revision": revision,
            "reset_revision": reset_revision,
            **checkpoint,
            **window,
            "stream_epoch": self.epoch,
        }
        if self.journal is not None:
            boundary["fork_boundary"] = (
                {
                    "last_item_id": self.branch.inherited_last_item_id,
                    "item_count": self.branch.inherited_item_count,
                }
                if self.branch
                else None
            )
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
        self._check_window_revision(process_revision if self.journal is not None else revision)
        if self.journal is not None:
            concurrent = await asyncio.to_thread(self.journal.changes, self.session_id, revision)
            if (concurrent and concurrent[0].revision != revision + 1) or any(
                change.resets_window for change in concurrent
            ):
                raise ConnectionError("Transcript membership changed during recovery")
        if replayed_count != expected_count:
            raise ConnectionError("Transcript membership changed during recovery")
        self._baseline_revision = revision
        yield {
            **boundary,
            "phase": "complete",
            **({"_publication_revision": process_revision} if self.journal is not None else {}),
        }

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
        if (
            event_type == "response.output_text.delta"
            and isinstance(event.get("message_id"), str)
            and event["message_id"] in self._replayed_native_messages
        ):
            # A final can commit between pre-ready preview capture and the saved-window read.
            return None
        if event_type == "session.heartbeat":
            await self.authorize()
            revision, reset_revision = session_stream.item_revision(self.session_id)
            if self.journal is not None:
                revision = await asyncio.to_thread(self.journal.revision, self.session_id)
                reset_revision = 0
            return {
                **event,
                **await self.checkpoint(revision),
                "item_revision": revision,
                "reset_revision": reset_revision,
                "stream_epoch": self.epoch,
                "reconcile_required": self.journal is None
                and self.enabled
                and revision != self._baseline_revision,
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
        # Sequence before reading the body: a later amendment can never hide behind an
        # earlier payload. Its own revision remains independently resumable.
        change_revision, recorded_ms = (
            await asyncio.to_thread(self.journal.item_version, self.session_id, item_id)
            if self.journal is not None
            else (0, 0)
        )
        saved = await asyncio.to_thread(self.store.get_item, self.session_id, item_id)
        if change_revision:
            event = {**event, "_change_revision": change_revision, "_recorded_at_ms": recorded_ms}
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
            self.journal is None
            and self.initial_limit is not None
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
        if self._replayed.get(item_id) == fingerprint and (
            self.journal is None or change_revision <= self._baseline_revision
        ):
            return None
        self._replayed.pop(item_id, None)
        return {**event, "item": item}
