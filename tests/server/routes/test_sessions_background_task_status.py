# Modified for Triune.
"""Background-shell tally: cache stickiness and the sidebar-list rollup.

A claude-native turn can settle to ``idle`` while background shells keep
running. ``_publish_status`` keeps a sticky per-session tally so the
in-chat "N background tasks still running" indicator survives the trailing
PTY-activity ``idle`` (which carries no count) and a reload.

The tally must clear on an authoritative ``Stop``-hook ``0`` (the shell
finished) and on a failure — but NOT on the countless trailing ``idle`` edges
that carry no count, and NOT on a new ``running`` turn (background shells
outlive turn boundaries, so the composer pill stays lit alongside the working
shimmer until the next authoritative count). It must never make
``_session_status_with_child_rollup`` report ``running``: the turn is over
and the session takes a new message immediately.
"""

from __future__ import annotations

import logging
import types
from unittest.mock import Mock

import httpx
import pytest
from pydantic import TypeAdapter

from omnigent.debug_logging import record_to_row
from omnigent.entities import MessageData, NewConversationItem
from omnigent.entities.communication import MessageCommunication
from omnigent.runner.identity import RUNNER_TUNNEL_TOKEN_HEADER, token_bound_runner_id
from omnigent.runtime import session_stream
from omnigent.server.auth import LEVEL_EDIT, LEVEL_OWNER, LEVEL_READ
from omnigent.server.routes import sessions as _sessions_mod
from omnigent.server.routes._sessions.common import _session_background_task_inventory_sources
from omnigent.server.routes._sessions.helpers import _publish_background_tasks
from omnigent.server.routes.sessions import (
    _CLAUDE_NATIVE_WRAPPER_LABEL_KEY,
    _CODEX_NATIVE_SUBAGENT_WRAPPER_LABEL_VALUE,
    _background_task_delivery_status,
    _publish_status,
    _session_status_with_child_rollup,
)
from omnigent.server.schemas import BackgroundTaskInfo, ErrorDetail, ServerStreamEvent
from omnigent.server.subagent_activity import record_subagent_activity
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.stores.permission_store.sqlalchemy_store import SqlAlchemyPermissionStore
from tests.debug_log_helpers import capture_debug_rows
from tests.server.routes.test_sessions_crud import session_id as session_id

_SID = "conv_bg_test"


def _tasks(*descriptions: str) -> list[BackgroundTaskInfo]:
    """Detail entries for the given shell descriptions."""
    return [BackgroundTaskInfo(status="running", description=d) for d in descriptions]


def _conv(kind: str, *, labels: dict[str, str] | None = None) -> object:
    """Minimal conversation stand-in for status-mapping helpers."""
    return types.SimpleNamespace(kind=kind, labels=labels or {})


@pytest.fixture(autouse=True)
def _clear_caches() -> None:
    """Isolate each case from leaked module-level cache state."""
    _sessions_mod._session_status_cache.pop(_SID, None)
    _sessions_mod._session_background_task_count_cache.pop(_SID, None)
    _sessions_mod._session_background_tasks_cache.pop(_SID, None)
    _session_background_task_inventory_sources.discard(_SID)
    _sessions_mod._session_active_response_cache.pop(_SID, None)
    yield
    _sessions_mod._session_status_cache.pop(_SID, None)
    _sessions_mod._session_background_task_count_cache.pop(_SID, None)
    _sessions_mod._session_background_tasks_cache.pop(_SID, None)
    _session_background_task_inventory_sources.discard(_SID)
    _sessions_mod._session_active_response_cache.pop(_SID, None)


def test_background_task_turn_end_closes_the_active_response() -> None:
    # The composer bug's mechanism: `waiting` KEEPS the in-flight response id,
    # and the snapshot projects `waiting` as `running` — so a reconnect reopened
    # the settled turn as "streaming" and queued every send behind "Steer".
    # Delivering the turn-end as `idle` closes the response, so the snapshot has
    # nothing to reopen. The tally still reports the shells.
    _publish_status(_SID, "running", response_id="resp_1")
    assert _sessions_mod._session_active_response_cache.get(_SID) == "resp_1"
    _publish_status(_SID, "idle", response_id="resp_1", background_task_count=2)
    assert _SID not in _sessions_mod._session_active_response_cache
    assert _sessions_mod._session_background_task_count_cache.get(_SID) == 2


@pytest.mark.parametrize("status", ["idle", "running", "waiting", "failed"])
async def test_count_only_event_preserves_turn_and_rehydrates_snapshot(
    client: httpx.AsyncClient,
    db_uri: str,
    session_id: str,
    monkeypatch: pytest.MonkeyPatch,
    status: str,
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    conv = store.get_conversation(session_id)
    assert conv is not None
    store.set_session_live_status(conv.id, status)
    _sessions_mod._session_status_cache[conv.id] = status
    if status in {"running", "waiting"}:
        _sessions_mod._session_active_response_cache[conv.id] = "active-response"
    publish = Mock()
    monkeypatch.setattr(session_stream, "publish", publish)
    task = {"id": "native-call", "type": "shell", "status": "running", "command": "sleep 30"}
    for count, tasks in ((1, [task]), (0, [])):
        previous_status = _sessions_mod._session_status_cache.get(conv.id)
        previous_response = _sessions_mod._session_active_response_cache.get(conv.id)
        previous_live = store.get_conversation(conv.id).live_status
        response = await client.post(
            f"/v1/sessions/{conv.id}/events",
            json={
                "type": "external_session_background_tasks",
                "data": {
                    "background_task_count": count,
                    "background_tasks": tasks,
                    "status": "idle",
                    "response_id": "must-not-apply",
                },
            },
        )
        assert response.status_code == 202, response.text
        assert response.json() == {"queued": False}
        event = publish.call_args.args[1]
        TypeAdapter(ServerStreamEvent).validate_python(event)
        assert event == {
            "type": "session.background_tasks",
            "conversation_id": conv.id,
            "background_task_count": count,
            "background_tasks": [BackgroundTaskInfo(**row).model_dump() for row in tasks],
            "sequence_number": None,
        }
        assert _sessions_mod._session_status_cache.get(conv.id) == previous_status
        assert _sessions_mod._session_active_response_cache.get(conv.id) == previous_response
        assert store.get_conversation(conv.id).live_status == previous_live
        snapshot = await client.get(f"/v1/sessions/{conv.id}")
        assert snapshot.status_code == 200, snapshot.text
        assert (snapshot.json()["background_task_count"] or 0) == count
        assert (snapshot.json()["background_tasks"] or []) == event["background_tasks"]
    assert store.list_items(conv.id).data == []
    assert publish.call_count == 2


@pytest.mark.parametrize("count", [True, -1, "1", None])
async def test_count_only_event_rejects_invalid_counts_without_changing_inventory(
    client: httpx.AsyncClient, db_uri: str, count: object
) -> None:
    conv = SqlAlchemyConversationStore(db_uri).create_conversation()
    response = await client.post(
        f"/v1/sessions/{conv.id}/events",
        json={
            "type": "external_session_background_tasks",
            "data": {"background_task_count": count},
        },
    )
    assert response.status_code == 400
    assert conv.id not in _sessions_mod._session_background_task_count_cache


@pytest.mark.parametrize(
    "actor,token,expected",
    [
        ("owner@example.test", None, 202),
        ("editor@example.test", None, 403),
        ("reader@example.test", None, 403),
        ("stranger@example.test", None, 404),
        ("editor@example.test", "bound-native-runner", 202),
        ("editor@example.test", "different-runner", 403),
    ],
)
async def test_native_inventory_requires_owner_or_bound_runner(
    auth_client: httpx.AsyncClient, db_uri: str, actor: str, token: str | None, expected: int
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    conv = store.create_conversation()
    store.replace_runner_id(conv.id, token_bound_runner_id("bound-native-runner"))
    permissions = SqlAlchemyPermissionStore(db_uri)
    for user, level in (
        ("owner@example.test", LEVEL_OWNER),
        ("editor@example.test", LEVEL_EDIT),
        ("reader@example.test", LEVEL_READ),
    ):
        permissions.ensure_user(user)
        permissions.grant(user, conv.id, level)
    headers = {"X-Forwarded-Email": actor}
    if token is not None:
        headers[RUNNER_TUNNEL_TOKEN_HEADER] = token
    response = await auth_client.post(
        f"/v1/sessions/{conv.id}/events",
        headers=headers,
        json={"type": "external_session_background_tasks", "data": {"background_task_count": 1}},
    )
    assert response.status_code == expected, response.text
    assert _sessions_mod._session_background_task_count_cache.get(conv.id) == (
        1 if expected == 202 else None
    )


def test_native_inventory_does_not_expire_when_an_assistant_turn_fails() -> None:
    _publish_background_tasks(_SID, 1, _tasks("sleep 30"))
    _publish_status(_SID, "running", response_id="turn")
    _publish_status(_SID, "failed")
    assert _sessions_mod._session_status_cache[_SID] == "failed"
    assert _SID not in _sessions_mod._session_active_response_cache
    assert _sessions_mod._session_background_task_count_cache[_SID] == 1
    _publish_background_tasks(_SID, 0, [])
    assert _SID not in _sessions_mod._session_background_task_count_cache


def test_idle_with_positive_count_sets_sticky_tally_but_list_stays_idle() -> None:
    # Stop hook: idle turn-end but a shell is still running. The tally sticks
    # (it feeds the in-chat indicator) while the list row stays idle — the turn
    # is over, so the sidebar must not spin and the composer must not queue.
    _publish_status(_SID, "idle", background_task_count=2)
    assert _sessions_mod._session_background_task_count_cache.get(_SID) == 2
    assert _session_status_with_child_rollup(_SID, []) == "idle"


@pytest.mark.parametrize("native", ["codex", "claude"])
@pytest.mark.parametrize("sender", ["current", "stale", "unrelated", "owner-only"])
async def test_reregistered_native_child_keeps_history_and_accepts_current_shells(
    client: httpx.AsyncClient, db_uri: str, session_id: str, sender: str, native: str
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    old_runner = token_bound_runner_id("parent-before-restart")
    new_runner = token_bound_runner_id("parent-after-restart")
    store.replace_runner_id(session_id, old_runner)
    registration = {
        "type": "external_codex_subagent_start",
        "data": {"thread_id": "native-child-thread", "tool_call_id": "spawn-1", "prompt": "Audit"},
    }
    if native == "claude":
        registration = {
            "type": "external_subagent_start",
            "data": {
                "subagent_id": "native-child-thread",
                "agent_type": "Explore",
                "tool_use_id": "spawn-1",
                "description": "Audit",
            },
        }
    created = await client.post(
        f"/v1/sessions/{session_id}/events",
        json=registration,
        headers={RUNNER_TUNNEL_TOKEN_HEADER: "parent-before-restart"},
    )
    assert created.status_code == 202, created.text
    child_id = created.json()["child_session_id"]
    store.append(
        child_id,
        [
            NewConversationItem(
                type="message",
                stable_id="b" * 32,
                response_id="saved-receipt",
                data=MessageData(
                    role="user",
                    content=[{"type": "input_text", "text": "Received assignment"}],
                    communication=MessageCommunication(
                        kind="peer",
                        message_id="saved-receipt",
                        source_conversation_id=session_id,
                        destination_conversation_id=child_id,
                        task_id="spawn-1",
                        delivery_state="confirmed",
                        receipt="model_consumed",
                    ),
                ),
            )
        ],
    )
    store.append(
        child_id,
        [
            NewConversationItem(
                type="message",
                stable_id="a" * 32,
                response_id="native-turn",
                data=MessageData(
                    role="assistant",
                    agent="codex-native-ui",
                    phase="final_answer",
                    content=[{"type": "output_text", "text": "Done"}],
                ),
            )
        ],
    )
    await record_subagent_activity(child_id, "returned", store, turn_id="native-turn")
    store.set_session_live_status(child_id, "idle")
    before = store.get_conversation(child_id)
    receipt_before = store.get_item(child_id, "b" * 32).data.communication.model_dump()
    items_before = {
        sid: [item.model_dump() for item in store.list_items(sid).data]
        for sid in (session_id, child_id)
    }
    store.replace_runner_id(session_id, new_runner)
    token = {
        "current": "parent-after-restart",
        "stale": "parent-before-restart",
        "unrelated": "unrelated-runner",
        "owner-only": None,
    }[sender]
    headers = {RUNNER_TUNNEL_TOKEN_HEADER: token} if token else {}
    # A body claim must never supply the authority missing from the request.
    registration["data"]["runner_id"] = new_runner
    registered = await client.post(
        f"/v1/sessions/{session_id}/events", json=registration, headers=headers
    )
    assert registered.status_code == (202 if sender == "current" else 403), registered.text
    after = store.get_conversation(child_id)
    assert after.runner_id == (new_runner if sender == "current" else old_runner)
    assert after.labels == before.labels
    assert after.live_status == before.live_status
    assert after.updated_at == before.updated_at
    assert store.get_item(child_id, "b" * 32).data.communication.model_dump() == receipt_before
    assert {
        sid: [item.model_dump() for item in store.list_items(sid).data]
        for sid in (session_id, child_id)
    } == items_before
    shell = await client.post(
        f"/v1/sessions/{child_id}/events",
        headers={RUNNER_TUNNEL_TOKEN_HEADER: "parent-after-restart"},
        json={
            "type": "external_session_background_tasks",
            "data": {"background_task_count": 0, "background_tasks": [], "shell_resources": []},
        },
    )
    assert shell.status_code == (202 if sender == "current" else 403), shell.text
    provenance = await client.post(
        f"/v1/sessions/{child_id}/events",
        headers={RUNNER_TUNNEL_TOKEN_HEADER: "parent-after-restart"},
        json={
            "type": "external_conversation_item",
            "data": {
                "source_id": "new-native-input",
                "item_type": "message",
                "item_data": {
                    "role": "user",
                    "user_authored": True,
                    "content": [{"type": "input_text", "text": "Native input"}],
                },
            },
        },
    )
    assert provenance.status_code == (202 if sender == "current" else 403), provenance.text


def test_trailing_idle_without_count_leaves_tally_sticky() -> None:
    # PTY-activity idle (no count) must NOT wipe the count the Stop hook set.
    _publish_status(_SID, "idle", background_task_count=2)
    _publish_status(_SID, "idle", background_task_count=None)
    assert _sessions_mod._session_background_task_count_cache.get(_SID) == 2


def test_authoritative_zero_clears_tally_and_list_drops_to_idle() -> None:
    # The shell finished: the next Stop hook reports an explicit 0, which must
    # clear the tally so the spinner goes out.
    _publish_status(_SID, "idle", background_task_count=2)
    _publish_status(_SID, "idle", background_task_count=0)
    assert _SID not in _sessions_mod._session_background_task_count_cache
    assert _session_status_with_child_rollup(_SID, []) == "idle"


def test_background_task_debug_rows_preserve_known_counts_without_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rows: list[dict[str, object]] = []

    class Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            rows.append(record_to_row(record, source="server"))

    monkeypatch.setattr(session_stream, "sse_logging_enabled", lambda: True)
    logger = session_stream.sse_event_logger()
    previous_level = logger.level
    handler = Capture()
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    try:
        for count in (2, None, 0):
            _publish_status(
                _SID,
                "idle",
                response_id="resp_bg",
                background_task_count=count,
                background_tasks=_tasks("private shell command", "private task detail")
                if count == 2
                else None,
                blocked_on="private approval detail",
            )
    finally:
        logger.removeHandler(handler)
        logger.setLevel(previous_level)

    assert [row["event_name"] for row in rows] == ["session.status"] * 3
    assert [row["session_id"] for row in rows] == [_SID] * 3
    assert [row["attributes"] for row in rows] == [
        {"status": "idle", "response_id": "resp_bg", "background_task_count": "2"},
        {"status": "idle", "response_id": "resp_bg"},
        {"status": "idle", "response_id": "resp_bg", "background_task_count": "0"},
    ]
    assert "private" not in repr(rows)


def test_new_turn_running_keeps_tally() -> None:
    # A new ``running`` turn does NOT clear the tally: background shells outlive
    # turn boundaries, so the composer pill stays lit alongside the working
    # shimmer until the next authoritative count (the trailing ``running`` edge
    # carries none).
    _publish_status(_SID, "idle", background_task_count=2)
    _publish_status(_SID, "running")
    assert _sessions_mod._session_background_task_count_cache.get(_SID) == 2


def test_failure_clears_tally_and_wins_over_count() -> None:
    _publish_status(_SID, "idle", background_task_count=2)
    _publish_status(_SID, "failed")
    assert _SID not in _sessions_mod._session_background_task_count_cache
    # ``failed`` is authoritative for the list row, never masked by a tally.
    assert _session_status_with_child_rollup(_SID, []) == "failed"


@pytest.mark.parametrize("count", [2, 0, None], ids=["positive", "cleared", "unknown"])
@pytest.mark.parametrize(
    ("code", "origin"),
    [
        ("runner_disconnected", "runner_disconnected_mid_turn"),
        ("native_turn_error", "external_session_status"),
    ],
)
def test_failure_debug_row_preserves_background_count_before_cleanup(
    count: int | None,
    code: str,
    origin: str,
) -> None:
    if count is not None:
        _publish_status(
            _SID, "idle", background_task_count=2, background_tasks=_tasks("private shell task")
        )
        if count == 0:
            _publish_status(_SID, "idle", background_task_count=0)
    _publish_status(_SID, "running", response_id="resp_bg")

    with capture_debug_rows("server") as rows:
        _publish_status(
            _SID,
            "failed",
            ErrorDetail(code=code, message="Synthetic failure"),
            response_id="resp_bg",
            failure_origin=origin,
        )

    failed = [row for row in rows if row["event_name"] == "session_turn_failed"]
    assert len(failed) == 1
    assert failed[0]["session_id"] == _SID
    expected = {
        "code": code,
        "origin": origin,
        "previous_status": "running",
        "response_id": "resp_bg",
    }
    if count == 2:
        expected["cached_background_task_count"] = "2"
    assert failed[0]["attributes"] == expected
    assert "private shell task" not in repr(failed)
    assert _SID not in _sessions_mod._session_background_task_count_cache
    assert _SID not in _sessions_mod._session_background_tasks_cache


# ── background-task detail rides with the tally ─────────────────────────────


def test_background_tasks_detail_stored_with_positive_count() -> None:
    # The per-shell detail is cached in lockstep with the count so a
    # reload/reconnect can restore the individual shells.
    tasks = _tasks("Wait for CI", "Build check")
    _publish_status(_SID, "idle", background_task_count=2, background_tasks=tasks)
    assert _sessions_mod._session_background_task_count_cache.get(_SID) == 2
    assert _sessions_mod._session_background_tasks_cache.get(_SID) == tasks


def test_background_tasks_detail_empty_when_count_only() -> None:
    # An older runner posts the count with no detail: the tally sticks and the
    # detail cache holds [] (pill shows the number, no per-shell detail).
    _publish_status(_SID, "idle", background_task_count=1, background_tasks=None)
    assert _sessions_mod._session_background_task_count_cache.get(_SID) == 1
    assert _sessions_mod._session_background_tasks_cache.get(_SID) == []


def test_background_tasks_detail_sticky_on_trailing_idle() -> None:
    # The trailing PTY-activity idle carries no count: it must not wipe the
    # detail the Stop hook just set (same rule as the count).
    tasks = _tasks("Wait for CI")
    _publish_status(_SID, "idle", background_task_count=1, background_tasks=tasks)
    _publish_status(_SID, "idle", background_task_count=None)
    assert _sessions_mod._session_background_tasks_cache.get(_SID) == tasks


def test_background_tasks_detail_cleared_on_authoritative_zero() -> None:
    _publish_status(_SID, "idle", background_task_count=1, background_tasks=_tasks("Wait for CI"))
    _publish_status(_SID, "idle", background_task_count=0)
    assert _SID not in _sessions_mod._session_background_tasks_cache


def test_background_tasks_detail_cleared_on_failure() -> None:
    _publish_status(_SID, "idle", background_task_count=1, background_tasks=_tasks("Wait for CI"))
    _publish_status(_SID, "failed")
    assert _SID not in _sessions_mod._session_background_tasks_cache


# ── background-task delivery status (ended-turn collapse) ───────────────────


def test_subagent_background_waiting_delivers_as_idle() -> None:
    # Regression: a claude-native sub-agent relabels its Stop turn-end to
    # `waiting` for background shells, but the parent's terminal-delivery gate
    # keys off idle/failed — `waiting` would hang the orchestrator. The turn
    # ended, so deliver `idle` (the tally still drives the child spinner).
    assert _background_task_delivery_status("waiting", 1, _conv("sub_agent")) == "idle"


def test_top_level_background_waiting_delivers_as_idle() -> None:
    # A top-level session's turn has ended too: `waiting` would spin the
    # sidebar, gate the composer into queue/"Steer", and let a reconnect reopen
    # the settled turn's streaming bubble. The tally carries the shells instead.
    assert _background_task_delivery_status("waiting", 1, _conv("session")) == "idle"


def test_top_level_waiting_without_background_count_unchanged() -> None:
    # A genuine async-work park (the runtime's own `waiting`, no tally) is a
    # real busy state and must survive the collapse.
    assert _background_task_delivery_status("waiting", None, _conv("session")) == "waiting"
    assert _background_task_delivery_status("waiting", 0, _conv("session")) == "waiting"


def test_subagent_waiting_without_background_count_unchanged() -> None:
    # A genuine async-park `waiting` (no background tally) is a real waiting
    # state, not a relabeled turn-end — it must not be collapsed.
    assert _background_task_delivery_status("waiting", None, _conv("sub_agent")) == "waiting"
    assert _background_task_delivery_status("waiting", 0, _conv("sub_agent")) == "waiting"


def test_codex_native_subagent_waiting_unchanged() -> None:
    # Codex-internal children are excluded from the native delivery branch, so
    # the collapse must not touch them either.
    codex_child = _conv(
        "sub_agent",
        labels={_CLAUDE_NATIVE_WRAPPER_LABEL_KEY: _CODEX_NATIVE_SUBAGENT_WRAPPER_LABEL_VALUE},
    )
    assert _background_task_delivery_status("waiting", 1, codex_child) == "waiting"


def test_non_waiting_status_passes_through() -> None:
    assert _background_task_delivery_status("idle", 1, _conv("sub_agent")) == "idle"
    assert _background_task_delivery_status("failed", 1, _conv("sub_agent")) == "failed"
