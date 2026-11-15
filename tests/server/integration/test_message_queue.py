"""Queued admission is durable, FIFO and independent of browser subscriptions.

SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""

from __future__ import annotations

import asyncio
import json
from typing import Any
from uuid import uuid4

import pytest
import pytest_asyncio

from omnigent.runtime import pending_inputs, session_stream
from omnigent.server.message_queue import QueuedStartupInputs
from omnigent.server.routes._sessions.common import _session_status_cache
from omnigent.server.routes.message_queue import create_message_queue_router
from omnigent.stores.file_store.sqlalchemy_store import SqlAlchemyFileStore
from tests._helpers.polling import poll_until_async
from tests.server.helpers import create_test_agent
from tests.server.integration.test_managed_launch_failure_teardown import _Env
from tests.server.integration.test_managed_launch_failure_teardown import (
    teardown_env as teardown_env,
)
from tests.server.integration.test_managed_startup_inputs import auth_app as auth_app
from tests.server.integration.test_managed_startup_inputs import (
    startup_permissions as startup_permissions,
)
from tests.server.integration.test_sessions_web_send_stable_id import _stub_runner

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def queue_env(teardown_env: _Env, db_uri: str, monkeypatch):
    env = teardown_env

    async def relay_ready(*args, **kwargs):
        pass

    monkeypatch.setattr("omnigent.server.routes.sessions._ensure_runner_relay_ready", relay_ready)
    old = env.app.state.startup_inputs
    startup = QueuedStartupInputs(env.conv_store, env.app.state.host_registry)
    startup.dispatch = old.dispatch
    env.app.state.startup_inputs = startup
    route_count = len(env.app.router.routes)
    env.app.include_router(
        create_message_queue_router(
            startup.message_queue,
            auth_provider=None,
            permission_store=None,
            file_store=SqlAlchemyFileStore(db_uri),
        ),
        prefix="/v1",
    )
    # The SPA fallback is already installed by create_app.
    added = env.app.router.routes[route_count:]
    del env.app.router.routes[route_count:]
    env.app.router.routes[0:0] = added
    try:
        yield env
    finally:
        await startup.shutdown()
        await old.shutdown()
        pending_inputs.reset_for_tests()


def message(text: str, *, stable_id: str | None = None) -> dict[str, Any]:
    stable_id = stable_id or uuid4().hex
    return {
        "queueId": f"q_{stable_id}",
        "stableId": stable_id,
        "text": text,
        "event": {
            "type": "message",
            "data": {
                "role": "user",
                "stable_id": stable_id,
                "content": [{"type": "input_text", "text": text}],
            },
        },
    }


async def session(env: _Env) -> str:
    agent = await create_test_agent(env.client)
    created = await env.client.post("/v1/sessions", json={"agent_id": agent["id"]})
    assert created.status_code == 201, created.text
    session_id = created.json()["id"]
    env.conv_store.set_runner_id(session_id, uuid4().hex)
    _session_status_cache[session_id] = "running"
    return session_id


async def test_fifo_survives_client_close_and_repeated_completion(queue_env: _Env, monkeypatch):
    env = queue_env
    session_id = await session(env)
    path = f"/v1/sessions/{session_id}/queued-messages"
    first, second = message("first queued"), message("second queued")
    for body in (first, second, first):
        result = await env.client.post(path, json=body)
        assert result.status_code == 201, result.text
    queue = env.app.state.startup_inputs.message_queue
    assert len(queue.store.read(session_id)["messages"]) == 2
    forwarded: list[dict[str, Any]] = []
    runner = _stub_runner(monkeypatch, forwarded)
    try:
        await queue.status(env.app, session_id, "running", "turn-one")
        await asyncio.gather(
            *[queue.status(env.app, session_id, "idle", "turn-one") for _ in range(3)]
        )
        await poll_until_async(
            lambda: len([e for e in forwarded if e.get("type") == "message"]) == 1, timeout_s=5
        )
        assert "first queued" in json.dumps(forwarded)
        assert "second queued" not in json.dumps(forwarded)
        await queue.status(env.app, session_id, "idle", "turn-one")
        assert len([e for e in forwarded if e.get("type") == "message"]) == 1
        await queue.status(env.app, session_id, "running", "turn-two")
        await queue.status(env.app, session_id, "idle", "turn-two")
        await poll_until_async(
            lambda: len([e for e in forwarded if e.get("type") == "message"]) == 2, timeout_s=5
        )
        assert "second queued" in json.dumps(forwarded)
    finally:
        await runner.aclose()


async def test_edit_reorder_delete_preserve_identity_and_author(queue_env: _Env):
    env = queue_env
    session_id = await session(env)
    path = f"/v1/sessions/{session_id}/queued-messages"
    first, second = message("first"), message("second")
    for body in (first, second):
        assert (await env.client.post(path, json=body)).status_code == 201
    edited = message("edited\nfull text", stable_id=first["stableId"])
    result = await env.client.patch(f"{path}/{first['queueId']}", json=edited)
    assert result.status_code == 200, result.text
    result = await env.client.post(
        f"{path}/{second['queueId']}/move", json={"beforeQueueId": first["queueId"]}
    )
    assert [m["text"] for m in result.json()["data"]] == ["second", "edited\nfull text"]
    result = await env.client.delete(f"{path}/{second['queueId']}")
    assert [m["stableId"] for m in result.json()["data"]] == [first["stableId"]]
    changed = message("different", stable_id=first["stableId"])
    assert (await env.client.post(path, json=changed)).status_code == 409
    bad = message("fake origin")
    bad["event"]["data"]["communication"] = {"kind": "system"}
    assert (await env.client.post(path, json=bad)).status_code == 400


async def test_scope_failure_and_uncertain_receipt_hold_remaining_queue(
    queue_env: _Env, monkeypatch
):
    env = queue_env
    session_id = await session(env)
    path = f"/v1/sessions/{session_id}/queued-messages"
    first, second = message("first"), message("second")
    for body in (first, second):
        assert (await env.client.post(path, json=body)).status_code == 201
    queue = env.app.state.startup_inputs.message_queue
    env.conv_store.set_host_id(session_id, uuid4().hex, "/changed")
    await queue.status(env.app, session_id, "idle", "first-turn")
    rows = (await env.client.get(path)).json()["data"]
    assert rows[0]["requiresRetry"] and "scope" in rows[0]["deliveryError"]
    assert not env.conv_store.list_pending_inputs(session_id)
    assert (await env.client.post(f"{path}/{first['queueId']}/send")).status_code == 200
    assert "scope" in (await env.client.get(path)).json()["data"][0]["deliveryError"]


async def test_recovery_reuses_native_claim_without_replaying_an_uncertain_input(queue_env: _Env):
    env = queue_env
    session_id = await session(env)
    body = message("uncertain native input")
    path = f"/v1/sessions/{session_id}/queued-messages"
    assert (await env.client.post(path, json=body)).status_code == 201
    startup = env.app.state.startup_inputs
    submitted = asyncio.Event()
    calls = []

    async def uncertain(context, session_id, event):
        if await context.claim(env.conv_store, session_id):
            calls.append(event.data["stable_id"])
            submitted.set()
            raise RuntimeError("transport lost after native submit")
        return {"queued": True}

    startup.dispatch = uncertain
    await startup.message_queue.status(env.app, session_id, "idle", "prior-turn")
    await asyncio.wait_for(submitted.wait(), 5)
    await poll_until_async(lambda: not startup._deliveries, timeout_s=5)
    restarted = QueuedStartupInputs(env.conv_store, startup.hosts)
    restarted.dispatch = uncertain
    restarted.message_queue.authorize = startup.message_queue.authorize
    try:
        await restarted.message_queue.recover(env.app, session_id)
        assert calls == [body["stableId"]]
        row = restarted.message_queue.store.read(session_id)
        assert row["inflight"] == body["stableId"]
        assert (await env.client.post(f"{path}/{body['queueId']}/send")).status_code == 409
    finally:
        await restarted.shutdown()


async def test_server_stream_completion_drives_queue_without_an_http_subscriber(
    queue_env: _Env, monkeypatch
):
    env = queue_env
    session_id = await session(env)
    body = message("server stream follow-up")
    path = f"/v1/sessions/{session_id}/queued-messages"
    assert (await env.client.post(path, json=body)).status_code == 201
    forwarded: list[dict[str, Any]] = []
    runner = _stub_runner(monkeypatch, forwarded)
    try:
        session_stream.publish(
            session_id, {"type": "response.created", "response": {"id": "stream-turn"}}
        )
        session_stream.publish(
            session_id, {"type": "response.in_progress", "response": {"id": "provider-turn"}}
        )
        session_stream.publish(
            session_id, {"type": "response.completed", "response": {"id": "provider-turn"}}
        )
        await poll_until_async(
            lambda: any(e.get("type") == "message" for e in forwarded), timeout_s=5
        )
        assert "server stream follow-up" in json.dumps(forwarded)
    finally:
        await runner.aclose()


async def test_queued_compact_uses_control_dispatch_and_waits_for_compaction_completion(
    queue_env: _Env,
):
    env = queue_env
    session_id = await session(env)
    path = f"/v1/sessions/{session_id}/queued-messages"
    compact, following = message("/compact"), message("after compaction")
    compact["command"] = "compact"
    for body in (compact, following):
        result = await env.client.post(path, json=body)
        assert result.status_code == 201, result.text
    startup = env.app.state.startup_inputs
    controls = []

    async def dispatch(context, session_id, event):
        if event.type == "compact" or await context.claim(env.conv_store, session_id):
            controls.append(event.type)
        return {"queued": False}

    startup.dispatch = dispatch
    await startup.message_queue.status(env.app, session_id, "idle", "before-compact")
    await poll_until_async(lambda: len(controls) == 1 and not startup._deliveries, timeout_s=5)
    assert controls == ["compact"]
    await startup.message_queue.status(env.app, session_id, "idle", "before-compact")
    assert controls == ["compact"]
    saved = env.conv_store.get_item(session_id, compact["stableId"])
    assert saved is not None and saved.type == "slash_command"
    assert saved.data.kind == "command" and saved.data.name == "compact"
    await startup.message_queue.compaction_status(env.app, session_id, "completed")
    await poll_until_async(lambda: controls == ["compact", "message"], timeout_s=5)


async def test_revoked_access_and_failed_turn_require_explicit_review(queue_env: _Env):
    env = queue_env
    session_id = await session(env)
    path = f"/v1/sessions/{session_id}/queued-messages"
    body = message("retained payload")
    assert (await env.client.post(path, json=body)).status_code == 201
    queue = env.app.state.startup_inputs.message_queue

    async def revoked(*args):
        from fastapi import HTTPException

        raise HTTPException(403, "Revoked")

    queue.authorize = revoked
    await queue.status(env.app, session_id, "idle", "completed-turn")
    row = queue.store.read(session_id)["messages"][0]
    assert "permission" in row["error"]
    assert not env.conv_store.list_pending_inputs(session_id)
    await queue.status(env.app, session_id, "failed", "completed-turn")
    assert "Previous turn failed" in queue.store.read(session_id)["messages"][0]["error"]


async def test_offline_queue_recovers_on_competing_replicas_with_one_input_claim(
    queue_env: _Env, monkeypatch
):
    from types import SimpleNamespace

    env = queue_env
    session_id = await session(env)
    host_id = uuid4().hex
    env.conv_store.set_host_id(session_id, host_id, "/original-workspace")
    startup = env.app.state.startup_inputs
    monkeypatch.setattr(startup.hosts, "get", lambda host: None)
    body = message("reconnect once")
    assert (
        await env.client.post(f"/v1/sessions/{session_id}/queued-messages", json=body)
    ).status_code == 201
    await startup.message_queue.status(env.app, session_id, "idle", "finished-before-reconnect")
    assert not env.conv_store.list_pending_inputs(session_id)
    state = startup.message_queue.store.read(session_id)
    assert state["ready"] and state["inflight"] is None
    assert state["messages"][0]["scope"]["workspace"] == "/original-workspace"
    forwarded = []

    async def dispatch(context, target_id, event):
        if await context.claim(env.conv_store, target_id):
            forwarded.append((context.user_id, event.data["stable_id"], event.data["content"]))
        return {"queued": False}

    monkeypatch.setattr(startup.hosts, "get", lambda host: SimpleNamespace(host_id=host_id))
    replica = QueuedStartupInputs(env.conv_store, startup.hosts)
    startup.dispatch = replica.dispatch = dispatch
    replica.message_queue.authorize = startup.message_queue.authorize
    try:
        await asyncio.gather(
            startup.message_queue.recover(env.app, session_id),
            replica.message_queue.recover(env.app, session_id),
        )
        await poll_until_async(
            lambda: len(forwarded) == 1 and not startup._deliveries and not replica._deliveries,
            timeout_s=5,
        )
        assert forwarded == [(None, body["stableId"], body["event"]["data"]["content"])]
        assert env.conv_store.get_item(session_id, body["stableId"]).response_id != "pending_input"
    finally:
        await replica.shutdown()


async def test_two_users_keep_queued_drafts_private_and_cannot_mutate_each_others_queue(
    auth_app,
    auth_client,
    startup_permissions,
):
    from omnigent.server.auth import LEVEL_EDIT, LEVEL_READ

    auth_client.headers["X-Forwarded-Email"] = "alice"
    agent = await create_test_agent(auth_client)
    created = await auth_client.post("/v1/sessions", json={"agent_id": agent["id"]})
    assert created.status_code == 201, created.text
    session_id = created.json()["id"]
    _session_status_cache[session_id] = "running"
    startup_permissions.grant("bob", session_id, LEVEL_READ)
    path = f"/v1/sessions/{session_id}/queued-messages"
    alice = message("alice private queued text")
    accepted = await auth_client.post(path, json=alice)
    assert accepted.status_code == 201, accepted.text
    assert accepted.json()["data"][0]["author"] == "alice"
    assert (await auth_client.get(path, headers={"X-Forwarded-Email": "bob"})).json()["data"] == []
    startup_permissions.grant("bob", session_id, LEVEL_EDIT)
    bob = message("bob private queued text")
    accepted = await auth_client.post(path, json=bob, headers={"X-Forwarded-Email": "bob"})
    assert accepted.status_code == 201, accepted.text
    assert [row["text"] for row in accepted.json()["data"]] == [bob["text"]]
    assert [row["text"] for row in (await auth_client.get(path)).json()["data"]] == [alice["text"]]
    for method, suffix, payload in [
        ("DELETE", "", None),
        ("PATCH", "", alice),
        ("POST", "/send", None),
        ("POST", "/move", {"beforeQueueId": None}),
    ]:
        denied = await auth_client.request(
            method,
            f"{path}/{alice['queueId']}{suffix}",
            json=payload,
            headers={"X-Forwarded-Email": "bob"},
        )
        assert denied.status_code == 403, denied.text
    denied = await auth_client.post(
        f"{path}/{bob['queueId']}/move",
        json={"beforeQueueId": alice["queueId"]},
        headers={"X-Forwarded-Email": "bob"},
    )
    assert denied.status_code == 409, denied.text
    queue = auth_app.state.startup_inputs.message_queue
    startup_permissions.revoke("alice", session_id)
    await queue.status(auth_app, session_id, "idle", "finished-turn")
    saved = queue.store.read(session_id)["messages"]
    assert [row["author"] for row in saved] == ["alice", "bob"]
    assert "permission" in saved[0]["error"]
    assert not auth_app.state.startup_inputs.conversations.list_pending_inputs(session_id)
    await auth_app.state.startup_inputs.shutdown()


async def test_private_queued_files_stay_hidden_until_original_author_dispatches(
    auth_app,
    auth_client,
    startup_permissions,
    db_uri,
    monkeypatch,
):
    from omnigent.server.auth import LEVEL_EDIT
    from omnigent.server.queue_attachments import QUEUE_AUTHOR

    auth_client.headers["X-Forwarded-Email"] = "alice"
    agent = await create_test_agent(auth_client)
    created = await auth_client.post("/v1/sessions", json={"agent_id": agent["id"]})
    assert created.status_code == 201, created.text
    session_id = created.json()["id"]
    startup = auth_app.state.startup_inputs
    startup.conversations.set_runner_id(session_id, uuid4().hex)
    _session_status_cache[session_id] = "running"
    startup_permissions.grant("bob", session_id, LEVEL_EDIT)
    path = f"/v1/sessions/{session_id}"
    upload = await auth_client.post(
        f"{path}/resources/files?presentation=true&private_queue=true",
        files={"file": ("alice-private.txt", b"alice's unsent private bytes", "text/plain")},
    )
    assert upload.status_code == 201, upload.text
    file_id = upload.json()["id"]
    files = SqlAlchemyFileStore(db_uri)
    assert files.get(file_id, session_id).source_metadata[QUEUE_AUTHOR] == "alice"
    for suffix in ("", "/content"):
        denied = await auth_client.get(
            f"{path}/resources/files/{file_id}{suffix}", headers={"X-Forwarded-Email": "bob"}
        )
        assert denied.status_code == 404, denied.text
    denied = await auth_client.delete(
        f"{path}/resources/files/{file_id}", headers={"X-Forwarded-Email": "bob"}
    )
    assert denied.status_code == 404, denied.text
    for suffix in ("/resources/files", "/resources?type=file", "/items"):
        listed = await auth_client.get(path + suffix, headers={"X-Forwarded-Email": "bob"})
        assert listed.status_code == 200, listed.text
        assert file_id not in listed.text and "alice-private.txt" not in listed.text
    owned = await auth_client.get(f"{path}/resources/files/{file_id}/content")
    assert owned.content == b"alice's unsent private bytes"
    assert owned.headers["cache-control"] == "no-store"
    body = message("Alice's private queued follow-up")
    body["event"]["data"]["content"].insert(
        0, {"type": "input_file", "file_id": file_id, "filename": "alice-private.txt"}
    )
    denied = await auth_client.post(
        path + "/queued-messages", json=body, headers={"X-Forwarded-Email": "bob"}
    )
    assert denied.status_code == 404, denied.text
    denied = await auth_client.post(
        path + "/events", json=body["event"], headers={"X-Forwarded-Email": "bob"}
    )
    assert denied.status_code == 404, denied.text
    accepted = await auth_client.post(path + "/queued-messages", json=body)
    assert accepted.status_code == 201, accepted.text
    assert (
        await auth_client.get(path + "/queued-messages", headers={"X-Forwarded-Email": "bob"})
    ).json()["data"] == []
    forwarded = []
    runner = _stub_runner(monkeypatch, forwarded)

    async def ready(*args, **kwargs):
        pass

    monkeypatch.setattr("omnigent.server.routes.sessions._ensure_runner_relay_ready", ready)
    try:
        await startup.message_queue.status(
            auth_app, session_id, "idle", "finished-before-private-send"
        )
        await poll_until_async(
            lambda: any(event.get("type") == "message" for event in forwarded), timeout_s=5
        )
        item = startup.conversations.get_item(session_id, body["stableId"])
        assert item.created_by == "alice"
        assert QUEUE_AUTHOR not in (files.get(file_id, session_id).source_metadata or {})
        public = await auth_client.get(
            f"{path}/resources/files/{file_id}/content", headers={"X-Forwarded-Email": "bob"}
        )
        assert public.status_code == 200 and public.content == b"alice's unsent private bytes"
    finally:
        await runner.aclose()
        await startup.shutdown()


async def test_private_queue_files_do_not_truncate_visible_file_pages(
    auth_client,
    startup_permissions,
    db_uri,
):
    from omnigent.server.auth import LEVEL_READ
    from omnigent.server.queue_attachments import private_queue_metadata

    auth_client.headers["X-Forwarded-Email"] = "alice"
    agent = await create_test_agent(auth_client)
    created = await auth_client.post("/v1/sessions", json={"agent_id": agent["id"]})
    assert created.status_code == 201, created.text
    session_id = created.json()["id"]
    startup_permissions.grant("bob", session_id, LEVEL_READ)
    path = f"/v1/sessions/{session_id}/resources/files"

    files = SqlAlchemyFileStore(db_uri)
    filenames = []
    for index, (filename, private) in enumerate(
        (
            ("secret-before.txt", True),
            ("public-first.txt", False),
            ("secret-between.txt", True),
            ("public-second.txt", False),
            ("secret-after.txt", True),
        ),
        start=1,
    ):
        files.create(
            file_id=f"{index:032x}",
            session_id=session_id,
            filename=filename,
            bytes=len(filename),
            source_metadata=private_queue_metadata(None, "alice") if private else None,
        )
        filenames.append(filename)

    owned = await auth_client.get(path, params={"limit": 10, "order": "asc"})
    assert [item["name"] for item in owned.json()["data"]] == filenames
    assert owned.json()["has_more"] is False

    bob = {"X-Forwarded-Email": "bob"}
    first = await auth_client.get(path, params={"limit": 1, "order": "asc"}, headers=bob)
    assert first.status_code == 200, first.text
    assert [item["name"] for item in first.json()["data"]] == ["public-first.txt"]
    assert first.json()["has_more"] is True

    second = await auth_client.get(
        path,
        params={"limit": 1, "order": "asc", "after": first.json()["last_id"]},
        headers=bob,
    )
    assert [item["name"] for item in second.json()["data"]] == ["public-second.txt"]
    assert second.json()["has_more"] is False

    backward = await auth_client.get(
        path,
        params={"limit": 1, "order": "asc", "before": second.json()["first_id"]},
        headers=bob,
    )
    assert [item["name"] for item in backward.json()["data"]] == ["public-first.txt"]
    assert backward.json()["has_more"] is False
    for response in (first, second, backward):
        assert "secret-" not in response.text
