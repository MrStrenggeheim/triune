# Modified for Triune; inherited notices remain applicable.
"""Unit tests for :func:`_stream_live_events` disconnect / completion cleanup.

Pins the contract that ``finally`` is cleanup-only (presence + nested
subscriber teardown) and that ``data: [DONE]`` is emitted only on
normal stream completion — never during ``aclose`` / ``GeneratorExit``.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from omnigent.runtime import session_stream
from omnigent.server import presence, shutdown_state
from omnigent.server.routes.sessions import _stream_live_events

pytestmark = pytest.mark.asyncio

SESSION_ID = "conv_stream_live_aclose"
USER_ID = "alice@example.com"


class _ConnectedRequest:
    """Minimal request stand-in: client stays connected."""

    async def is_disconnected(self) -> bool:
        return False


@pytest.fixture(autouse=True)
def _reset_presence_and_subscribers() -> Any:
    """Isolate module-global presence + session_stream state per test."""
    presence.reset_for_tests()
    shutdown_state.reset_for_tests()
    session_stream._subscribers.clear()
    yield
    presence.reset_for_tests()
    shutdown_state.reset_for_tests()
    session_stream._subscribers.clear()


async def test_aclose_cleans_presence_and_subscribers_without_runtime_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Client ``aclose`` must not raise, and must tear down presence + slots.

    Regression: yielding ``[DONE]`` from the generator ``finally`` during
    ``aclose`` raised ``RuntimeError: async generator ignored GeneratorExit``,
    which could skip or obscure cleanup.
    """
    monkeypatch.setattr(presence, "_LEAVE_GRACE_S", 0.05)

    gen = _stream_live_events(
        _ConnectedRequest(),  # type: ignore[arg-type]
        SESSION_ID,
        viewer_user_id=USER_ID,
        viewer_idle=False,
        presence_root_id=SESSION_ID,
    )
    # Ready heartbeat proves the subscribe slot is registered before aclose.
    first = await asyncio.wait_for(gen.__anext__(), timeout=2.0)
    assert "session.heartbeat" in first
    assert SESSION_ID in session_stream._subscribers
    assert [v["user_id"] for v in presence.snapshot(SESSION_ID, SESSION_ID)["viewers"]] == [
        USER_ID
    ]

    # Direct close — the path StreamingResponse takes on client disconnect.
    await gen.aclose()

    assert SESSION_ID not in session_stream._subscribers, (
        "subscribe finally must drop the subscriber slot on aclose"
    )
    # Disconnect schedules leave after grace; wait past the shrunken window.
    for _ in range(50):
        if presence.snapshot(SESSION_ID, SESSION_ID)["viewers"] == []:
            break
        await asyncio.sleep(0.02)
    assert presence.snapshot(SESSION_ID, SESSION_ID)["viewers"] == [], (
        "presence.disconnect in finally must clear the viewer after grace"
    )


async def test_server_shutdown_ends_stream_without_done_for_browser_reconnect() -> None:
    gen = _stream_live_events(
        _ConnectedRequest(),  # type: ignore[arg-type]
        SESSION_ID,
    )
    assert "session.heartbeat" in await asyncio.wait_for(gen.__anext__(), timeout=2.0)
    assert SESSION_ID in session_stream._subscribers

    shutdown_state.mark_server_shutting_down()
    session_stream.shutdown_all()
    assert [frame async for frame in gen] == []
    assert SESSION_ID not in session_stream._subscribers


async def test_normal_completion_emits_done_and_cleans_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Subscribe end-of-stream still yields ``[DONE]`` then cleans up."""
    monkeypatch.setattr(presence, "_LEAVE_GRACE_S", 0.05)

    gen = _stream_live_events(
        _ConnectedRequest(),  # type: ignore[arg-type]
        SESSION_ID,
        viewer_user_id=USER_ID,
        viewer_idle=False,
        presence_root_id=SESSION_ID,
    )
    first = await asyncio.wait_for(gen.__anext__(), timeout=2.0)
    assert "session.heartbeat" in first
    assert SESSION_ID in session_stream._subscribers

    session_stream.close(SESSION_ID)
    chunks: list[str] = []
    async for chunk in gen:
        chunks.append(chunk)

    assert chunks[-1] == "data: [DONE]\n\n", (
        f"normal completion must emit [DONE]; got trailing {chunks[-1]!r}"
    )
    assert SESSION_ID not in session_stream._subscribers
    for _ in range(50):
        if presence.snapshot(SESSION_ID, SESSION_ID)["viewers"] == []:
            break
        await asyncio.sleep(0.02)
    assert presence.snapshot(SESSION_ID, SESSION_ID)["viewers"] == []


@pytest.mark.parametrize("bound", ["events", "bytes", "age"])
async def test_overflow_during_completion_preparation_cannot_publish_complete(monkeypatch, bound):
    from omnigent.runtime import inflight_text
    from omnigent.server.routes._sessions.helpers import _iter_live_events

    monkeypatch.setattr(session_stream, "_SUBSCRIBER_QUEUE_MAX_EVENTS", 2)
    if bound == "bytes":
        monkeypatch.setattr(session_stream, "_SUBSCRIBER_QUEUE_MAX_BYTES", 128)
    if bound == "age":
        monkeypatch.setattr(session_stream, "_SUBSCRIBER_QUEUE_MAX_AGE_S", 0.05)
    preparing, release = asyncio.Event(), asyncio.Event()

    class Recovery:
        enabled = True

        async def authorize(self):
            return None

        async def events(self):
            boundary = {
                "type": "session.sync",
                "item_revision": 0,
                "reset_revision": 0,
                "reset": True,
                "last_position": -1,
                "item_count": 0,
                "last_item_id": None,
                "stream_epoch": inflight_text.stream_epoch(),
            }
            yield {**boundary, "phase": "start"}
            yield {**boundary, "phase": "complete"}

        async def prepare(self, event):
            if event.get("phase") == "complete":
                preparing.set()
                await release.wait()
            return event

    stream = _iter_live_events(_ConnectedRequest(), SESSION_ID, recovery=Recovery())
    try:
        assert (await anext(stream))["type"] == "session.heartbeat"
        assert (await anext(stream))["phase"] == "start"
        pending = asyncio.create_task(anext(stream))
        await preparing.wait()
        for _ in range(1 if bound == "age" else 3):
            session_stream.publish(
                SESSION_ID,
                {"type": "session.heartbeat", "padding": "x" * 40 if bound == "bytes" else ""},
            )
        await asyncio.sleep(0.06 if bound == "age" else 0)
        release.set()
        with pytest.raises(session_stream.SubscriberOverflowError):
            await pending
    finally:
        await stream.aclose()
    assert not session_stream.has_subscribers(SESSION_ID)


@pytest.mark.parametrize("phase", ["live", "replay", "snapshot"])
async def test_anyio_cancelled_adapter_cleans_presence_and_nested_tasks(monkeypatch, phase):
    import anyio

    from omnigent.server.routes._sessions.helpers import _iter_live_events

    monkeypatch.setattr(presence, "_LEAVE_GRACE_S", 0.001)
    started = anyio.Event()
    closed = []

    async def snapshot():
        try:
            started.set()
            await anyio.sleep_forever()
        finally:
            closed.append("snapshot")

    class Recovery:
        enabled = True

        async def authorize(self):
            return None

        async def prepare(self, event):
            return event

        async def events(self):
            try:
                started.set()
                await anyio.sleep_forever()
                yield {}
            finally:
                closed.append("replay")

    async def consume():
        stream = _iter_live_events(
            _ConnectedRequest(),
            SESSION_ID,
            on_subscribed=snapshot if phase == "snapshot" else None,
            recovery=Recovery() if phase == "replay" else None,
            viewer_user_id=USER_ID,
            presence_root_id=SESSION_ID,
        )
        try:
            await anext(stream)
            if phase == "live":
                started.set()
            await anext(stream)
        finally:
            await stream.aclose()

    async with anyio.create_task_group() as group:
        group.start_soon(consume)
        await started.wait()
        group.cancel_scope.cancel()
    await asyncio.sleep(0.01)
    assert not session_stream.has_subscribers(SESSION_ID)
    assert presence.snapshot(SESSION_ID, SESSION_ID)["viewers"] == []
    assert closed == ([] if phase == "live" else [phase])
