"""Durable approval reservations without human verdict payloads.

SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import func, select, tuple_
from sqlalchemy.orm import Session

from omnigent.db.db_models import (
    SqlApprovalDelivery,
    SqlApprovalDeliveryTarget,
    SqlConversationMetadata,
    current_workspace_id,
)
from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    run_write_transaction,
)
from omnigent.errors import ErrorCode, OmnigentError


def held_approval_count(session: Session, visible_session_id: str) -> int:
    return (
        session.scalar(
            select(func.count())
            .select_from(SqlApprovalDeliveryTarget)
            .join(
                SqlApprovalDelivery,
                (SqlApprovalDelivery.workspace_id == SqlApprovalDeliveryTarget.workspace_id)
                & (
                    SqlApprovalDelivery.conversation_id
                    == SqlApprovalDeliveryTarget.conversation_id
                )
                & (SqlApprovalDelivery.elicitation_id == SqlApprovalDeliveryTarget.elicitation_id),
            )
            .where(
                SqlApprovalDeliveryTarget.workspace_id == current_workspace_id(),
                SqlApprovalDeliveryTarget.visible_conversation_id == visible_session_id,
                SqlApprovalDelivery.state == "held",
            )
        )
        or 0
    )


class ApprovalDeliveryStore:
    def __init__(self, storage_location: str) -> None:
        self.session = make_named_managed_session_maker(
            get_or_create_engine(storage_location),
            query_name_prefix="omnigent.approval_delivery",
            immediate=True,
        )

    @staticmethod
    def _value(row: SqlApprovalDelivery) -> dict[str, Any]:
        return {**json.loads(row.payload), "state": row.state, "released": row.released}

    @staticmethod
    def _key(session_id: str, elicitation_id: str) -> tuple[int, str, str]:
        return current_workspace_id(), session_id, elicitation_id

    def read(self, session_id: str, elicitation_id: str) -> dict[str, Any] | None:
        with self.session("read") as session:
            row = session.get(SqlApprovalDelivery, self._key(session_id, elicitation_id))
            return self._value(row) if row is not None else None

    def reserve(
        self,
        session_id: str,
        elicitation_id: str,
        payload: dict[str, Any],
        *,
        expected_runner_binding: str | None,
        pending_counts: dict[str, int] | None = None,
    ) -> tuple[dict[str, Any], bool]:
        required = {
            "identity",
            "action",
            "event",
            "question_receipt",
            "conversation_binding",
        }
        if not required <= set(payload) <= required | {"mirror_sessions"}:
            raise OmnigentError(
                "Invalid redacted approval reservation.", code=ErrorCode.INVALID_INPUT
            )
        if payload["action"] not in {"accept", "decline", "cancel"}:
            raise OmnigentError("Invalid approval action.", code=ErrorCode.INVALID_INPUT)
        identity = payload["identity"]
        if (
            identity.get("session_id") != session_id
            or identity.get("elicitation_id") != elicitation_id
        ):
            raise OmnigentError(
                "Approval identity does not match its journal key.", code=ErrorCode.INVALID_INPUT
            )

        def write(session: Session) -> tuple[dict[str, Any], bool]:
            workspace_id = current_workspace_id()
            conversation = session.scalar(
                select(SqlConversationMetadata)
                .where(
                    SqlConversationMetadata.workspace_id == workspace_id,
                    SqlConversationMetadata.id == session_id,
                )
                .with_for_update()
            )
            if conversation is None or conversation.runner_id != expected_runner_binding:
                raise OmnigentError(
                    "The approval runner binding changed.", code=ErrorCode.CONFLICT
                )
            existing = session.get(SqlApprovalDelivery, self._key(session_id, elicitation_id))
            if existing is not None:
                return self._value(existing), False
            held = (
                session.scalar(
                    select(func.count())
                    .select_from(SqlApprovalDelivery)
                    .where(
                        SqlApprovalDelivery.workspace_id == workspace_id,
                        SqlApprovalDelivery.conversation_id == session_id,
                        SqlApprovalDelivery.state == "held",
                    )
                )
                or 0
            )
            if held >= 100:
                raise OmnigentError(
                    "Reconcile outstanding approval attempts first.", code=ErrorCode.CONFLICT
                )
            row = SqlApprovalDelivery(
                workspace_id=workspace_id,
                conversation_id=session_id,
                elicitation_id=elicitation_id,
                state="held",
                released=False,
                payload=json.dumps(payload),
            )
            session.add(row)
            for visible_id in [session_id, *payload.get("mirror_sessions", [])]:
                session.add(
                    SqlApprovalDeliveryTarget(
                        workspace_id=workspace_id,
                        visible_conversation_id=visible_id,
                        conversation_id=session_id,
                        elicitation_id=elicitation_id,
                    )
                )
            conversation.pending_elicitation_count = max(
                conversation.pending_elicitation_count or 0,
                held + 1,
                (pending_counts or {}).get(session_id, 0),
            )
            for ancestor_id in payload.get("mirror_sessions", []):
                ancestor = session.get(SqlConversationMetadata, (workspace_id, ancestor_id))
                if ancestor is not None:
                    ancestor.pending_elicitation_count = max(
                        ancestor.pending_elicitation_count or 0,
                        (pending_counts or {}).get(ancestor_id, 1),
                        held_approval_count(session, ancestor_id),
                    )
            return self._value(row), True

        return run_write_transaction(self.session, "reserve", write)

    def accept(self, session_id: str, elicitation_id: str, identity: dict[str, Any]) -> bool:
        def write(session: Session) -> bool:
            session.scalar(
                select(SqlConversationMetadata)
                .where(
                    SqlConversationMetadata.workspace_id == current_workspace_id(),
                    SqlConversationMetadata.id == session_id,
                )
                .with_for_update()
            )
            row = session.get(SqlApprovalDelivery, self._key(session_id, elicitation_id))
            if row is None or json.loads(row.payload)["identity"] != identity:
                return False
            if row.state == "held":
                row.state = "accepted"
                session_ids = [session_id, *json.loads(row.payload).get("mirror_sessions", [])]
                for visible_id in session_ids:
                    metadata = session.get(
                        SqlConversationMetadata, (current_workspace_id(), visible_id)
                    )
                    if metadata is not None:
                        metadata.pending_elicitation_count = max(
                            held_approval_count(session, visible_id),
                            (metadata.pending_elicitation_count or 0) - 1,
                        )
            return True

        return run_write_transaction(self.session, "accept", write)

    def held(self, session_id: str) -> list[dict[str, Any]]:
        with self.session("held") as session:
            rows = session.scalars(
                select(SqlApprovalDelivery)
                .where(
                    SqlApprovalDelivery.workspace_id == current_workspace_id(),
                    SqlApprovalDelivery.conversation_id == session_id,
                    SqlApprovalDelivery.state == "held",
                )
                .limit(100)
            )
            return [self._value(row) for row in rows]

    def recovery_page(
        self,
        after: tuple[int, str, str] | None = None,
    ) -> list[tuple[int, str, str, dict[str, Any]]]:
        key = tuple_(
            SqlApprovalDelivery.workspace_id,
            SqlApprovalDelivery.conversation_id,
            SqlApprovalDelivery.elicitation_id,
        )
        query = select(SqlApprovalDelivery).where(SqlApprovalDelivery.state == "held")
        if after is not None:
            query = query.where(key > after)
        with self.session("recover") as session:
            return [
                (row.workspace_id, row.conversation_id, row.elicitation_id, self._value(row))
                for row in session.scalars(
                    query.order_by(
                        SqlApprovalDelivery.workspace_id,
                        SqlApprovalDelivery.conversation_id,
                        SqlApprovalDelivery.elicitation_id,
                    ).limit(128)
                )
            ]

    def mark_released(
        self, session_id: str, elicitation_id: str, identity: dict[str, Any]
    ) -> bool:
        def write(session: Session) -> bool:
            row = session.get(
                SqlApprovalDelivery, self._key(session_id, elicitation_id), with_for_update=True
            )
            if (
                row is None
                or row.state != "accepted"
                or json.loads(row.payload)["identity"] != identity
            ):
                return False
            row.released = True
            return True

        return run_write_transaction(self.session, "release", write)

    def release_page(
        self, after: tuple[int, str, str] | None = None
    ) -> list[tuple[int, str, str, dict[str, Any]]]:
        key = tuple_(
            SqlApprovalDelivery.workspace_id,
            SqlApprovalDelivery.conversation_id,
            SqlApprovalDelivery.elicitation_id,
        )
        query = select(SqlApprovalDelivery).where(
            SqlApprovalDelivery.state == "accepted", SqlApprovalDelivery.released.is_(False)
        )
        if after is not None:
            query = query.where(key > after)
        with self.session("release_recovery") as session:
            return [
                (row.workspace_id, row.conversation_id, row.elicitation_id, self._value(row))
                for row in session.scalars(
                    query.order_by(
                        SqlApprovalDelivery.workspace_id,
                        SqlApprovalDelivery.conversation_id,
                        SqlApprovalDelivery.elicitation_id,
                    ).limit(8)
                )
            ]
