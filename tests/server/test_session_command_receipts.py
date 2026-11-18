# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Identified command retries cannot reissue an accepted or ambiguous downstream action."""

import asyncio

import pytest

from omnigent.entities.conversation import ErrorData, MessageData, NewConversationItem
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.schemas import SessionEventInput
from omnigent.server.session_command_receipts import (
    SessionCommandReceipts,
    require_failed_response,
)
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore


@pytest.mark.asyncio
async def test_receipt_survives_restart_and_checks_actor_and_target(db_uri):
    conversations = SqlAlchemyConversationStore(db_uri)
    sid = conversations.create_conversation().id
    command = SessionEventInput(type="interrupt", data={"response_id": "turn-a"})
    entered, release = asyncio.Event(), asyncio.Event()
    calls = 0

    async def dispatch():
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        return {"queued": False}

    first = asyncio.create_task(
        SessionCommandReceipts(db_uri).execute(sid, "alice", "abc", command, dispatch)
    )
    await asyncio.wait_for(entered.wait(), 3)
    with pytest.raises(OmnigentError, match="unconfirmed"):
        await SessionCommandReceipts(db_uri).execute(sid, "alice", "abc", command, dispatch)
    release.set()
    assert await first == {"queued": False}
    assert await SessionCommandReceipts(db_uri).execute(
        sid, "alice", "abc", command, dispatch
    ) == {"queued": False}
    for user, target in (("bob", "turn-a"), ("alice", "turn-b")):
        with pytest.raises(OmnigentError, match="different request"):
            await SessionCommandReceipts(db_uri).execute(
                sid,
                user,
                "abc",
                SessionEventInput(type="interrupt", data={"response_id": target}),
                dispatch,
            )
    assert calls == 1


@pytest.mark.asyncio
async def test_unknown_delivery_never_replays_and_offline_refusal_retries(db_uri):
    sid = SqlAlchemyConversationStore(db_uri).create_conversation().id
    command = SessionEventInput(type="message", data={"role": "user", "content": []})
    guard = SessionCommandReceipts(db_uri)

    async def unknown():
        raise ConnectionError("ack unavailable")

    async def offline():
        raise OmnigentError("held", code=ErrorCode.HOST_OFFLINE)

    async def accepted():
        return {"queued": True}

    with pytest.raises(OmnigentError) as error:
        await guard.execute(sid, None, "one", command, unknown)
    assert error.value.code == ErrorCode.COMMAND_OUTCOME_UNKNOWN
    with pytest.raises(OmnigentError, match="unconfirmed"):
        await SessionCommandReceipts(db_uri).execute(sid, None, "one", command, accepted)
    with pytest.raises(OmnigentError, match="held"):
        await guard.execute(sid, None, "two", command, offline)
    assert await guard.execute(sid, None, "two", command, accepted) == {"queued": True}


def test_continue_only_targets_latest_saved_failed_response(db_uri):
    store = SqlAlchemyConversationStore(db_uri)
    sid = store.create_conversation().id
    store.append(
        sid,
        [
            NewConversationItem(
                response_id="failed",
                type="error",
                data=ErrorData(source="llm", code="rate_limit_exceeded", message="fixture"),
            )
        ],
    )
    require_failed_response(store, sid, "failed")
    with pytest.raises(OmnigentError, match="latest failed"):
        require_failed_response(store, sid, "older")
    store.append(
        sid,
        [
            NewConversationItem(
                response_id="new", type="message", data=MessageData(role="user", content=[])
            )
        ],
    )
    with pytest.raises(OmnigentError, match="latest failed"):
        require_failed_response(store, sid, "failed")


def test_http_retry_receipt_returns_original_ack_without_recovery_again(db_uri, monkeypatch):
    from omnigent.server.routes.sessions import routes_events
    from tests.server.routes.test_session_event_batches import _make_client

    store = SqlAlchemyConversationStore(db_uri)
    sid = store.create_conversation().id
    calls = []

    async def recover(**kwargs):
        calls.append(kwargs["session_id"])
        return {"queued": False, "recovered": True, "recovery": "native_terminal_ready"}

    monkeypatch.setattr(routes_events, "_retry_session_single_flight", recover)
    with _make_client(store) as client:
        options = {
            "headers": {"Idempotency-Key": "same-click"},
            "json": {"type": "retry_session", "data": {}},
        }
        response = client.post(f"/sessions/{sid}/events", **options)
        assert response.status_code == 202, response.text
        again = client.post(f"/sessions/{sid}/events", **options)
        assert again.status_code == 202 and again.json() == response.json()
        assert calls == [sid]


def test_ack_lost_for_web_send_and_bound_continuation_returns_original_receipt(db_uri):
    from tests.server.routes.test_session_event_batches import _make_client

    store = SqlAlchemyConversationStore(db_uri)
    sid = store.create_conversation().id
    dispatched = []

    class Startup:
        async def accepts(self, conv, app):
            return True

        async def enqueue(self, session_id, event, **_):
            dispatched.append(event.data["stable_id"])
            return store.append(
                session_id,
                [
                    NewConversationItem(
                        response_id="queued",
                        type="message",
                        stable_id=event.data["stable_id"],
                        data=MessageData(role="user", content=event.data["content"]),
                    )
                ],
            )[0]

    with _make_client(store) as client:
        client.app.state.startup_inputs = Startup()

        def post(key, **data):
            return client.post(
                f"/sessions/{sid}/events",
                headers={"Idempotency-Key": key},
                json={
                    "type": "message",
                    "data": {
                        "role": "user",
                        "content": [{"type": "input_text", "text": "go"}],
                        **data,
                    },
                },
            )

        for _ in range(2):
            first = post("original", stable_id="f" * 32)
            assert first.status_code == 202, first.text
        assert dispatched == ["f" * 32]
        store.append(
            sid,
            [
                NewConversationItem(
                    response_id="failed",
                    type="error",
                    data=ErrorData(source="llm", code="connection_error", message="fixture"),
                )
            ],
        )
        sent = post("click", continuation_of="failed")
        assert sent.status_code == 202, sent.text
        retry = post("different-tab", continuation_of="failed")
        assert retry.status_code == 202 and retry.json() == sent.json()
        assert len(dispatched) == 2
        assert post("stale", continuation_of="earlier").status_code == 409
        assert len(dispatched) == 2
