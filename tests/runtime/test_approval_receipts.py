"""Exact consumption identities survive cleanup without retaining secret answers."""

import asyncio
import hashlib
import json

import pytest

from omnigent.errors import OmnigentError
from omnigent.runtime.approval_receipts import ApprovalReceipts
from omnigent.server.schemas import ElicitationResult


@pytest.mark.asyncio
async def test_receipt_survives_future_cleanup_and_contains_no_secret_or_secret_digest():
    registry = ApprovalReceipts()
    future = asyncio.get_running_loop().create_future()

    def resolve(result):
        if future.done():
            return False
        future.set_result(result)
        return True

    request_id = registry.register("session", "question", lambda: not future.done(), resolve)
    identity = {**registry.describe("session", "question"), "attempt_id": "a" * 64}
    secret = "synthetic private answer: 8zn1"
    result = ElicitationResult(action="accept", content={"secret": secret})
    receipt = registry.deliver("session", "question", identity, result)
    assert future.result() == result
    registry.discard("session", "question", request_id)
    assert registry.describe("session", "question") is None
    assert registry.query("session", "question", "a" * 64) == receipt
    encoded = json.dumps(list(registry._accepted.values()))
    assert secret not in encoded
    assert hashlib.sha256(secret.encode()).hexdigest() not in encoded
    assert "content" not in receipt
    assert registry.acknowledge("session", "question", identity)
    assert registry.query("session", "question", "a" * 64) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("mismatch", ["session", "request", "instance", "expired"])
async def test_foreign_expired_or_replaced_request_never_consumes_a_future(mismatch):
    registry = ApprovalReceipts()
    future = asyncio.get_running_loop().create_future()
    registry.register(
        "session",
        "question",
        lambda: not future.done(),
        lambda result: future.set_result(result) or True,
    )
    identity = {**registry.describe("session", "question"), "attempt_id": "a" * 64}
    if mismatch == "request":
        identity["request_id"] = "b" * 64
    elif mismatch == "instance":
        identity["owner_instance_id"] = "b" * 64
    elif mismatch == "expired":
        future.cancel()
    with pytest.raises(OmnigentError):
        registry.deliver(
            "foreign" if mismatch == "session" else "session",
            "question",
            identity,
            ElicitationResult(action="decline"),
        )
    assert future.cancelled() if mismatch == "expired" else not future.done()
    assert not registry._accepted


@pytest.mark.asyncio
async def test_receipt_capacity_fails_before_consumption_and_never_evicts_unknown_receipts():
    registry = ApprovalReceipts(limit=1)
    futures = []
    for number in range(2):
        future = asyncio.get_running_loop().create_future()
        futures.append(future)
        registry.register(
            "session",
            str(number),
            lambda future=future: not future.done(),
            lambda result, future=future: future.set_result(result) or True,
        )
    first = {**registry.describe("session", "0"), "attempt_id": "a" * 64}
    registry.deliver("session", "0", first, ElicitationResult(action="decline"))
    second = {**registry.describe("session", "1"), "attempt_id": "b" * 64}
    with pytest.raises(OmnigentError):
        registry.deliver("session", "1", second, ElicitationResult(action="decline"))
    assert not futures[1].done()
    assert registry.query("session", "0", "a" * 64)["accepted"]
    assert registry.acknowledge("session", "0", first)
    registry.deliver("session", "1", second, ElicitationResult(action="decline"))
