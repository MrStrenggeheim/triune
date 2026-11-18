# Modified for Triune.
"""Pure pub-sub in-process live stream for real-time SSE delivery.

This module is a fan-out broadcaster keyed by ``conversation_id``.
Every active call to :func:`subscribe` owns its own bounded ephemeral
``asyncio.Queue``; :func:`publish` fans the event out to all queues
currently subscribed to that conversation_id. A subscriber that falls
behind past the bound is disconnected so it can recover through the
snapshot + live-tail reconnect contract. Events emitted before any
subscriber is connected are LOST — there is no buffer and no replay.
Clients that need to recover state across a disconnect fetch
``GET /v1/sessions/{id}`` for the persisted history and dedupe by item id.

This module owns no per-conversation lifecycle. There is no
``register`` / ``unregister`` step: the first ``subscribe`` call
lazily creates a subscriber slot, and the last ``subscribe`` to
exit removes the slot in its ``finally`` block.

Producer (workflow thread, sync):
    publish(conversation_id, event)  — thread-safe broadcast
    close(conversation_id)           — broadcasts end-of-stream
                                       to all active subscribers

Consumer (SSE endpoint, async):
    subscribe(conversation_id) -> AsyncIterator  — yields events
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
import time
import weakref
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable, Iterable
from typing import Any

import anyio

from omnigent.db.workspace_cache import WorkspaceScopedCache
from omnigent.debug_logging import (
    audit_event_logger,
    debug_event,
    debug_sink_enabled,
    sse_event_logger,
    sse_logging_enabled,
)
from omnigent.errors import ErrorImpact, ErrorPhase
from omnigent.native.input_diagnostics import input_attributes
from omnigent.runtime import disconnect_outcome, inflight_text, pending_elicitations
from omnigent.runtime.stream_queue import (
    MAX_STREAM_BYTES,
    BoundedEventQueue,
    EventTooLargeError,
    StreamEvent,
)

_logger = logging.getLogger(__name__)

# A generous burst allowance that still bounds one stalled subscriber's memory.
_SUBSCRIBER_QUEUE_MAX_EVENTS = 1024
_SUBSCRIBER_QUEUE_MAX_BYTES = MAX_STREAM_BYTES
_SUBSCRIBER_QUEUE_MAX_AGE_S = 30.0
_SNAPSHOT_TIMEOUT_S = 15.0

# Sentinel objects that signal terminal subscriber states.
_DONE = object()
_OVERFLOW = object()


class SubscriberOverflowError(RuntimeError):
    """Raised when a subscriber falls behind the bounded live-event queue."""


class SubscriberEventTooLargeError(SubscriberOverflowError):
    """A deterministic size failure requires explicit intervention, not replay."""


# Subscriber registry: conversation_id -> set of
# (queue, event_loop) pairs. The event_loop reference is needed
# so the sync producer thread can safely deliver items via
# ``call_soon_threadsafe`` into the queue's owning loop.
_subscribers: WorkspaceScopedCache[
    str,
    set[tuple[asyncio.Queue[dict[str, Any] | object], asyncio.AbstractEventLoop]],
] = WorkspaceScopedCache()
_lock = threading.Lock()
# Process-local invalidation, never a second transcript or body cache.
_item_revisions: WorkspaceScopedCache[str, tuple[int, int]] = WorkspaceScopedCache()
_ITEM_MUTATION_HISTORY_LIMIT = 128
# IDs only; the floor records mutations whose exact identities are no longer retained.
_item_mutations: WorkspaceScopedCache[str, tuple[int, dict[str, int]]] = WorkspaceScopedCache()


def item_revision(conversation_id: str) -> tuple[int, int]:
    """Return (revision, latest revision requiring authoritative reset)."""
    with _lock:
        return _item_revisions.get(conversation_id, (0, 0))


def mark_items_changed(
    conversation_id: str, *, reset: bool = False, item_id: str | None = None
) -> None:
    """Invalidate after a durable commit; epoch changes invalidate lost process state."""
    with _lock:
        revision, reset_revision = _item_revisions.get(conversation_id, (0, 0))
        revision += 1
        _item_revisions[conversation_id] = (revision, revision if reset else reset_revision)
        if reset:
            floor, mutations = _item_mutations.get(conversation_id, (0, {}))
            if item_id is None:
                floor, mutations = revision, {}
            else:
                mutations.pop(item_id, None)
                mutations[item_id] = revision
                if len(mutations) > _ITEM_MUTATION_HISTORY_LIMIT:
                    floor = max(floor, mutations.pop(next(iter(mutations))))
            _item_mutations[conversation_id] = (floor, mutations)


def item_mutations_since(conversation_id: str, revision: int) -> tuple[str, ...] | None:
    """Return coalesced changed IDs, or require reset after untracked/expired mutations."""
    with _lock:
        floor, mutations = _item_mutations.get(conversation_id, (0, {}))
        if revision < floor:
            return None
        return tuple(item_id for item_id, changed_at in mutations.items() if changed_at > revision)


# Queue objects have process-unique identity and disappear with their subscriptions.
_internal_queues: weakref.WeakSet[asyncio.Queue[Any]] = weakref.WeakSet()


def _saved_item_placeholder(event: object) -> dict[str, Any] | None:
    """Keep the exact item identity until an authorized stream producer can load its body."""
    if not isinstance(event, dict):
        return None
    kind = event.get("type")
    if kind == "session.input.consumed":
        field, key = "data", "item_id"
    elif kind in {"response.output_item.done", "response.output_item.updated"}:
        field, key = "item", "id"
    else:
        return None
    fields = event.get(field)
    if not isinstance(fields, dict) or not isinstance(fields.get(key), str):
        return None
    header = {
        k: event[k] for k in ("type", "sequence_number", "framework_input_ids") if k in event
    }
    header[field] = {k: fields[k] for k in (key, "position", "cleared_pending_id") if k in fields}
    return {**header, "_requires_saved_item": True}


def _enqueue_or_overflow(
    queue: asyncio.Queue[dict[str, Any] | object],
    item: dict[str, Any] | object,
) -> None:
    """Enqueue *item*, replacing a full backlog with an overflow signal."""
    if getattr(queue, "_session_stream_overflowed", False):
        return
    try:
        queue.put_nowait(item)
        return
    except EventTooLargeError:
        placeholder = (
            _saved_item_placeholder(item)
            if getattr(queue, "_saved_item_references", False)
            else None
        )
        if placeholder is None:
            queue._session_stream_oversized = True  # type: ignore[attr-defined]
        else:
            try:
                queue.put_nowait(placeholder)
                return
            except EventTooLargeError:
                queue._session_stream_oversized = True  # type: ignore[attr-defined]
            except asyncio.QueueFull:
                pass
    except asyncio.QueueFull:
        pass

    while True:
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            break
    queue._session_stream_overflowed = True  # type: ignore[attr-defined]
    queue.put_nowait(_OVERFLOW)


def _schedule_delivery(
    conversation_id: str,
    subscriber: tuple[asyncio.Queue[dict[str, Any] | object], asyncio.AbstractEventLoop],
    item: dict[str, Any] | object,
) -> bool:
    """Schedule one delivery, dropping a slot whose loop has closed."""
    queue, loop = subscriber
    # Re-check membership under the same lock subscribe cleanup uses. A slot
    # removed after the caller's snapshot must not count as a live recipient.
    with _lock:
        subs = _subscribers.get(conversation_id)
        if subs is None or subscriber not in subs:
            return False
        try:
            loop.call_soon_threadsafe(_enqueue_or_overflow, queue, item)
        except RuntimeError:
            subs.discard(subscriber)
            if not subs:
                _subscribers.pop(conversation_id, None)
            return False
        return queue not in _internal_queues


# ── SSE-event debug logging (ZeroBus table and/or local file; see
# omnigent.debug_logging) ─────────────────────────────────────────────────────
# Frequent, low-signal events not worth a debug-log row.
_SSE_SKIP_TYPES = frozenset(
    {"session.terminal.activity", "session.heartbeat", "response.heartbeat"}
)
# Failure events logged at WARNING so the table's level column flags them.
_SSE_WARN_TYPES = frozenset(
    {"response.failed", "response.error", "turn.failed", "response.policy_denied"}
)
# Terminal SSE events → the turn's outcome. Emitted once per turn as a
# first-class ``turn_finished`` audit row (session-scoped), so turn success /
# failure is queryable without inferring it from the raw SSE stream.
_TURN_OUTCOME_BY_EVENT_TYPE = {
    "response.completed": "completed",
    "response.failed": "failed",
    "response.cancelled": "cancelled",
    "response.incomplete": "incomplete",
}
_FAILED_EVENT_SOURCES = ("llm", "execution", "tool", "harness")
# The authoritative progress-impact per turn outcome: this is where "the task
# actually stopped" is known, so it overrides any per-error code default (a
# nominally-transient retry that ultimately failed the turn lands here as
# blocking). ``completed`` carries no impact; ``cancelled`` is a user-initiated
# stop, not lost progress.
_TURN_OUTCOME_IMPACT = {
    "failed": ErrorImpact.BLOCKING,
    "incomplete": ErrorImpact.BLOCKING,
    "cancelled": ErrorImpact.BENIGN,
}
# Top-level event fields safe to log — stable identifiers, closed enums, and
# pure numerics only. Deliberately excludes human/LLM-authored free text
# (``reason`` — PolicyDeniedEvent's deny reason is LLM-generated and can quote
# the content it evaluated — and ``blocked_on``, a free-form "human phrase") and
# ``tool_name`` (author-defined for custom/MCP tools; ``call_id`` still
# correlates a call to its result without naming the tool), alongside the
# content fields dropped in _sse_safe_attributes.
_SSE_SAFE_KEYS = (
    "parent_session_id",
    "child_session_id",
    "agent_id",
    "status",
    "call_id",
    "message_id",
    "phase",
    "stage",
    "attempt",
    "max_attempts",
    "sequence_number",
    "index",
    "final",
    "model",
    "context_tokens",
    "context_window",
    "total_cost_usd",
)


def _sse_safe_attributes(event: dict[str, Any]) -> dict[str, object]:
    """Extract only safe identifiers/dimensions from an SSE event.

    A strict whitelist: content and free-text fields (``delta`` text, tool
    ``arguments`` / outputs, message/reasoning ``data``, ``error.message``,
    human/LLM-authored ``reason`` / ``blocked_on``, and ``tool_name``) are never
    read, so no model response or user content reaches the debug table.
    """
    attrs: dict[str, object] = {}
    for key in _SSE_SAFE_KEYS:
        value = event.get(key)
        if value is not None and not isinstance(value, (dict, list)):
            attrs[key] = value
    if event.get("type") == "session.status":
        count = event.get("background_task_count")
        if isinstance(count, int) and not isinstance(count, bool) and count >= 0:
            attrs["background_task_count"] = count
    response = event.get("response")
    if isinstance(response, dict) and isinstance(response.get("id"), str):
        attrs["response_id"] = response["id"]
    elif isinstance(event.get("response_id"), str):
        attrs["response_id"] = event["response_id"]
    item = event.get("item")
    if isinstance(item, dict):
        nested_response_id = item.get("response_id")
        if (
            "response_id" not in attrs
            and isinstance(nested_response_id, str)
            and len(nested_response_id) <= 256
        ):
            attrs["response_id"] = nested_response_id
        if isinstance(item.get("id"), str):
            attrs["item_id"] = item["id"]
        if isinstance(item.get("type"), str):
            attrs["item_type"] = item["type"]
        # For error items capture code, level and source (all flat on the item
        # from to_api_dict()) so dashboards can exclude info-level notices from
        # error-rate metrics and group errors by cause and source.
        if item.get("type") == "error":
            if isinstance(item.get("level"), str):
                attrs["item_level"] = item["level"]
            code = item.get("code")
            if isinstance(code, str) and len(code) <= 64:
                attrs["item_code"] = code
            source = item.get("source")
            if isinstance(source, str) and len(source) <= 32:
                attrs["item_source"] = source
    if event.get("type") == "session.input.consumed":
        data = event.get("data")
        if isinstance(data, dict):
            for key in ("item_id", "cleared_pending_id"):
                value = data.get(key)
                if isinstance(value, str) and len(value) <= 256:
                    attrs[key] = value
    attrs.update(input_attributes(event))
    error = event.get("error")
    if not isinstance(error, dict) and isinstance(response, dict):
        error = response.get("error")
    if isinstance(error, dict):
        if error.get("code") is not None:
            attrs["error_code"] = error["code"]
        if error.get("source") is not None:
            attrs["error_source"] = error["source"]
    if event.get("type") == "response.failed" and event.get("source") in _FAILED_EVENT_SOURCES:
        attrs["error_source"] = event["source"]
    return attrs


def _log_sse_event(conversation_id: str, event: dict[str, Any]) -> None:
    """Mirror one emitted SSE event to the debug-log sinks (best-effort).

    No-op unless a sink is enabled (the ZeroBus table, the local file, or both).
    Logs the event name and safe ids only (never content); heartbeats /
    terminal-activity are skipped, and failure events go at WARNING. Never raises
    into :func:`publish`.
    """
    with contextlib.suppress(Exception):
        if not sse_logging_enabled():
            return
        event_type = event.get("type")
        if not isinstance(event_type, str) or event_type in _SSE_SKIP_TYPES:
            return
        level = logging.WARNING if event_type in _SSE_WARN_TYPES else logging.INFO
        extra = debug_event(event_type, session_id=conversation_id)
        extra["attributes"] = _sse_safe_attributes(event)
        sse_event_logger().log(level, "sse %s", event_type, extra=extra)
        # Turn-outcome audit rows are table-only: emit them only when the ZeroBus
        # sink is on, not merely when the file sink is (the audit logger has no
        # handler without the table, so an unguarded call would leak to root).
        if debug_sink_enabled():
            _log_turn_outcome(conversation_id, event_type, event)


def _log_turn_outcome(conversation_id: str, event_type: str, event: dict[str, Any]) -> None:
    """Emit a first-class ``turn_finished`` audit row on a terminal SSE event.

    One row per turn (terminal events fire once), carrying the outcome plus safe
    ids, so turn success/failure rate is a direct query rather than an inference
    over the raw stream. Table-only via the audit logger; caller already gated on
    :func:`debug_sink_enabled` and wrapped in ``suppress``.
    """
    outcome = _TURN_OUTCOME_BY_EVENT_TYPE.get(event_type)
    if outcome is None:
        return
    extra = debug_event("turn_finished", session_id=conversation_id, outcome=outcome)
    attributes = extra["attributes"]
    if isinstance(attributes, dict):
        response = event.get("response")
        if isinstance(response, dict) and isinstance(response.get("id"), str):
            attributes["response_id"] = response["id"]
        error = event.get("error")
        if not isinstance(error, dict) and isinstance(response, dict):
            error = response.get("error")
        if isinstance(error, dict) and error.get("code") is not None:
            attributes["error_code"] = str(error["code"])
        if event_type == "response.failed" and event.get("source") in _FAILED_EVENT_SOURCES:
            attributes["error_source"] = event["source"]
        impact = _TURN_OUTCOME_IMPACT.get(outcome)
        if impact is not None:
            attributes["error_impact"] = impact.value
            # A terminal turn outcome is, by definition, in the turn phase.
            attributes["error_phase"] = ErrorPhase.TURN.value
    level = logging.WARNING if outcome in ("failed", "incomplete") else logging.INFO
    audit_event_logger().log(level, "turn %s", outcome, extra=extra)


def publish(conversation_id: str, event: dict[str, Any]) -> int:
    """
    Broadcast an event to every active subscriber of the given
    conversation (called from sync workflow thread). The event
    payload is delivered verbatim — no sequence number or other
    ordering field is added on the wire. Events emitted while no
    subscriber is connected are dropped silently; reconnecting
    clients use the snapshot endpoint, not replay.

    No-op when ``_subscribers`` has no entry for this
    ``conversation_id`` (typical between turns when nothing is
    listening).

    :param conversation_id: The conversation to publish to,
        e.g. ``"conv_abc123"``.
    :param event: The event dict to publish, e.g.
        ``{"type": "response.output_text.delta",
        "delta": "Hello"}``. The ``"type"`` key SHOULD match the
        ``type`` ``Literal`` of one of the variants in
        :data:`omnigent.server.schemas.ServerStreamEvent`;
        the Omnigent route layer validates each emitted dict against
        the union before serializing, so an unmodelled event
        fails loud at the SSE boundary.
    :returns: The number of subscriber slots where delivery was
        successfully scheduled (``0`` when nothing was listening or the
        event was suppressed). A slow subscriber's queue may still overflow
        after dispatch, so a positive count is presence, not delivery.
        Callers that need a live listener — e.g. the browser action bridge —
        use this to fail fast instead of awaiting a response that can never
        arrive; most callers ignore it.
    """
    kind = event.get("type")
    elicitation_id = event.get("elicitation_id")
    if isinstance(elicitation_id, str):
        held_attempt = pending_elicitations.held_runner_attempt(conversation_id, elicitation_id)
        if held_attempt is not None:
            if kind == "response.elicitation_resolved":
                return 0  # Only the durable exact-receipt completion releases this hold.
            if kind == "response.elicitation_request":
                params = event.get("params")
                delivery = params.get("runner_delivery") if isinstance(params, dict) else None
                if not isinstance(delivery, dict) or delivery.get("attempt_id") != held_attempt:
                    return 0
    # Mirror the emitted event to the debug-log sinks (best-effort, no content,
    # no-op unless a sink is enabled). Done first so it captures every event the
    # server produces — including ones with no live subscriber.
    _log_sse_event(conversation_id, event)
    disconnect_outcome.observe_event(conversation_id, event)
    # Track reconnect state and centrally suppress or rewrite native deltas
    # before they reach subscribers.
    live_event = inflight_text.record_publish(conversation_id, event)
    # Side-channel: keep the cross-session pending-elicitations
    # index in step with the SSE stream. Only acts on
    # ``response.elicitation_request`` events; every other event
    # type is a single dict lookup and a return. A suppressed event is
    # always a text delta, never an elicitation, so this still runs.
    pending_elicitations.record_publish(conversation_id, event)
    if live_event is None:
        return 0
    with _lock:
        subs = list(_subscribers.get(conversation_id, ()))
    scheduled = 0
    for subscriber in subs:
        if _schedule_delivery(conversation_id, subscriber, live_event):
            scheduled += 1
    return scheduled


def has_subscribers(conversation_id: str) -> bool:
    """
    Return whether any live subscriber is currently registered for
    the given conversation.

    Because this stream has no buffer and no replay, an event
    published while this returns ``False`` is lost — callers can use
    that to fail fast instead of awaiting a response that can never
    arrive (e.g. a browser action dispatched to a session no renderer
    is watching).

    :param conversation_id: The conversation to check,
        e.g. ``"conv_abc123"``.
    :returns: ``True`` when at least one subscriber slot is registered.
    """
    with _lock:
        return any(
            queue not in _internal_queues for queue, _ in _subscribers.get(conversation_id, ())
        )


def close(conversation_id: str) -> None:
    """
    Broadcast an end-of-stream sentinel to every active subscriber
    of the given conversation. Subscribers awaiting their queue
    will see the sentinel, exit their async-iteration loop, and
    cleanly tear down their entry. Idempotent and a no-op when no
    subscribers are connected.

    :param conversation_id: The conversation whose subscribers
        should be signalled, e.g. ``"conv_abc123"``.
    """
    with _lock:
        subs = list(_subscribers.get(conversation_id, ()))
    for subscriber in subs:
        _schedule_delivery(conversation_id, subscriber, _DONE)


def shutdown_all() -> None:
    """Signal all active subscribers across every conversation to exit.

    Broadcasts the end-of-stream sentinel to every queued subscriber so
    SSE generators return at their next iteration without waiting for a
    heartbeat timeout or forced task cancellation. Called from the asyncio
    event loop (``ShutdownSignalingServer.shutdown`` in
    ``omnigent.server.graceful_shutdown``) before
    uvicorn's graceful-shutdown wait starts, so streams drain within the
    window rather than being force-cancelled. Sync callers should use
    :func:`close` per-conversation instead.
    """
    with _lock:
        # Shutdown spans every workspace and runs context-free, so sweep the
        # whole backing rather than the current workspace's slice.
        all_subs = [entry for subs in _subscribers.all_values() for entry in subs]
    for queue, _ in all_subs:
        _enqueue_or_overflow(queue, _DONE)


async def subscribe(
    conversation_id: str,
    *,
    internal: bool = False,
    saved_item_references: bool = False,
    heartbeat_interval_s: float | None = None,
    ready_event: dict[str, Any] | None = None,
    pre_ready_snapshot: Callable[[], Iterable[dict[str, Any]]] | None = None,
    on_subscribed: Callable[[], Awaitable[Iterable[dict[str, Any]]]] | None = None,
    replay: Callable[[], AsyncGenerator[dict[str, Any], None]] | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """
    Subscribe to live events for a conversation.

    Creates a fresh bounded ephemeral queue for this subscriber, registers
    it under ``conversation_id``, and yields events as they arrive
    from :func:`publish`. Ends when :func:`close` broadcasts the
    end-of-stream sentinel or when the caller stops iterating
    (e.g. client disconnect cancels the generator). The
    ``finally`` block always unregisters this subscriber slot so
    a stale queue cannot keep accumulating events.

    If the subscriber falls more than
    :data:`_SUBSCRIBER_QUEUE_MAX_EVENTS` events behind, its queued backlog
    is replaced with an overflow signal and this iterator raises
    :class:`SubscriberOverflowError`. HTTP/SSE callers treat that as a
    dropped transport and reconnect through the persisted snapshot rather
    than retaining an unbounded in-memory backlog.

    Live-tail only: events emitted before this call are NOT
    replayed. Multiple concurrent subscribers to the same
    conversation each see every event independently — there is
    no contention between them.

    Must be called from the asyncio event loop that the caller
    intends to iterate on; the sync producer side uses
    ``loop.call_soon_threadsafe`` to enqueue across threads.

    :param conversation_id: The conversation to subscribe to,
        e.g. ``"conv_abc123"``.
    :param heartbeat_interval_s: When set, yield a synthetic
        ``{"type": "session.heartbeat"}`` dict whenever the queue
        has been idle for this many seconds. Heartbeats are
        generated locally inside this subscriber and never enter
        the publish path, so multiple subscribers each get their
        own independent cadence. ``None`` (default) preserves the
        pure event-driven shape used by harness-internal
        consumers that don't need keepalive.
    :param internal: Receive events without advertising a browser listener through
        has_subscribers or publish's recipient count.
    :param ready_event: Optional event yielded immediately after
        this subscriber's slot is registered, e.g.
        ``{"type": "session.heartbeat"}``. This gives HTTP/SSE
        clients a subscription acknowledgment before an expensive
        snapshot hook runs, while still registering the live-tail
        queue before any producer can publish a turn event.
    :param pre_ready_snapshot: Optional SYNC hook run once, immediately
        after slot registration and before any ``yield``/``await``. Its
        events are yielded ahead of the live tail. Unlike ``on_subscribed``
        this must be synchronous: it is the only place a dedup-sensitive
        snapshot can be read while still partitioning exactly against the
        live tail, because no ``publish`` can interleave before the first
        suspension. Use it for the in-flight assistant-text replay;
        reading that from ``on_subscribed`` (after ``yield ready_event``)
        double-renders deltas streamed in the gap. Best-effort:
        exceptions are swallowed so a failing snapshot never blocks the
        live tail. ``None`` skips it.
    :param on_subscribed: Optional async hook run once, right after this
        subscriber's slot is registered and before the first live event
        is awaited. Its returned event dicts are yielded as a
        snapshot-on-connect ahead of the live tail. Registering the slot
        first guarantees no delta is dropped between snapshot and tail.
        Best-effort: exceptions are swallowed so a slow/failing snapshot
        never blocks live delivery. ``None`` skips the snapshot.
    :param replay: Optional required persisted replay, run after slot registration
        and the ready event, before snapshots and the live tail.
        Errors propagate so clients cannot mistake an incomplete replay for success.
    :returns: An async iterator of event dicts. Each event is
        yielded verbatim as it was passed to :func:`publish`,
        plus synthetic heartbeat dicts when *heartbeat_interval_s*
        is set.
    :raises SubscriberOverflowError: If this subscriber falls behind the
        bounded event queue.
    """
    queue = BoundedEventQueue(
        max_events=_SUBSCRIBER_QUEUE_MAX_EVENTS,
        max_bytes=_SUBSCRIBER_QUEUE_MAX_BYTES,
        max_age=_SUBSCRIBER_QUEUE_MAX_AGE_S,
    )
    queue._saved_item_references = saved_item_references  # type: ignore[attr-defined]
    loop = asyncio.get_running_loop()
    entry = (queue, loop)
    with _lock:
        _subscribers.setdefault(conversation_id, set()).add(entry)
        if internal:
            _internal_queues.add(queue)
    # Read the pre-ready snapshot synchronously here — after slot
    # registration, before the ``yield`` below suspends. On the Omnigent event
    # loop (where the relay calls ``publish``) nothing runs in between, so
    # the snapshot and the live tail partition exactly: deltas before this
    # point are in the snapshot, deltas after are on ``queue``. Reading it
    # after ``yield ready_event`` instead lets the relay publish deltas
    # into BOTH, which render twice.
    try:
        pre_ready_events: list[dict[str, Any]] = (
            list(pre_ready_snapshot()) if pre_ready_snapshot is not None else []
        )
    except Exception:
        _logger.debug(
            "session_stream pre_ready_snapshot failed for %s",
            conversation_id,
            exc_info=True,
        )
        pre_ready_events = []

    def check_backlog() -> None:
        if getattr(queue, "_session_stream_oversized", False):
            raise SubscriberEventTooLargeError
        held_expired = (
            live_task is not None
            and live_task.done()
            and not live_task.cancelled()
            and queue.last_taken_deadline <= time.monotonic()
        )
        if held_expired or queue.expired or getattr(queue, "_session_stream_overflowed", False):
            raise SubscriberOverflowError(
                f"session stream backlog exceeded for {conversation_id!r}"
            )

    def snapshot_key(event: dict[str, Any]) -> tuple[str, str]:
        kind = str(event.get("type", ""))
        if kind.startswith("session.resource."):
            resource = event.get("resource")
            identity = (
                resource.get("id") if isinstance(resource, dict) else event.get("resource_id")
            )
            return "resource", str(identity or "*")
        if kind.startswith("session.child_session."):
            return "child", str(event.get("child_session_id", "*"))
        return kind, "*"

    changed_during_snapshot: set[tuple[str, str]] = set()
    changed_child_fields: dict[str, set[str]] = {}
    snapshot_superseded = False

    async def snapshot() -> Iterable[dict[str, Any]]:
        assert on_subscribed is not None
        try:
            return await asyncio.wait_for(on_subscribed(), timeout=_SNAPSHOT_TIMEOUT_S)
        except Exception as exc:
            _logger.debug("session snapshot %s failed (%s)", conversation_id, type(exc).__name__)
            return ()

    snapshot_task: asyncio.Task[Iterable[dict[str, Any]]] | None = None
    next_task: asyncio.Task[Any] | None = None
    live_task: asyncio.Task[Any] | None = None
    try:
        if ready_event is not None:
            yield ready_event
        if on_subscribed is not None:
            snapshot_task = asyncio.create_task(snapshot())
        if replay is not None:
            async with contextlib.aclosing(replay()) as replay_events:
                try:
                    while True:
                        next_task = asyncio.create_task(anext(replay_events))
                        while True:
                            # Queue age is enforced even when replay is stuck in a read.
                            done, _ = await asyncio.wait(
                                {next_task},
                                timeout=min(heartbeat_interval_s or queue.max_age, queue.max_age),
                            )
                            check_backlog()
                            if done:
                                break
                            if heartbeat_interval_s is not None:
                                yield {"type": "session.heartbeat"}
                        try:
                            replay_event = next_task.result()
                        except StopAsyncIteration:
                            break
                        yield StreamEvent(
                            replay_event, time.monotonic() + queue.max_age, check_backlog
                        )
                finally:
                    if next_task is not None:
                        next_task.cancel()
                        with anyio.CancelScope(shield=True):
                            await asyncio.gather(next_task, return_exceptions=True)
        check_backlog()
        for pre_ready_event in pre_ready_events:
            yield pre_ready_event
        heartbeat_deadline = (
            loop.time() + heartbeat_interval_s if heartbeat_interval_s is not None else None
        )
        while True:
            check_backlog()
            if live_task is None:
                live_task = asyncio.create_task(queue.get())
            waiting = {live_task}
            if snapshot_task is not None:
                waiting.add(snapshot_task)
            done, _ = await asyncio.wait(
                waiting,
                timeout=max(0, heartbeat_deadline - loop.time()) if heartbeat_deadline else None,
                return_when=asyncio.FIRST_COMPLETED,
            )
            check_backlog()
            if heartbeat_deadline is not None and loop.time() >= heartbeat_deadline:
                assert heartbeat_interval_s is not None
                heartbeat_deadline = loop.time() + heartbeat_interval_s
                yield {"type": "session.heartbeat"}
            if snapshot_task in done:
                assert snapshot_task is not None
                snapshot_events = snapshot_task.result()
                snapshot_task = None
                for snapshot_event in snapshot_events:
                    check_backlog()
                    key = snapshot_key(snapshot_event)
                    if key[0] == "child" and key[1] in changed_child_fields:
                        # Live child bodies are partial: omit only overwritten fields
                        # so the client's normal merge keeps both base and live state.
                        snapshot_event = {
                            **snapshot_event,
                            "child": {
                                field: value
                                for field, value in snapshot_event.get("child", {}).items()
                                if field not in changed_child_fields[key[1]]
                            },
                        }
                        yield snapshot_event
                        continue
                    if (
                        snapshot_superseded
                        or key in changed_during_snapshot
                        or (key[0], "*") in changed_during_snapshot
                    ):
                        continue
                    yield snapshot_event
            if live_task not in done:
                continue
            check_backlog()
            item = live_task.result()
            live_task = None
            if item is _DONE:
                return
            if item is _OVERFLOW:
                raise SubscriberOverflowError(
                    f"session stream subscriber for {conversation_id!r} "
                    f"exceeded {_SUBSCRIBER_QUEUE_MAX_EVENTS} queued events"
                )
            assert isinstance(item, dict)
            if snapshot_task is not None:
                if item.get("type") == "session.child_session.updated":
                    child = item.get("child", {})
                    if isinstance(child, dict):
                        changed_child_fields.setdefault(
                            str(item.get("child_session_id")), set()
                        ).update(child)
                        if (
                            sum(map(len, changed_child_fields.values()))
                            > _SUBSCRIBER_QUEUE_MAX_EVENTS
                        ):
                            raise SubscriberOverflowError(
                                "Ancillary snapshot change tracking exceeded"
                            )
                if len(changed_during_snapshot) >= _SUBSCRIBER_QUEUE_MAX_EVENTS:
                    snapshot_superseded = True
                else:
                    changed_during_snapshot.add(snapshot_key(item))
            yield StreamEvent(item, queue.last_taken_deadline, check_backlog)
    finally:
        # Level-triggered ASGI cancellation can interrupt every await below.
        # Remove the registry entry synchronously before joining child tasks.
        with _lock:
            _internal_queues.discard(queue)
            subs = _subscribers.get(conversation_id)
            if subs is not None:
                subs.discard(entry)
                if not subs:
                    _subscribers.pop(conversation_id, None)
        pending = [task for task in (snapshot_task, next_task, live_task) if task is not None]
        for task in pending:
            task.cancel()
        with anyio.CancelScope(shield=True):
            await asyncio.gather(*pending, return_exceptions=True)
