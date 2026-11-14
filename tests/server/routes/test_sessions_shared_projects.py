# Modified for Triune.
"""Regression tests: sessions shared into a project stay on "Shared with me".

Projects are a "My sessions"-only sidebar surface — filing a session into a
project is owner-only. When someone shares a session that happens to carry a
project label, the recipient should see it under "Shared with me", NOT as one
of their own project folders under "My sessions".

The sidebar builds project folders from two owner-scoped server surfaces:

- ``GET /v1/sessions/projects`` — the folder *names*, and
- ``GET /v1/sessions?project=<name>`` — the sessions *inside* a folder.

Both must filter by ownership (an ``owner``-level grant), not mere access, or
a shared session leaks into the recipient's "My sessions" project view. These
tests drive the real routes against file-backed SQLite stores with header auth.
"""

from __future__ import annotations

import base64
import json

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from omnigent.entities import MessageData, NewConversationItem
from omnigent.errors import OmnigentError
from omnigent.server.auth import LEVEL_OWNER, LEVEL_READ, UnifiedAuthProvider
from omnigent.server.routes.sessions import create_sessions_router
from omnigent.stores.agent_store.sqlalchemy_store import SqlAlchemyAgentStore
from omnigent.stores.conversation_store import SIDE_CHAT_LABEL_KEY
from omnigent.stores.conversation_store.sqlalchemy_store import (
    SqlAlchemyConversationStore,
)
from omnigent.stores.permission_store.sqlalchemy_store import (
    SqlAlchemyPermissionStore,
)

ALICE = "alice@example.com"
BOB = "bob@example.com"
PROJECT_LABEL_KEY = "omni_project"


def _multi_user_app(db_uri: str) -> FastAPI:
    """Build a header-auth app mounting the sessions router at ``/v1``."""
    app = FastAPI()

    @app.exception_handler(OmnigentError)
    async def _handle(request: Request, exc: OmnigentError) -> JSONResponse:
        del request
        return JSONResponse(
            status_code=exc.http_status,
            content={"error": {"code": exc.code, "message": exc.message}},
        )

    app.include_router(
        create_sessions_router(
            conversation_store=SqlAlchemyConversationStore(db_uri),
            agent_store=SqlAlchemyAgentStore(db_uri),
            auth_provider=UnifiedAuthProvider(source="header"),
            permission_store=SqlAlchemyPermissionStore(db_uri),
        ),
        prefix="/v1",
    )
    return app


def _seed_shared_project_session(db_uri: str) -> str:
    """Seed a session owned by Bob, filed under a project, and read-shared to
    Alice. Returns the session id."""
    agent_store = SqlAlchemyAgentStore(db_uri)
    conv_store = SqlAlchemyConversationStore(db_uri)
    perms = SqlAlchemyPermissionStore(db_uri)
    if agent_store.get("087b7cb7ac30abf4debfaa578d052ec6") is None:
        agent_store.create(
            agent_id="087b7cb7ac30abf4debfaa578d052ec6",
            name="test-agent",
            bundle_location="087b7cb7ac30abf4debfaa578d052ec6/bundle",
        )
    conv = conv_store.create_conversation(
        title="Bob's session", agent_id="087b7cb7ac30abf4debfaa578d052ec6"
    )
    conv_store.set_labels(conv.id, {PROJECT_LABEL_KEY: "Bob Project"})
    for user in (ALICE, BOB):
        perms.ensure_user(user)
    perms.grant(BOB, conv.id, LEVEL_OWNER)
    perms.grant(ALICE, conv.id, LEVEL_READ)
    return conv.id


def test_shared_project_not_listed_as_recipients_own_project(db_uri: str) -> None:
    """A project whose only member is a session shared TO Alice (owned by Bob)
    must not appear in Alice's project list — folders are her own sessions."""
    _seed_shared_project_session(db_uri)
    app = _multi_user_app(db_uri)

    # Bob owns it, so it's his project. Label-only (no first-class row here),
    # so it lists with id=None.
    bob = TestClient(app).get("/v1/sessions/projects", headers={"X-Forwarded-Email": BOB})
    assert bob.status_code == 200
    assert bob.json() == [{"id": None, "name": "Bob Project", "icon": None, "archived": False}]

    # Alice can access the session, but doesn't own it — no folder for her.
    alice = TestClient(app).get("/v1/sessions/projects", headers={"X-Forwarded-Email": ALICE})
    assert alice.status_code == 200
    assert alice.json() == []


def test_shared_session_excluded_from_recipients_project_folder(db_uri: str) -> None:
    """Fetching a project folder's sessions (``?project=``) as Alice excludes a
    session merely shared with her — it belongs on "Shared with me"."""
    conv_id = _seed_shared_project_session(db_uri)
    app = _multi_user_app(db_uri)

    # Bob's folder holds the session.
    bob = TestClient(app).get(
        "/v1/sessions?project=Bob%20Project", headers={"X-Forwarded-Email": BOB}
    )
    assert bob.status_code == 200
    assert [s["id"] for s in bob.json()["data"]] == [conv_id]

    # Alice's same-named folder is empty — the shared session isn't hers to file.
    alice = TestClient(app).get(
        "/v1/sessions?project=Bob%20Project", headers={"X-Forwarded-Email": ALICE}
    )
    assert alice.status_code == 200
    assert alice.json()["data"] == []


def test_shared_session_still_visible_in_flat_list(db_uri: str) -> None:
    """The fix is scoped to project surfaces: the shared session still shows up
    in Alice's unfiltered session list, where the "Shared with me" tab reads it
    (the frontend splits owned vs. shared by permission_level there)."""
    conv_id = _seed_shared_project_session(db_uri)
    app = _multi_user_app(db_uri)

    resp = TestClient(app).get("/v1/sessions", headers={"X-Forwarded-Email": ALICE})
    assert resp.status_code == 200
    items = {s["id"]: s for s in resp.json()["data"]}
    assert conv_id in items
    # Below LEVEL_OWNER, so the frontend files it under "Shared with me".
    assert items[conv_id]["permission_level"] < LEVEL_OWNER


@pytest.mark.parametrize(
    ("params", "expected"),
    [
        ({"visibility": "mine", "project": "Bob Project"}, {"owned_active"}),
        (
            {"visibility": "archived", "include_archived": "true"},
            {"owned_archived", "shared_archived"},
        ),
        (
            {"visibility": "all", "include_archived": "true", "project": "Bob Project"},
            {"owned_active", "owned_archived"},
        ),
        ({"visibility": "all"}, {"owned_active", "shared_active"}),
    ],
)
def test_client_scopes_preserve_owned_projects_and_shared_archives(
    db_uri: str, params: dict[str, str], expected: set[str]
) -> None:
    """Archive lists retain shared rows; project lists retain the ownership boundary."""
    ids = {"shared_active": _seed_shared_project_session(db_uri)}
    conv_store = SqlAlchemyConversationStore(db_uri)
    perms = SqlAlchemyPermissionStore(db_uri)
    shared = conv_store.get_conversation(ids["shared_active"])
    assert shared is not None
    for name, owner, archived in [
        ("owned_active", ALICE, False),
        ("owned_archived", ALICE, True),
        ("shared_archived", BOB, True),
    ]:
        conv = conv_store.create_conversation(title=name, agent_id=shared.agent_id)
        conv_store.set_labels(conv.id, {PROJECT_LABEL_KEY: "Bob Project"})
        perms.grant(owner, conv.id, LEVEL_OWNER)
        if owner != ALICE:
            perms.grant(ALICE, conv.id, LEVEL_READ)
        if archived:
            conv_store.update_conversation(conv.id, archived=True)
        ids[name] = conv.id

    with TestClient(_multi_user_app(db_uri)) as client:
        response = client.get("/v1/sessions", params=params, headers={"X-Forwarded-Email": ALICE})
    assert response.status_code == 200
    assert {row["id"] for row in response.json()["data"]} == {ids[name] for name in expected}


@pytest.mark.parametrize(
    ("params", "expected"),
    [
        ({}, {"owned", "shared"}),
        ({"visibility": "mine", "include_archived": "true"}, {"owned"}),
        ({"visibility": "shared", "include_archived": "true"}, {"shared"}),
        ({"visibility": "archived"}, {"archived"}),
        ({"include_archived": "true"}, {"owned", "shared", "archived"}),
    ],
)
def test_message_search_authorized_paging_and_visibility(db_uri, params, expected) -> None:
    """The message route inherits the list's visibility rules and rechecks each page."""
    ids = {"shared": _seed_shared_project_session(db_uri)}
    store = SqlAlchemyConversationStore(db_uri)
    perms = SqlAlchemyPermissionStore(db_uri)
    shared = store.get_conversation(ids["shared"])
    for name, owner in (("owned", ALICE), ("private", BOB), ("archived", BOB)):
        conv = store.create_conversation(title=name, agent_id=shared.agent_id)
        ids[name] = conv.id
        perms.grant(owner, conv.id, LEVEL_OWNER)
    perms.grant(ALICE, ids["archived"], LEVEL_READ)
    store.update_conversation(ids["archived"], archived=True)
    for session_id in ids.values():
        store.append(
            session_id,
            [
                NewConversationItem(
                    type="message",
                    response_id="search-test",
                    data=MessageData(
                        role="assistant",
                        agent="test-agent",
                        content=[{"type": "output_text", "text": "😀 Écho 50%_/ ÉCHO 50%_/"}],
                    ),
                )
                for _ in range(3)
            ],
        )
    headers = {"X-Forwarded-Email": ALICE}
    with TestClient(_multi_user_app(db_uri)) as client:
        seen, cursor = [], None
        while True:
            response = client.get(
                "/v1/sessions/search/messages",
                headers=headers,
                params={
                    "query": "écho 50%_/",
                    "limit": 2,
                    **params,
                    **({"cursor": cursor} if cursor else {}),
                },
            )
            assert response.status_code == 200, response.text
            page = response.json()
            assert "total" not in page
            seen.extend(page["data"])
            if not page["has_more"]:
                assert page["next_cursor"] is None
                break
            cursor = page["next_cursor"]
        assert {hit["session_id"] for hit in seen} == {ids[name] for name in expected}
        assert len(seen) == 3 * len(expected)
        assert len({hit["item_id"] for hit in seen}) == len(seen)
        assert all(hit["role"] == "assistant" and hit["occurrence_count"] == 2 for hit in seen)
        assert seen[0]["ranges"][0] == {"start": 3, "end": 13}
        for scope in (ids["shared"], ids["private"]):
            response = client.get(
                "/v1/sessions/search/messages",
                headers=headers,
                params={
                    "query": "ÉCHO",
                    "session_id": scope,
                },
            )
            assert response.status_code == 200
            assert len(response.json()["data"]) == (3 if scope == ids["shared"] else 0)
        first = client.get(
            "/v1/sessions/search/messages",
            headers=headers,
            params={
                "query": "ÉCHO",
                "limit": 1,
                "session_id": ids["shared"],
            },
        ).json()
        for change in ({"query": "other"}, {"session_id": ids["owned"]}, {"visibility": "mine"}):
            response = client.get(
                "/v1/sessions/search/messages",
                headers=headers,
                params={
                    "query": "ÉCHO",
                    "session_id": ids["shared"],
                    "cursor": first["next_cursor"],
                    **change,
                },
            )
            assert response.status_code == 400
        perms.revoke(ALICE, ids["shared"])
        response = client.get(
            "/v1/sessions/search/messages",
            headers=headers,
            params={
                "query": "ÉCHO",
                "session_id": ids["shared"],
                "cursor": first["next_cursor"],
            },
        )
        assert response.status_code == 200
        assert response.json()["data"] == []


def test_message_search_authentication_validation_and_empty_query(db_uri, monkeypatch) -> None:
    monkeypatch.delenv("OMNIGENT_LOCAL_SINGLE_USER", raising=False)
    with TestClient(_multi_user_app(db_uri)) as client:
        assert (
            client.get("/v1/sessions/search/messages", params={"query": "secret"}).status_code
            == 401
        )
        headers = {"X-Forwarded-Email": ALICE}
        for params in (
            {},
            {"query": "x", "limit": 101},
            {"query": "x" * 513},
            {"query": "x", "session_id": "invalid"},
            {"query": "x", "visibility": "unknown"},
            {"query": "x", "message_filter": "unknown"},
            {"query": "x", "include_titles": "unknown"},
        ):
            assert (
                client.get(
                    "/v1/sessions/search/messages", headers=headers, params=params
                ).status_code
                == 422
            )
        assert (
            client.get(
                "/v1/sessions/search/messages",
                headers=headers,
                params={"query": "x", "cursor": "bad"},
            ).status_code
            == 400
        )
        response = client.get(
            "/v1/sessions/search/messages", headers=headers, params={"query": ""}
        )
        assert response.status_code == 200
        assert response.json() == {"data": [], "has_more": False, "next_cursor": None}


def test_message_search_child_inheritance_revocation_and_cursor_bounds(db_uri) -> None:
    parent_id = _seed_shared_project_session(db_uri)
    store = SqlAlchemyConversationStore(db_uri)
    permissions = SqlAlchemyPermissionStore(db_uri)
    child = store.create_conversation(
        agent_id=store.get_conversation(parent_id).agent_id, parent_conversation_id=parent_id
    )
    store.append(
        child.id,
        [
            NewConversationItem(
                type="message",
                response_id="search-child",
                data=MessageData(role="user", content=[{"type": "input_text", "text": "needle"}]),
            )
            for _ in range(3)
        ],
    )
    headers = {"X-Forwarded-Email": ALICE}
    params = {"query": "needle", "session_id": child.id, "limit": 1}
    with TestClient(_multi_user_app(db_uri)) as client:
        first = client.get("/v1/sessions/search/messages", headers=headers, params=params)
        assert first.status_code == 200
        page = first.json()
        assert len(page["data"]) == 1 and page["next_cursor"]
        payload = json.loads(base64.urlsafe_b64decode(page["next_cursor"] + "=="))
        for index in (3, 5):
            invalid = payload.copy()
            invalid[index] = 10**100
            cursor = base64.urlsafe_b64encode(json.dumps(invalid).encode()).decode().rstrip("=")
            response = client.get(
                "/v1/sessions/search/messages",
                headers=headers,
                params={**params, "cursor": cursor},
            )
            assert response.status_code == 400
        permissions.grant(ALICE, child.id, LEVEL_OWNER)
        permissions.revoke(ALICE, parent_id)
        assert client.get(f"/v1/sessions/{child.id}", headers=headers).status_code == 404
        for cursor in (None, page["next_cursor"]):
            response = client.get(
                "/v1/sessions/search/messages",
                headers=headers,
                params={**params, **({"cursor": cursor} if cursor else {})},
            )
            assert response.status_code == 200
            assert response.json() == {"data": [], "has_more": False, "next_cursor": None}


def test_all_chat_message_search_includes_only_authorized_branches_and_delegates(db_uri) -> None:
    parent_id = _seed_shared_project_session(db_uri)
    store = SqlAlchemyConversationStore(db_uri)
    permissions = SqlAlchemyPermissionStore(db_uri)
    agent_id = store.get_conversation(parent_id).agent_id
    child = store.create_conversation(agent_id=agent_id, parent_conversation_id=parent_id)
    nested = store.create_conversation(agent_id=agent_id, parent_conversation_id=child.id)
    branch = store.fork_conversation(parent_id, title="shared branch")
    hidden_branch = store.fork_conversation(parent_id, title="private branch")
    private = store.create_conversation(title="private root", agent_id=agent_id)
    private_child = store.create_conversation(agent_id=agent_id, parent_conversation_id=private.id)
    for conv in (branch, hidden_branch, private):
        permissions.grant(BOB, conv.id, LEVEL_OWNER)
    for conv in (branch, hidden_branch):
        store.set_labels(conv.id, {SIDE_CHAT_LABEL_KEY: "1"})
    permissions.grant(ALICE, branch.id, LEVEL_READ)
    permissions.grant(ALICE, private_child.id, LEVEL_OWNER)
    for session_id in (
        parent_id,
        child.id,
        nested.id,
        branch.id,
        hidden_branch.id,
        private.id,
        private_child.id,
    ):
        store.append(
            session_id,
            [
                NewConversationItem(
                    type="message",
                    response_id="all-chat-search",
                    data=MessageData(
                        role="user", content=[{"type": "input_text", "text": "needle"}]
                    ),
                )
            ],
        )
    headers = {"X-Forwarded-Email": ALICE}
    params = {"query": "needle", "limit": 1}
    with TestClient(_multi_user_app(db_uri)) as client:
        seen, cursor, first_cursor = set(), None, None
        while True:
            response = client.get(
                "/v1/sessions/search/messages",
                headers=headers,
                params={
                    **params,
                    **({"cursor": cursor} if cursor else {}),
                },
            )
            assert response.status_code == 200, response.text
            page = response.json()
            seen.update(hit["session_id"] for hit in page["data"])
            if not page["has_more"]:
                break
            assert page["next_cursor"] and page["next_cursor"] != cursor
            cursor = page["next_cursor"]
            first_cursor = first_cursor or cursor
        assert seen == {parent_id, child.id, nested.id, branch.id}
        assert first_cursor is not None
        permissions.grant(ALICE, child.id, LEVEL_OWNER)
        permissions.revoke(ALICE, parent_id)
        remaining = client.get("/v1/sessions/search/messages", headers=headers, params=params)
        assert remaining.status_code == 200
        assert {hit["session_id"] for hit in remaining.json()["data"]} == {branch.id}
        permissions.revoke(ALICE, branch.id)
        for cursor in (None, first_cursor):
            response = client.get(
                "/v1/sessions/search/messages",
                headers=headers,
                params={
                    **params,
                    **({"cursor": cursor} if cursor else {}),
                },
            )
            assert response.status_code == 200
            assert response.json() == {"data": [], "has_more": False, "next_cursor": None}


def test_unified_search_title_previews_trusted_filters_and_captured_scope(db_uri, monkeypatch):
    clock = [100]
    monkeypatch.setattr(
        "omnigent.stores.conversation_store.sqlalchemy_store.now_epoch", lambda: clock[0]
    )
    shared_id = _seed_shared_project_session(db_uri)
    store = SqlAlchemyConversationStore(db_uri)
    agent_id = store.get_conversation(shared_id).agent_id
    store.update_conversation(shared_id, title="😀 needle shared")
    private = store.create_conversation(title="needle private", agent_id=agent_id)
    SqlAlchemyPermissionStore(db_uri).grant(BOB, private.id, LEVEL_OWNER)
    store.append(
        private.id,
        [
            NewConversationItem(
                type="message",
                response_id="private",
                data=MessageData(
                    role="user",
                    user_authored=True,
                    content=[{"type": "input_text", "text": "needle private"}],
                ),
            )
        ],
    )
    ids = {}
    for time, label, role, metadata in (
        (200, "legacy", "user", {}),
        (300, "human", "user", {"user_authored": True}),
        (400, "answer", "assistant", {"agent": "Actual actor", "phase": "final_answer"}),
        (500, "progress", "assistant", {"agent": "Actual actor", "phase": "commentary"}),
    ):
        clock[0] = time
        item = NewConversationItem(
            type="message",
            response_id="search",
            created_by=ALICE if role == "user" else None,
            data=MessageData(
                role=role,
                content=[
                    {
                        "type": "input_text" if role == "user" else "output_text",
                        "text": "needle " + label,
                    }
                ],
                **metadata,
            ),
        )
        ids[label] = store.append(shared_id, [item])[0].id
    endpoint = "/v1/sessions/search/messages"
    headers = {"X-Forwarded-Email": ALICE}
    with TestClient(_multi_user_app(db_uri)) as client:
        base = {"query": "needle", "include_titles": True, "limit": 1}
        found, cursor = [], None
        while True:
            response = client.get(
                endpoint,
                headers=headers,
                params={**base, **({"cursor": cursor} if cursor else {})},
            )
            assert response.status_code == 200, response.text
            page = response.json()
            found.extend(page["data"])
            if not page["has_more"]:
                break
            cursor = page["next_cursor"]
        assert [(hit["created_at"], hit["kind"]) for hit in found] == [
            (500, "chat"),
            (500, "message"),
            (400, "message"),
            (300, "message"),
            (200, "message"),
        ]
        title = found[0]
        assert title["session_id"] == shared_id and title["item_id"] == ids["progress"]
        assert title["snippet"] == "needle progress" and title["sender_name"] == "Actual actor"
        assert title["title_ranges"] == [{"start": 3, "end": 9}]
        assert title["ranges"] == [] and title["occurrence_count"] == 0
        for message_filter, expected in (
            ("user", {ids["human"]}),
            ("final", {ids["human"], ids["answer"]}),
        ):
            response = client.get(
                endpoint,
                headers=headers,
                params={"query": "needle", "message_filter": message_filter},
            )
            assert response.status_code == 200
            assert {hit["item_id"] for hit in response.json()["data"]} == expected
        scoped = client.get(
            endpoint, headers=headers, params={**base, "session_id": shared_id, "limit": 100}
        ).json()
        assert scoped["data"] == found
        assert (
            client.get(
                endpoint, headers=headers, params={**base, "session_id": private.id}
            ).json()["data"]
            == []
        )
        first = client.get(endpoint, headers=headers, params=base).json()
        for changed in ({"message_filter": "final"}, {"include_titles": False}):
            response = client.get(
                endpoint,
                headers=headers,
                params={**base, "cursor": first["next_cursor"], **changed},
            )
            assert response.status_code == 400
