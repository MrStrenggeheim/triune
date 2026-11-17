# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Real ingestion keeps authorization and mutable scope fresh around metadata reads."""

from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.datastructures import Headers

import omnigent.server.routes.sessions.routes_events as event_routes
import omnigent.server.subagent_activity as activity
from omnigent.db.db_models import workspace_scope
from omnigent.entities import MessageData, NewConversationItem
from omnigent.errors import OmnigentError
from omnigent.runner.transports.ws_tunnel.frames import EventAckFrame, EventBatchFrame
from omnigent.server.auth import LEVEL_OWNER, UnifiedAuthProvider
from omnigent.server.routes.sessions import create_sessions_router
from omnigent.stores.agent_store.sqlalchemy_store import SqlAlchemyAgentStore
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.stores.permission_store.sqlalchemy_store import SqlAlchemyPermissionStore
from tests.server.routes.test_session_event_batches import _assistant_event

OWNER = "native-owner@example.invalid"
SESSION = "e" * 32


@pytest.fixture
def native_ingest_stack(db_uri: str):
    store = SqlAlchemyConversationStore(db_uri)
    agents = SqlAlchemyAgentStore(db_uri)
    permissions = SqlAlchemyPermissionStore(db_uri)
    app = FastAPI()
    registered = []

    @app.middleware("http")
    async def tenant_context(request: Request, call_next):
        with workspace_scope(int(request.headers.get("x-test-workspace", "0"))):
            return await call_next(request)

    @app.exception_handler(OmnigentError)
    async def error(_request: Request, exc: OmnigentError):
        return JSONResponse(status_code=exc.http_status, content={"code": exc.code})

    app.include_router(
        create_sessions_router(
            conversation_store=store,
            agent_store=agents,
            permission_store=permissions,
            auth_provider=UnifiedAuthProvider(source="header"),
            register_runner_ingest=registered.append,
        ),
        prefix="/v1",
    )

    def seed(tenant: int, owner: str = OWNER):
        with workspace_scope(tenant):
            agents.create("a" * 32, name="synthetic", bundle_location="synthetic/missing")
            permissions.ensure_user(owner)
            conv = store.create_conversation(
                conversation_id=SESSION,
                title="synthetic",
                agent_id="a" * 32,
                workspace=f"/native/{tenant}",
                runner_id="runner-a",
            )
            permissions.grant(owner, conv.id, LEVEL_OWNER)
            store.set_session_state(conv.id, {"policy": "x" * 32768})
        return conv

    return app, store, permissions, registered[0], seed


@pytest.mark.parametrize("tenant", [0, 87])
async def test_native_http_refreshes_scope_and_rechecks_acl(native_ingest_stack, tenant):
    app, store, permissions, _ingest, seed = native_ingest_stack
    other = 87 if tenant == 0 else 0
    seed(tenant)
    seed(other, "private-owner@example.invalid")
    headers = {"X-Forwarded-Email": OWNER, "x-test-workspace": str(tenant)}
    url = f"/v1/sessions/{SESSION}/events"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://synthetic", headers=headers
    ) as client:
        first = await client.post(url, json=_assistant_event(source_id="first"))
        assert first.status_code == 202
        with workspace_scope(tenant):
            await asyncio.to_thread(store.clear_runner_id, SESSION)
            assert await asyncio.to_thread(store.set_runner_id, SESSION, "runner-b")
            await asyncio.to_thread(store.set_host_id, SESSION, None, "/native/changed")
        second = await client.post(url, json=_assistant_event(source_id="second"))
        assert second.status_code == 202
        with workspace_scope(tenant):
            items = store.list_items(SESSION).data
            assert [item.data.resource_scope["runner_id"] for item in items] == [
                "runner-a",
                "runner-b",
            ]
            assert [item.data.resource_scope["workspace"] for item in items] == [
                f"/native/{tenant}",
                "/native/changed",
            ]
            assert await asyncio.to_thread(permissions.revoke, OWNER, SESSION)
        forbidden = await client.post(url, json=_assistant_event(source_id="revoked"))
        assert forbidden.status_code == 404
        foreign = await client.post(
            url,
            headers={"x-test-workspace": str(other)},
            json=_assistant_event(source_id="foreign"),
        )
        assert foreign.status_code == 404
        with workspace_scope(tenant):
            assert len(store.list_items(SESSION).data) == 2
        with workspace_scope(other):
            assert store.list_items(SESSION).data == []


@pytest.mark.parametrize("tenant", [0, 87])
async def test_runner_batch_revalidates_binding_after_await(
    native_ingest_stack, monkeypatch: pytest.MonkeyPatch, tenant
):
    app, store, _permissions, ingest, seed = native_ingest_stack
    seed(tenant)
    persist = event_routes._persist_external_conversation_item

    async def rebind_after_commit(*args, **kwargs):
        item_id = await persist(*args, **kwargs)
        await asyncio.to_thread(store.clear_runner_id, SESSION)
        assert await asyncio.to_thread(store.set_runner_id, SESSION, "runner-b")
        await asyncio.to_thread(store.set_session_live_status, SESSION, "failed")
        return item_id

    monkeypatch.setattr(event_routes, "_persist_external_conversation_item", rebind_after_commit)
    batch = EventBatchFrame(
        id="binding-change",
        session_id=SESSION,
        events=[_assistant_event(source_id="first"), _assistant_event(source_id="superseded")],
    )
    with workspace_scope(tenant):
        ack = await ingest(
            app=app, headers=Headers({}), owner=None, runner_id="runner-a", batch=batch
        )
        assert ack == EventAckFrame(batch.id, len(batch.events))
        items = store.list_items(SESSION).data
        assert len(items) == 1
        assert items[0].data.resource_scope["runner_id"] == "runner-a"
        current = store.get_conversation(SESSION)
        assert current.runner_id == "runner-b"
        assert current.live_status == "failed"


async def test_return_lookup_reloads_lifecycle_labels_after_await(
    native_ingest_stack, monkeypatch: pytest.MonkeyPatch
):
    _app, store, _permissions, _ingest, seed = native_ingest_stack
    seed(87)
    seed(0, "private-owner@example.invalid")
    child_id = "f" * 32
    for tenant in (0, 87):
        with workspace_scope(tenant):
            store.create_conversation(conversation_id=child_id, parent_conversation_id=SESSION)
            store.set_labels(child_id, {"omnigent.subagent.dispatch_id": f"old-{tenant}"})
    entered, release = asyncio.Event(), asyncio.Event()
    original_to_thread = asyncio.to_thread
    observed = []

    async def gated_to_thread(function, *args, **kwargs):
        if function is activity._read_return_conversation:
            entered.set()
            await asyncio.wait_for(release.wait(), timeout=2)
        return await original_to_thread(function, *args, **kwargs)

    def prior(_store, parent_id, actual_child, turn, dispatch):
        observed.append((parent_id, actual_child, turn, dispatch))
        return

    monkeypatch.setattr(asyncio, "to_thread", gated_to_thread)
    monkeypatch.setattr(activity, "_returned_activity", prior)
    item = NewConversationItem(
        type="message",
        response_id="turn",
        data=MessageData(
            role="assistant",
            agent="synthetic",
            content=[{"type": "output_text", "text": "synthetic"}],
        ),
    )
    with workspace_scope(87):
        task = asyncio.create_task(activity.record_claude_subagent_return(child_id, item, store))
        await asyncio.wait_for(entered.wait(), timeout=2)
        await original_to_thread(
            store.set_labels, child_id, {"omnigent.subagent.dispatch_id": "new-87"}
        )
        release.set()
        await asyncio.wait_for(task, timeout=2)
    assert observed == [(SESSION, child_id, "turn", "new-87")]
