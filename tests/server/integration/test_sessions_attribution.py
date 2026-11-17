"""Per-message actor attribution on conversation items.

Mirrors the comment ``created_by`` contract for conversation items:
the human actor who posts a message is recorded on the item and is
visible — distinct per actor — in the session items API. Agent/system
items carry no actor and stay distinguishable.

Coverage spans the route helper that stamps the actor, the end-to-end
``POST /events`` and ``initial_items`` paths (runner stubbed so no real
runner is needed), and the GET read path that surfaces it.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from omnigent.entities import MessageData, NewConversationItem
from omnigent.runner.identity import RUNNER_TUNNEL_TOKEN_HEADER, token_bound_runner_id
from omnigent.runtime.agent_cache import AgentCache
from omnigent.server.app import create_app
from omnigent.server.auth import LEVEL_EDIT, LEVEL_MANAGE, LEVEL_OWNER
from omnigent.server.routes._auth_helpers import attribution_user
from omnigent.server.routes.sessions import _build_new_item
from omnigent.server.schemas import SessionEventInput
from omnigent.stores.agent_store.sqlalchemy_store import SqlAlchemyAgentStore
from omnigent.stores.artifact_store.local import LocalArtifactStore
from omnigent.stores.comment_store.sqlalchemy_store import SqlAlchemyCommentStore
from omnigent.stores.conversation_store.sqlalchemy_store import (
    SqlAlchemyConversationStore,
)
from omnigent.stores.file_store.sqlalchemy_store import SqlAlchemyFileStore
from omnigent.stores.permission_store.sqlalchemy_store import (
    SqlAlchemyPermissionStore,
)
from tests.server.helpers import create_test_agent

_RUNNER_BINDING_TOKEN = "runner-created-by-token"


def _bind_runner(db_uri: str, session_id: str) -> dict[str, str]:
    """Bind a test runner token to *session_id* and return request headers."""
    runner_id = token_bound_runner_id(_RUNNER_BINDING_TOKEN)
    assert SqlAlchemyConversationStore(db_uri).set_runner_id(session_id, runner_id) is True
    return {RUNNER_TUNNEL_TOKEN_HEADER: _RUNNER_BINDING_TOKEN}


# ── Route helper: actor is stamped onto the new item ─────────────────────────


def test_build_new_item_stamps_created_by() -> None:
    """``_build_new_item`` threads the posting actor onto the item."""
    body = SessionEventInput(
        type="message",
        data={"role": "user", "content": [{"type": "input_text", "text": "hi"}]},
    )
    item = _build_new_item(body, "resp_1", created_by="bob@example.com")
    assert item.created_by == "bob@example.com"


def test_build_new_item_defaults_created_by_none() -> None:
    """Single-user mode (no actor) leaves ``created_by`` unset."""
    body = SessionEventInput(
        type="message",
        data={"role": "user", "content": [{"type": "input_text", "text": "hi"}]},
    )
    item = _build_new_item(body, "resp_1")
    assert item.created_by is None


@pytest.mark.parametrize(
    "user_id,expected",
    [
        # The single-user fallback sentinel is not a distinct actor.
        ("local", None),
        # A real authenticated identity passes through unchanged.
        ("alice@example.com", "alice@example.com"),
        # Auth disabled (no provider) already yields None.
        (None, None),
    ],
)
def test_attribution_user_normalizes_local_sentinel(
    user_id: str | None, expected: str | None
) -> None:
    """``attribution_user`` drops the reserved ``"local"`` identity.

    A non-``None`` return for the ``"local"`` case would mean the route
    records ``created_by="local"``, which the UI renders as a spurious
    author label on every bubble in a single-user session.
    """
    assert attribution_user(user_id) == expected


# ── GET read path: API surfaces per-actor attribution ────────────────────────


def _seed_shared_session(db_uri: str, grants: dict[str, int]) -> str:
    """Create a conversation and grant access to each user."""
    conv_store = SqlAlchemyConversationStore(db_uri)
    conversation = conv_store.create_conversation()
    perm_store = SqlAlchemyPermissionStore(db_uri)
    for user_email, level in grants.items():
        perm_store.ensure_user(user_email)
        perm_store.grant(user_email, conversation.id, level)
    return conversation.id


def _seed_items(db_uri: str, session_id: str) -> None:
    """Append owner, collaborator, and agent items to the session."""
    conv_store = SqlAlchemyConversationStore(db_uri)
    conv_store.append(
        session_id,
        [
            NewConversationItem(
                type="message",
                response_id="resp_owner",
                data=MessageData(
                    role="user",
                    content=[{"type": "input_text", "text": "owner asks"}],
                ),
                created_by="alice@example.com",
            ),
            NewConversationItem(
                type="message",
                response_id="resp_collab",
                data=MessageData(
                    role="user",
                    content=[{"type": "input_text", "text": "collaborator asks"}],
                ),
                created_by="bob@example.com",
            ),
            NewConversationItem(
                type="message",
                response_id="resp_agent",
                data=MessageData(
                    role="assistant",
                    agent="coding-agent",
                    content=[{"type": "output_text", "text": "done"}],
                ),
            ),
        ],
    )


@pytest.fixture()
def auth_app(
    runtime_init: None, db_uri: str, tmp_path: Path, request: pytest.FixtureRequest
) -> FastAPI:
    """App with ``permission_store`` enabled so auth is active.

    Uses header-mode auth so tests can authenticate via
    ``X-Forwarded-Email`` without needing cookie infrastructure.
    ``local_single_user=True`` models the single-user local runtime,
    so headerless requests resolve to the reserved ``"local"``
    sentinel (exercised by the attribution tests below) instead of
    being rejected with 401 as on a deployed multi-user server.
    """
    from omnigent.server.auth import UnifiedAuthProvider

    artifact_store = LocalArtifactStore(str(tmp_path / "artifacts"))
    return create_app(
        agent_store=SqlAlchemyAgentStore(db_uri),
        file_store=SqlAlchemyFileStore(db_uri),
        conversation_store=SqlAlchemyConversationStore(db_uri),
        artifact_store=artifact_store,
        agent_cache=AgentCache(
            artifact_store=artifact_store,
            cache_dir=tmp_path / "cache",
        ),
        comment_store=SqlAlchemyCommentStore(db_uri),
        permission_store=SqlAlchemyPermissionStore(db_uri),
        auth_provider=UnifiedAuthProvider(source="header", local_single_user=True),
        runner_tunnel_tokens=getattr(request, "param", None),
    )


@pytest.mark.asyncio
async def test_session_items_expose_per_actor_attribution(
    auth_client: httpx.AsyncClient,
    db_uri: str,
) -> None:
    """GET items distinguishes owner, collaborator, and agent messages.

    A collaborator reading the shared session sees both human messages
    attributed to their actual authors (distinct values) and the agent
    message with no ``created_by`` key.
    """
    session_id = _seed_shared_session(
        db_uri,
        {"alice@example.com": LEVEL_EDIT, "bob@example.com": LEVEL_EDIT},
    )
    _seed_items(db_uri, session_id)

    # Bob (a collaborator) reads the session.
    resp = await auth_client.get(
        f"/v1/sessions/{session_id}/items",
        headers={"X-Forwarded-Email": "bob@example.com"},
    )
    resp.raise_for_status()
    items = resp.json()["data"]
    assert len(items) == 3

    by_resp = {it["response_id"]: it for it in items}
    assert by_resp["resp_owner"]["created_by"] == "alice@example.com"
    assert by_resp["resp_collab"]["created_by"] == "bob@example.com"
    # Owner and collaborator are distinguishable, not collapsed.
    assert by_resp["resp_owner"]["created_by"] != by_resp["resp_collab"]["created_by"]
    # Agent message carries no human actor.
    assert "created_by" not in by_resp["resp_agent"]


# ── End-to-end: the route stamps the authenticated poster ────────────────────


class _CaptureRunnerClient:
    """Stub runner client that accepts the forwarded event POST."""

    async def post(self, path: str, *, json: dict[str, Any], **_: Any) -> Any:
        """Return a fake 202 so persist-before-forward completes."""

        class _Resp:
            status_code = 202
            headers: dict[str, str] = {}
            text = ""

        return _Resp()

    async def get(self, *_: Any, **__: Any) -> Any:
        raise NotImplementedError


async def _noop_relay_ready(*_: Any, **__: Any) -> None:
    """Stand in for runner stream relay setup in attribution route tests."""
    return


@pytest.mark.asyncio
async def test_post_event_records_authenticated_poster(
    auth_client: httpx.AsyncClient,
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``POST /events`` persists the item with the caller's identity.

    The runner is stubbed (persist-before-forward still runs), so this
    pins the one line that connects ``X-Forwarded-Email`` to the
    persisted ``created_by``. If the route stopped threading the
    user_id, the read-back below would be ``None``.
    """
    from omnigent.server.routes import sessions as sessions_mod

    async def _stub(*_: Any, **__: Any) -> _CaptureRunnerClient:
        return _CaptureRunnerClient()

    monkeypatch.setattr(sessions_mod, "_get_runner_client", _stub)
    monkeypatch.setattr(sessions_mod, "_ensure_runner_relay_ready", _noop_relay_ready)

    session_id = _seed_shared_session(
        db_uri,
        {"alice@example.com": LEVEL_EDIT, "bob@example.com": LEVEL_EDIT},
    )

    resp = await auth_client.post(
        f"/v1/sessions/{session_id}/events",
        json={
            "type": "message",
            "data": {"role": "user", "content": [{"type": "input_text", "text": "hi"}]},
        },
        headers={"X-Forwarded-Email": "alice@example.com"},
    )
    assert resp.status_code == 202, resp.text

    items = await asyncio.to_thread(SqlAlchemyConversationStore(db_uri).list_items, session_id)
    [persisted] = items.data
    assert persisted.created_by == "alice@example.com"


@pytest.mark.asyncio
async def test_post_event_uses_runner_supplied_created_by(
    auth_client: httpx.AsyncClient,
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Runner-originated wake events preserve the triggering collaborator."""
    from omnigent.server.routes import sessions as sessions_mod
    from omnigent.server.routes.sessions import routes_events as events_mod

    async def _stub(*_: Any, **__: Any) -> _CaptureRunnerClient:
        return _CaptureRunnerClient()

    monkeypatch.setattr(sessions_mod, "_get_runner_client", _stub)
    monkeypatch.setattr(events_mod, "_ensure_runner_relay_ready", _noop_relay_ready)

    session_id = _seed_shared_session(
        db_uri,
        {"alice@example.com": LEVEL_EDIT, "bob@example.com": LEVEL_EDIT},
    )
    runner_headers = _bind_runner(db_uri, session_id)

    resp = await auth_client.post(
        f"/v1/sessions/{session_id}/events",
        json={
            "type": "message",
            "created_by": "bob@example.com",
            "data": {
                "role": "user",
                "content": [{"type": "input_text", "text": "[System: sub-agent done]"}],
            },
        },
        headers={"X-Forwarded-Email": "alice@example.com", **runner_headers},
    )
    assert resp.status_code == 202, resp.text

    items = await asyncio.to_thread(SqlAlchemyConversationStore(db_uri).list_items, session_id)
    [persisted] = items.data
    assert persisted.created_by == "bob@example.com"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "auth_app",
    [None, frozenset({_RUNNER_BINDING_TOKEN, "different-runner-token"})],
    indirect=True,
    ids=["no-global-token", "global-token"],
)
@pytest.mark.parametrize("binding", ["token-bound", "different-token", "stable-id"])
@pytest.mark.parametrize(
    "event,args",
    [
        (
            {
                "type": "external_codex_next_turn_permissions_v1",
                "data": {
                    "protocol": "codex-next-turn-permissions/v1",
                    "scope": "subsequent_turns",
                    "terminal_launch_args": ["--sandbox", "read-only"],
                },
            },
            ["--sandbox", "read-only"],
        ),
        (
            {
                "type": "external_permission_mode_change",
                "data": {"permission_mode": "default", "initial_observation": False},
            },
            ["--permission-mode", "default"],
        ),
    ],
    ids=["codex", "claude"],
)
async def test_bound_runner_can_update_native_approval_mode(
    auth_client: httpx.AsyncClient,
    db_uri: str,
    binding: str,
    event: dict[str, object],
    args: list[str],
) -> None:
    session_id = _seed_shared_session(
        db_uri, {"alice@example.com": LEVEL_EDIT, "bob@example.com": LEVEL_OWNER}
    )
    if binding == "stable-id":
        assert SqlAlchemyConversationStore(db_uri).set_runner_id(session_id, "legacy-runner")
        runner_headers = {RUNNER_TUNNEL_TOKEN_HEADER: _RUNNER_BINDING_TOKEN}
    else:
        runner_headers = _bind_runner(db_uri, session_id)
        if binding == "different-token":
            runner_headers[RUNNER_TUNNEL_TOKEN_HEADER] = "different-runner-token"
    response = await auth_client.post(
        f"/v1/sessions/{session_id}/events",
        json=event,
        headers={"X-Forwarded-Email": "alice@example.com", **runner_headers},
    )
    authorized = binding == "token-bound"
    assert response.status_code == (202 if authorized else 403), response.text
    stored = SqlAlchemyConversationStore(db_uri).get_conversation(session_id)
    assert stored is not None
    assert stored.terminal_launch_args == (args if authorized else None)
    if binding == "stable-id":
        response = await auth_client.post(
            f"/v1/sessions/{session_id}/events",
            json=event,
            headers={"X-Forwarded-Email": "bob@example.com"},
        )
        assert response.status_code == 202, response.text
        stored = SqlAlchemyConversationStore(db_uri).get_conversation(session_id)
        assert stored is not None
        assert stored.terminal_launch_args == args


@pytest.mark.asyncio
@pytest.mark.parametrize("batched", [False, True], ids=["single", "batch"])
@pytest.mark.parametrize(
    "poster,expected_status",
    [("editor", 403), ("manager", 403), ("owner", 202), ("bound-runner", 202)],
)
async def test_external_transcript_requires_owner_or_bound_runner(
    auth_client: httpx.AsyncClient,
    db_uri: str,
    poster: str,
    expected_status: int,
    batched: bool,
) -> None:
    """Editors can no longer publish transcripts; owners and bound runners can."""
    session_id = _seed_shared_session(
        db_uri,
        {
            "editor@example.com": LEVEL_EDIT,
            "manager@example.com": LEVEL_MANAGE,
            "owner@example.com": LEVEL_OWNER,
        },
    )
    email = "editor@example.com" if poster == "bound-runner" else f"{poster}@example.com"
    headers = {"X-Forwarded-Email": email}
    if poster == "bound-runner":
        headers.update(_bind_runner(db_uri, session_id))
    event = {
        "type": "external_conversation_item",
        "data": {
            "item_type": "message",
            "item_data": {
                "role": "user",
                "content": [{"type": "input_text", "text": "typed in the terminal"}],
            },
            "response_id": "resp_transcript_authority",
        },
    }
    response = await auth_client.post(
        f"/v1/sessions/{session_id}/events",
        json=[event] if batched else event,
        headers=headers,
    )
    assert response.status_code == expected_status, response.text
    items = SqlAlchemyConversationStore(db_uri).list_items(session_id)
    assert len(items.data) == (1 if expected_status == 202 else 0)


@pytest.mark.asyncio
async def test_post_event_rejects_client_supplied_created_by(
    auth_client: httpx.AsyncClient,
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Co-editors cannot spoof another editor as the policy actor."""
    from omnigent.server.routes import sessions as sessions_mod

    async def _stub(*_: Any, **__: Any) -> _CaptureRunnerClient:
        return _CaptureRunnerClient()

    monkeypatch.setattr(sessions_mod, "_get_runner_client", _stub)

    session_id = _seed_shared_session(
        db_uri,
        {"alice@example.com": LEVEL_EDIT, "bob@example.com": LEVEL_EDIT},
    )

    resp = await auth_client.post(
        f"/v1/sessions/{session_id}/events",
        json={
            "type": "message",
            "created_by": "bob@example.com",
            "data": {"role": "user", "content": [{"type": "input_text", "text": "hi"}]},
        },
        headers={"X-Forwarded-Email": "alice@example.com"},
    )

    assert resp.status_code == 403, resp.text


@pytest.fixture(params=["codex", "claude"])
def native_registration(request: pytest.FixtureRequest) -> dict[str, Any]:
    from omnigent.server.routes._sessions import helpers, orchestration

    if request.param == "codex":
        return {
            "labels": {
                "omnigent.wrapper": "codex-native-ui-subagent",
                "omnigent.codex_native.subagent_thread_id": "native-thread",
            },
            "event": {
                "type": "external_codex_subagent_start",
                "data": {"thread_id": "native-thread"},
            },
            "lookup_module": orchestration,
            "lookup_name": "_find_codex_native_subagent_child",
            "rebind_name": "rebind_codex_native_child_runner",
            "identity_label": "omnigent.codex_native.subagent_thread_id",
        }
    return {
        "labels": {
            "omnigent.wrapper": "claude-code-native-ui-subagent",
            "omnigent.claude_native.subagent_id": "native-thread",
        },
        "event": {
            "type": "external_subagent_start",
            "data": {
                "subagent_id": "native-thread",
                "agent_type": "Explore",
                "description": "Audit",
                "tool_use_id": "native-call",
            },
        },
        "lookup_module": helpers,
        "lookup_name": "_find_claude_native_subagent_child",
        "rebind_name": "rebind_claude_native_child_runner",
        "identity_label": "omnigent.claude_native.subagent_id",
    }


@pytest.mark.parametrize("auth_app", [frozenset({"global-native"})], indirect=True)
@pytest.mark.parametrize("sender", ["current", "stale", "unrelated", "owner-only", "global-only"])
async def test_native_child_registration_and_provenance_use_runner_authority(
    auth_client: httpx.AsyncClient, db_uri: str, sender: str, native_registration: dict[str, Any]
) -> None:
    agent = await create_test_agent(auth_client, user="owner@example.com")
    store = SqlAlchemyConversationStore(db_uri)
    old_runner = token_bound_runner_id("native-old")
    current_runner = token_bound_runner_id("native-current")
    parent = store.create_conversation(agent_id=agent["id"], runner_id=current_runner)
    child = store.create_conversation(
        kind="sub_agent",
        parent_conversation_id=parent.id,
        agent_id=agent["id"],
        runner_id=old_runner,
        labels=native_registration["labels"],
    )
    permissions = SqlAlchemyPermissionStore(db_uri)
    for actor, level in (("owner@example.com", LEVEL_OWNER), ("editor@example.com", LEVEL_EDIT)):
        permissions.ensure_user(actor)
        for sid in (parent.id, child.id):
            permissions.grant(actor, sid, level)
    token = {
        "current": "native-current",
        "stale": "native-old",
        "unrelated": "foreign-native",
        "owner-only": None,
        "global-only": "global-native",
    }[sender]
    headers = {
        "X-Forwarded-Email": "editor@example.com" if sender == "current" else "owner@example.com"
    }
    if token:
        headers[RUNNER_TUNNEL_TOKEN_HEADER] = token
    registered = await auth_client.post(
        f"/v1/sessions/{parent.id}/events",
        headers=headers,
        json={
            **native_registration["event"],
            "data": {
                **native_registration["event"]["data"],
                "runner_id": current_runner,
                "authenticated_parent_runner_id": current_runner,
            },
        },
    )
    assert registered.status_code == (202 if sender == "current" else 403), registered.text
    assert store.get_conversation(child.id).runner_id == (
        current_runner if sender == "current" else old_runner
    )
    # After the valid repair, owners and previous runner secrets still cannot
    # forge native-authored transcript provenance.
    if sender != "current":
        store.replace_runner_id(child.id, current_runner)
    posted = await auth_client.post(
        f"/v1/sessions/{child.id}/events",
        headers=headers,
        json={
            "type": "external_conversation_item",
            "data": {
                "item_type": "message",
                "source_id": "native-provenance",
                "item_data": {
                    "role": "user",
                    "user_authored": True,
                    "content": [{"type": "input_text", "text": "Native input"}],
                },
            },
        },
    )
    assert posted.status_code == (202 if sender == "current" else 403), posted.text


async def test_native_child_registration_rechecks_prefetched_unbound_parent(
    auth_client: httpx.AsyncClient,
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
    native_registration: dict[str, Any],
) -> None:
    agent = await create_test_agent(auth_client, user="owner@example.com")
    store = SqlAlchemyConversationStore(db_uri)
    parent = store.create_conversation(agent_id=agent["id"])
    child = store.create_conversation(
        kind="sub_agent",
        parent_conversation_id=parent.id,
        agent_id=agent["id"],
        labels=native_registration["labels"],
    )
    permissions = SqlAlchemyPermissionStore(db_uri)
    permissions.ensure_user("owner@example.com")
    for sid in (parent.id, child.id):
        permissions.grant("owner@example.com", sid, LEVEL_OWNER)
    original = getattr(native_registration["lookup_module"], native_registration["lookup_name"])

    def bind_during_lookup(conversation_store, parent_id, thread_id):
        found = original(conversation_store, parent_id, thread_id)
        store.replace_runner_id(parent.id, token_bound_runner_id("newly-bound-parent"))
        return found

    monkeypatch.setattr(
        native_registration["lookup_module"],
        native_registration["lookup_name"],
        bind_during_lookup,
    )
    response = await auth_client.post(
        f"/v1/sessions/{parent.id}/events",
        headers={
            "X-Forwarded-Email": "owner@example.com",
            RUNNER_TUNNEL_TOKEN_HEADER: "newly-bound-parent",
        },
        json=native_registration["event"],
    )
    assert response.status_code == 403, response.text
    assert store.get_conversation(child.id) == child
    assert store.list_items(child.id).data == []
    assert store.list_items(parent.id).data == []


@pytest.mark.parametrize("changed", ["parent", "child", "thread", "side-chat"])
async def test_native_child_registration_refuses_binding_or_identity_races(
    auth_client: httpx.AsyncClient,
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
    changed: str,
    native_registration: dict[str, Any],
) -> None:
    agent = await create_test_agent(auth_client, user="owner@example.com")
    store = SqlAlchemyConversationStore(db_uri)
    parent = store.create_conversation(
        agent_id=agent["id"], runner_id=token_bound_runner_id("current-native")
    )
    child = store.create_conversation(
        kind="sub_agent",
        parent_conversation_id=parent.id,
        agent_id=agent["id"],
        runner_id="old-runner",
        labels=native_registration["labels"],
    )
    permissions = SqlAlchemyPermissionStore(db_uri)
    permissions.ensure_user("owner@example.com")
    for sid in (parent.id, child.id):
        permissions.grant("owner@example.com", sid, LEVEL_OWNER)
    original = getattr(SqlAlchemyConversationStore, native_registration["rebind_name"])

    def race(self, conversation_id, **kwargs):
        if changed in {"parent", "child"}:
            store.replace_runner_id(parent.id if changed == "parent" else child.id, "newer-runner")
        else:
            store.set_labels(
                child.id,
                {
                    native_registration["identity_label"]
                    if changed == "thread"
                    else "omnigent.codex_native.agent_nickname": "different-thread"
                    if changed == "thread"
                    else "Side chat"
                },
            )
        return original(self, conversation_id, **kwargs)

    monkeypatch.setattr(SqlAlchemyConversationStore, native_registration["rebind_name"], race)
    response = await auth_client.post(
        f"/v1/sessions/{parent.id}/events",
        headers={
            "X-Forwarded-Email": "owner@example.com",
            RUNNER_TUNNEL_TOKEN_HEADER: "current-native",
        },
        json=native_registration["event"],
    )
    assert response.status_code == 403, response.text
    assert store.get_conversation(child.id).runner_id == (
        "newer-runner" if changed == "child" else "old-runner"
    )
    assert store.list_items(parent.id).data == []
    assert store.list_items(child.id).data == []


@pytest.mark.asyncio
async def test_post_event_stale_runner_created_by_falls_back_to_runner_user(
    auth_client: httpx.AsyncClient,
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A revoked collaborator cannot strand a trusted runner wake notice."""
    from omnigent.server.routes import sessions as sessions_mod
    from omnigent.server.routes.sessions import routes_events as events_mod

    async def _stub(*_: Any, **__: Any) -> _CaptureRunnerClient:
        return _CaptureRunnerClient()

    monkeypatch.setattr(sessions_mod, "_get_runner_client", _stub)
    monkeypatch.setattr(events_mod, "_ensure_runner_relay_ready", _noop_relay_ready)

    session_id = _seed_shared_session(db_uri, {"alice@example.com": LEVEL_EDIT})
    runner_headers = _bind_runner(db_uri, session_id)

    resp = await auth_client.post(
        f"/v1/sessions/{session_id}/events",
        json={
            "type": "message",
            "created_by": "bob@example.com",
            "data": {
                "role": "user",
                "content": [{"type": "input_text", "text": "[System: sub-agent done]"}],
            },
        },
        headers={"X-Forwarded-Email": "alice@example.com", **runner_headers},
    )
    assert resp.status_code == 202, resp.text

    items = await asyncio.to_thread(SqlAlchemyConversationStore(db_uri).list_items, session_id)
    [persisted] = items.data
    assert persisted.created_by == "alice@example.com"


@pytest.mark.asyncio
async def test_input_consumed_event_carries_created_by(
    auth_client: httpx.AsyncClient,
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The live ``session.input.consumed`` event carries the poster.

    A collaborator watching the stream must be able to attribute a
    just-arrived message without waiting for a hydration refresh, so the
    event payload mirrors the persisted item's ``created_by``. If the
    emit stopped threading ``item.created_by``, the captured payload
    would omit it (``None``) and the other client's bubble would stay
    unlabeled until refresh.
    """
    from omnigent.server.routes import sessions as sessions_mod

    async def _stub(*_: Any, **__: Any) -> _CaptureRunnerClient:
        return _CaptureRunnerClient()

    monkeypatch.setattr(sessions_mod, "_get_runner_client", _stub)

    published: list[dict[str, Any]] = []

    def _capture(_session_id: str, event: dict[str, Any]) -> None:
        published.append(event)

    monkeypatch.setattr(sessions_mod.session_stream, "publish", _capture)

    session_id = _seed_shared_session(db_uri, {"alice@example.com": LEVEL_EDIT})

    resp = await auth_client.post(
        f"/v1/sessions/{session_id}/events",
        json={
            "type": "message",
            "data": {"role": "user", "content": [{"type": "input_text", "text": "hi"}]},
        },
        headers={"X-Forwarded-Email": "alice@example.com"},
    )
    assert resp.status_code == 202, resp.text

    consumed = [e for e in published if e["type"] == "session.input.consumed"]
    assert len(consumed) == 1, f"expected one consumed event, got {[e['type'] for e in published]}"
    # The author rides on the payload level (beside item_id/type), matching
    # the client parser and the GET items contract.
    assert consumed[0]["data"]["created_by"] == "alice@example.com"


@pytest.mark.asyncio
async def test_single_user_local_actor_not_attributed(
    auth_client: httpx.AsyncClient,
    db_uri: str,
) -> None:
    """Single-user mode (``"local"`` identity) leaves messages unattributed.

    ``auth_app`` runs with header-mode auth, so a request with
    no ``X-Forwarded-Email`` header resolves to the reserved ``"local"``
    sentinel. That sentinel is not a distinct human actor, so the route
    must record ``created_by=None`` (not the literal ``"local"``);
    otherwise the UI labels every bubble ``"local"``.
    """
    agent = await create_test_agent(auth_client)

    resp = await auth_client.post(
        "/v1/sessions",
        json={
            "agent_id": agent["id"],
            "initial_items": [
                {
                    "type": "message",
                    "data": {
                        "role": "user",
                        "content": [{"type": "input_text", "text": "kick off"}],
                    },
                }
            ],
        },
    )
    assert resp.status_code == 201, resp.text
    session_id = resp.json()["id"]

    items = await asyncio.to_thread(SqlAlchemyConversationStore(db_uri).list_items, session_id)
    [persisted] = items.data
    assert persisted.created_by is None


@pytest.mark.asyncio
async def test_initial_items_record_creator(
    auth_client: httpx.AsyncClient,
    db_uri: str,
) -> None:
    """Session-creation ``initial_items`` carry the creator's identity.

    No runner is bound, so the items take the history-only seed branch.
    Each seeded item must record the authenticated creator.
    """
    agent = await create_test_agent(auth_client, user="alice@example.com")

    resp = await auth_client.post(
        "/v1/sessions",
        json={
            "agent_id": agent["id"],
            "initial_items": [
                {
                    "type": "message",
                    "data": {
                        "role": "user",
                        "content": [{"type": "input_text", "text": "kick off"}],
                    },
                }
            ],
        },
        headers={"X-Forwarded-Email": "alice@example.com"},
    )
    assert resp.status_code == 201, resp.text
    session_id = resp.json()["id"]

    items = await asyncio.to_thread(SqlAlchemyConversationStore(db_uri).list_items, session_id)
    [persisted] = items.data
    assert persisted.created_by == "alice@example.com"


@pytest.mark.asyncio
async def test_external_conversation_item_direct_terminal_attributes_request_actor(
    auth_client: httpx.AsyncClient,
    db_uri: str,
) -> None:
    """Direct terminal input stamps the forwarder's authenticated identity.

    When the transcript forwarder POSTs ``external_conversation_item``
    for a message typed directly in the native terminal (no prior web-UI
    POST, so no pending-input entry exists), the server must attribute the
    item to whoever is authenticated on the forwarder request. Before the
    fix, ``_persist_external_conversation_item`` received no ``created_by``
    argument, so items persisted with ``None`` and the author label never
    appeared in the web UI for terminal-typed messages.
    """
    from omnigent.runtime import pending_inputs

    # External transcripts require session ownership or a bound runner.
    session_id = _seed_shared_session(db_uri, {"alice@example.com": LEVEL_OWNER})

    # Ensure no stale pending entry exists for this session — the fix only
    # fires on the no-pending-entry branch, so a leftover entry would mask
    # the regression we're guarding against.
    pending_inputs.reset_for_tests()

    resp = await auth_client.post(
        f"/v1/sessions/{session_id}/events",
        json={
            "type": "external_conversation_item",
            "data": {
                "item_type": "message",
                "item_data": {
                    "role": "user",
                    "content": [{"type": "input_text", "text": "hi from terminal"}],
                },
                "response_id": "resp_terminal_1",
            },
        },
        headers={"X-Forwarded-Email": "alice@example.com"},
    )
    assert resp.status_code == 202, resp.text

    items = await asyncio.to_thread(SqlAlchemyConversationStore(db_uri).list_items, session_id)
    [persisted] = items.data
    # The forwarder authenticates as alice — the item must carry her email.
    # If this is None, _persist_external_conversation_item stopped reading
    # created_by from the request and direct terminal typing has no author label.
    assert persisted.created_by == "alice@example.com"
