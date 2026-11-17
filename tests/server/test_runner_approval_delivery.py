"""Durable server journal against actual authenticated runner/scaffold APIs.

SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse

from omnigent.errors import OmnigentError
from omnigent.runner import create_runner_app, pending_approvals
from omnigent.runner.routing import RunnerRouter
from omnigent.runtime import pending_elicitations, session_stream
from omnigent.runtime.harnesses._scaffold import HarnessApp, TurnContext
from omnigent.server.approval_deliveries import ApprovalDeliveries, held_event
from omnigent.server.auth import LEVEL_EDIT, LEVEL_OWNER, LEVEL_READ, UnifiedAuthProvider
from omnigent.server.routes._question_receipts import build_question_receipt_payload
from omnigent.server.routes._sessions import helpers, orchestration
from omnigent.server.routes.sessions.routes_elicitations import register_elicitations_routes
from omnigent.server.schemas import ElicitationRequestParams, ElicitationResult
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.stores.permission_store.sqlalchemy_store import SqlAlchemyPermissionStore
from tests.runner.conftest import _FakeProcessManager
from tests.runner.helpers import NullServerClient


class _FaultTransport(httpx.AsyncBaseTransport):
    """Inject faults at the real HTTP receiver boundary without replacing its API."""

    def __init__(self, app):
        self.inner = httpx.ASGITransport(app=app)
        self.mode = "normal"
        self.calls = []
        self.last_body = None
        self.receipt_override = None
        self.entered = asyncio.Event()
        self.unblock = asyncio.Event()

    async def handle_async_request(self, request):
        self.calls.append((request.method, request.url.path))
        if request.method == "POST":
            self.last_body = json.loads(request.content)
            self.entered.set()
            if self.mode == "before":
                raise httpx.ConnectError("Synthetic failure before receiver", request=request)
            if self.mode == "cancel":
                await self.unblock.wait()
            if self.mode == "generic":
                return httpx.Response(200, json={"queued": False})
        if request.method == "DELETE" and self.mode == "release500":
            return httpx.Response(500, json={"released": False})
        response = await self.inner.handle_async_request(request)
        if request.method == "POST" and self.mode == "after":
            await response.aread()
            raise httpx.ReadError("Synthetic lost receipt reply", request=request)
        if request.method == "GET" and self.receipt_override and "/question/" in request.url.path:
            await response.aread()
            return httpx.Response(200, json=self.receipt_override)
        return response


def _server_app(store, router, permissions):
    app = FastAPI()

    @app.exception_handler(OmnigentError)
    async def error(_request: Request, exc: OmnigentError):
        return JSONResponse(
            {"code": str(exc.code), "message": str(exc)}, status_code=exc.http_status
        )

    routes = APIRouter(prefix="/v1")
    register_elicitations_routes(
        routes,
        conversation_store=store,
        agent_store=Mock(),
        runner_router=router,
        permission_store=permissions,
        auth_provider=UnifiedAuthProvider(source="header", local_single_user=False),
    )
    app.include_router(routes)
    return app


@pytest.fixture(params=["runner", "harness"])
async def boundary(request, db_uri, monkeypatch):
    """Real SQLite journal, routing, ACL, Future owners and authenticated HTTP APIs."""
    pending_approvals.reset_for_tests()
    monkeypatch.setattr(pending_elicitations, "_count_persist_hook", None)
    monkeypatch.setattr(pending_elicitations, "_observer", None)
    store = SqlAlchemyConversationStore(db_uri)
    parent = store.create_conversation()
    conversation = store.create_conversation(
        runner_id="configured-runner", parent_conversation_id=parent.id, title="child"
    )
    sid = conversation.id
    permissions = SqlAlchemyPermissionStore(db_uri)
    for user, level in [("owner", LEVEL_OWNER), ("editor", LEVEL_EDIT), ("reader", LEVEL_READ)]:
        permissions.grant(user, parent.id, level)
    params = {
        "message": "Synthetic exact question",
        "thread_id": "original-thread",
        "turn_id": "original-turn",
        "item_id": "original-item",
        "codex_request_id": 17,
        "ask_user_question": {
            "questions": [
                {
                    "id": "secret",
                    "header": "Auth",
                    "question": "Token?",
                    "isSecret": True,
                    "textInput": {"default": "SYNTHETIC-secret-default"},
                }
            ]
        },
        "content_preview": {"token": "SYNTHETIC-secret-default"},
    }
    event = {
        "type": "response.elicitation_request",
        "elicitation_id": "question",
        "params": params,
    }
    session_stream.publish(sid, event)
    harness = HarnessApp()
    harness_app = harness.build()
    harness_app.state.conversation_id = sid
    harness_app.state.harness_auth_token = "spawn-token"
    ctx = TurnContext(
        "response",
        asyncio.Queue(),
        asyncio.Event(),
        session_id=sid,
        approval_receipts=harness._approval_receipts,
    )
    harness._in_flight[ctx.response_id] = ctx
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=harness_app),
        base_url="http://harness",
        headers={"Authorization": "Bearer spawn-token"},
    ) as harness_client:
        manager = _FakeProcessManager(harness_client)
        runner_app = create_runner_app(
            process_manager=manager,
            server_client=NullServerClient(),
            runner_id="configured-runner",
            auth_token="runner-token",
        )
        if request.param == "runner":
            future = pending_approvals.register("question", conversation_id=sid)
            registry = pending_approvals.receipt_registry
        else:
            future = asyncio.create_task(
                ctx.elicit("question", ElicitationRequestParams(mode="form", message="Token?"))
            )
            await asyncio.sleep(0)
            registry = harness._approval_receipts
        transport = _FaultTransport(runner_app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://runner",
            headers={"Authorization": "Bearer runner-token"},
        ) as runner_client:
            router = RunnerRouter(registry=Mock(), conversation_store=store)
            router._clients["configured-runner"] = runner_client
            service = ApprovalDeliveries(store, router)
            app = _server_app(store, router, permissions)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://server",
                headers={"X-Forwarded-Email": "owner"},
            ) as client:
                try:
                    yield SimpleNamespace(
                        store=store,
                        sid=sid,
                        parent=parent,
                        params=params,
                        event=event,
                        service=service,
                        router=router,
                        transport=transport,
                        future=future,
                        registry=registry,
                        owner=request.param,
                        client=client,
                        path=f"/v1/sessions/{sid}/elicitations/question",
                        permissions=permissions,
                        manager=manager,
                        runner_app=runner_app,
                        harness=harness,
                        ctx=ctx,
                    )
                finally:
                    future.cancel()
                    await asyncio.gather(future, return_exceptions=True)
                    pending_approvals.reset_for_tests()


def _posts(boundary):
    return [call for call in boundary.transport.calls if call[0] == "POST"]


async def _restart_server(boundary):
    pending_elicitations.reset_for_tests()
    service = ApprovalDeliveries(
        SqlAlchemyConversationStore(boundary.store.storage_location), boundary.router
    )
    await service.restore_all()
    return service


async def test_exact_ack_secret_receipt_ids_and_action(boundary, caplog):
    b = boundary
    secret = "SYNTHETIC-answer-only-in-transient-wire"
    result = {"action": "accept", "content": {"secret": secret}}
    expected = build_question_receipt_payload(b.sid, "question", b.params, result)
    response = await b.client.post(b.path + "/resolve", json=result)
    assert response.status_code == 202, response.text
    verdict = await b.future
    assert verdict.approved if b.owner == "runner" else verdict.action == "accept"
    assert verdict.content == result["content"]
    assert b.transport.last_body["result"]["_meta"]["question_submission"] == {
        **expected["source"],
        "session_id": b.sid,
        "elicitation_id": "question",
        "submission_id": expected["submission_id"],
    }
    row = b.service.store.read(b.sid, "question")
    assert row["state"] == "accepted"
    items = b.store.list_items(b.sid).data
    assert len(items) == 1
    assert items[0].data.resource == expected
    assert items[0].id == hashlib.sha256(expected["submission_id"].encode()).hexdigest()[:32]
    assert items[0].data.resource["questions"] == [
        {
            "id": "secret",
            "header": "Auth",
            "question": "Token?",
            "answered": True,
            "redacted": True,
        }
    ]
    encoded = json.dumps(row) + json.dumps(items[0].to_api_dict()) + caplog.text
    assert secret not in encoded and hashlib.sha256(secret.encode()).hexdigest() not in encoded
    assert "SYNTHETIC-secret-default" not in json.dumps(row)
    assert pending_elicitations.count_for(b.sid) == 0
    assert not b.registry._accepted
    assert len(_posts(b)) == 1
    again = await b.client.post(b.path + "/resolve", json=result)
    assert again.status_code == 202
    assert len(_posts(b)) == 1 and len(b.store.list_items(b.sid).data) == 1


async def test_lost_ack_server_restart_queries_exact_receipt_without_replay(boundary):
    b = boundary
    b.transport.mode = "after"
    response = await b.client.post(b.path + "/resolve", json={"action": "decline"})
    assert response.status_code == 503, response.text
    await b.future
    row = b.service.store.read(b.sid, "question")
    assert row["state"] == "held" and not b.store.list_items(b.sid).data
    assert (
        pending_elicitations.held_runner_attempt(b.sid, "question")
        == row["identity"]["attempt_id"]
    )
    # Ordinary runner resolution and duplicate request cannot clear the durable hold.
    session_stream.publish(
        b.sid, {"type": "response.elicitation_resolved", "elicitation_id": "question"}
    )
    session_stream.publish(b.sid, b.event)
    assert (
        pending_elicitations.held_runner_attempt(b.sid, "question")
        == row["identity"]["attempt_id"]
    )
    b.transport.mode = "normal"
    fresh = await _restart_server(b)
    assert pending_elicitations.count_for(b.sid) == 1
    await fresh.reconcile(b.sid, "question", fresh.store.read(b.sid, "question"))
    assert fresh.store.read(b.sid, "question")["state"] == "accepted"
    assert len(_posts(b)) == 1
    assert pending_elicitations.count_for(b.sid) == 0
    assert len(b.store.list_items(b.sid).data) == 1
    receipt_path = (
        f"/v1/sessions/{b.sid}/approval-deliveries/question/{row['identity']['attempt_id']}"
    )
    assert ("GET", receipt_path) in b.transport.calls


@pytest.mark.parametrize("mode", ["before", "generic", "cancel", "receiver_restart"])
async def test_unknown_delivery_survives_restart_and_exact_retry_never_posts(boundary, mode):
    b = boundary
    b.transport.mode = "after" if mode == "receiver_restart" else mode
    task = asyncio.create_task(b.client.post(b.path + "/resolve", json={"action": "decline"}))
    if mode == "cancel":
        await asyncio.wait_for(b.transport.entered.wait(), 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    else:
        response = await task
        assert response.status_code == 503, response.text
    if mode == "receiver_restart":
        await b.future
        b.registry._accepted.clear()  # New receiver process has no consumption receipt.
    else:
        assert not b.future.done()
    original = b.service.store.read(b.sid, "question")
    b.transport.mode = "normal"
    fresh = await _restart_server(b)
    assert pending_elicitations.count_for(b.sid) == 1
    with pytest.raises(OmnigentError):
        await fresh.resolve(b.sid, "question", b.event, ElicitationResult(action="decline"))
    assert len(_posts(b)) == 1
    assert fresh.store.read(b.sid, "question") == original
    get = await b.client.get(b.path)
    assert get.status_code == 200 and get.json()["status"] == "pending"
    assert get.json()["delivery_state"] == "unconfirmed"
    assert len(_posts(b)) == 1 and not b.store.list_items(b.sid).data
    # Durable count cannot be lowered by another replica's empty in-memory index.
    b.store.set_pending_elicitation_count(b.sid, 0)
    assert b.store.get_conversation(b.sid).pending_elicitation_count == 1
    b.store.set_pending_elicitation_count(b.parent.id, 0)
    assert b.store.get_conversation(b.parent.id).pending_elicitation_count == 1


@pytest.mark.parametrize(
    "field",
    [
        "runner_id",
        "owner_kind",
        "runner_instance_id",
        "request_id",
        "owner_instance_id",
        "attempt_id",
        "session_id",
        "elicitation_id",
        "action",
        "accepted",
    ],
)
async def test_untrusted_or_mismatched_receipt_never_clears_held_card(boundary, field):
    b = boundary
    b.transport.mode = "after"
    assert (
        await b.client.post(b.path + "/resolve", json={"action": "decline"})
    ).status_code == 503
    await b.future
    original = b.service.store.read(b.sid, "question")
    identity = original["identity"]
    b.transport.mode = "normal"
    b.transport.receipt_override = {**identity, "accepted": True, "action": "decline"}
    b.transport.receipt_override[field] = False if field == "accepted" else "foreign"
    fresh = await _restart_server(b)
    with pytest.raises(OmnigentError):
        await fresh.reconcile(b.sid, "question", original)
    assert fresh.store.read(b.sid, "question")["state"] == "held"
    assert pending_elicitations.count_for(b.sid) == 1 and len(_posts(b)) == 1


async def test_acl_and_changed_runner_binding_cannot_deliver_or_clear(boundary):
    b = boundary
    for user in ["reader", "stranger"]:
        before = list(b.transport.calls)
        response = await b.client.post(
            b.path + "/resolve", json={"action": "decline"}, headers={"X-Forwarded-Email": user}
        )
        assert response.status_code in {403, 404}
        assert (await b.client.get(b.path, headers={"X-Forwarded-Email": user})).status_code in {
            403,
            404,
        }
        assert b.transport.calls == before and not b.future.done()
    b.transport.mode = "before"
    assert (
        await b.client.post(
            b.path + "/resolve",
            json={"action": "decline"},
            headers={"X-Forwarded-Email": "editor"},
        )
    ).status_code == 503
    original = b.service.store.read(b.sid, "question")
    b.store.clear_runner_id(b.sid)
    assert b.store.set_runner_id(b.sid, "foreign-runner")
    before = list(b.transport.calls)
    fresh = await _restart_server(b)
    with pytest.raises(OmnigentError):
        await fresh.reconcile(b.sid, "question", original)
    assert b.transport.calls == before and not b.future.done()
    assert fresh.store.read(b.sid, "question")["state"] == "held"


async def test_expired_exact_id_generic_route_success_cannot_clear_card(boundary):
    b = boundary
    b.future.cancel()
    await asyncio.gather(b.future, return_exceptions=True)
    if b.owner == "runner":
        pending_approvals.cleanup("question")
    response = await b.client.post(b.path + "/resolve", json={"action": "decline"})
    assert response.status_code == 503, response.text
    assert not _posts(b)
    assert b.service.store.read(b.sid, "question") is None
    assert pending_elicitations.count_for(b.sid) == 1


@pytest.mark.parametrize("failure", ["missing", "http500", "disconnect"])
async def test_local_future_delivery_succeeds_when_runner_is_unavailable(failure, monkeypatch):
    session_id, elicitation_id = "local-session", "exact-local-approval"
    future = asyncio.get_running_loop().create_future()
    monkeypatch.setitem(orchestration._harness_elicitation_registry, elicitation_id, future)
    monkeypatch.setitem(orchestration._harness_elicitation_owners, elicitation_id, session_id)
    runner = AsyncMock()
    runner.post.return_value = httpx.Response(500)
    if failure == "disconnect":
        runner.post.side_effect = httpx.ConnectError("Synthetic runner disconnect")
    monkeypatch.setattr(
        helpers,
        "_get_runner_client",
        AsyncMock(return_value=None if failure == "missing" else runner),
    )
    try:
        await orchestration._resolve_elicitation(
            session_id, {"elicitation_id": elicitation_id, "action": "decline"}, object()
        )
        assert future.result() == ElicitationResult(action="decline")
    finally:
        orchestration._harness_pre_resolved_elicitations.pop(elicitation_id, None)


async def test_unknown_verdict_is_not_forwarded_or_saved_for_a_future_waiter(monkeypatch):
    forward = AsyncMock()
    monkeypatch.setattr(orchestration, "_forward_approval_to_runner", forward)
    await orchestration._resolve_elicitation(
        "unknown-session", {"elicitation_id": "unknown-question", "action": "decline"}, object()
    )
    forward.assert_not_called()
    assert orchestration._harness_pre_resolved_elicitations.get("unknown-question") is None


async def test_snapshot_releases_only_exact_durable_accepted_cached_hold(boundary):
    b = boundary
    b.transport.mode = "after"
    assert (
        await b.client.post(b.path + "/resolve", json={"action": "decline"})
    ).status_code == 503
    await b.future
    held = b.service.store.read(b.sid, "question")
    b.transport.mode = "normal"
    await b.service.reconcile(b.sid, "question", held)
    # A second replica retained these markers while another accepted the receipt.
    pending_elicitations.record_publish(b.sid, held_event(held))
    pending_elicitations.record_publish(
        b.parent.id, helpers._targeted_elicitation_event(held_event(held), target_session_id=b.sid)
    )
    assert helpers._pending_elicitation_snapshot_for_session(b.store, b.parent) == []
    assert (
        helpers._pending_elicitation_snapshot_for_session(b.store, b.store.get_conversation(b.sid))
        == []
    )
    # A later request reusing the opaque elicitation ID is not the accepted attempt.
    pending_elicitations.record_publish(b.sid, b.event)
    snapshot = helpers._pending_elicitation_snapshot_for_session(
        b.store, b.store.get_conversation(b.sid)
    )
    assert snapshot == [b.event]


async def test_release_failure_is_visible_and_retry_never_replays_answer(boundary, caplog):
    b = boundary
    b.transport.mode = "release500"
    response = await b.client.post(b.path + "/resolve", json={"action": "decline"})
    assert response.status_code == 202
    await b.future
    assert b.service.store.read(b.sid, "question")["state"] == "accepted"
    assert b.registry._accepted
    assert "Approval receipt release is pending" in caplog.text
    b.transport.mode = "normal"
    fresh = await _restart_server(b)
    await fresh.reconcile(b.sid, "question", fresh.store.read(b.sid, "question"))
    assert not b.registry._accepted and len(_posts(b)) == 1


async def test_concurrent_opposite_reservation_conflicts_before_policy_writes(
    boundary, monkeypatch
):
    b = boundary
    b.transport.mode = "release500"  # Keep the winning accepted receipt available to the loser.
    loser = ApprovalDeliveries(b.store, b.router)
    ready, winner_done = threading.Event(), threading.Event()
    reserve = loser.store.reserve

    def delayed_reserve(*args, **kwargs):
        ready.set()
        assert winner_done.wait(5)
        return reserve(*args, **kwargs)

    monkeypatch.setattr(loser.store, "reserve", delayed_reserve)
    task = asyncio.create_task(
        loser.resolve(b.sid, "question", b.event, ElicitationResult(action="decline"))
    )
    try:
        assert await asyncio.to_thread(ready.wait, 5)
        await b.service.resolve(b.sid, "question", b.event, ElicitationResult(action="accept"))
        winner_done.set()
        with pytest.raises(OmnigentError) as error:
            await task
        assert error.value.code == "conflict"
        assert len(_posts(b)) == 1
        assert b.service.store.read(b.sid, "question")["action"] == "accept"
    finally:
        winner_done.set()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_crash_after_acceptance_cannot_leave_durable_count_held(boundary, monkeypatch):
    b = boundary
    resolve = pending_elicitations.resolve

    def crash_after_accept(*_args):
        raise RuntimeError("Synthetic crash after durable acceptance")

    with monkeypatch.context() as crash:
        crash.setattr(pending_elicitations, "resolve", crash_after_accept)
        with pytest.raises(RuntimeError, match="Synthetic crash"):
            await b.service.resolve(
                b.sid, "question", b.event, ElicitationResult(action="decline")
            )
    await b.future
    assert b.service.store.read(b.sid, "question")["state"] == "accepted"
    assert b.store.get_conversation(b.sid).pending_elicitation_count == 0
    assert b.store.get_conversation(b.parent.id).pending_elicitation_count == 0
    assert b.registry._accepted
    fresh = await _restart_server(b)
    await fresh.retry_releases_once()
    assert not b.registry._accepted and len(_posts(b)) == 1
    assert b.service.store.read(b.sid, "question")["released"] is True
    resolve(b.sid, "question")


async def test_stale_count_writes_prune_only_matching_accepted_attempt(boundary):
    b = boundary
    b.transport.mode = "after"
    assert (
        await b.client.post(b.path + "/resolve", json={"action": "decline"})
    ).status_code == 503
    await b.future
    record = b.service.store.read(b.sid, "question")
    exact = [(b.sid, "question", record["identity"]["attempt_id"])]
    b.transport.mode = "normal"
    await b.service.reconcile(b.sid, "question", record)
    # The queued count contained one journal hold and one unrelated local/native wait.
    for visible in [b.sid, b.parent.id]:
        b.store.set_pending_elicitation_count(visible, 2, approval_attempts=exact)
        assert b.store.get_conversation(visible).pending_elicitation_count == 1
        b.store.set_pending_elicitation_count(
            visible, 2, approval_attempts=[(b.sid, "question", "f" * 64)]
        )
        assert b.store.get_conversation(visible).pending_elicitation_count == 2


async def test_lost_delete_reply_recovers_durable_release_progress(boundary, monkeypatch):
    b = boundary
    mark = b.service.store.mark_released

    def crash_before_mark(*_args):
        raise RuntimeError("Synthetic crash after DELETE before release commit")

    with monkeypatch.context() as crash:
        crash.setattr(b.service.store, "mark_released", crash_before_mark)
        with pytest.raises(RuntimeError, match="after DELETE"):
            await b.service.resolve(
                b.sid, "question", b.event, ElicitationResult(action="decline")
            )
    await b.future
    assert not b.registry._accepted
    record = b.service.store.read(b.sid, "question")
    assert record["state"] == "accepted" and record["released"] is False
    fresh = await _restart_server(b)
    await fresh.retry_releases_once()
    assert fresh.store.read(b.sid, "question")["released"] is True
    assert len(_posts(b)) == 1
    assert mark(b.sid, "question", record["identity"]) is True


async def test_release_loop_has_backoff_and_propagates_shutdown_cancellation(monkeypatch):
    service = object.__new__(ApprovalDeliveries)
    retry = AsyncMock(return_value=(0, "session", "question"))
    monkeypatch.setattr(service, "retry_releases_once", retry)
    sleep = AsyncMock(side_effect=asyncio.CancelledError)
    monkeypatch.setattr(asyncio, "sleep", sleep)
    with pytest.raises(asyncio.CancelledError):
        await service.release_loop()
    retry.assert_awaited_once_with(None)
    sleep.assert_awaited_once_with(15)


@pytest.mark.parametrize("changed", ["binding", "runner_instance", "request_nonce"])
async def test_identity_change_after_reservation_cannot_consume_or_replay(
    boundary, changed, monkeypatch
):
    b = boundary
    reserve = b.service.store.reserve

    def reserve_then_replace(*args, **kwargs):
        record, created = reserve(*args, **kwargs)
        assert created
        if changed == "binding":
            b.store.replace_runner_id(
                b.sid, "foreign-runner", expected_runner_id="configured-runner"
            )
        elif changed == "runner_instance":
            replacement = create_runner_app(
                process_manager=b.manager,
                server_client=NullServerClient(),
                runner_id="configured-runner",
                auth_token="runner-token",
            )
            b.transport.inner = httpx.ASGITransport(app=replacement)
        else:
            _nonce, pending, resolve = b.registry._pending[(b.sid, "question")]
            b.registry._pending[(b.sid, "question")] = ("f" * 64, pending, resolve)
        return record, created

    monkeypatch.setattr(b.service.store, "reserve", reserve_then_replace)
    with pytest.raises(OmnigentError):
        await b.service.resolve(b.sid, "question", b.event, ElicitationResult(action="decline"))
    assert not b.future.done()
    original = b.service.store.read(b.sid, "question")
    assert original["state"] == "held"
    posts = len(_posts(b))
    fresh = await _restart_server(b)
    with pytest.raises(OmnigentError):
        await fresh.reconcile(b.sid, "question", original)
    assert fresh.store.read(b.sid, "question") == original
    assert len(_posts(b)) == posts and not b.future.done()
