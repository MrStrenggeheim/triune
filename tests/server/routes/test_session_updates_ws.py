# Modified for Triune.
"""Tests for the ``WS /v1/sessions/updates`` push stream.

The endpoint replaces the web app's HTTP poll of ``GET /v1/sessions``:
a client sends the session ids it's watching and the server pushes a
``snapshot`` followed by ``changed`` / ``removed`` deltas as those
sessions change. These tests drive the real route (no mocks of the
store or auth) against file-backed SQLite stores, mutating persisted
conversation state to trigger deltas, and assert cross-user isolation.

The per-connection rescan interval is monkeypatched down so the
interval-driven ``changed`` / ``removed`` frames arrive promptly
instead of after the production 4 s cadence.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocket, WebSocketDisconnect

import omnigent.server.routes.sessions as sessions_routes
import omnigent.stores.conversation_store.sqlalchemy_store as conversation_module
from omnigent.runtime import pending_elicitations
from omnigent.server.auth import LEVEL_OWNER, UnifiedAuthProvider
from omnigent.server.routes.sessions import SessionLiveness, create_sessions_router
from omnigent.stores.agent_store.sqlalchemy_store import SqlAlchemyAgentStore
from omnigent.stores.comment_store.sqlalchemy_store import SqlAlchemyCommentStore
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.stores.permission_store.sqlalchemy_store import SqlAlchemyPermissionStore

ALICE = "alice@example.com"
BOB = "bob@example.com"


class _NoIdentityAuthProvider:
    """Auth provider whose handshake yields no identity.

    Exercises the updates-stream's reject-when-unauthenticated gate
    deterministically — unlike header mode, which falls back to the
    reserved ``"local"`` user and would never return ``None``.
    """

    def get_user_id(self, request: object) -> None:
        """Always return ``None`` (no authenticated identity)."""
        del request
        return


@pytest.fixture
def fast_rescan(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Shrink the per-connection rescan interval so interval-driven
    deltas (``changed`` / ``removed``) land in well under a second.

    Patches the module-level constants the ticker reads at sleep time;
    these are plain config values, not ``asyncio`` singletons, so the
    patch is local and safe. The heartbeat interval is also shrunk so
    idle-only tests receive heartbeats promptly instead of waiting the
    production 30 s.
    """
    monkeypatch.setattr(sessions_routes, "_SESSION_UPDATES_RESCAN_INTERVAL_S", 0.05)
    monkeypatch.setattr(sessions_routes, "_SESSION_UPDATES_HEARTBEAT_INTERVAL_S", 0.1)


@pytest.fixture
def stores(
    db_uri: str,
) -> tuple[SqlAlchemyConversationStore, SqlAlchemyAgentStore, SqlAlchemyPermissionStore]:
    """Real file-backed stores so writes from the test thread are visible
    to the WS handler thread."""
    return (
        SqlAlchemyConversationStore(db_uri),
        SqlAlchemyAgentStore(db_uri),
        SqlAlchemyPermissionStore(db_uri),
    )


@pytest.fixture
def liveness_state() -> dict[str, SessionLiveness]:
    """Mutable liveness map the test can flip mid-connection to drive a
    ``runner_online`` / ``host_online`` change through the stream. Ids
    absent from the map default to ``runner_online=True``,
    ``host_online=None`` (matching the server's missing-row terminal)."""
    return {}


@pytest.fixture
def comment_store(db_uri: str) -> SqlAlchemyCommentStore:
    """Real file-backed comment store so comment writes from the test
    thread are visible to the WS handler thread, mirroring ``stores``."""
    return SqlAlchemyCommentStore(db_uri)


@pytest.fixture
def app(
    stores: tuple[SqlAlchemyConversationStore, SqlAlchemyAgentStore, SqlAlchemyPermissionStore],
    liveness_state: dict[str, SessionLiveness],
    comment_store: SqlAlchemyCommentStore,
) -> FastAPI:
    """Minimal app mounting only the sessions router, with header-based
    auth and a real permission store — the surface the updates stream
    actually exercises. ``liveness_lookup`` reads the mutable
    ``liveness_state`` (default runner online, no host) so tests control
    liveness."""
    conversation_store, agent_store, permission_store = stores

    def _liveness_lookup(ids: list[str]) -> dict[str, SessionLiveness]:
        return {
            sid: liveness_state.get(sid, SessionLiveness(runner_online=True, host_online=None))
            for sid in ids
        }

    app = FastAPI()
    app.include_router(
        create_sessions_router(
            conversation_store=conversation_store,
            agent_store=agent_store,
            auth_provider=UnifiedAuthProvider(source="header"),
            permission_store=permission_store,
            liveness_lookup=_liveness_lookup,
            comment_store=comment_store,
        ),
        prefix="/v1",
    )
    return app


def _seed_session(
    stores: tuple[SqlAlchemyConversationStore, SqlAlchemyAgentStore, SqlAlchemyPermissionStore],
    *,
    owner: str,
    title: str,
) -> str:
    """Create a session-shaped conversation (non-null ``agent_id``) owned
    by ``owner`` and return its id."""
    conversation_store, agent_store, permission_store = stores
    # The conversations.agent_id FK requires a real agent row; create one
    # idempotently (the same agent backs every seeded session).
    if agent_store.get("087b7cb7ac30abf4debfaa578d052ec6") is None:
        agent_store.create(
            agent_id="087b7cb7ac30abf4debfaa578d052ec6",
            name="test-agent",
            bundle_location="087b7cb7ac30abf4debfaa578d052ec6/bundle",
        )
    conv = conversation_store.create_conversation(
        title=title, agent_id="087b7cb7ac30abf4debfaa578d052ec6"
    )
    permission_store.ensure_user(owner)
    permission_store.grant(owner, conv.id, LEVEL_OWNER)
    return conv.id


def _recv_until(ws: object, wanted: set[str], *, max_frames: int = 50) -> dict[str, object]:
    """
    Read frames until one whose ``type`` is in ``wanted`` arrives.

    Heartbeats and snapshots that aren't being awaited are skipped so a
    test can target a specific delta frame without depending on cadence.

    :param ws: The connected test WebSocket.
    :param wanted: Frame ``type`` values to stop on, e.g. ``{"changed"}``.
    :param max_frames: Safety bound so a missing frame fails fast rather
        than hanging.
    :returns: The first matching frame as a parsed dict.
    """
    for _ in range(max_frames):
        frame = json.loads(ws.receive_text())  # type: ignore[attr-defined]
        if frame.get("type") in wanted:
            return frame
    raise AssertionError(f"no frame in {wanted} after {max_frames} frames")


def test_watch_returns_snapshot_of_accessible_sessions(app: FastAPI, stores) -> None:
    """A ``watch`` for owned ids returns a snapshot containing exactly
    those sessions, with their persisted titles."""
    s1 = _seed_session(stores, owner=ALICE, title="first")
    s2 = _seed_session(stores, owner=ALICE, title="second")
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        ws.send_text(json.dumps({"type": "watch", "session_ids": [s1, s2]}))
        snapshot = _recv_until(ws, {"snapshot"})
        items = {item["id"]: item for item in snapshot["items"]}  # type: ignore[index]
        # Both watched, owned sessions are present — proves the snapshot
        # reads real conversation rows for exactly the watched ids.
        assert set(items) == {s1, s2}
        assert items[s1]["title"] == "first"
        assert items[s2]["title"] == "second"
        # No relay has reported, so the relay-fed status cache misses and
        # the list status presents as idle.
        assert items[s1]["status"] == "idle"
        # Both liveness fields are folded into the payload (defaults:
        # runner online, no host) so the client can drop its /health poll
        # for these sessions. A regression that stopped applying host_online
        # would drop the key (stream dumps full rows, so it must be present).
        assert items[s1]["runner_online"] is True
        assert items[s1]["host_online"] is None


def test_list_activity_serializes_once_with_byte_identical_nulls(app, stores, monkeypatch):
    from omnigent.server.schemas import SessionActivity, SessionListItem

    sid = _seed_session(stores, owner=ALICE, title="activity serialization")
    stores[0].create_conversation(parent_conversation_id=sid, agent_id="a" * 32)
    item_dump, activity_dump = SessionListItem.model_dump, SessionActivity.model_dump
    legacy = True
    projections = []

    def dump_item(self, *args, **kwargs):
        if legacy:
            kwargs.pop("exclude", None)
        result = item_dump(self, *args, **kwargs)
        if result.get("activity"):
            projections.append(result["activity"])
        return result

    def dump_activity(self, *args, **kwargs):
        result = activity_dump(self, *args, **kwargs)
        projections.append(result)
        return result

    monkeypatch.setattr(SessionListItem, "model_dump", dump_item)
    monkeypatch.setattr(SessionActivity, "model_dump", dump_activity)
    with TestClient(app) as client:
        url = "/v1/sessions?visibility=mine&limit=30"
        headers = {"X-Forwarded-Email": ALICE}
        before = client.get(url, headers=headers)
        assert before.status_code == 200
        assert len(projections) == 2
        legacy = False
        projections.clear()
        after = client.get(url, headers=headers)
        assert after.status_code == 200 and after.content == before.content
        assert len(projections) == 1
        child = after.json()["data"][0]["activity"]["descendants"][0]
        for field in ("viewer_last_seen", "branch_source_id", "project_id", "owner"):
            assert field in child and child[field] is None


def test_light_summary_payloads_equal_full_reads_and_keep_authority_and_freshness(
    app: FastAPI, stores, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, _, permissions = stores
    parent = _seed_session(stores, owner=ALICE, title="summary")
    child = store.create_conversation(
        kind="sub_agent",
        parent_conversation_id=parent,
        agent_id="087b7cb7ac30abf4debfaa578d052ec6",
    )
    private = store.fork_conversation(child.id)
    permissions.ensure_user(BOB)
    permissions.grant(BOB, private.id, LEVEL_OWNER)
    store.set_labels(parent, {"omni_project": "audit", "omnigent.pinned.alice@example.com": "1"})
    store.set_runner_id(child.id, "summary-runner")
    store.set_session_live_status(child.id, "waiting")
    store.set_pending_elicitation_count(child.id, 3)
    for session_id in (parent, child.id, private.id):
        store.set_session_state(session_id, {"policy": "x" * 32768})
    force_full = True
    decoded: list[str | None] = []
    full_get, full_list = store.get_conversations, store.list_conversations
    decode_state = conversation_module._decode_session_state

    def get(ids, *, include_execution_state=True):
        return full_get(ids, include_execution_state=force_full or include_execution_state)

    def list_rows(*args, **kwargs):
        if force_full:
            kwargs["include_execution_state"] = True
        return full_list(*args, **kwargs)

    def decode(value):
        decoded.append(value)
        return decode_state(value)

    monkeypatch.setattr(store, "get_conversations", get)
    monkeypatch.setattr(store, "list_conversations", list_rows)
    monkeypatch.setattr(conversation_module, "_decode_session_state", decode)
    queries = (
        "?limit=30&visibility=mine&sort_by=updated_at&order=desc",
        "?limit=100&visibility=mine&kind=any&include_side_chats=true&sort_by=updated_at&order=desc",
        "?limit=30&visibility=shared&sort_by=updated_at&order=desc",
        "?limit=20&visibility=mine&project=audit&sort_by=updated_at&order=desc",
        "?limit=20&visibility=mine&project=other&sort_by=updated_at&order=desc",
        "?limit=1&visibility=mine&pinned=true",
    )
    headers = {"X-Forwarded-Email": ALICE}
    with TestClient(app) as client:
        full_pages = [
            client.get("/v1/sessions" + query, headers=headers).json() for query in queries
        ]
        with client.websocket_connect("/v1/sessions/updates", headers=headers) as ws:
            ws.send_json({"type": "watch", "session_ids": [parent, private.id]})
            full_snapshot = _recv_until(ws, {"snapshot"})
        assert decoded
        force_full = False
        decoded.clear()
        light_pages = [
            client.get("/v1/sessions" + query, headers=headers).json() for query in queries
        ]
        with client.websocket_connect("/v1/sessions/updates", headers=headers) as ws:
            ws.send_json({"type": "watch", "session_ids": [parent, private.id]})
            assert _recv_until(ws, {"snapshot"}) == full_snapshot
        assert light_pages == full_pages
        assert decoded == []
        assert [row["id"] for row in full_snapshot["items"]] == [parent]
        facts = full_snapshot["items"][0]["activity"]["descendants"]
        assert [fact["id"] for fact in facts] == [child.id]
        assert facts[0]["status"] == "running"
        assert facts[0]["pending_elicitations_count"] == 3
        store.set_session_live_status(child.id, "failed")
        store.set_pending_elicitation_count(child.id, 1)
        updated = client.get("/v1/sessions", headers=headers).json()["data"][0]
        assert updated["activity"]["descendants"][0]["status"] == "failed"
        assert updated["activity"]["descendants"][0]["pending_elicitations_count"] == 1


def test_child_busy_rollup_flows_through_updates_stream(
    app: FastAPI,
    stores,
    fast_rescan: None,
) -> None:
    """
    A watched parent row reflects direct child sub-agent busy status.

    The sidebar relies on this WebSocket stream after the initial list
    fetch, so the stream's shared list-item builder must pass the same
    direct child ids as ``GET /v1/sessions``. This seeds a real child
    conversation and the relay-fed status cache, then proves both the
    initial snapshot and a later diff frame carry the rolled-up parent
    status.
    """
    conversation_store = stores[0]
    parent_id = _seed_session(stores, owner=ALICE, title="parent")
    child = conversation_store.create_conversation(
        kind="sub_agent",
        title="coder:auth",
        parent_conversation_id=parent_id,
        agent_id="087b7cb7ac30abf4debfaa578d052ec6",
    )
    sessions_routes._session_status_cache.pop(parent_id, None)
    sessions_routes._session_status_cache[child.id] = "waiting"
    try:
        with TestClient(app).websocket_connect(
            "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
        ) as ws:
            ws.send_text(json.dumps({"type": "watch", "session_ids": [parent_id]}))
            snapshot = _recv_until(ws, {"snapshot"})
            snapshot_items = {item["id"]: item for item in snapshot["items"]}  # type: ignore[index]
            assert snapshot_items[parent_id]["status"] == "running"

            sessions_routes._session_status_cache[child.id] = "idle"
            changed = _recv_until(ws, {"changed"})
            changed_items = {item["id"]: item for item in changed["items"]}  # type: ignore[index]
            assert changed_items[parent_id]["status"] == "idle"
    finally:
        sessions_routes._session_status_cache.pop(parent_id, None)
        sessions_routes._session_status_cache.pop(child.id, None)


def test_runner_offline_pushes_changed_frame(
    app: FastAPI, stores, liveness_state: dict[str, SessionLiveness], fast_rescan: None
) -> None:
    """Flipping a watched session's runner to offline (host still up) pushes
    a ``changed`` frame carrying ``runner_online: false`` and
    ``host_online: true`` — this is the runner-down-but-host-alive state the
    open view uses, and it lets the client retire its /health poll."""
    s1 = _seed_session(stores, owner=ALICE, title="live")
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        ws.send_text(json.dumps({"type": "watch", "session_ids": [s1]}))
        snapshot = _recv_until(ws, {"snapshot"})
        assert snapshot["items"][0]["runner_online"] is True  # type: ignore[index]
        # Runner goes offline but the host stays alive; the next rescan must
        # diff both fields and push them. A broken fold (a field missing or
        # not diffed) would yield only heartbeats and hang this wait.
        liveness_state[s1] = SessionLiveness(runner_online=False, host_online=True)
        changed = _recv_until(ws, {"changed"})
        items = {item["id"]: item for item in changed["items"]}  # type: ignore[index]
        # Strict runner_online flipped to False while host_online reports the
        # host is still reachable — exactly the pair that distinguishes "wake
        # the runner with a message" from "host offline, must reconnect".
        assert items[s1]["runner_online"] is False
        assert items[s1]["host_online"] is True


def test_list_sessions_omits_liveness_fields(
    app: FastAPI, stores, liveness_state: dict[str, SessionLiveness]
) -> None:
    """``GET /v1/sessions`` does NOT compute per-item liveness.

    The list deliberately skips ``runner_online`` / ``host_online``: no
    list consumer reads them (the sidebar no longer surfaces connection
    state), and the open-session view sources liveness from the
    single-session snapshot, the WS updates stream, and the ``/health``
    poll. Skipping it here drops the session-connectivity and hosts-table
    queries from every list call. The updates stream still carries the
    fields (see the changed-frame tests). Even with a liveness state set
    for the session, the list must not surface it."""
    s1 = _seed_session(stores, owner=ALICE, title="live")
    liveness_state[s1] = SessionLiveness(runner_online=False, host_online=True)

    resp = TestClient(app).get("/v1/sessions", headers={"X-Forwarded-Email": ALICE})

    assert resp.status_code == 200
    items = {item["id"]: item for item in resp.json()["data"]}
    # The list uses exclude_none; both keys are absent because the list
    # never computes liveness. Re-adding the lookup here would reintroduce
    # the per-list connectivity + hosts queries this change removed.
    assert "runner_online" not in items[s1]
    assert "host_online" not in items[s1]


def test_title_change_pushes_changed_frame(app: FastAPI, stores, fast_rescan: None) -> None:
    """Mutating a watched session's persisted title makes the server push
    a ``changed`` frame carrying the new value."""
    conversation_store = stores[0]
    s1 = _seed_session(stores, owner=ALICE, title="before")
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        ws.send_text(json.dumps({"type": "watch", "session_ids": [s1]}))
        _recv_until(ws, {"snapshot"})
        # Mutate persisted state from the test thread; the handler's next
        # rescan must observe it and diff it against the snapshot baseline.
        conversation_store.update_conversation(s1, title="after")
        changed = _recv_until(ws, {"changed"})
        items = {item["id"]: item for item in changed["items"]}  # type: ignore[index]
        # The changed frame carries the new title — proves the diff fired
        # on the real field change, not a spurious or stale value.
        assert items[s1]["title"] == "after"


def test_cleared_field_pushes_explicit_null(app: FastAPI, stores, fast_rescan: None) -> None:
    """Clearing a previously-set nullable field (a runner unbind nulling
    ``runner_id``) pushes a ``changed`` frame that carries the key as an
    explicit ``null``.

    The stream dumps full rows (NOT ``exclude_none``) precisely so a
    non-null → null transition arrives as an explicit ``null`` the client can
    overlay-clear, rather than a dropped key that would leave the stale value.
    If the stream regressed to ``exclude_none``, ``runner_id`` would be absent
    from the frame and this test's ``in`` assertion fails.
    """
    conversation_store = stores[0]
    s1 = _seed_session(stores, owner=ALICE, title="bound")
    # Bind a runner first so the snapshot baseline carries runner_id; the
    # clear below is then a genuine non-null → null transition.
    assert conversation_store.set_runner_id(s1, "rnr_test") is True
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        ws.send_text(json.dumps({"type": "watch", "session_ids": [s1]}))
        snapshot = _recv_until(ws, {"snapshot"})
        # Baseline carries the bound runner — the value the clear must reverse.
        assert snapshot["items"][0]["runner_id"] == "rnr_test"  # type: ignore[index]
        conversation_store.clear_runner_id(s1)
        changed = _recv_until(ws, {"changed"})
        item = {i["id"]: i for i in changed["items"]}[s1]  # type: ignore[index]
        # The key is present AND explicitly null. Presence proves the stream
        # dumps full rows (exclude_none would omit it); the None value proves
        # the client can overlay-clear the stale runner_id.
        assert "runner_id" in item
        assert item["runner_id"] is None


def test_harness_override_is_streamed_and_cleared(app: FastAPI, stores, fast_rescan: None) -> None:
    """Harness grouping follows streamed overrides and clears an unknown harness."""
    conversation_store = stores[0]
    session_id = _seed_session(stores, owner=ALICE, title="custom agent")
    conversation_store.update_conversation(session_id, harness_override="pi")
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        ws.send_text(json.dumps({"type": "watch", "session_ids": [session_id]}))
        snapshot = _recv_until(ws, {"snapshot"})
        assert snapshot["items"][0]["harness"] == "pi"
        conversation_store.update_conversation(session_id, _unset_harness_override=True)
        changed = _recv_until(ws, {"changed"})
        item = {item["id"]: item for item in changed["items"]}[session_id]
        # The seeded agent has no bundle, so its default harness is unknown.
        assert "harness" in item
        assert item["harness"] is None


def test_no_change_emits_no_changed_frame(app: FastAPI, stores, fast_rescan: None) -> None:
    """An idle watched session produces no ``changed`` frames — only
    heartbeats — so a static list generates no diff traffic."""
    s1 = _seed_session(stores, owner=ALICE, title="static")
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        ws.send_text(json.dumps({"type": "watch", "session_ids": [s1]}))
        _recv_until(ws, {"snapshot"})
        # Several rescans elapse (interval 0.05 s); none should diff since
        # nothing changed. Any "changed"/"removed" here means the differ
        # is emitting on unchanged state.
        for _ in range(5):
            frame = json.loads(ws.receive_text())
            assert frame["type"] == "heartbeat", (
                f"expected only heartbeats for an unchanged session, got {frame['type']}"
            )


def test_delete_pushes_removed_frame(app: FastAPI, stores, fast_rescan: None) -> None:
    """Deleting a watched session makes the server push a ``removed``
    frame for its id (the row no longer resolves)."""
    permission_store = stores[2]
    s1 = _seed_session(stores, owner=ALICE, title="doomed")
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        ws.send_text(json.dumps({"type": "watch", "session_ids": [s1]}))
        _recv_until(ws, {"snapshot"})
        # Drop access so the next rescan can no longer resolve the id for
        # this user — the list-stream's definition of "removed".
        permission_store.revoke(ALICE, s1)
        removed = _recv_until(ws, {"removed"})
        # The removed frame names exactly the now-inaccessible id.
        assert removed["ids"] == [s1]


def test_other_users_session_is_not_visible(app: FastAPI, stores, fast_rescan: None) -> None:
    """Bob watching Alice's session never receives it — neither in the
    snapshot nor in any later frame (cross-user isolation, W-series)."""
    s_alice = _seed_session(stores, owner=ALICE, title="alice-only")
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": BOB}
    ) as ws:
        ws.send_text(json.dumps({"type": "watch", "session_ids": [s_alice]}))
        snapshot = _recv_until(ws, {"snapshot"})
        # Bob has no grant on Alice's session → the snapshot omits it.
        assert snapshot["items"] == []
        # And it must not leak via a later changed frame when Alice mutates
        # her own session.
        stores[0].update_conversation(s_alice, title="changed-by-alice")
        for _ in range(5):
            frame = json.loads(ws.receive_text())
            assert frame["type"] == "heartbeat", (
                f"Bob received a {frame['type']} frame for a session he "
                f"cannot access — cross-user leak"
            )


def test_unauthenticated_connection_is_rejected(stores) -> None:
    """With permissions enabled, a socket whose handshake yields no
    identity is closed at the handshake (policy violation) before any
    session data is read."""
    conversation_store, agent_store, permission_store = stores
    app = FastAPI()
    app.include_router(
        create_sessions_router(
            conversation_store=conversation_store,
            agent_store=agent_store,
            auth_provider=_NoIdentityAuthProvider(),  # type: ignore[arg-type]
            permission_store=permission_store,
        ),
        prefix="/v1",
    )
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with TestClient(app).websocket_connect("/v1/sessions/updates"):
            pass
    # 1008 = WS_1008_POLICY_VIOLATION — the auth gate fired before accept.
    assert exc_info.value.code == 1008


def test_watch_set_truncated_at_cap(
    app: FastAPI,
    stores,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A watch-set larger than the cap is truncated to the cap, and the
    drop is logged. Ids past the cap never appear in the snapshot — they
    fall back to the client's list poll, so the server must surface the
    truncation rather than silently shrinking the set."""
    # Shrink the cap to 2 so three seeded sessions exceed it without
    # seeding the production 500.
    monkeypatch.setattr(sessions_routes, "_SESSION_UPDATES_MAX_WATCHED", 2)
    s1 = _seed_session(stores, owner=ALICE, title="one")
    s2 = _seed_session(stores, owner=ALICE, title="two")
    s3 = _seed_session(stores, owner=ALICE, title="three")
    with caplog.at_level(logging.WARNING, logger="omnigent.server.routes.sessions"):
        with TestClient(app).websocket_connect(
            "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
        ) as ws:
            # Send all three in order; the reader keeps the first two
            # (preserving order) and drops the third.
            ws.send_text(json.dumps({"type": "watch", "session_ids": [s1, s2, s3]}))
            snapshot = _recv_until(ws, {"snapshot"})
            ids = {item["id"] for item in snapshot["items"]}  # type: ignore[index]
            # Exactly the first two watched ids resolve; the third was
            # truncated before the snapshot fetch ever saw it. A regression
            # that dropped the cap would let all three through here.
            assert ids == {s1, s2}
            assert len(snapshot["items"]) == 2  # type: ignore[arg-type]
    # The truncation is logged with the distinct-id count so an oversized
    # watch-set is diagnosable. Absence here means the drop went silent.
    assert any("watch-set truncated" in record.getMessage() for record in caplog.records), (
        "expected a watch-set-truncation warning, got none"
    )


def test_transient_store_error_does_not_kill_stream(
    app: FastAPI,
    stores,
    fast_rescan: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A store read that raises during one rescan tick is logged and
    skipped — the stream stays open and a later real change still pushes a
    ``changed`` frame. Without the ticker's guard, the raised exception
    would tear the connection down and force a reconnect + re-snapshot."""
    conversation_store = stores[0]
    s1 = _seed_session(stores, owner=ALICE, title="before")
    real_get = conversation_store.get_conversations
    calls = {"n": 0}

    def flaky_get(ids: list[str], *, include_execution_state: bool = True) -> dict[str, object]:
        """Succeed on the connect snapshot, fail the first rescan tick,
        then recover — a transient blip, not a permanent outage."""
        calls["n"] += 1
        # Call 1 is the snapshot (must succeed so the client gets a
        # baseline). Call 2 is the first ticker rescan — fail it.
        if calls["n"] == 2:
            raise RuntimeError("transient store blip")
        return real_get(ids, include_execution_state=include_execution_state)

    monkeypatch.setattr(conversation_store, "get_conversations", flaky_get)
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        ws.send_text(json.dumps({"type": "watch", "session_ids": [s1]}))
        _recv_until(ws, {"snapshot"})
        # Mutate after the failing tick is guaranteed to occur (call 2);
        # a later successful tick must observe it. If the failed tick had
        # killed the ticker, the connection would close and _recv_until
        # would raise WebSocketDisconnect instead of returning a frame.
        conversation_store.update_conversation(s1, title="after")
        changed = _recv_until(ws, {"changed"})
        items = {item["id"]: item for item in changed["items"]}  # type: ignore[index]
        assert items[s1]["title"] == "after"
    # >= 3 proves at least one rescan ran after the injected failure
    # (call 1 = snapshot, call 2 = failed tick, call 3+ = recovered ticks).
    assert calls["n"] >= 3, (
        f"expected the ticker to keep rescanning after a failed tick, "
        f"but get_conversations was called only {calls['n']} time(s)"
    )


def test_session_added_event_pushes_unwatched_session(
    app: FastAPI, stores, fast_rescan: None
) -> None:
    """A ``session_added`` discovery event pushes a session the client isn't
    watching — the path that lets a session created elsewhere (another tab /
    CLI) enter the sidebar without a list poll.

    The client can never put an unknown session in its watch-set, so the
    interval diff can't surface it; the server reacts to the create/grant
    event instead. The pushed frame carries the real persisted row (fetched,
    not echoed from the event), which is what the client reconciles into the
    list. ``fast_rescan`` shrinks the heartbeat cadence so that if the push
    regressed, ``_recv_until`` exhausts its frame budget on heartbeats and
    fails fast instead of blocking on the 30 s production heartbeat.
    """
    s1 = _seed_session(stores, owner=ALICE, title="watched")
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        ws.send_text(json.dumps({"type": "watch", "session_ids": [s1]}))
        _recv_until(ws, {"snapshot"})
        # A brand-new session is created for Alice elsewhere and announced on
        # her discovery channel — it is NOT in the watch-set above.
        s2 = _seed_session(stores, owner=ALICE, title="brand new")
        sessions_routes.user_session_stream.publish(
            ALICE, {"type": "session_added", "session_id": s2}
        )
        changed = _recv_until(ws, {"changed"})
        items = {item["id"]: item for item in changed["items"]}  # type: ignore[index]
        # The unwatched new session is pushed, carrying its persisted title —
        # proving the server fetched the real row, not echoed the event.
        assert s2 in items
        assert items[s2]["title"] == "brand new"


def test_session_added_for_inaccessible_session_is_not_pushed(
    app: FastAPI, stores, fast_rescan: None
) -> None:
    """A discovery announcement for a session the user can't access is dropped.

    The per-id access check in the push path is the cross-user safety net: even
    if a ``session_added`` for Bob's session landed on Alice's channel (e.g. a
    future mis-keyed publish), Alice must never be pushed a session she has no
    grant on. A regression that skipped the access check would leak Bob's row
    into Alice's stream as a ``changed`` frame.
    """
    s1 = _seed_session(stores, owner=ALICE, title="alice")
    bob_session = _seed_session(stores, owner=BOB, title="bob only")
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        ws.send_text(json.dumps({"type": "watch", "session_ids": [s1]}))
        _recv_until(ws, {"snapshot"})
        # Announce Bob's session on Alice's channel; the access check must drop it.
        sessions_routes.user_session_stream.publish(
            ALICE, {"type": "session_added", "session_id": bob_session}
        )
        # Alice's watched session is static, so every frame must be a heartbeat;
        # a ``changed`` here (carrying bob_session) would be a cross-user leak.
        for _ in range(5):
            frame = json.loads(ws.receive_text())
            assert frame["type"] == "heartbeat", (
                f"expected only heartbeats, got {frame['type']} "
                f"(a changed frame would mean Bob's session leaked to Alice)"
            )


def test_pin_label_collapses_to_canonical_key_on_the_wire(
    app: FastAPI, stores, fast_rescan: None
) -> None:
    """Pins are stored per-user (``omnigent.pinned.<user>``), but the watch
    stream collapses the caller's own pin key to the canonical
    ``omnigent.pinned`` and never emits another user's per-user key. Exercised
    via the normal rescan-diff path: pinning a watched session out of band
    surfaces on the next ``changed`` frame (``fast_rescan`` shrinks the tick).
    """
    from omnigent.stores.conversation_store import pinned_label_key

    conversation_store, _agent_store, _permission_store = stores
    s1 = _seed_session(stores, owner=ALICE, title="watched")
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        ws.send_text(json.dumps({"type": "watch", "session_ids": [s1]}))
        _recv_until(ws, {"snapshot"})
        # Pin s1 under Alice's per-user key (as PATCH does), plus a foreign pin
        # under Bob's key that must NOT leak to Alice.
        conversation_store.set_labels(
            s1,
            {
                pinned_label_key(ALICE): "1721760000000",
                pinned_label_key(BOB): "1700000000000",
            },
        )
        changed = _recv_until(ws, {"changed"})
        items = {item["id"]: item for item in changed["items"]}  # type: ignore[index]
        assert s1 in items
        labels = items[s1]["labels"]
        # Alice's pin surfaces as the canonical bare key…
        assert labels.get("omnigent.pinned") == "1721760000000"
        # …and neither per-user key (hers or Bob's) leaks onto the wire.
        assert pinned_label_key(ALICE) not in labels
        assert pinned_label_key(BOB) not in labels


# ── comments fingerprint ──────────────────────────────────────────────


# One second in microseconds — comments_updated_at is epoch-µs.
_US = 1_000_000


@pytest.fixture
def comment_clock(monkeypatch: pytest.MonkeyPatch) -> dict[str, int]:
    """Deterministic write clock for comment rows.

    Patches the ``now_epoch_us`` reference the comment store uses for
    all comment timestamps (``created_at`` derives from the same read)
    so consecutive comment writes get distinct, controlled values.

    :param monkeypatch: Pytest monkeypatch fixture.
    :returns: Mutable ``{"now": <epoch seconds>}`` dict; assign
        ``clock["now"]`` to move time forward.
    """
    state = {"now": 1_000}
    monkeypatch.setattr(
        "omnigent.stores.comment_store.sqlalchemy_store.now_epoch_us",
        lambda: state["now"] * _US,
    )
    return state


def test_comment_add_pushes_changed_frame(
    app: FastAPI,
    stores,
    comment_store: SqlAlchemyCommentStore,
    comment_clock: dict[str, int],
    fast_rescan: None,
) -> None:
    """Adding a comment to a watched session pushes a ``changed`` frame.

    This is the freshness path the CommentsPanel relies on: another
    user's POST /comments must surface on this stream so the web app
    can invalidate its cached comment list without polling.
    """
    s1 = _seed_session(stores, owner=ALICE, title="commented")
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        ws.send_text(json.dumps({"type": "watch", "session_ids": [s1]}))
        snapshot = _recv_until(ws, {"snapshot"})
        items = {item["id"]: item for item in snapshot["items"]}
        # Baseline: no comments yet. The stream dumps full rows, so the
        # fingerprint fields must be present (count 0 / explicit null).
        assert items[s1]["comments_count"] == 0
        assert items[s1]["comments_updated_at"] is None

        comment_store.add(
            conversation_id=s1,
            path="src/app.py",
            body="needs a null check",
            start_index=0,
            end_index=10,
        )
        changed = _recv_until(ws, {"changed"})
        changed_items = {item["id"]: item for item in changed["items"]}
        # The add must move both fingerprint fields; a frame without them
        # means the WS builder isn't reading the comment store.
        assert changed_items[s1]["comments_count"] == 1
        assert changed_items[s1]["comments_updated_at"] == 1_000 * _US


def test_comment_status_change_pushes_changed_frame(
    app: FastAPI,
    stores,
    comment_store: SqlAlchemyCommentStore,
    comment_clock: dict[str, int],
    fast_rescan: None,
) -> None:
    """Marking a comment addressed pushes a ``changed`` frame.

    This is the agent flow: ``update_comment`` (status draft →
    addressed) changes no row count, so the ``updated_at`` bump is the
    only signal — if it didn't move, other viewers would keep showing
    the comment as open.
    """
    s1 = _seed_session(stores, owner=ALICE, title="addressed")
    comment = comment_store.add(
        conversation_id=s1,
        path="src/app.py",
        body="fix me",
        start_index=0,
        end_index=6,
    )
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        ws.send_text(json.dumps({"type": "watch", "session_ids": [s1]}))
        snapshot = _recv_until(ws, {"snapshot"})
        items = {item["id"]: item for item in snapshot["items"]}
        assert items[s1]["comments_count"] == 1
        assert items[s1]["comments_updated_at"] == 1_000 * _US

        comment_clock["now"] = 2_000
        comment_store.update_comment(comment.id, s1, status="addressed")
        changed = _recv_until(ws, {"changed"})
        changed_items = {item["id"]: item for item in changed["items"]}
        # Count is unchanged — the moved timestamp alone must trigger the
        # frame. A stale creation-time value here means update_comment didn't bump
        # updated_at and in-place edits are invisible to clients.
        assert changed_items[s1]["comments_count"] == 1
        assert changed_items[s1]["comments_updated_at"] == 2_000 * _US


def test_comment_delete_of_older_comment_pushes_changed_frame(
    app: FastAPI,
    stores,
    comment_store: SqlAlchemyCommentStore,
    comment_clock: dict[str, int],
    fast_rescan: None,
) -> None:
    """Deleting a non-newest comment pushes a ``changed`` frame.

    The deleted row is not the most recently updated one, so
    ``max(updated_at)`` is unchanged — the count drop is the only
    signal. This is the case that justifies ``comments_count``.
    """
    s1 = _seed_session(stores, owner=ALICE, title="deleted")
    older = comment_store.add(
        conversation_id=s1, path="a.py", body="old", start_index=0, end_index=3
    )
    comment_clock["now"] = 2_000
    comment_store.add(conversation_id=s1, path="a.py", body="new", start_index=4, end_index=7)
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        ws.send_text(json.dumps({"type": "watch", "session_ids": [s1]}))
        snapshot = _recv_until(ws, {"snapshot"})
        items = {item["id"]: item for item in snapshot["items"]}
        assert items[s1]["comments_count"] == 2
        assert items[s1]["comments_updated_at"] == 2_000 * _US

        comment_store.delete(older.id, s1)
        changed = _recv_until(ws, {"changed"})
        changed_items = {item["id"]: item for item in changed["items"]}
        # The timestamp must NOT move (the surviving comment is the
        # newest) — count 2 → 1 is what fires the frame. If this hangs
        # at _recv_until, deletes of older comments are invisible.
        assert changed_items[s1]["comments_count"] == 1
        assert changed_items[s1]["comments_updated_at"] == 2_000 * _US


def test_daily_cost_recorded_for_owned_session_without_a_policy(app: FastAPI, stores) -> None:
    """Per-user daily cost is recorded even when the session has no policy.

    The policy gate that previously suppressed the ``user_daily_cost`` write on
    no-policy sessions has been removed, so the daily rollup accrues for any
    owned session that records spend. Here the owned session has no guardrails/policy,
    yet posting cumulative spend must still land in the owner's daily rollup. A
    regression that re-added the gate would leave ``get_daily_cost`` at 0.0.
    """
    conversation_store = stores[0]
    today = datetime.now(UTC).strftime("%Y-%m-%d")
    sid = _seed_session(stores, owner=ALICE, title="no-policy session")
    resp = TestClient(app).post(
        f"/v1/sessions/{sid}/events",
        json={"type": "external_session_usage", "data": {"cumulative_cost_usd": 0.5}},
        headers={"X-Forwarded-Email": ALICE},
    )
    assert resp.status_code == 202, resp.text
    # Recorded under the owner despite no policy on the session — proves the
    # write is no longer policy-gated.
    assert conversation_store.get_daily_cost(ALICE, today) == pytest.approx(0.5)


def test_daily_cost_tracks_display_cost_not_policy_cost(app: FastAPI, stores) -> None:
    """The daily rollup follows ``total_cost_usd`` (S), not ``policy_cost_usd``.

    claude-native posts the statusLine total ``S`` as ``cumulative_cost_usd``
    (display) and a higher ``max(S, C)`` as ``policy_cost_usd`` (the real-time
    gate value, inflated mid-turn by in-flight sub-agent spend). The per-user
    daily report must reflect real spend, so its delta comes from
    ``total_cost_usd`` = ``S``. A regression that fed ``policy_cost_usd`` into
    the rollup would over-report the daily total by the gate's mid-turn lead.
    """
    conversation_store = stores[0]
    today = datetime.now(UTC).strftime("%Y-%m-%d")
    sid = _seed_session(stores, owner=ALICE, title="cost split session")
    resp = TestClient(app).post(
        f"/v1/sessions/{sid}/events",
        json={
            "type": "external_session_usage",
            # Display S = 0.20; enforcement value 0.90 leads it (sub-agent mid-run).
            "data": {"cumulative_cost_usd": 0.20, "policy_cost_usd": 0.90},
        },
        headers={"X-Forwarded-Email": ALICE},
    )
    assert resp.status_code == 202, resp.text
    # Daily = S (0.20), NOT the 0.90 enforcement figure. A value of 0.90 would
    # mean the rollup tracked policy_cost_usd and inherited the gate's
    # mid-turn inflation — the daily over-report this split prevents.
    assert conversation_store.get_daily_cost(ALICE, today) == pytest.approx(0.20)


def test_daily_cost_attributed_via_root_for_sub_agent_without_owner_grant(
    app: FastAPI, stores
) -> None:
    """Sub-agent spend is attributed to the root session's owner.

    Relay / SDK sub-agents are spawned by the internal runner (no user
    context in the POST), so their conversations never receive an owner
    permission grant.  Previously ``_record_daily_cost`` called
    ``get_session_owner(child.id)``, got ``None``, and silently dropped the
    cost from the daily rollup — the per-user daily budget never saw it.

    The fix: fall back to ``get_session_owner(root_conversation_id)`` when
    the direct lookup misses.  This test creates a parent (owned) + a child
    conversation (no grant, but ``root_conversation_id`` → parent), posts
    cumulative spend on the child, and asserts the owner's daily total rises.
    """
    conversation_store, _agent_store, _permission_store = stores
    today = datetime.now(UTC).strftime("%Y-%m-%d")

    # Parent session — owned by Alice.
    parent_id = _seed_session(stores, owner=ALICE, title="parent session")

    # Child conversation — simulates a relay sub-agent: no permission grant.
    # Passing parent_conversation_id causes create_conversation to inherit
    # root_conversation_id from the parent automatically.
    child = conversation_store.create_conversation(
        title="sub-agent",
        agent_id="087b7cb7ac30abf4debfaa578d052ec6",
        parent_conversation_id=parent_id,
    )
    # Sanity: child has no owner grant (the gap being fixed).
    assert conversation_store.get_session_owner(child.id) is None

    # Post cumulative cost on the child — no auth header (internal runner path).
    resp = TestClient(app).post(
        f"/v1/sessions/{child.id}/events",
        json={"type": "external_session_usage", "data": {"cumulative_cost_usd": 0.75}},
    )
    assert resp.status_code == 202, resp.text

    # Sub-agent spend must appear in Alice's daily rollup via the root fallback.
    assert conversation_store.get_daily_cost(ALICE, today) == pytest.approx(0.75)


def test_projects_changed_event_forwards_to_client(
    app: FastAPI, stores, fast_rescan: None
) -> None:
    """A ``projects_changed`` discovery event reaches the connected client.

    Project rows aren't sessions, so the watch-set diff can never surface a
    project create/rename/delete made in another client; the stream must
    forward the discovery event as its own frame for the client to refresh its
    projects cache. A regression here leaves other open clients (another tab,
    the mobile app) showing a stale folder name until a full reload.
    ``fast_rescan`` shrinks the heartbeat cadence so a dropped forward fails
    fast on exhausted heartbeats instead of blocking.
    """
    s1 = _seed_session(stores, owner=ALICE, title="watched")
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        ws.send_text(json.dumps({"type": "watch", "session_ids": [s1]}))
        _recv_until(ws, {"snapshot"})
        # A project mutation elsewhere announces on Alice's discovery channel.
        sessions_routes.user_session_stream.publish(ALICE, {"type": "projects_changed"})
        frame = _recv_until(ws, {"projects_changed"})
        assert frame["type"] == "projects_changed"


def test_deep_branch_activity_uses_authorized_persisted_status_in_lists_and_updates(
    app: FastAPI, stores, fast_rescan: None
) -> None:
    store, _, permissions = stores
    parent = _seed_session(stores, owner=ALICE, title="parent")
    child = store.create_conversation(
        kind="sub_agent",
        parent_conversation_id=parent,
        agent_id="087b7cb7ac30abf4debfaa578d052ec6",
    )
    branch = store.fork_conversation(child.id)
    permissions.grant(ALICE, branch.id, LEVEL_OWNER)
    nested = branch
    descendants = [child, branch]
    for _ in range(4):
        nested = store.create_conversation(
            kind="sub_agent",
            parent_conversation_id=nested.id,
            agent_id="087b7cb7ac30abf4debfaa578d052ec6",
        )
        descendants.append(nested)
    store.set_session_live_status(nested.id, "waiting")
    expected = [
        {
            "id": row.id,
            "status": "running" if row.id == nested.id else "idle",
            "updated_at": store.get_conversation(row.id).updated_at,
            "pending_elicitations_count": 0,
            "viewer_last_seen": None,
            "viewer_unread": False,
            "latest_error": "unknown",
            "branch_source_id": child.id if row.id == branch.id else None,
            "parent_session_id": row.parent_conversation_id,
            "archived": False,
            "project_id": None,
            "labels": {},
            "permission_level": LEVEL_OWNER if row.id == branch.id else None,
            "owner": ALICE if row.id == branch.id else None,
        }
        for row in sorted(descendants, key=lambda row: row.id)
    ]
    with TestClient(app) as client:
        response = client.get("/v1/sessions", headers={"X-Forwarded-Email": ALICE})
        assert response.status_code == 200
        root = next(row for row in response.json()["data"] if row["id"] == parent)
        assert root["activity"] == {
            "own_status": "idle",
            "descendant_running": True,
            "descendants": expected,
            "descendants_complete": True,
        }
        assert root["status"] == "running"
        with client.websocket_connect(
            "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
        ) as ws:
            ws.send_text(json.dumps({"type": "watch", "session_ids": [parent]}))
            snapshot = _recv_until(ws, {"snapshot"})["items"][0]
            assert snapshot["activity"] == root["activity"]
            store.set_session_live_status(nested.id, "idle")
            changed = _recv_until(ws, {"changed"})["items"][0]
            assert changed["activity"]["own_status"] == "idle"
            assert changed["activity"]["descendant_running"] is False
            assert changed["activity"]["descendants_complete"] is True
            assert {row["id"] for row in changed["activity"]["descendants"]} == {
                row.id for row in descendants
            }
            assert all(row["status"] == "idle" for row in changed["activity"]["descendants"])
            assert changed["status"] == "idle"
            # A revoked branch prunes the entire path, including running descendants.
            permissions.revoke(ALICE, branch.id)
            store.set_session_live_status(nested.id, "running")
            ws.send_text(json.dumps({"type": "watch", "session_ids": [parent]}))
            pruned = _recv_until(ws, {"snapshot"})["items"][0]
            assert pruned["activity"]["descendant_running"] is False
            assert pruned["activity"]["descendants_complete"] is True
            assert [row["id"] for row in pruned["activity"]["descendants"]] == [child.id]
        refreshed = client.get("/v1/sessions", headers={"X-Forwarded-Email": ALICE})
        assert (
            next(row for row in refreshed.json()["data"] if row["id"] == parent)["activity"]
            == pruned["activity"]
        )


def test_unknown_descendant_coverage_stays_null_in_list_and_ws(
    app: FastAPI, stores, monkeypatch: pytest.MonkeyPatch
) -> None:
    session_id = _seed_session(stores, owner=ALICE, title="parent")

    def incomplete(parents: list[str], *, limit: int):
        assert limit > 0
        return {parent: [] for parent in parents}, False

    monkeypatch.setattr(stores[0], "list_activity_child_ids", incomplete)
    with TestClient(app) as client:
        row = client.get("/v1/sessions", headers={"X-Forwarded-Email": ALICE}).json()["data"][0]
        assert row["activity"] == {
            "own_status": "idle",
            "descendant_running": None,
            "descendants": [],
            "descendants_complete": False,
        }
        with client.websocket_connect(
            "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
        ) as ws:
            ws.send_text(json.dumps({"type": "watch", "session_ids": [session_id]}))
            assert _recv_until(ws, {"snapshot"})["items"][0]["activity"] == row["activity"]


def test_descendant_own_facts_counts_and_viewer_seeds_match_rows_and_ws(
    app: FastAPI, stores, fast_rescan: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, _, permissions = stores
    parent = _seed_session(stores, owner=ALICE, title="parent")
    permissions.ensure_user(BOB)
    permissions.grant(BOB, parent, LEVEL_OWNER)
    store.set_session_live_status(parent, "failed")
    expected_counts = {}
    for runner, persisted, cached, expected in [
        (False, 9, 0, 0),
        (False, 9, 2, 2),
        (True, 9, 0, 9),
        (True, 1, 2, 2),
        (True, 0, 0, 0),
    ]:
        child = store.create_conversation(
            kind="sub_agent",
            parent_conversation_id=parent,
            agent_id="087b7cb7ac30abf4debfaa578d052ec6",
        )
        permissions.grant(ALICE, child.id, LEVEL_OWNER)
        permissions.grant(BOB, child.id, LEVEL_OWNER)
        if runner:
            store.set_runner_id(child.id, "runner-test")
        store.set_pending_elicitation_count(child.id, persisted)
        for index in range(cached):
            pending_elicitations.record_publish(
                child.id,
                {
                    "type": "response.elicitation_request",
                    "elicitation_id": f"request-{index}",
                },
            )
        expected_counts[child.id] = expected
    store.set_session_live_status(child.id, "failed")
    failed_id = child.id
    store.set_labels(
        failed_id,
        {
            "omnigent.pinned.alice@example.com": "100",
            "omnigent.pinned.bob@example.com": "200",
            "omni_project": "Example",
            "unrelated": "not a sidebar filter fact",
        },
    )
    # A cache hit overrides persisted status without importing a scalar parent rollup.
    running_id = next(iter(expected_counts))
    store.set_session_live_status(running_id, "idle")
    monkeypatch.setitem(sessions_routes._session_status_cache, running_id, "waiting")
    sessions_routes._set_read_state(ALICE, failed_id, 111, True)
    sessions_routes._set_read_state(BOB, failed_id, 222, False)

    def no_transcript(*args, **kwargs):
        pytest.fail("Descendant metadata must not hydrate transcripts")

    monkeypatch.setattr(store, "list_items", no_transcript)
    with TestClient(app) as client:
        by_viewer = {}
        for viewer, last_seen, unread in [(ALICE, 111, True), (BOB, 222, False)]:
            response = client.get("/v1/sessions", headers={"X-Forwarded-Email": viewer})
            assert response.status_code == 200
            parent_row = next(row for row in response.json()["data"] if row["id"] == parent)
            activity = parent_row["activity"]
            by_viewer[viewer] = activity
            assert activity["own_status"] == "failed"
            assert activity["descendant_running"] is True
            assert activity["descendants_complete"] is True
            facts = {row["id"]: row for row in activity["descendants"]}
            assert len(facts) == len(activity["descendants"]) == len(expected_counts)
            assert {
                key: row["pending_elicitations_count"] for key, row in facts.items()
            } == expected_counts
            assert facts[failed_id]["status"] == "failed"
            assert facts[failed_id]["latest_error"] == "unknown"
            assert facts[failed_id]["viewer_last_seen"] == last_seen
            assert facts[failed_id]["viewer_unread"] is unread
            assert facts[running_id]["status"] == "running"
            assert all(row["branch_source_id"] is None for row in facts.values())
            assert all(row["parent_session_id"] == parent for row in facts.values())
            assert facts[failed_id]["labels"] == {
                "omnigent.pinned": "100" if viewer == ALICE else "200",
                "omni_project": "Example",
            }
            # Directly listed descendants use the identical pending/read semantics.
            listed = client.get(
                "/v1/sessions?kind=any", headers={"X-Forwarded-Email": viewer}
            ).json()["data"]
            assert expected_counts.keys() <= {row["id"] for row in listed}
            for row in listed:
                if row["id"] in facts:
                    for field in [
                        "pending_elicitations_count",
                        "viewer_last_seen",
                        "viewer_unread",
                        "parent_session_id",
                        "archived",
                        "project_id",
                        "permission_level",
                        "owner",
                    ]:
                        assert row.get(field) == facts[row["id"]][field]
            with client.websocket_connect(
                "/v1/sessions/updates", headers={"X-Forwarded-Email": viewer}
            ) as ws:
                ws.send_json({"type": "watch", "session_ids": [parent]})
                snapshot = _recv_until(ws, {"snapshot"})["items"][0]
                assert snapshot["activity"] == activity
        assert by_viewer[ALICE]["descendants"] != by_viewer[BOB]["descendants"]


def _recv_transcript(ws, session_id, event_type, *, phase=None):
    for _ in range(1000):
        frame = _recv_until(ws, {"session.event", "session.error"})
        if frame["session_id"] != session_id:
            continue
        assert frame["type"] != "session.error", frame
        event = frame["event"]
        if event["type"] == event_type and (phase is None or event.get("phase") == phase):
            return event
    raise AssertionError(f"No {event_type} frame for {session_id}")


def _subscribe(ws, sid, **cursor):
    ws.send_json({"type": "subscribe", "session_id": sid, **cursor})
    return _recv_transcript(ws, sid, "session.sync", phase="complete")


def test_disconnect_cleanup_tolerates_already_closed_transport(app, stores, monkeypatch):
    from omnigent.runtime import session_stream

    closed = []

    async def disconnected_close(self, *args, **kwargs):
        closed.append(self)
        raise WebSocketDisconnect(code=1006)

    monkeypatch.setattr(WebSocket, "close", disconnected_close)
    sid = _seed_session(stores, owner=ALICE, title="disconnect cleanup")
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        _subscribe(ws, sid)
        assert session_stream.has_subscribers(sid)
    assert len(closed) == 1
    assert not session_stream.has_subscribers(sid)


@pytest.mark.timeout(20)
def test_multiplex_replay_watch_presence_and_unsubscribe(app, stores, monkeypatch):
    from omnigent.entities import MessageData, NewConversationItem
    from omnigent.runtime import session_stream
    from omnigent.server import presence

    monkeypatch.setattr(presence, "_LEAVE_GRACE_S", 0)
    first = _seed_session(stores, owner=ALICE, title="first")
    second = _seed_session(stores, owner=ALICE, title="second")
    item = stores[0].append(
        first,
        [
            NewConversationItem(
                type="message",
                response_id="turn",
                data=MessageData(
                    role="user",
                    content=[{"type": "input_text", "text": "canonical"}],
                ),
            )
        ],
    )[0]
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        capabilities = ws.receive_json()
        assert capabilities["type"] == "capabilities"
        assert capabilities["transcript_stream"] == capabilities["transcript_window"] == 1
        ws.send_json({"type": "watch", "session_ids": [first, second]})
        assert len(_recv_until(ws, {"snapshot"})["items"]) == 2
        ws.send_json({"type": "subscribe", "session_id": first})
        saved = _recv_transcript(ws, first, "response.output_item.done")
        assert saved["item"]["id"] == item.id and saved["item"]["position"] == 0
        _recv_transcript(ws, first, "session.sync", phase="complete")
        _subscribe(ws, second)
        assert session_stream.has_subscribers(first) and session_stream.has_subscribers(second)
        ws.send_json({"type": "presence", "session_id": first, "idle": True})
        viewers = _recv_transcript(ws, first, "session.presence")["viewers"]
        while viewers and not viewers[0]["idle"]:
            viewers = _recv_transcript(ws, first, "session.presence")["viewers"]
        assert viewers[0]["user_id"] == ALICE and viewers[0]["idle"]
        ws.send_json({"type": "unsubscribe", "session_id": first})
        assert _recv_until(ws, {"session.unsubscribed"})["session_id"] == first
        assert not session_stream.has_subscribers(first)
        session_stream.publish(
            second,
            {
                "type": "session.changed_files.invalidated",
                "session_id": second,
                "environment_id": "default",
            },
        )
        assert (
            _recv_transcript(ws, second, "session.changed_files.invalidated")["session_id"]
            == second
        )
    assert not session_stream.has_subscribers(second)
    assert presence.snapshot(first, first)["viewers"] == []
    assert presence.snapshot(second, second)["viewers"] == []


@pytest.mark.timeout(20)
@pytest.mark.parametrize("initial_limit", [None, 100])
def test_multiplex_authorization_and_active_revocation_are_member_scoped(
    app, stores, initial_limit
):
    from omnigent.runtime import session_stream

    first = _seed_session(stores, owner=ALICE, title="first")
    second = _seed_session(stores, owner=ALICE, title="second")
    secret = _seed_session(stores, owner=BOB, title="secret")
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        _subscribe(ws, first, initial_limit=initial_limit)
        _subscribe(ws, second, initial_limit=initial_limit)
        ws.send_json({"type": "subscribe", "session_id": secret})
        error = _recv_until(ws, {"session.error"})
        assert error["session_id"] == secret and error["code"] == "not_found"
        assert not session_stream.has_subscribers(secret)
        stores[2].revoke(ALICE, first)
        session_stream.publish(
            first,
            {
                "type": "session.changed_files.invalidated",
                "session_id": first,
                "environment_id": "default",
            },
        )
        error = _recv_until(ws, {"session.error"})
        assert error["session_id"] == first and error["code"] == "not_found"
        assert not session_stream.has_subscribers(first)
        session_stream.publish(
            second,
            {
                "type": "session.changed_files.invalidated",
                "session_id": second,
                "environment_id": "default",
            },
        )
        assert (
            _recv_transcript(ws, second, "session.changed_files.invalidated")["session_id"]
            == second
        )
        ws.send_json({"type": "watch", "session_ids": [second]})
        assert _recv_until(ws, {"snapshot"})["items"][0]["id"] == second


@pytest.mark.parametrize("change", ["rebind", "reroute", "disconnect", "revoke", "delete"])
async def test_stream_authorization_reuses_fresh_conversation_and_rejects_changes(
    app, stores, monkeypatch, change
):
    from unittest.mock import AsyncMock, Mock

    from starlette.requests import Request

    from omnigent.errors import OmnigentError
    from omnigent.runner.routing import RunnerRouter

    store, agents, permissions = stores
    sid = _seed_session(stores, owner=ALICE, title="runner authorization")
    store.set_runner_id(sid, "original-runner")
    registry = Mock()
    runner = RunnerRouter(registry=registry, conversation_store=store)
    client_for_runner = Mock(return_value=object())
    monkeypatch.setattr(runner, "_client_for_runner", client_for_runner)
    ensure = AsyncMock()
    monkeypatch.setattr(sessions_routes, "_ensure_runner_relay_ready", ensure)
    router = create_sessions_router(
        conversation_store=store,
        agent_store=agents,
        auth_provider=UnifiedAuthProvider(source="header"),
        permission_store=permissions,
        runner_router=runner,
    )
    endpoint = next(
        route.endpoint for route in router.routes if route.path.endswith("/{session_id}/stream")
    )
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": f"/v1/sessions/{sid}/stream",
            "headers": [(b"x-forwarded-email", ALICE.encode())],
            "app": app,
        }
    )
    await endpoint(
        request=request,
        session_id=sid,
        idle=False,
        after_position=-1,
        after_revision=None,
        stream_epoch=None,
        initial_limit=100,
        window_start_position=None,
    )
    read = Mock(wraps=store.get_conversation)
    route = Mock(wraps=runner.client_for_session_resources)
    monkeypatch.setattr(store, "get_conversation", read)
    monkeypatch.setattr(runner, "client_for_session_resources", route)
    await request.state.stream_authorize()
    # Access and binding each remain fresh; routing must not load a third copy.
    assert read.call_count == 2
    current = route.call_args.kwargs["conversation"]
    assert current.id == sid and current.runner_id == "original-runner"
    assert current is not ensure.call_args.kwargs["conversation"]
    route.reset_mock()
    if change == "rebind":
        store.clear_runner_id(sid)
        assert store.set_runner_id(sid, "replacement-runner")
    elif change == "reroute":
        client_for_runner.return_value = object()
    elif change == "disconnect":
        registry.get.return_value = None
    elif change == "revoke":
        permissions.revoke(ALICE, sid)
    else:
        await store.delete_conversation(sid)
    with pytest.raises(OmnigentError if change in {"revoke", "delete"} else ConnectionError):
        await request.state.stream_authorize()
    if change in {"rebind", "revoke", "delete"}:
        route.assert_not_called()


@pytest.mark.timeout(20)
def test_multiplex_member_overflow_keeps_other_subscription(app, stores, monkeypatch):
    from omnigent.runtime import session_stream

    monkeypatch.setattr(session_stream, "_SUBSCRIBER_QUEUE_MAX_EVENTS", 8)
    first = _seed_session(stores, owner=ALICE, title="slow")
    second = _seed_session(stores, owner=ALICE, title="healthy")
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        _subscribe(ws, first)
        _subscribe(ws, second)
        for _ in range(100):
            session_stream.publish(
                first,
                {
                    "type": "session.changed_files.invalidated",
                    "session_id": first,
                    "environment_id": "default",
                },
            )
        error = _recv_until(ws, {"session.error"})
        assert error == {"type": "session.error", "session_id": first, "code": "stream_overflow"}
        assert not session_stream.has_subscribers(first)
        session_stream.publish(
            second,
            {
                "type": "session.changed_files.invalidated",
                "session_id": second,
                "environment_id": "default",
            },
        )
        assert (
            _recv_transcript(ws, second, "session.changed_files.invalidated")["session_id"]
            == second
        )


@pytest.mark.timeout(20)
def test_multiplex_runner_preparation_fails_before_subscribing(app, stores, monkeypatch):
    from unittest.mock import AsyncMock

    from omnigent.errors import ErrorCode, OmnigentError
    from omnigent.runtime import session_stream

    sid = _seed_session(stores, owner=ALICE, title="runner")
    ensure = AsyncMock(
        side_effect=OmnigentError("Runner is on another replica", code=ErrorCode.CONFLICT)
    )
    monkeypatch.setattr(sessions_routes, "_ensure_runner_relay_ready", ensure)
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        ws.send_json({"type": "subscribe", "session_id": sid})
        error = _recv_until(ws, {"session.error"})
        assert error["session_id"] == sid and error["code"] == "conflict"
        assert not session_stream.has_subscribers(sid)
        ensure.assert_awaited_once()
        ws.send_json({"type": "watch", "session_ids": [sid]})
        assert _recv_until(ws, {"snapshot"})["items"][0]["id"] == sid


@pytest.mark.timeout(20)
def test_multiplex_validates_cursor_and_caps_memberships(app, stores, monkeypatch):
    from omnigent.runtime import session_stream

    monkeypatch.setattr("omnigent.server.session_multiplex.MAX_MEMBERSHIPS", 1)
    first = _seed_session(stores, owner=ALICE, title="active")
    second = _seed_session(stores, owner=ALICE, title="over limit")
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        _subscribe(ws, first)
        ws.send_json({"type": "subscribe", "session_id": second, "after_position": -2})
        assert _recv_until(ws, {"session.error"})["code"] == "invalid_input"
        ws.send_json({"type": "subscribe", "session_id": second})
        assert _recv_until(ws, {"session.error"})["code"] == "subscription_limit"
        assert session_stream.has_subscribers(first)
        assert not session_stream.has_subscribers(second)
        ws.send_json({"type": "presence", "session_id": second, "idle": True})
        ws.send_json({"type": "unsubscribe", "session_id": first})
        assert _recv_until(ws, {"session.unsubscribed"})["session_id"] == first


@pytest.mark.timeout(20)
def test_multiplex_negotiated_window_validation_and_expanded_resume(app, stores):
    from omnigent.entities import MessageData, NewConversationItem

    sid = _seed_session(stores, owner=ALICE, title="window")
    originals = stores[0].append(
        sid,
        [
            NewConversationItem(
                type="message",
                response_id="turn",
                data=MessageData(
                    role="user",
                    content=[{"type": "input_text", "text": str(index)}],
                ),
            )
            for index in range(301)
        ],
    )
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        complete = _subscribe(ws, sid, initial_limit=100)
        assert complete["window_item_count"] == 100
        assert complete["item_count"] == 301
        assert complete["window_start_position"] == 201
        assert complete["first_item_id"] == originals[201].id
        for options in (
            {"initial_limit": 0},
            {"initial_limit": True},
            {"initial_limit": 1.5},
            {"initial_limit": "100"},
            {"initial_limit": 2**53},
            {"initial_limit": 100, "window_start_position": -1},
            {"initial_limit": 100, "window_start_position": True},
            {"initial_limit": 100, "window_start_position": 2**53},
            {"window_start_position": 0},
        ):
            ws.send_json({"type": "subscribe", "session_id": sid, **options})
            assert _recv_until(ws, {"session.error"})["code"] == "invalid_input"
        complete = _subscribe(ws, sid, initial_limit=100, window_start_position=2)
        assert complete["window_start_position"] == 2
        assert complete["window_item_count"] == 299
        assert complete["first_item_id"] == originals[2].id
        assert complete["has_older_items"]
        complete = _subscribe(ws, sid, initial_limit=999)
        assert complete["window_item_count"] == 200
        complete = _subscribe(ws, sid)
        assert complete["item_count"] == 301
        assert complete["window_item_count"] is None


@pytest.mark.timeout(20)
def test_sse_window_query_validation_and_shared_recovery_wiring(app, stores, monkeypatch):
    sid = _seed_session(stores, owner=ALICE, title="SSE window")
    captured = []

    async def finite_stream(request, session_id, *args, recovery, **kwargs):
        captured.append(recovery)
        async for event in recovery.events():
            yield event

    monkeypatch.setattr(
        "omnigent.server.routes.sessions.routes_events._iter_live_events", finite_stream
    )
    with TestClient(app) as client:
        url = f"/v1/sessions/{sid}/stream"
        headers = {"X-Forwarded-Email": ALICE}
        for query in (
            "initial_limit=0",
            "initial_limit=true",
            "initial_limit=1.5",
            "initial_limit=9007199254740992",
            "initial_limit=100&window_start_position=-1",
            "initial_limit=100&window_start_position=9007199254740992",
        ):
            assert client.get(url + "?" + query, headers=headers).status_code == 422
        from omnigent.errors import ErrorCode, OmnigentError

        with pytest.raises(OmnigentError) as invalid:
            client.get(url + "?window_start_position=0", headers=headers)
        assert invalid.value.code == ErrorCode.INVALID_INPUT
        response = client.get(url + "?initial_limit=999&window_start_position=0", headers=headers)
        assert response.status_code == 200, response.text
        assert captured[-1].enabled
        assert captured[-1].initial_limit == 200
        assert captured[-1].window_start_position == 0
        assert '"window_item_count": 0' in response.text


async def test_multiplex_writer_isolates_auth_and_rechecks_after_contention():
    import asyncio
    from unittest.mock import AsyncMock

    from fastapi import APIRouter

    from omnigent.server.session_multiplex import SessionMultiplex

    auth_started, release_auth = asyncio.Event(), asyncio.Event()
    write_started, release_write = asyncio.Event(), asyncio.Event()
    sent = []
    revoked = False
    checks = 0

    async def write(frame):
        if frame["type"] == "blocker":
            write_started.set()
            await release_write.wait()
        sent.append(frame["type"])

    async def authorize():
        nonlocal checks
        checks += 1
        auth_started.set()
        await release_auth.wait()
        if revoked:
            raise ConnectionError("revoked")

    mux = SessionMultiplex(APIRouter(), AsyncMock(), write, asyncio.Lock())
    candidate = asyncio.create_task(mux.send({"type": "candidate"}, authorize))
    await auth_started.wait()
    blocker = asyncio.create_task(mux.send({"type": "blocker"}))
    await write_started.wait()
    release_auth.set()
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert checks == 1
    revoked = True
    release_write.set()
    await blocker
    with pytest.raises(ConnectionError, match="revoked"):
        await candidate
    assert checks == 2
    assert sent == ["blocker"]
    await mux.close()


async def test_multiplex_hot_backlog_yields_to_ready_sibling():
    import asyncio
    from unittest.mock import AsyncMock

    from fastapi import APIRouter

    from omnigent.server.session_multiplex import SessionMultiplex

    sent = []
    gate = asyncio.Event()
    sibling_ready = asyncio.Event()

    async def write(frame):
        sent.append(frame["type"])
        if len(sent) == 5:
            gate.set()

    async def sibling_auth():
        sibling_ready.set()
        await gate.wait()

    mux = SessionMultiplex(APIRouter(), AsyncMock(), write, asyncio.Lock())

    async def hot():
        for _ in range(100):
            await mux.send({"type": "hot"})

    sibling = asyncio.create_task(mux.send({"type": "sibling"}, sibling_auth))
    await sibling_ready.wait()
    await asyncio.gather(hot(), sibling)
    assert sent.index("sibling") <= 6
    await mux.close()


async def test_multiplex_writer_deadline_breaks_socket(monkeypatch):
    import asyncio
    from unittest.mock import AsyncMock

    from fastapi import APIRouter

    from omnigent.server import session_multiplex

    monkeypatch.setattr(session_multiplex, "_WRITE_TIMEOUT_S", 0.01)
    socket = AsyncMock()

    async def blocked(frame):
        await asyncio.Event().wait()

    mux = session_multiplex.SessionMultiplex(APIRouter(), socket, blocked, asyncio.Lock())
    with pytest.raises(ConnectionError, match="write failed"):
        await mux.send({"type": "blocked"})
    socket.close.assert_awaited_once_with(code=1011)
    with pytest.raises(ConnectionError, match="closed"):
        await mux.send({"type": "later"})
    await mux.close()


@pytest.mark.timeout(20)
def test_slow_list_read_does_not_block_transcript_or_new_membership(app, stores, monkeypatch):
    import threading

    from omnigent.runtime import session_stream

    first = _seed_session(stores, owner=ALICE, title="first")
    second = _seed_session(stores, owner=ALICE, title="second")
    started, release = threading.Event(), threading.Event()
    original = stores[0].get_conversations

    def held(ids, **kwargs):
        started.set()
        assert release.wait(5)
        return original(ids, **kwargs)

    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        _subscribe(ws, first)
        monkeypatch.setattr(stores[0], "get_conversations", held)
        ws.send_json({"type": "watch", "session_ids": [first]})
        try:
            assert started.wait(5)
            _subscribe(ws, second)
            session_stream.publish(
                first,
                {
                    "type": "session.changed_files.invalidated",
                    "session_id": first,
                    "environment_id": "default",
                },
            )
            assert (
                _recv_transcript(ws, first, "session.changed_files.invalidated")["session_id"]
                == first
            )
            ws.send_json({"type": "watch", "session_ids": [second]})
        finally:
            release.set()
        snapshot = _recv_until(ws, {"snapshot"})
        assert [item["id"] for item in snapshot["items"]] == [second]


@pytest.mark.timeout(20)
@pytest.mark.parametrize("path", ["watch", "discovery"])
@pytest.mark.parametrize("revoked", ["root", "branch"])
def test_list_publication_rechecks_grants_after_liveness(
    app, stores, monkeypatch, fast_rescan, path, revoked
):
    import asyncio
    import threading

    from omnigent.server.routes.sessions import routes_core

    store, _, permissions = stores
    root = _seed_session(stores, owner=ALICE, title="root")
    child = store.create_conversation(
        kind="sub_agent", parent_conversation_id=root, agent_id="087b7cb7ac30abf4debfaa578d052ec6"
    )
    branch = store.fork_conversation(child.id)
    permissions.grant(ALICE, branch.id, LEVEL_OWNER)
    store.set_session_live_status(branch.id, "running")
    started, release = threading.Event(), threading.Event()
    original = routes_core._apply_liveness_to_items

    async def held(items, lookup):
        await original(items, lookup)
        started.set()
        assert await asyncio.to_thread(release.wait, 5)

    monkeypatch.setattr(routes_core, "_apply_liveness_to_items", held)
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        _recv_until(ws, {"capabilities"})
        if path == "watch":
            ws.send_json({"type": "watch", "session_ids": [root]})
        else:
            # A heartbeat proves reader/discovery tasks have started.
            _recv_until(ws, {"heartbeat"})
            sessions_routes.user_session_stream.publish(
                ALICE, {"type": "session_added", "session_id": root}
            )
        try:
            assert started.wait(5)
            permissions.revoke(ALICE, root if revoked == "root" else branch.id)
        finally:
            release.set()
        if revoked == "root" and path == "discovery":
            for _ in range(3):
                assert json.loads(ws.receive_text())["type"] == "heartbeat"
        else:
            frame = _recv_until(ws, {"snapshot" if path == "watch" else "changed"})
            if revoked == "root":
                assert frame["items"] == []
            else:
                item = frame["items"][0]
                assert [row["id"] for row in item["activity"]["descendants"]] == [child.id]
                assert item["activity"]["descendant_running"] is False
                assert item["status"] == "idle"


async def test_ready_fifo_bounds_service_under_auth_and_write_contention():
    import asyncio
    from unittest.mock import AsyncMock

    from fastapi import APIRouter

    from omnigent.server.session_multiplex import SessionMultiplex

    writer_started, release_writer = asyncio.Event(), asyncio.Event()
    slow_ready = asyncio.Event()
    release_slow = asyncio.Event()
    sent = []
    checks = 0

    async def write(frame):
        if frame["type"] == "blocker":
            writer_started.set()
            await release_writer.wait()
        sent.append(frame["type"])

    async def slow_auth():
        nonlocal checks
        checks += 1
        if checks == 1:
            slow_ready.set()
        else:
            await release_slow.wait()

    mux = SessionMultiplex(APIRouter(), AsyncMock(), write)
    blocker = asyncio.create_task(mux.send({"type": "blocker"}))
    await writer_started.wait()
    slow = asyncio.create_task(mux.send({"type": "slow"}, slow_auth))
    await slow_ready.wait()
    fast = [asyncio.create_task(mux.send({"type": "fast"})) for _ in range(20)]
    await asyncio.sleep(0)
    release_writer.set()
    await blocker
    await asyncio.sleep(0)
    assert sent == ["blocker"]
    release_slow.set()
    await asyncio.gather(slow, *fast)
    assert sent == ["blocker", "slow", *(["fast"] * 20)]
    assert checks == 2
    await mux.close()


@pytest.mark.timeout(30)
@pytest.mark.parametrize("count", [300, 1000])
def test_expanded_real_replay_backpressures_without_losing_items(app, stores, monkeypatch, count):
    import asyncio

    from omnigent.entities import NewConversationItem
    from omnigent.entities.conversation import MessageData
    from omnigent.server import session_multiplex

    sid = _seed_session(stores, owner=ALICE, title="expanded")
    originals = stores[0].append(
        sid,
        [
            NewConversationItem(
                type="message",
                response_id="turn",
                data=MessageData(role="user", content=[{"type": "input_text", "text": "saved"}]),
            )
            for _ in range(count)
        ],
    )
    original_send = session_multiplex.SessionMultiplex.send

    async def delayed(self, *args, **kwargs):
        await asyncio.sleep(0.001)
        return await original_send(self, *args, **kwargs)

    monkeypatch.setattr(session_multiplex.SessionMultiplex, "send", delayed)
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        ws.send_json(
            {
                "type": "subscribe",
                "session_id": sid,
                "initial_limit": 100,
                "window_start_position": 0,
            }
        )
        seen = []
        while True:
            frame = json.loads(ws.receive_text())
            assert frame["type"] != "session.error", frame
            event = frame.get("event", {})
            if event.get("type") == "response.output_item.done":
                seen.append((event["item"]["id"], event["item"]["position"]))
            if event.get("type") == "session.sync" and event.get("phase") == "complete":
                break
        assert seen == [(item.id, item.position) for item in originals]
        assert event["window_item_count"] == count


async def test_cancelled_physical_write_closes_socket_before_sibling():
    import asyncio
    from unittest.mock import AsyncMock

    from fastapi import APIRouter

    from omnigent.server.session_multiplex import SessionMultiplex

    started = asyncio.Event()
    socket = AsyncMock()
    calls = []

    async def write(frame):
        calls.append(frame["type"])
        started.set()
        await asyncio.Event().wait()

    mux = SessionMultiplex(APIRouter(), socket, write)
    active = asyncio.create_task(mux.send({"type": "active"}))
    await started.wait()
    sibling = asyncio.create_task(mux.send({"type": "sibling"}))
    active.cancel()
    with pytest.raises(asyncio.CancelledError):
        await active
    with pytest.raises(ConnectionError, match="closed"):
        await sibling
    assert calls == ["active"]
    socket.close.assert_awaited_once_with(code=1011)
    await mux.close()


@pytest.mark.timeout(30)
@pytest.mark.parametrize("resume", [False, True], ids=["cold", "retained"])
@pytest.mark.parametrize("oversized", [False, True], ids=["supported", "legacy-oversized"])
def test_stored_output_exact_delivery_or_terminal_size_error(app, stores, resume, oversized):
    from omnigent.entities import NewConversationItem
    from omnigent.entities.conversation import FunctionCallOutputData

    sid = _seed_session(stores, owner=ALICE, title="large-output")
    text = "\0" * (2 * 1048576 if oversized else 1048576)
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        baseline = _subscribe(ws, sid) if resume else None
        [saved] = stores[0].append(
            sid,
            [
                NewConversationItem(
                    type="function_call_output",
                    response_id="turn",
                    data=FunctionCallOutputData(call_id="call", output=text),
                )
            ],
        )
        request = {"type": "subscribe", "session_id": sid, "initial_limit": 100}
        if baseline is not None:
            request.update(
                after_position=baseline["last_position"],
                after_revision=baseline["item_revision"],
                stream_epoch=baseline["stream_epoch"],
            )
        ws.send_json(request)
        delivered = []
        completed = False
        error = None
        while not completed and error is None:
            frame = json.loads(ws.receive_text())
            if frame["type"] == "session.error":
                error = frame["code"]
                break
            event = frame.get("event", {})
            if event.get("type") == "response.output_item.done":
                delivered.append(event["item"])
            completed = event.get("type") == "session.sync" and event.get("phase") == "complete"
        if oversized:
            assert error == "stream_event_too_large"
            assert delivered == [] and not completed
        else:
            assert error is None and completed
            assert [(item["id"], item["position"], item["output"]) for item in delivered] == [
                (saved.id, saved.position, text)
            ]
        assert stores[0].get_item(sid, saved.id).data.output == text


@pytest.mark.timeout(30)
@pytest.mark.parametrize("transport", ["websocket", "sse", "feed2"])
def test_oversized_saved_item_reference_is_ordered_exact_and_authorized(
    app, stores, monkeypatch, transport
):
    import hashlib

    from omnigent.entities import NewConversationItem
    from omnigent.entities.conversation import FunctionCallOutputData
    from omnigent.errors import ErrorCode, OmnigentError
    from omnigent.runtime import session_stream
    from omnigent.server.routes.sessions import routes_events

    sid = _seed_session(stores, owner=ALICE, title="large referenced item")
    text = "\0" * (2 * 1048576) + " — exact"
    [saved] = stores[0].append(
        sid,
        [
            NewConversationItem(
                type="function_call_output",
                response_id="turn",
                data=FunctionCallOutputData(call_id="call", output=text),
            )
        ],
    )
    headers = {"X-Forwarded-Email": ALICE}
    events = []
    with TestClient(app) as client:
        if transport == "sse":
            original = routes_events._iter_live_events

            async def through_checkpoint(*args, **kwargs):
                from contextlib import aclosing

                async with aclosing(original(*args, **kwargs)) as source:
                    async for frame in source:
                        yield frame
                        if frame["type"] == "session.sync" and frame.get("phase") == "complete":
                            break

            monkeypatch.setattr(routes_events, "_iter_live_events", through_checkpoint)
            response = client.get(
                f"/v1/sessions/{sid}/stream?initial_limit=100",
                headers={**headers, "X-Omnigent-Item-References": "1"},
            )
            assert response.status_code == 200 and len(response.content) < 65536
            events = [
                json.loads(line[6:])
                for line in response.text.splitlines()
                if line.startswith("data: {")
            ]
        else:
            with client.websocket_connect("/v1/sessions/updates", headers=headers) as ws:
                ws.send_json(
                    {
                        "type": "subscribe",
                        "session_id": sid,
                        "initial_limit": 100,
                        "item_references": True,
                        **({"subscription_id": "large-body"} if transport == "feed2" else {}),
                    }
                )
                while True:
                    frame = json.loads(ws.receive_text())
                    assert frame["type"] != "session.error"
                    if event := frame.get("event"):
                        events.append(event)
                        if event["type"] == "session.sync" and event.get("phase") == "complete":
                            break
                # Live delivery enters the subscriber byte cap before projection.
                session_stream.publish(
                    sid,
                    {
                        "type": "session.input.consumed",
                        "data": {
                            "item_id": saved.id,
                            "type": saved.type,
                            "data": saved.data.model_dump(),
                            "cleared_pending_id": "pending-exact",
                        },
                    },
                )
                consumed = _recv_transcript(ws, sid, "session.item_reference")
                assert consumed["header"]["data"]["cleared_pending_id"] == "pending-exact"
                result = client.get(
                    f"/v1/sessions/{sid}/items/{saved.id}/stream-content",
                    params={
                        "sha256": consumed["sha256"],
                        "position": saved.position,
                        "consumed": True,
                    },
                    headers=headers,
                )
                assert result.json() == saved.data.model_dump()
        refs = [event for event in events if event["type"] == "session.item_reference"]
        assert len(refs) == 1
        ref = refs[0]
        assert events.index(ref) < len(events) - 1 and events[-1]["phase"] == "complete"
        assert (ref["item_id"], ref["position"]) == (saved.id, saved.position)
        assert ref["header"]["type"] == "response.output_item.done" and "item" not in ref["header"]
        path = f"/v1/sessions/{sid}/items/{saved.id}/stream-content"
        if transport == "feed2":
            header = ref["header"]["tool_output"]
            assert (
                header["id"] == saved.id and header["call_id"] == "call" and "output" not in header
            )
        params = {"sha256": ref["sha256"], "position": ref["position"]}
        result = client.get(path, params=params, headers=headers)
        assert result.status_code == 200 and result.json() == saved.to_api_dict()
        assert len(result.content) == ref["byte_length"] > 8 * 1024 * 1024
        assert hashlib.sha256(result.content).hexdigest() == ref["sha256"]
        with pytest.raises(OmnigentError) as denied:
            client.get(path, params=params, headers={"X-Forwarded-Email": BOB})
        assert denied.value.code in {ErrorCode.FORBIDDEN, ErrorCode.NOT_FOUND}
        with pytest.raises(OmnigentError) as stale:
            client.get(path, params={**params, "sha256": "0" * 64}, headers=headers)
        assert stale.value.code == ErrorCode.CONFLICT


@pytest.mark.parametrize("malformed", [False, True])
def test_publication_preserves_raw_branch_edges_and_overlapping_root_order(app, stores, malformed):
    store, _, permissions = stores
    root = _seed_session(stores, owner=ALICE, title="root")
    branch = store.fork_conversation(root)
    permissions.grant(ALICE, branch.id, LEVEL_OWNER)
    store.create_conversation(
        kind="sub_agent",
        parent_conversation_id=branch.id,
        agent_id="087b7cb7ac30abf4debfaa578d052ec6",
    )
    if malformed:
        store.set_labels(branch.id, {"omnigent.branch.inherited_item_count": "-1"})
        store.delete_label(branch.id, "omnigent.fork.source_id")
        store.delete_label(branch.id, "omnigent.side_chat.source_id")
        assert store.get_conversation(branch.id).branch is None
    with TestClient(app) as client:
        page = client.get("/v1/sessions", headers={"X-Forwarded-Email": ALICE}).json()["data"]
        expected = {
            item["id"]: item["activity"] for item in page if item["id"] in {root, branch.id}
        }
        with client.websocket_connect(
            "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
        ) as ws:
            ws.send_json({"type": "watch", "session_ids": [root, branch.id]})
            actual = {
                item["id"]: item["activity"] for item in _recv_until(ws, {"snapshot"})["items"]
            }
            assert actual == expected
            assert branch.id in [row["id"] for row in actual[root]["descendants"]]


async def test_broker_overflow_while_completion_waits_for_writer_is_terminal(monkeypatch):
    import asyncio
    from unittest.mock import AsyncMock

    from fastapi import APIRouter

    from omnigent.runtime import inflight_text, session_stream
    from omnigent.server.session_multiplex import SessionMultiplex

    monkeypatch.setattr(session_stream, "_SUBSCRIBER_QUEUE_MAX_EVENTS", 2)
    router = APIRouter()
    completion_produced = asyncio.Event()
    writer_started, release_writer = asyncio.Event(), asyncio.Event()
    errored = asyncio.Event()
    sent = []

    @router.get("/sessions/{session_id}/stream")
    async def endpoint(session_id: str):
        raise AssertionError("WebSocket must not invoke the SSE adapter")

    async def authorize():
        return None

    async def replay():
        yield {
            "type": "session.sync",
            "phase": "start",
            "item_revision": 0,
            "stream_epoch": inflight_text.stream_epoch(),
        }
        yield {
            "type": "session.sync",
            "phase": "complete",
            "item_revision": 0,
            "stream_epoch": inflight_text.stream_epoch(),
        }
        completion_produced.set()

    async def factory(request, session_id, **kwargs):
        request.state.stream_authorize = authorize
        return session_stream.subscribe(session_id, replay=replay)

    endpoint.stream_events = factory

    async def write(frame):
        if frame["type"] == "blocker":
            writer_started.set()
            await release_writer.wait()
        sent.append(frame)
        if frame["type"] == "session.error":
            errored.set()

    socket = AsyncMock()
    socket.scope = {"type": "websocket", "headers": []}
    mux = SessionMultiplex(router, socket, write)
    blocker = asyncio.create_task(mux.send({"type": "blocker"}))
    await writer_started.wait()
    try:
        await mux.handle({"type": "subscribe", "session_id": "writer-overflow"})
        await asyncio.wait_for(completion_produced.wait(), 1)
        for _ in range(3):
            session_stream.publish("writer-overflow", {"type": "session.heartbeat"})
        await asyncio.sleep(0)
        release_writer.set()
        await blocker
        await asyncio.wait_for(errored.wait(), 1)
        assert not any(frame.get("event", {}).get("phase") == "complete" for frame in sent)
        assert sent[-1]["code"] == "stream_overflow"
    finally:
        release_writer.set()
        await mux.close()
    assert not session_stream.has_subscribers("writer-overflow")


@pytest.mark.timeout(20)
def test_negotiated_membership_ignores_retired_unsubscribe(app, stores, monkeypatch):
    from omnigent.entities import MessageData, NewConversationItem
    from omnigent.runtime import session_stream

    monkeypatch.setenv("TRIUNE_TRANSCRIPT_FEED", "canary")
    sid = _seed_session(stores, owner=ALICE, title="generation")
    with TestClient(app).websocket_connect(
        "/v1/sessions/updates", headers={"X-Forwarded-Email": ALICE}
    ) as ws:
        caps = ws.receive_json()
        assert caps["transcript_feed"] == 2 and caps["transcript_feed_default"] == 1
        _subscribe(ws, sid, subscription_id="old", initial_limit=100)
        _subscribe(ws, sid, subscription_id="active", initial_limit=100)
        ws.send_json({"type": "unsubscribe", "session_id": sid, "subscription_id": "old"})
        item = stores[0].append(
            sid,
            [
                NewConversationItem(
                    type="message",
                    response_id="test",
                    data=MessageData(
                        role="user", content=[{"type": "input_text", "text": "still live"}]
                    ),
                )
            ],
        )[0]
        session_stream.publish(
            sid, {"type": "response.output_item.done", "item": item.to_api_dict()}
        )
        while True:
            frame = _recv_until(ws, {"session.event", "session.error"})
            assert frame["subscription_id"] == "active" and frame["type"] == "session.event", frame
            if frame["event"]["type"] == "response.output_item.done":
                assert frame["event"]["_change_revision"] == 1
                break


def test_enrolled_tab_and_expiring_display_observation(app, monkeypatch, tmp_path):
    monkeypatch.setenv("TRIUNE_TRANSCRIPT_FEED", "canary")
    monkeypatch.setenv("TRIUNE_TRANSCRIPT_CANARY_CHAT", "fixture-chat")
    monkeypatch.setenv("TRIUNE_STREAM_OBSERVE_DIR", str(tmp_path))
    monkeypatch.setenv("TRIUNE_STREAM_OBSERVE_UNTIL_MS", "4102444800000")
    for entry, expected in [("other", 1), ("fixture-chat", 2)]:
        with TestClient(app).websocket_connect(
            f"/v1/sessions/updates?entry_chat={entry}", headers={"X-Forwarded-Email": ALICE}
        ) as ws:
            caps = ws.receive_json()
            assert caps["transcript_feed_default"] == expected
            assert caps["transcript_observation_until_ms"] == 4102444800000
