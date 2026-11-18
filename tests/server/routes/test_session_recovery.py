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
    assert not frames[0]["reset"]
    assert frames[1]["item"]["resource"]["result_text"] == "longer final"
    before = session_stream.item_revision(sid)
    await store.delete_conversation(sid)
    assert session_stream.item_revision(sid)[1] > before[0]


async def test_activity_enrichments_replay_only_changed_ids_in_a_long_chat(saved, monkeypatch):
    store, sid = saved
    [activity, *messages] = store.append(
        sid,
        [
            NewConversationItem(
                type="resource_event",
                response_id="turn",
                data=ResourceEventData(
                    event_type="session.subagent.returned",
                    resource_id="child",
                    resource_type="session",
                    resource={"dispatch_id": "dispatch", "task_input": "original"},
                ),
            ),
            *[_message(str(index)) for index in range(401)],
        ],
    )
    revision = session_stream.item_revision(sid)[0]
    for index in range(20):
        store.enrich_resource_event(
            sid, activity.id, {"dispatch_id": "dispatch", "task_input": "expanded" * (index + 2)}
        )
    read = Mock(wraps=store.list_items)
    get_item = Mock(wraps=store.get_item)
    monkeypatch.setattr(store, "list_items", read)
    monkeypatch.setattr(store, "get_item", get_item)
    recovery = SessionRecovery(
        store,
        sid,
        _allowed,
        enabled=True,
        after_position=messages[-1].position,
        after_revision=revision,
        stream_epoch=inflight_text.stream_epoch(),
    )
    frames = await _events(recovery)
    assert not frames[0]["reset"]
    assert [event["item"]["id"] for event in frames if "item" in event] == [activity.id]
    assert frames[1]["item"]["position"] == activity.position == 0
    assert frames[1]["item"]["resource"]["task_input"] == "expanded" * 21
    read.assert_not_called()
    get_item.assert_called_once_with(sid, activity.id)
    assert not (await recovery.prepare({"type": "session.heartbeat"}))["reconcile_required"]


async def test_mutation_during_delta_replay_is_recovered_without_another_full_reset(saved):
    store, sid = saved
    [activity] = store.append(
        sid,
        [
            NewConversationItem(
                type="resource_event",
                response_id="turn",
                data=ResourceEventData(
                    event_type="session.subagent.returned",
                    resource_id="child",
                    resource_type="session",
                    resource={"dispatch_id": "dispatch", "task_input": "original"},
                ),
            )
        ],
    )
    revision = session_stream.item_revision(sid)[0]
    store.enrich_resource_event(
        sid, activity.id, {"dispatch_id": "dispatch", "task_input": "first update"}
    )
    changed = False

    async def project(items):
        nonlocal changed
        if not changed:
            changed = True
            store.enrich_resource_event(
                sid, activity.id, {"dispatch_id": "dispatch", "task_input": "newest longer update"}
            )
        return items

    recovery = SessionRecovery(
        store,
        sid,
        _allowed,
        enabled=True,
        after_position=activity.position,
        after_revision=revision,
        stream_epoch=inflight_text.stream_epoch(),
        project=project,
    )
    with pytest.raises(ConnectionError, match="changed during recovery"):
        await _events(recovery)
    heartbeat = await recovery.prepare({"type": "session.heartbeat"})
    assert heartbeat["reconcile_required"]
    resumed = await _events(
        SessionRecovery(
            store,
            sid,
            _allowed,
            enabled=True,
            after_position=activity.position,
            after_revision=revision,
            stream_epoch=inflight_text.stream_epoch(),
        )
    )
    assert not resumed[0]["reset"]
    assert resumed[1]["item"]["resource"]["task_input"] == "newest longer update"
    assert resumed[1]["item"]["position"] == activity.position


def test_mutation_tracking_coalesces_bounds_and_isolates_workspaces(monkeypatch):
    sid = uuid4().hex
    monkeypatch.setattr(session_stream, "_ITEM_MUTATION_HISTORY_LIMIT", 2)
    for _ in range(20):
        session_stream.mark_items_changed(sid, reset=True, item_id="first")
    assert session_stream.item_mutations_since(sid, 0) == ("first",)
    with workspace_scope(99):
        assert session_stream.item_mutations_since(sid, 0) == ()
        session_stream.mark_items_changed(sid, reset=True, item_id="other-workspace")
        assert session_stream.item_mutations_since(sid, 0) == ("other-workspace",)
    checkpoint = session_stream.item_revision(sid)[0]
    session_stream.mark_items_changed(sid, reset=True, item_id="second")
    session_stream.mark_items_changed(sid, reset=True, item_id="third")
    assert session_stream.item_mutations_since(sid, 0) is None
    assert session_stream.item_mutations_since(sid, checkpoint) == ("second", "third")
    session_stream.mark_items_changed(sid, reset=True)
    assert session_stream.item_mutations_since(sid, checkpoint) is None


@pytest.mark.parametrize("expired", [False, True])
async def test_untracked_or_expired_mutations_still_require_full_reset(
    saved, monkeypatch, expired
):
    store, sid = saved
    items = store.append(sid, [_message(str(index)) for index in range(3)])
    revision = session_stream.item_revision(sid)[0]
    monkeypatch.setattr(session_stream, "_ITEM_MUTATION_HISTORY_LIMIT", 2)
    if expired:
        for item in items:
            session_stream.mark_items_changed(sid, reset=True, item_id=item.id)
    else:
        session_stream.mark_items_changed(sid, reset=True)
    frames = await _events(
        SessionRecovery(
            store,
            sid,
            _allowed,
            enabled=True,
            after_position=items[-1].position,
            after_revision=revision,
            stream_epoch=inflight_text.stream_epoch(),
        )
    )
    assert frames[0]["reset"]
    assert [frame["item"]["id"] for frame in frames if "item" in frame] == [
        item.id for item in items
    ]


async def test_delta_replay_rechecks_authorization_before_point_reads(saved, monkeypatch):
    store, sid = saved
    [item] = store.append(sid, [_message()])
    revision = session_stream.item_revision(sid)[0]
    session_stream.mark_items_changed(sid, reset=True, item_id=item.id)
    authorizations = 0

    async def revoked():
        nonlocal authorizations
        authorizations += 1
        if authorizations > 1:
            raise OmnigentError("Conversation not found", code=ErrorCode.NOT_FOUND)

    read = Mock(wraps=store.get_item)
    monkeypatch.setattr(store, "get_item", read)
    with pytest.raises(OmnigentError):
        await _events(
            SessionRecovery(
                store,
                sid,
                revoked,
                enabled=True,
                after_position=item.position,
                after_revision=revision,
                stream_epoch=inflight_text.stream_epoch(),
            )
        )
    read.assert_not_called()


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


async def test_window_cold_100_of_10000_decodes_only_window_and_legacy_reads_all(
    saved, monkeypatch
):
    store, sid = saved
    originals = store.append(sid, [_message(str(index)) for index in range(10000)])
    read = Mock(wraps=store.list_items)
    decode = Mock(wraps=store._decode_item_data_batch)
    monkeypatch.setattr(store, "list_items", read)
    monkeypatch.setattr(store, "_decode_item_data_batch", decode)
    frames = await _events(SessionRecovery(store, sid, _allowed, enabled=True, initial_limit=100))
    assert [frame["item"]["id"] for frame in frames if "item" in frame] == [
        item.id for item in originals[-100:]
    ]
    assert frames[0] == {**frames[-1], "phase": "start"}
    assert frames[-1]["item_count"] == 10000
    assert frames[-1]["window_item_count"] == 100
    assert frames[-1]["window_start_position"] == 9900
    assert frames[-1]["has_older_items"]
    assert frames[-1]["first_item_id"] == originals[-100].id
    read.assert_called_once_with(sid, order="desc", limit=100, through_position=9999)
    assert sum(len(call.args[0]) for call in decode.call_args_list) == 100
    read.reset_mock()
    decode.reset_mock()
    legacy = await _events(SessionRecovery(store, sid, _allowed, enabled=True))
    assert len([frame for frame in legacy if "item" in frame]) == 10000
    assert "window_item_count" not in legacy[-1]
    assert sum(len(call.args[0]) for call in decode.call_args_list) == 10000
    assert all(call.kwargs["limit"] == 200 for call in read.call_args_list)


@pytest.mark.parametrize("limit,expected", [(1, 1), (100, 100), (200, 200), (999, 200)])
async def test_window_limits_and_hidden_canonical_first_row(saved, limit, expected):
    store, sid = saved
    pending = _message(response_id=PENDING_INPUT_RESPONSE_ID)
    hidden = _message("hidden metadata")
    hidden.data.is_meta = True
    originals = store.append(sid, [pending, hidden, *[_message() for _ in range(199)]])
    frames = await _events(
        SessionRecovery(store, sid, _allowed, enabled=True, initial_limit=limit)
    )
    assert len([frame for frame in frames if "item" in frame]) == expected
    assert frames[-1]["item_count"] == 200
    assert frames[-1]["window_item_count"] == expected
    assert frames[-1]["first_item_id"] == originals[-expected].id
    assert frames[-1]["has_older_items"] == (expected < 200)


async def test_expanded_window_reset_keeps_requested_start_across_bounded_pages(
    saved, monkeypatch
):
    store, sid = saved
    originals = store.append(sid, [_message(str(index)) for index in range(1000)])
    read = Mock(wraps=store.list_items)
    monkeypatch.setattr(store, "list_items", read)
    frames = await _events(
        SessionRecovery(
            store,
            sid,
            _allowed,
            enabled=True,
            initial_limit=100,
            window_start_position=123,
            after_position=999,
            after_revision=0,
            stream_epoch="previous-process",
        )
    )
    assert frames[0]["reset"]
    assert frames[-1]["window_start_position"] == 123
    assert frames[-1]["window_item_count"] == 877
    assert frames[-1]["first_item_id"] == originals[123].id
    assert frames[-1]["has_older_items"]
    assert [frame["item"]["id"] for frame in frames if "item" in frame] == [
        item.id for item in originals[123:]
    ]
    assert read.call_count == 5
    assert all(call.kwargs["limit"] == 200 for call in read.call_args_list)
    assert all(call.kwargs["through_position"] == 999 for call in read.call_args_list)


async def test_window_delta_and_live_tail_ignore_old_mutation_outside_loaded_range(saved):
    store, sid = saved
    originals = store.append(
        sid,
        [
            NewConversationItem(
                type="resource_event",
                response_id="turn",
                data=ResourceEventData(
                    event_type="session.subagent.returned",
                    resource_id=f"child-{index}",
                    resource_type="session",
                    resource={"dispatch_id": f"dispatch-{index}", "task_input": "original"},
                ),
            )
            for index in range(10)
        ],
    )
    revision = session_stream.item_revision(sid)[0]
    for item in (originals[1], originals[8]):
        store.enrich_resource_event(
            sid, item.id, {**item.data.resource, "task_input": "expanded original task"}
        )
    recovery = SessionRecovery(
        store,
        sid,
        _allowed,
        enabled=True,
        initial_limit=3,
        window_start_position=7,
        after_position=9,
        after_revision=revision,
        stream_epoch=inflight_text.stream_epoch(),
    )
    frames = await _events(recovery)
    assert not frames[0]["reset"]
    assert [frame["item"]["id"] for frame in frames if "item" in frame] == [originals[8].id]
    assert frames[1]["item"]["resource"]["task_input"] == "expanded original task"
    assert frames[-1]["window_item_count"] == 3
    assert (
        await recovery.prepare(
            {"type": "response.output_item.updated", "item": {"id": originals[1].id}}
        )
        is None
    )
    assert (
        await recovery.prepare(
            {"type": "response.output_item.done", "item": originals[8].to_api_dict()}
        )
        is None
    )
    [new] = store.append(sid, [_message("new tail")])
    assert (await recovery.prepare({"type": "response.output_item.done", "item": {"id": new.id}}))[
        "item"
    ]["id"] == new.id


def _delete_canonical(store, sid, item_id):
    from sqlalchemy import delete

    from omnigent.db.db_models import SqlConversationItem, current_workspace_id

    with store._conv_session("test_delete_canonical") as session:
        session.execute(
            delete(SqlConversationItem).where(
                SqlConversationItem.workspace_id == current_workspace_id(),
                SqlConversationItem.conversation_id == sid,
                SqlConversationItem.id == item_id,
            )
        )
    session_stream.mark_items_changed(sid, reset=True)


async def test_window_reset_preserves_deleted_earliest_lower_bound_and_truthful_counts(saved):
    store, sid = saved
    originals = store.append(sid, [_message() for _ in range(10)])
    _delete_canonical(store, sid, originals[5].id)
    frames = await _events(
        SessionRecovery(
            store,
            sid,
            _allowed,
            enabled=True,
            initial_limit=3,
            window_start_position=5,
        )
    )
    assert frames[-1]["window_start_position"] == 5
    assert frames[-1]["window_item_count"] == 4
    assert frames[-1]["item_count"] == 9
    assert frames[-1]["first_item_id"] == originals[6].id
    assert frames[-1]["has_older_items"]
    assert [frame["item"]["position"] for frame in frames if "item" in frame] == [6, 7, 8, 9]


@pytest.mark.parametrize("start", [None, 0, 9])
async def test_empty_window_metadata(saved, start):
    store, sid = saved
    frames = await _events(
        SessionRecovery(
            store,
            sid,
            _allowed,
            enabled=True,
            initial_limit=100,
            window_start_position=start,
        )
    )
    assert frames[-1]["window_item_count"] == 0
    assert frames[-1]["window_start_position"] == (start or 0)
    assert frames[-1]["first_item_id"] is None
    assert not frames[-1]["has_older_items"]


@pytest.mark.parametrize("explicit", [False, True])
@pytest.mark.parametrize("change", ["deletion", "promotion", "mutation"])
async def test_window_reset_interleaving_never_claims_complete(saved, explicit, change):
    store, sid = saved
    originals = store.append(
        sid,
        [
            _message(response_id=PENDING_INPUT_RESPONSE_ID),
            *[_message() for _ in range(8)],
            NewConversationItem(
                type="resource_event",
                response_id="turn",
                data=ResourceEventData(
                    event_type="session.subagent.returned",
                    resource_id="child",
                    resource_type="session",
                    resource={"dispatch_id": "dispatch", "task_input": "original"},
                ),
            ),
        ],
    )
    recovery = SessionRecovery(
        store,
        sid,
        _allowed,
        enabled=True,
        initial_limit=3,
        window_start_position=7 if explicit else None,
    )
    frames = recovery.events()
    async with contextlib.aclosing(frames):
        assert (await anext(frames))["window_item_count"] == 3
        if change == "deletion":
            _delete_canonical(store, sid, originals[7].id)
        elif change == "promotion":
            store.append(sid, [_message("accepted", replaces_pending_id=originals[0].id)])
        else:
            store.enrich_resource_event(
                sid, originals[-1].id, {"dispatch_id": "dispatch", "task_input": "new longer task"}
            )
        emitted = []
        with pytest.raises(ConnectionError, match="changed during recovery"):
            async for frame in frames:
                emitted.append(frame)
        assert not any(frame.get("phase") == "complete" for frame in emitted)


async def test_window_subscribe_highwater_append_overlap_and_tail_dedup(saved, monkeypatch):
    store, sid = saved
    originals = store.append(sid, [_message() for _ in range(10)])
    original_read = store.list_items
    appended = []

    def read(*args, **kwargs):
        assert session_stream.has_subscribers(sid)
        assert kwargs["through_position"] == 9
        [new] = store.append(sid, [_message("after fence")])
        appended.append(new)
        for item in (originals[-1], new):
            session_stream.publish(
                sid, {"type": "response.output_item.done", "item": item.to_api_dict()}
            )
        return original_read(*args, **kwargs)

    monkeypatch.setattr(store, "list_items", read)
    recovery = SessionRecovery(store, sid, _allowed, enabled=True, initial_limit=3)
    stream = _stream_live_events(_Connected(), sid, recovery=recovery)
    events = []
    async with contextlib.aclosing(stream):
        while not appended or not any(
            event.get("item", {}).get("id") == appended[0].id for event in events
        ):
            frame = await asyncio.wait_for(anext(stream), timeout=2)
            events.append(json.loads(frame.split("data: ", 1)[1]))
    assert [event["item"]["id"] for event in events if "item" in event] == [
        *[item.id for item in originals[-3:]],
        appended[0].id,
    ]
    assert (
        next(event for event in events if event.get("phase") == "complete")["last_position"] == 9
    )
    assert not session_stream.has_subscribers(sid)


async def test_window_pages_reauthorize_before_read_and_projection(saved, monkeypatch):
    store, sid = saved
    store.append(sid, [_message() for _ in range(500)])
    count = 0

    async def authorize():
        nonlocal count
        count += 1
        if count == 4:
            raise OmnigentError("Revoked", code=ErrorCode.NOT_FOUND)

    read = Mock(wraps=store.list_items)
    monkeypatch.setattr(store, "list_items", read)
    with pytest.raises(OmnigentError):
        await _events(
            SessionRecovery(
                store,
                sid,
                authorize,
                enabled=True,
                initial_limit=100,
                window_start_position=0,
            )
        )
    assert read.call_count == 1


async def test_window_question_receipt_identity_redaction_and_old_pending_consumption(saved):
    from omnigent.runtime.pending_inputs import make_pending_id
    from omnigent.server.routes._question_receipts import record_question_receipt

    store, sid = saved
    [pending] = store.append(sid, [_message(response_id=PENDING_INPUT_RESPONSE_ID)])
    params = {
        "ask_user_question": {
            "questions": [
                {
                    "id": "credential",
                    "question": "Credential?",
                    "isSecret": True,
                    "textInput": {"default": "private-default"},
                },
            ]
        }
    }
    result = {"action": "accept", "content": {"credential": "private-answer"}}
    receipts = [
        await record_question_receipt(store, sid, eid, params, result)
        for eid in ("question-first", "question-second")
    ]
    assert await record_question_receipt(store, sid, "question-second", params, result) is None
    recovery = SessionRecovery(store, sid, _allowed, enabled=True, initial_limit=1)
    cold = await _events(recovery)
    assert cold[1]["item"] == receipts[-1]
    assert cold[-1]["first_item_id"] == receipts[-1]["id"]
    assert cold[-1]["window_item_count"] == 1 and cold[-1]["item_count"] == 2
    assert receipts[0]["id"] != receipts[1]["id"]
    # A consumed input outside the window still settles its exact optimistic identity.
    [consumed] = store.append(sid, [_message("accepted", replaces_pending_id=pending.id)])
    pending_id = make_pending_id(sid, pending.id)
    control = await recovery.prepare(
        {
            "type": "session.input.consumed",
            "data": {"item_id": consumed.id, "cleared_pending_id": pending_id},
        }
    )
    assert control["data"]["item_id"] == consumed.id and control["data"]["position"] == 0
    assert control["data"]["cleared_pending_id"] == pending_id
    assert (
        await recovery.prepare(
            {"type": "response.output_item.done", "item": consumed.to_api_dict()}
        )
        is None
    )
    assert (await recovery.prepare({"type": "session.heartbeat"}))["reconcile_required"]
    expanded = await _events(
        SessionRecovery(
            store,
            sid,
            _allowed,
            enabled=True,
            initial_limit=1,
            window_start_position=1,
            after_position=2,
            after_revision=cold[-1]["item_revision"],
            stream_epoch=inflight_text.stream_epoch(),
        )
    )
    assert expanded[-1]["reset"] and expanded[-1]["item_count"] == 3
    assert [frame["item"] for frame in expanded if "item" in frame] == receipts
    assert expanded[-1]["window_item_count"] == 2 and expanded[-1]["has_older_items"]
    assert "private-answer" not in json.dumps(expanded)
    assert "private-default" not in json.dumps(expanded)


@pytest.mark.parametrize("allowed", [False, True])
async def test_window_activity_projection_preserves_membership_and_source_permissions(
    saved, allowed
):
    from omnigent.server.subagent_activity import recover_subagent_activity

    store, sid = saved
    store.append(sid, [_message("older")])
    child = store.create_conversation(parent_conversation_id=sid)
    [source] = store.append(child.id, [_message("authorized child task")])
    [activity] = store.append(
        sid,
        [
            NewConversationItem(
                type="resource_event",
                response_id="turn",
                data=ResourceEventData(
                    event_type="session.subagent.delegated",
                    resource_id=child.id,
                    resource_type="session",
                    resource={
                        "dispatch_id": "dispatch",
                        "task_input_ref": {"conversation_id": child.id, "item_id": source.id},
                    },
                ),
            )
        ],
    )
    checked = []

    async def can_read(source_id):
        checked.append(source_id)
        return allowed

    async def project(items):
        return await recover_subagent_activity(sid, items, store, can_read)

    recovery = SessionRecovery(
        store, sid, _allowed, enabled=True, initial_limit=1, project=project
    )
    frames = await _events(recovery)
    projected = frames[1]["item"]
    assert checked == [child.id]
    assert projected["id"] == frames[-1]["first_item_id"] == activity.id
    assert projected["position"] == activity.position
    assert frames[-1]["window_item_count"] == 1 and frames[-1]["item_count"] == 2
    assert projected["resource"].get("task_input") == (
        "authorized child task" if allowed else None
    )
    assert "task_input" not in store.get_item(sid, activity.id).data.resource
    assert (
        await recovery.prepare(
            {"type": "response.output_item.done", "item": activity.to_api_dict()}
        )
        is None
    )


async def test_versioned_replay_and_live_cursor_share_atomic_sqlite_revision(saved):
    from sqlalchemy import delete

    from omnigent.db.db_models import SqlConversationItem
    from omnigent.server.session_recovery import feed_epoch

    store, sid = saved
    journal = store.transcript_journal
    assert journal is not None
    rows = store.append(sid, [_message(str(i)) for i in range(40)])
    with pytest.raises(RuntimeError, match="rollback"):
        with store._conv_session("test_rollback_transcript_change") as session:
            session.execute(
                delete(SqlConversationItem).where(SqlConversationItem.id == rows[-1].id)
            )
            raise RuntimeError("rollback")
    assert journal.revision(sid) == 40
    assert store.get_item(sid, rows[-1].id) == rows[-1]
    recovery = SessionRecovery(
        store, sid, _allowed, enabled=True, journal=journal, initial_limit=40
    )
    frames = await _events(recovery)
    pages = [event["items"] for event in frames if event["type"] == "session.snapshot_page"]
    assert list(map(len, pages)) == [32, 8]
    assert [item["id"] for page in pages for item in page] == [row.id for row in rows]
    assert frames[-1]["item_revision"] == 40 and frames[-1]["stream_epoch"] == feed_epoch()
    [new] = store.append(sid, [_message("live")])
    frame = await recovery.prepare({"type": "response.output_item.done", "item": {"id": new.id}})
    assert frame["_change_revision"] == 41
    assert frame["item"]["position"] == 40
    heartbeat = await recovery.prepare({"type": "session.heartbeat"})
    assert heartbeat["item_revision"] == frame["_change_revision"]
    assert not heartbeat["reconcile_required"]
    resumed = await _events(
        SessionRecovery(
            store,
            sid,
            _allowed,
            enabled=True,
            journal=journal,
            initial_limit=40,
            after_position=40,
            after_revision=41,
            stream_epoch=feed_epoch(),
        )
    )
    assert [event["phase"] for event in resumed] == ["start", "complete"]
    assert not resumed[-1]["reset"]
    _delete_canonical(store, sid, rows[10].id)
    reset = await _events(
        SessionRecovery(
            store,
            sid,
            _allowed,
            enabled=True,
            journal=journal,
            initial_limit=40,
            after_position=40,
            after_revision=41,
            stream_epoch=feed_epoch(),
        )
    )
    assert reset[-1]["reset"] and reset[-1]["item_revision"] == 42


async def test_versioned_amendment_replays_the_old_position_and_resets_expired_cursor(saved):
    from omnigent.server.session_recovery import feed_epoch

    store, sid = saved
    journal = store.transcript_journal
    assert journal is not None
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
    assert journal.revision(sid) == 1
    store.enrich_resource_event(
        sid, resource.id, {"result_text": "a longer final", "result_finality": "adapter_result"}
    )
    (change,) = journal.changes(sid, 1)
    assert (change.item_id, change.position, change.revision) == (resource.id, 0, 2)
    resumed = await _events(
        SessionRecovery(
            store,
            sid,
            _allowed,
            enabled=True,
            journal=journal,
            initial_limit=10,
            after_position=0,
            after_revision=1,
            stream_epoch=feed_epoch(),
        )
    )
    assert not resumed[-1]["reset"]
    assert resumed[1]["items"][0]["resource"]["result_text"] == "a longer final"
    store.append(sid, [_message() for _ in range(300)])
    assert len(journal.changes(sid, -1)) == 256
    reset = await _events(
        SessionRecovery(
            store,
            sid,
            _allowed,
            enabled=True,
            journal=journal,
            initial_limit=10,
            after_position=0,
            after_revision=1,
            stream_epoch=feed_epoch(),
        )
    )
    assert reset[-1]["reset"] and reset[-1]["window_item_count"] == 10
    with workspace_scope(123):
        assert journal.changes(sid, -1) == [] and journal.revision(sid) == 0


async def test_prejournal_database_keeps_existing_history_and_rolls_back_to_legacy_reader(
    saved, db_uri
):
    store, sid = saved
    with store._conv_engine.begin() as connection:
        for name in ("append", "amend", "remove", "cleanup"):
            connection.exec_driver_sql(f"DROP TRIGGER triune_transcript_{name}")
        connection.exec_driver_sql("DROP TABLE triune_transcript_changes")
    [old] = store.append(sid, [_message("existing allocation")])
    upgraded = SqlAlchemyConversationStore(db_uri)
    journal = upgraded.transcript_journal
    assert journal is not None and journal.revision(sid) == 0
    initial = await _events(
        SessionRecovery(upgraded, sid, _allowed, enabled=True, journal=journal, initial_limit=5)
    )
    assert [item["id"] for page in initial if "items" in page for item in page["items"]] == [
        old.id
    ]
    [new] = upgraded.append(sid, [_message("new allocation")])
    assert journal.revision(sid) == 1
    legacy = await _events(SessionRecovery(store, sid, _allowed, enabled=True, initial_limit=5))
    assert [event["item"]["id"] for event in legacy if "item" in event] == [old.id, new.id]


async def test_versioned_snapshot_including_a_later_append_still_acknowledges_its_change(
    saved, monkeypatch
):
    store, sid = saved
    [first] = store.append(sid, [_message("first")])
    recovery = SessionRecovery(
        store, sid, _allowed, enabled=True, journal=store.transcript_journal, initial_limit=10
    )
    checkpoint = recovery.checkpoint
    later = []

    async def racing_checkpoint(revision):
        later.extend(store.append(sid, [_message("arrives before the snapshot read")]))
        return await checkpoint(revision)

    monkeypatch.setattr(recovery, "checkpoint", racing_checkpoint)
    frames = await _events(recovery)
    assert frames[-1]["item_revision"] == 1 and frames[-1]["last_position"] == 1
    assert [row["id"] for frame in frames for row in frame.get("items", ())] == [
        first.id,
        later[0].id,
    ]
    assert (
        await recovery.prepare({"type": "response.output_item.done", "item": {"id": first.id}})
        is None
    )
    delivery = await recovery.prepare(
        {"type": "response.output_item.done", "item": {"id": later[0].id}}
    )
    assert delivery["_change_revision"] == 2


async def test_replayed_final_suppresses_only_its_own_pre_ready_native_preview(saved, monkeypatch):
    store, sid = saved
    final = NewConversationItem(
        type="message",
        response_id="active",
        data=MessageData(
            role="assistant",
            agent="fixture",
            phase="final_answer",
            stream_message_id="finished-preview",
            content=[{"type": "output_text", "text": "final answer"}],
        ),
    )
    recovery = SessionRecovery(
        store, sid, _allowed, journal=store.transcript_journal, enabled=True, initial_limit=100
    )
    old_preview = {
        "type": "response.output_text.delta",
        "message_id": "finished-preview",
        "delta": "old prefix",
        "delta_index": 1,
    }
    current_preview = {**old_preview, "message_id": "still-working"}
    checkpoint = recovery.checkpoint

    async def finish_after_registration(revision):
        store.append(sid, [final])
        return await checkpoint(revision)

    monkeypatch.setattr(recovery, "checkpoint", finish_after_registration)
    frames = await _events(recovery)
    assert frames[-1]["item_count"] == 1 and frames[-1]["item_revision"] == 0
    assert await recovery.prepare(old_preview) is None
    assert await recovery.prepare(current_preview) == current_preview
