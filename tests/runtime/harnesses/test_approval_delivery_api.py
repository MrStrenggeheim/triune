"""Harness-owner approval receipts retain per-spawn and conversation guards."""

from __future__ import annotations

import asyncio

import httpx

from omnigent.runtime.approval_receipts import RUNNER_ID_HEADER, RUNNER_INSTANCE_HEADER
from omnigent.runtime.harnesses._scaffold import HarnessApp, TurnContext
from omnigent.server.schemas import ElicitationRequestParams

_BASE = "/v1/sessions/session/approval-deliveries/question"
_ATTEMPT = "a" * 64
_RUNNER_HEADERS = {
    RUNNER_ID_HEADER: "configured-runner",
    RUNNER_INSTANCE_HEADER: "b" * 64,
}


async def _pending_harness() -> tuple[HarnessApp, object, asyncio.Task[object], TurnContext]:
    harness = HarnessApp()
    app = harness.build()
    app.state.conversation_id = "session"
    app.state.harness_auth_token = "spawn-token"
    context = TurnContext(
        "response",
        asyncio.Queue(),
        asyncio.Event(),
        session_id="session",
        approval_receipts=harness._approval_receipts,
    )
    harness._in_flight[context.response_id] = context
    future = asyncio.create_task(
        context.elicit(
            "question",
            ElicitationRequestParams(mode="form", message="Answer?"),
        )
    )
    await asyncio.sleep(0)
    return harness, app, future, context


async def test_scaffold_requires_spawn_bearer_and_exact_conversation() -> None:
    harness, app, future, _context = await _pending_harness()
    del harness
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://harness"
    ) as client:
        assert (await client.get(_BASE, headers=_RUNNER_HEADERS)).status_code == 401
        wrong_token = {
            **_RUNNER_HEADERS,
            "Authorization": "Bearer wrong",
        }
        assert (await client.get(_BASE, headers=wrong_token)).status_code == 401
        headers = {
            **_RUNNER_HEADERS,
            "Authorization": "Bearer spawn-token",
        }
        foreign = await client.get(
            "/v1/sessions/foreign/approval-deliveries/question",
            headers=headers,
        )
        assert foreign.status_code == 404
        exact = await client.get(_BASE, headers=headers)
        assert exact.status_code == 200
        assert exact.json()["owner_kind"] == "harness"
    future.cancel()
    await asyncio.gather(future, return_exceptions=True)


async def test_scaffold_runner_binding_and_restart_instance_fail_closed() -> None:
    first_harness, first_app, first_future, _first_context = await _pending_harness()
    second_harness, second_app, second_future, _second_context = await _pending_harness()
    del first_harness, second_harness
    headers = {
        **_RUNNER_HEADERS,
        "Authorization": "Bearer spawn-token",
    }
    async with (
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=first_app), base_url="http://first"
        ) as first_client,
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=second_app), base_url="http://second"
        ) as second_client,
    ):
        old_identity = (await first_client.get(_BASE, headers=headers)).json() | {
            "attempt_id": _ATTEMPT
        }
        current = await second_client.get(_BASE, headers=headers)
        assert current.status_code == 200
        assert current.json()["owner_instance_id"] != old_identity["owner_instance_id"]

        changed_headers = {
            **headers,
            RUNNER_INSTANCE_HEADER: "c" * 64,
        }
        changed_process = await first_client.post(
            f"{_BASE}/{_ATTEMPT}",
            headers=changed_headers,
            json={"identity": old_identity, "result": {"action": "accept"}},
        )
        restarted_owner = await second_client.post(
            f"{_BASE}/{_ATTEMPT}",
            headers=headers,
            json={"identity": old_identity, "result": {"action": "accept"}},
        )
        assert changed_process.status_code == 409
        assert restarted_owner.status_code == 409
        assert not first_future.done()
        assert not second_future.done()
    first_future.cancel()
    second_future.cancel()
    await asyncio.gather(first_future, second_future, return_exceptions=True)


async def test_scaffold_unknown_attempt_never_falls_through_to_event_route() -> None:
    _harness, app, future, _context = await _pending_harness()
    headers = {
        **_RUNNER_HEADERS,
        "Authorization": "Bearer spawn-token",
    }
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://harness"
    ) as client:
        assert (await client.get(_BASE, headers=headers)).status_code == 200
        unknown = await client.get(
            f"{_BASE}/{_ATTEMPT}",
            params={"owner_kind": "harness"},
            headers=headers,
        )
        assert unknown.status_code == 404
        assert not future.done()
    future.cancel()
    await asyncio.gather(future, return_exceptions=True)
