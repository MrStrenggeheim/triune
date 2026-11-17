"""Exact Future consumption receipts containing identities and action only.

SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""

from __future__ import annotations

import secrets
from collections.abc import Callable
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.schemas import ElicitationResult

RUNNER_ID_HEADER = "X-Omnigent-Runner-Id"
RUNNER_INSTANCE_HEADER = "X-Omnigent-Runner-Instance-Id"


class PendingApprovalIdentity(BaseModel):
    """Exact owner binding returned by read-only preflight."""

    model_config = ConfigDict(extra="forbid", strict=True)
    protocol_version: Literal[1]
    session_id: str = Field(min_length=1)
    elicitation_id: str = Field(min_length=1)
    runner_id: str = Field(min_length=1)
    runner_instance_id: str = Field(pattern=r"^[0-9a-f]{64}$")
    owner_kind: Literal["runner", "harness"]
    owner_instance_id: str = Field(pattern=r"^[0-9a-f]{64}$")
    request_id: str = Field(pattern=r"^[0-9a-f]{64}$")


class ApprovalIdentity(PendingApprovalIdentity):
    """Durably reserved attempt bound to one Future registration."""

    attempt_id: str = Field(pattern=r"^[0-9a-f]{64}$")


class ApprovalDelivery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    identity: ApprovalIdentity
    result: ElicitationResult


class ApprovalRelease(BaseModel):
    model_config = ConfigDict(extra="forbid")
    identity: ApprovalIdentity


class ApprovalReceipt(ApprovalIdentity):
    accepted: Literal[True]
    action: Literal["accept", "decline", "cancel"]


def parse_approval_body(
    payload: object, *, release: bool = False
) -> ApprovalDelivery | ApprovalRelease:
    """Reject malformed input without echoing transient human answers in errors."""
    try:
        return (
            ApprovalRelease.model_validate(payload)
            if release
            else ApprovalDelivery.model_validate(payload)
        )
    except ValidationError:
        raise OmnigentError(
            "Invalid approval delivery body.", code=ErrorCode.INVALID_INPUT
        ) from None


def check_approval_binding(
    identity: PendingApprovalIdentity,
    session_id: str,
    elicitation_id: str,
    runner_id: str,
    runner_instance_id: str,
    *,
    attempt_id: str | None = None,
    owner_kind: str | None = None,
) -> None:
    expected = {
        "session_id": session_id,
        "elicitation_id": elicitation_id,
        "runner_id": runner_id,
        "runner_instance_id": runner_instance_id,
    }
    if attempt_id is not None:
        expected["attempt_id"] = attempt_id
    if owner_kind is not None:
        expected["owner_kind"] = owner_kind
    if any(getattr(identity, key, None) != value for key, value in expected.items()):
        raise OmnigentError("Approval delivery binding changed.", code=ErrorCode.CONFLICT)


class ApprovalReceipts:
    """Retain unacknowledged consumption metadata without retaining human answers."""

    def __init__(
        self, *, limit: int = 1024, owner_kind: Literal["runner", "harness"] = "runner"
    ) -> None:
        self.instance_id = secrets.token_hex(32)
        self.limit = limit
        self.owner_kind = owner_kind
        self._pending: dict[
            tuple[str, str], tuple[str, Callable[[], bool], Callable[[ElicitationResult], bool]]
        ] = {}
        self._accepted: dict[tuple[str, str, str], dict[str, Any]] = {}

    def register(
        self,
        session_id: str,
        elicitation_id: str,
        is_pending: Callable[[], bool],
        resolve: Callable[[ElicitationResult], bool],
    ) -> str:
        request_id = secrets.token_hex(32)
        self._pending[(session_id, elicitation_id)] = (request_id, is_pending, resolve)
        return request_id

    def discard(self, session_id: str, elicitation_id: str, request_id: str) -> None:
        current = self._pending.get((session_id, elicitation_id))
        if current is not None and current[0] == request_id:
            self._pending.pop((session_id, elicitation_id), None)

    def describe(
        self,
        session_id: str,
        elicitation_id: str,
        *,
        runner_id: str = "inprocess",
        runner_instance_id: str | None = None,
    ) -> dict[str, Any] | None:
        current = self._pending.get((session_id, elicitation_id))
        if current is None or not current[1]():
            return None
        return {
            "protocol_version": 1,
            "session_id": session_id,
            "elicitation_id": elicitation_id,
            "runner_id": runner_id,
            "runner_instance_id": runner_instance_id or self.instance_id,
            "owner_kind": self.owner_kind,
            "owner_instance_id": self.instance_id,
            "request_id": current[0],
        }

    def deliver(
        self,
        session_id: str,
        elicitation_id: str,
        identity: dict[str, Any],
        result: ElicitationResult,
        *,
        runner_id: str = "inprocess",
        runner_instance_id: str | None = None,
    ) -> dict[str, Any]:
        try:
            parsed = ApprovalIdentity.model_validate(identity)
        except ValidationError:
            raise OmnigentError(
                "Invalid approval identity.", code=ErrorCode.INVALID_INPUT
            ) from None
        check_approval_binding(
            parsed,
            session_id,
            elicitation_id,
            runner_id,
            runner_instance_id or self.instance_id,
            owner_kind=self.owner_kind,
        )
        attempt_id = parsed.attempt_id
        key = (session_id, elicitation_id, attempt_id)
        if key in self._accepted:
            raise OmnigentError(
                "Query the recorded attempt instead of replaying it.", code=ErrorCode.CONFLICT
            )
        current = self.describe(
            session_id, elicitation_id, runner_id=runner_id, runner_instance_id=runner_instance_id
        )
        if current is None:
            raise OmnigentError(
                "The exact approval request is not pending.", code=ErrorCode.NOT_FOUND
            )
        if any(identity.get(key) != value for key, value in current.items()):
            raise OmnigentError("Approval request identity changed.", code=ErrorCode.CONFLICT)
        if len(self._accepted) >= self.limit:
            raise OmnigentError(
                "Approval receipt capacity reached; reconcile pending attempts.",
                code=ErrorCode.CONFLICT,
            )
        pending = self._pending[(session_id, elicitation_id)]
        if not pending[2](result):
            raise OmnigentError(
                "The approval request is no longer pending.", code=ErrorCode.NOT_FOUND
            )
        # No await between resolving the exact Future and recording this receipt.
        receipt = {**current, "attempt_id": attempt_id, "accepted": True, "action": result.action}
        self._accepted[key] = receipt
        self._pending.pop((session_id, elicitation_id), None)
        return dict(receipt)

    def query(
        self, session_id: str, elicitation_id: str, attempt_id: str
    ) -> dict[str, Any] | None:
        receipt = self._accepted.get((session_id, elicitation_id, attempt_id))
        return dict(receipt) if receipt is not None else None

    def acknowledge(self, session_id: str, elicitation_id: str, identity: dict[str, Any]) -> bool:
        attempt_id = identity.get("attempt_id")
        if not isinstance(attempt_id, str):
            return False
        receipt = self._accepted.get((session_id, elicitation_id, attempt_id))
        if receipt is None or identity != {
            key: value for key, value in receipt.items() if key not in ("accepted", "action")
        }:
            return False
        self._accepted.pop((session_id, elicitation_id, attempt_id), None)
        return True
