"""Persisted replay, old-position mutation invalidation and live-tail boundary."""

from __future__ import annotations

import asyncio
import contextlib
import json
from unittest.mock import Mock
from uuid import uuid4

import pytest

from omnigent.db.db_models import workspace_scope
from omnigent.entities.conversation import MessageData, NewConversationItem, ResourceEventData
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.runtime import inflight_text, session_stream
from omnigent.server.routes.sessions import _stream_live_events
from omnigent.server.session_recovery import SessionRecovery
from omnigent.stores.conversation_store import PENDING_INPUT_RESPONSE_ID
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore


async def _allowed():
    pass


class _Connected:
    async def is_disconnected(self):
        return False


def _message(text="saved", *, response_id="turn", **kwargs):
    return NewConversationItem(
        type="message",
        response_id=response_id,
        data=MessageData(role="user", content=[{"type": "input_text", "text": text}]),
        **kwargs,
    )


@pytest.fixture
def saved(db_uri):
    store = SqlAlchemyConversationStore(db_uri)
    session = store.create_conversation()
    return store, session.id


async def _events(recovery):
    return [event async for event in recovery.events()]


def test_positions_are_populated_and_scoped_without_pending_in_highwater(saved):
    store, sid = saved
    pending, item = store.append(
        sid, [_message(response_id=PENDING_INPUT_RESPONSE_ID), _message()]
    )
    assert pending.position == 0 and item.position == 1
    assert pending.to_api_dict()["position"] == 0
    assert store.get_item(sid, item.id).position == 1
    assert store.list_items(sid, after_position=0).data == [item]
    assert store.item_checkpoint(sid) == {
        "last_position": 1,
        "item_count": 1,
        "last_item_id": item.id,
    }
    other = store.create_conversation()
    assert store.item_checkpoint(other.id)["last_position"] == -1
    with workspace_scope(99):
        assert store.item_checkpoint(sid)["item_count"] == 0


async def test_append_cursor_empty_and_epoch_reset(saved):
    store, sid = saved
    empty = await _events(SessionRecovery(store, sid, _allowed, enabled=True))
    assert [e["phase"] for e in empty] == ["start", "complete"]
    assert empty[-1]["reset"] and empty[-1]["last_position"] == -1
    [first] = store.append(sid, [_message()])
    revision = session_stream.item_revision(sid)[0]
    [second] = store.append(sid, [_message("next")])
    kwargs = {
        "enabled": True,
        "after_position": first.position,
        "after_revision": revision,
        "stream_epoch": inflight_text.stream_epoch(),
    }
    resumed = await _events(SessionRecovery(store, sid, _allowed, **kwargs))
    assert not resumed[0]["reset"]
    assert [e["item"]["id"] for e in resumed if "item" in e] == [second.id]
    kwargs["stream_epoch"] = "other-process"
    reset = await _events(SessionRecovery(store, sid, _allowed, **kwargs))
    assert reset[0]["reset"]
    assert [e["item"]["position"] for e in reset if "item" in e] == [0, 1]
    kwargs.update(after_position=999, stream_epoch=inflight_text.stream_epoch())
    assert (await _events(SessionRecovery(store, sid, _allowed, **kwargs)))[0]["reset"]


async def test_old_pending_promotion_requires_reset_and_retains_receipt_slot(saved):
    store, sid = saved
    pending, later = store.append(
        sid, [_message(response_id=PENDING_INPUT_RESPONSE_ID), _message()]
    )
    revision = session_stream.item_revision(sid)[0]
    [consumed] = store.append(sid, [_message("accepted", replaces_pending_id=pending.id)])
    assert consumed.position == pending.position == 0
    reset = await _events(
        SessionRecovery(
            store,
            sid,
            _allowed,
            enabled=True,
            after_position=later.position,
            after_revision=revision,
            stream_epoch=inflight_text.stream_epoch(),
        )
    )
    assert reset[0]["reset"]
    assert [e["item"]["id"] for e in reset if "item" in e] == [consumed.id, later.id]


async def test_revision_covers_mutation_removal_and_noops(saved):
    store, sid = saved
    [pending] = store.append(sid, [_message(response_id=PENDING_INPUT_RESPONSE_ID)])
    before = session_stream.item_revision(sid)
    assert not store.transition_pending_input(sid, pending.id, expected="failed", status=None)
    assert session_stream.item_revision(sid) == before
    assert store.transition_pending_input(sid, pending.id, expected="completed", status=None)
    after = session_stream.item_revision(sid)
    assert after[0] > before[0] and after[1] == after[0]
    [resource] = store.append(
        sid,
        [
            NewConversationItem(
                type="resource_event",
                response_id="turn",
                data=ResourceEventData(
                    event_type="session.subagent.returned",
                    resource_id="child",
                    resource_type="agent",
                    resource={"result_text": "short"},
                ),
            )
        ],
    )
    before = session_stream.item_revision(sid)
    assert store.enrich_resource_event(
        sid, resource.id, {"result_text": "longer final", "result_finality": "adapter_result"}
    )
    assert session_stream.item_revision(sid)[1] > before[0]
    assert store.get_item(sid, resource.id).position == resource.position
    recovery = SessionRecovery(
        store,
        sid,
        _allowed,
        enabled=True,
        after_position=resource.position,
        after_revision=before[0],
        stream_epoch=inflight_text.stream_epoch(),
    )
    frames = await _events(recovery)
    assert frames[0]["reset"]
    assert frames[1]["item"]["resource"]["result_text"] == "longer final"
    before = session_stream.item_revision(sid)
    await store.delete_conversation(sid)
    assert session_stream.item_revision(sid)[1] > before[0]


async def test_idle_heartbeats_do_not_rescan_unchanged_history(saved, monkeypatch):
    store, sid = saved
    recovery = SessionRecovery(store, sid, _allowed, enabled=True)
    await _events(recovery)
    checkpoint = Mock(wraps=store.item_checkpoint)
    monkeypatch.setattr(store, "item_checkpoint", checkpoint)
    for _ in range(3):
        heartbeat = await recovery.prepare({"type": "session.heartbeat"})
        assert not heartbeat["reconcile_required"]
    checkpoint.assert_not_called()
    store.append(sid, [_message()])
    assert (await recovery.prepare({"type": "session.heartbeat"}))["reconcile_required"]
    assert checkpoint.call_count == 1


async def test_subscribe_before_read_race_and_replay_dedup(saved, monkeypatch):
    store, sid = saved
    [first] = store.append(sid, [_message()])
    original = store.list_items
    injected = []

    def read(*args, **kwargs):
        assert session_stream.has_subscribers(sid)
        if not injected:
            [second] = store.append(sid, [_message("during read")])
            injected.append(second)
            session_stream.publish(
                sid, {"type": "response.output_item.done", "item": second.to_api_dict()}
            )
            session_stream.publish(
                sid, {"type": "response.output_item.done", "item": first.to_api_dict()}
            )
            session_stream.publish(
                sid,
                {
                    "type": "session.changed_files.invalidated",
                    "session_id": sid,
                    "environment_id": "default",
                },
            )
        return original(*args, **kwargs)

    monkeypatch.setattr(store, "list_items", read)
    recovery = SessionRecovery(store, sid, _allowed, enabled=True)
    gen = _stream_live_events(_Connected(), sid, recovery=recovery)
    frames = []
    async with contextlib.aclosing(gen):
        for _ in range(10):
            frame = await asyncio.wait_for(anext(gen), timeout=2)
            event = json.loads(frame.split("data: ", 1)[1])
            frames.append(event)
            if event["type"] == "session.changed_files.invalidated":
                break
    assert [e["item"]["id"] for e in frames if "item" in e] == [first.id, injected[0].id]
    assert not session_stream.has_subscribers(sid)


async def test_replay_authorization_and_read_failure_are_not_swallowed(saved, monkeypatch):
    store, sid = saved
    store.append(sid, [_message()])

    async def denied():
        raise OmnigentError("Conversation not found", code=ErrorCode.NOT_FOUND)

    with pytest.raises(OmnigentError):
        await _events(SessionRecovery(store, sid, denied, enabled=True))
    monkeypatch.setattr(store, "list_items", Mock(side_effect=RuntimeError("DB unavailable")))
    gen = _stream_live_events(
        _Connected(), sid, recovery=SessionRecovery(store, sid, _allowed, enabled=True)
    )
    async with contextlib.aclosing(gen):
        with pytest.raises(RuntimeError, match="DB unavailable"):
            async for _ in gen:
                pass
    assert not session_stream.has_subscribers(sid)


async def test_overflow_stays_terminal_and_other_subscribers_continue(monkeypatch):
    monkeypatch.setattr(session_stream, "_SUBSCRIBER_QUEUE_MAX_EVENTS", 2)
    sid = uuid4().hex
    slow = session_stream.subscribe(sid, ready_event={"type": "ready"})
    healthy = session_stream.subscribe(sid, ready_event={"type": "ready"})
    async with contextlib.aclosing(slow), contextlib.aclosing(healthy):
        await anext(slow)
        await anext(healthy)
        for index in range(12):
            session_stream.publish(sid, {"type": "event", "index": index})
            assert (await anext(healthy))["index"] == index
        with pytest.raises(session_stream.SubscriberOverflowError):
            await anext(slow)
    assert not session_stream.has_subscribers(sid)


async def test_heartbeat_deadline_survives_a_busy_queue():
    sid = uuid4().hex
    sub = session_stream.subscribe(sid, heartbeat_interval_s=0.01, ready_event={"type": "ready"})
    async with contextlib.aclosing(sub):
        await anext(sub)
        session_stream.publish(sid, {"type": "first"})
        session_stream.publish(sid, {"type": "second"})
        assert (await anext(sub))["type"] == "first"
        await asyncio.sleep(0.02)
        assert (await anext(sub))["type"] == "session.heartbeat"
        assert (await anext(sub))["type"] == "second"


async def test_duplicate_append_and_framework_receipt_revision(saved):
    from omnigent.entities.communication import MessageCommunication

    store, sid = saved
    stable_id = uuid4().hex
    pending = _message(response_id=PENDING_INPUT_RESPONSE_ID, stable_id=stable_id)
    pending.data.communication = MessageCommunication(
        kind="system", message_id=stable_id, destination_conversation_id=sid
    )
    [accepted] = store.append(sid, [pending])
    before = session_stream.item_revision(sid)
    assert store.append(sid, [pending])[0].deduplicated
    assert session_stream.item_revision(sid) == before
    confirmed = store.confirm_framework_input(sid, accepted.id, "native-turn")
    assert confirmed.position == accepted.position
    assert session_stream.item_revision(sid)[1] > before[0]
    current = session_stream.item_revision(sid)
    assert store.confirm_framework_input(sid, accepted.id, "native-turn") is None
    assert session_stream.item_revision(sid) == current


async def test_saved_pending_snapshot_and_consumed_metadata_include_position(saved):
    from omnigent.runtime import pending_inputs
    from omnigent.server.routes.sessions import _publish_input_consumed
    from omnigent.server.startup_inputs import ManagedStartupInputs

    store, sid = saved
    [pending] = store.append(sid, [_message(response_id=PENDING_INPUT_RESPONSE_ID)])
    startup = ManagedStartupInputs(store, Mock())
    snapshot = await startup.pending_snapshot(sid)
    assert snapshot[0]["position"] == pending.position == 0
    assert snapshot[0]["item_id"] == pending.id
    assert snapshot[0]["created_at"] == pending.created_at
    assert snapshot[0]["pending_id"] == pending_inputs.make_pending_id(sid, pending.id)
    sub = session_stream.subscribe(sid, ready_event={"type": "ready"})
    async with contextlib.aclosing(sub):
        await anext(sub)
        _publish_input_consumed(sid, pending)
        consumed = await anext(sub)
    assert consumed["data"]["position"] == pending.position
    assert consumed["data"]["item_id"] == pending.id


async def test_replay_pages_are_bounded_and_keep_captured_highwater(saved, monkeypatch):
    store, sid = saved
    originals = store.append(sid, [_message(str(index)) for index in range(7)])
    monkeypatch.setattr("omnigent.server.session_recovery._REPLAY_PAGE_SIZE", 2)
    original_read = store.list_items
    calls = []

    def read(*args, **kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            store.append(sid, [_message("after the fence")])
        return original_read(*args, **kwargs)

    monkeypatch.setattr(store, "list_items", read)
    recovery = SessionRecovery(store, sid, _allowed, enabled=True)
    frames = await _events(recovery)
    assert [event["item"]["id"] for event in frames if "item" in event] == [
        item.id for item in originals
    ]
    assert len(calls) == 4 and all(call["limit"] == 2 for call in calls)
    assert all(call["through_position"] == 6 for call in calls)
    assert (await recovery.prepare({"type": "session.heartbeat"}))["reconcile_required"]


async def test_updated_item_uses_current_saved_position_without_losing_state_frames(saved):
    store, sid = saved
    [item] = store.append(sid, [_message()])
    recovery = SessionRecovery(store, sid, _allowed, enabled=True)
    frame = await recovery.prepare(
        {"type": "response.output_item.updated", "item": {"id": item.id}}
    )
    assert frame["item"] == item.to_api_dict()
    state = {
        "type": "session.changed_files.invalidated",
        "session_id": sid,
        "environment_id": "default",
    }
    assert await recovery.prepare(state) is state
