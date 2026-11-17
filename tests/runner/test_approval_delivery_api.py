"""Exact receiver protocol through runner and scaffold ASGI boundaries, without models."""

from __future__ import annotations

import asyncio
import hashlib
import json
from types import SimpleNamespace

import httpx
import pytest

from omnigent.runner import create_runner_app, pending_approvals
from omnigent.runtime.harnesses._scaffold import HarnessApp, TurnContext
from omnigent.runtime.harnesses.process_manager import NoLiveHarnessError
from omnigent.server.schemas import ElicitationRequestParams
from tests.runner.conftest import _FakeProcessManager
from tests.runner.helpers import NullServerClient

_BASE = "/v1/sessions/session/approval-deliveries/question"
_ATTEMPT = "a" * 64
_OTHER_ATTEMPT = "b" * 64


@pytest.fixture(params=["runner", "harness"])
async def receiver(request):
    """Use the real Future owners and APIs with an in-memory authenticated transport."""
    pending_approvals.reset_for_tests()
    harness = HarnessApp()
    harness_app = harness.build()
    harness_app.state.conversation_id = "session"
    harness_app.state.harness_auth_token = "spawn-token"
    ctx = TurnContext(
        "response",
        asyncio.Queue(),
        asyncio.Event(),
        session_id="session",
        approval_receipts=harness._approval_receipts,
    )
    harness._in_flight[ctx.response_id] = ctx
    calls: list[tuple[str, str]] = []

    async def capture(outbound: httpx.Request) -> None:
        calls.append((outbound.method, outbound.url.path))

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=harness_app),
        base_url="http://harness",
        headers={"Authorization": "Bearer spawn-token"},
        event_hooks={"request": [capture]},
    ) as harness_client:
        manager = _FakeProcessManager(harness_client)
        app = create_runner_app(
            process_manager=manager,
            server_client=NullServerClient(),
            runner_id="configured-runner",
            auth_token="runner-token",
        )
        if request.param == "runner":
            future = pending_approvals.register("question", conversation_id="session")
            registry = pending_approvals.receipt_registry
        else:
            future = asyncio.create_task(
                ctx.elicit(
                    "question",
                    ElicitationRequestParams(mode="form", message="Answer?"),
                )
            )
            await asyncio.sleep(0)
            registry = harness._approval_receipts
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://runner",
            headers={"Authorization": "Bearer runner-token"},
        ) as client:
            try:
                yield SimpleNamespace(
                    client=client,
                    app=app,
                    future=future,
                    registry=registry,
                    owner=request.param,
                    harness=harness,
                    harness_app=harness_app,
                    ctx=ctx,
                    calls=calls,
                    manager=manager,
                )
            finally:
                future.cancel()
                await asyncio.gather(future, return_exceptions=True)
                pending_approvals.reset_for_tests()


async def _identity(receiver: SimpleNamespace) -> dict[str, object]:
    response = await receiver.client.get(_BASE)
    assert response.status_code == 200, response.text
    identity = response.json()
    assert set(identity) == {
        "protocol_version",
        "session_id",
        "elicitation_id",
        "runner_id",
        "runner_instance_id",
        "owner_kind",
        "owner_instance_id",
        "request_id",
    }
    assert identity["runner_id"] == "configured-runner"
    assert identity["owner_kind"] == receiver.owner
    return {**identity, "attempt_id": _ATTEMPT}


@pytest.mark.parametrize("action", ["accept", "decline", "cancel"])
async def test_exact_action_consumption_query_cleanup_and_durable_release(
    receiver: SimpleNamespace,
    action: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    identity = await _identity(receiver)
    secret = "SYNTHETIC-secret-answer-12"
    body = {
        "identity": identity,
        "result": {"action": action, "content": {"secret": secret}},
    }
    response = await receiver.client.post(f"{_BASE}/{_ATTEMPT}", json=body)
    expected = {**identity, "accepted": True, "action": action}
    assert response.status_code == 200, response.text
    assert response.json() == expected
    verdict = await receiver.future
    if receiver.owner == "runner":
        assert verdict.approved is (action == "accept")
        assert verdict.content == ({"secret": secret} if action == "accept" else None)
        pending_approvals.cleanup("question")
    else:
        assert verdict.action == action
        assert receiver.ctx.cancelled.is_set() is (action == "decline")
    assert not receiver.registry._pending
    encoded = json.dumps(list(receiver.registry._accepted.values()))
    assert secret not in encoded
    assert hashlib.sha256(secret.encode()).hexdigest() not in encoded
    assert "content" not in encoded
    assert secret not in caplog.text
    assert hashlib.sha256(secret.encode()).hexdigest() not in caplog.text

    receipt = await receiver.client.get(
        f"{_BASE}/{_ATTEMPT}", params={"owner_kind": receiver.owner}
    )
    assert receipt.status_code == 200
    assert receipt.json() == expected

    duplicate = await receiver.client.post(f"{_BASE}/{_ATTEMPT}", json=body)
    assert duplicate.status_code == 409
    assert receiver.registry.query("session", "question", _ATTEMPT) == expected

    foreign_identity = {**identity, "request_id": "f" * 64}
    refused_release = await receiver.client.request(
        "DELETE",
        f"{_BASE}/{_ATTEMPT}",
        json={"identity": foreign_identity},
    )
    assert refused_release.status_code == 200
    assert refused_release.json() == {"released": False}
    assert receiver.registry.query("session", "question", _ATTEMPT) == expected

    release = await receiver.client.request(
        "DELETE", f"{_BASE}/{_ATTEMPT}", json={"identity": identity}
    )
    assert release.status_code == 200
    assert release.json() == {"released": True}
    assert receiver.registry.query("session", "question", _ATTEMPT) is None
    missing = await receiver.client.get(
        f"{_BASE}/{_ATTEMPT}", params={"owner_kind": receiver.owner}
    )
    assert missing.status_code == 404


@pytest.mark.parametrize(
    ("field", "replacement"),
    [
        ("session_id", "foreign-session"),
        ("elicitation_id", "foreign-question"),
        ("runner_id", "foreign-runner"),
        ("runner_instance_id", "b" * 64),
        ("owner_instance_id", "b" * 64),
        ("request_id", "b" * 64),
        ("attempt_id", _OTHER_ATTEMPT),
    ],
)
async def test_foreign_binding_never_consumes_future(
    receiver: SimpleNamespace,
    field: str,
    replacement: str,
) -> None:
    identity = await _identity(receiver)
    identity[field] = replacement
    response = await receiver.client.post(
        f"{_BASE}/{_ATTEMPT}",
        json={"identity": identity, "result": {"action": "accept"}},
    )
    assert response.status_code in {400, 409}
    assert not receiver.future.done()
    assert not receiver.registry._accepted


async def test_foreign_owner_never_consumes_future(receiver: SimpleNamespace) -> None:
    identity = await _identity(receiver)
    identity["owner_kind"] = "harness" if receiver.owner == "runner" else "runner"
    response = await receiver.client.post(
        f"{_BASE}/{_ATTEMPT}",
        json={"identity": identity, "result": {"action": "accept"}},
    )
    assert response.status_code in {404, 409}
    assert not receiver.future.done()
    assert not receiver.registry._accepted


async def test_expired_request_and_unknown_attempt_fail_closed(receiver: SimpleNamespace) -> None:
    identity = await _identity(receiver)
    unknown = await receiver.client.get(
        f"{_BASE}/{_ATTEMPT}", params={"owner_kind": receiver.owner}
    )
    assert unknown.status_code == 404

    receiver.future.cancel()
    await asyncio.gather(receiver.future, return_exceptions=True)
    if receiver.owner == "runner":
        pending_approvals.cleanup("question")
    await asyncio.sleep(0)
    expired = await receiver.client.get(_BASE)
    assert expired.status_code == 404
    post = await receiver.client.post(
        f"{_BASE}/{_ATTEMPT}",
        json={"identity": identity, "result": {"action": "accept"}},
    )
    assert post.status_code in {404, 409}
    assert not receiver.registry._accepted


async def test_same_id_new_future_rejects_old_attempt_and_old_request_nonce(
    receiver: SimpleNamespace,
) -> None:
    first_identity = await _identity(receiver)
    accepted = await receiver.client.post(
        f"{_BASE}/{_ATTEMPT}",
        json={"identity": first_identity, "result": {"action": "accept"}},
    )
    assert accepted.status_code == 200
    await receiver.future
    if receiver.owner == "runner":
        pending_approvals.cleanup("question")
        second = pending_approvals.register("question", conversation_id="session")
    else:
        second = asyncio.create_task(
            receiver.ctx.elicit(
                "question",
                ElicitationRequestParams(mode="form", message="Answer again?"),
            )
        )
        await asyncio.sleep(0)

    second_identity = (await receiver.client.get(_BASE)).json() | {"attempt_id": _OTHER_ATTEMPT}
    assert second_identity["request_id"] != first_identity["request_id"]

    duplicate = await receiver.client.post(
        f"{_BASE}/{_ATTEMPT}",
        json={"identity": first_identity, "result": {"action": "decline"}},
    )
    stale_nonce = await receiver.client.post(
        f"{_BASE}/{_OTHER_ATTEMPT}",
        json={
            "identity": {**first_identity, "attempt_id": _OTHER_ATTEMPT},
            "result": {"action": "decline"},
        },
    )
    assert duplicate.status_code == 409
    assert stale_nonce.status_code == 409
    assert not second.done()

    delivered = await receiver.client.post(
        f"{_BASE}/{_OTHER_ATTEMPT}",
        json={"identity": second_identity, "result": {"action": "cancel"}},
    )
    assert delivered.status_code == 200
    await second


async def test_runner_restart_instance_rejects_old_identity() -> None:
    pending_approvals.reset_for_tests()
    future = pending_approvals.register("question", conversation_id="session")
    first_app = create_runner_app(
        process_manager=None,
        server_client=NullServerClient(),
        runner_id="configured-runner",
    )
    second_app = create_runner_app(
        process_manager=None,
        server_client=NullServerClient(),
        runner_id="configured-runner",
    )
    async with (
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=first_app), base_url="http://first"
        ) as first_client,
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=second_app), base_url="http://second"
        ) as second_client,
    ):
        old_identity = (await first_client.get(_BASE)).json() | {"attempt_id": _ATTEMPT}
        current = await second_client.get(_BASE)
        assert current.status_code == 200
        assert current.json()["runner_instance_id"] != old_identity["runner_instance_id"]
        rejected = await second_client.post(
            f"{_BASE}/{_ATTEMPT}",
            json={"identity": old_identity, "result": {"action": "accept"}},
        )
        assert rejected.status_code == 409
        assert not future.done()
    pending_approvals.reset_for_tests()


class _NoLiveManager:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    async def get_client(self, conversation_id: str, harness: str) -> None:
        self.calls.append((conversation_id, harness))
        raise NoLiveHarnessError("missing")


async def test_preflight_never_starts_a_missing_harness() -> None:
    manager = _NoLiveManager()
    app = create_runner_app(
        process_manager=manager,  # type: ignore[arg-type]
        server_client=NullServerClient(),
        runner_id="configured-runner",
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://runner"
    ) as client:
        response = await client.get(_BASE)
    assert response.status_code == 404
    assert manager.calls == [("session", "any")]


class _GenericSuccessClient:
    async def request(self, method: str, url: str, **kwargs: object) -> httpx.Response:
        request = httpx.Request(method, f"http://harness{url}")
        return httpx.Response(204, request=request)


class _GenericSuccessManager:
    async def get_client(self, conversation_id: str, harness: str) -> _GenericSuccessClient:
        assert (conversation_id, harness) == ("session", "any")
        return _GenericSuccessClient()


async def test_generic_2xx_is_never_approval_proof() -> None:
    app = create_runner_app(
        process_manager=_GenericSuccessManager(),  # type: ignore[arg-type]
        server_client=NullServerClient(),
        runner_id="configured-runner",
    )
    identity = {
        "protocol_version": 1,
        "session_id": "session",
        "elicitation_id": "question",
        "runner_id": "configured-runner",
        "runner_instance_id": app.state.approval_runner_instance_id,
        "owner_kind": "harness",
        "owner_instance_id": "c" * 64,
        "request_id": "d" * 64,
        "attempt_id": _ATTEMPT,
    }
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://runner"
    ) as client:
        preflight = await client.get(_BASE)
        post = await client.post(
            f"{_BASE}/{_ATTEMPT}",
            json={"identity": identity, "result": {"action": "accept"}},
        )
    assert preflight.status_code == 502
    assert post.status_code == 502


async def test_runner_api_requires_bearer_and_exposes_explicit_identity() -> None:
    pending_approvals.reset_for_tests()
    pending_approvals.register("question", conversation_id="session")
    app = create_runner_app(
        process_manager=None,
        server_client=NullServerClient(),
        runner_id="explicit-runner",
        auth_token="runner-token",
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://runner"
    ) as client:
        assert (await client.get(_BASE)).status_code == 401
        assert (
            await client.get(_BASE, headers={"Authorization": "Bearer wrong"})
        ).status_code == 401
        response = await client.get(_BASE, headers={"Authorization": "Bearer runner-token"})
    assert response.status_code == 200
    assert response.json()["runner_id"] == "explicit-runner"
    assert response.json()["runner_instance_id"] == app.state.approval_runner_instance_id
    pending_approvals.reset_for_tests()
