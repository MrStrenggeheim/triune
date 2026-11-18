# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""At-most-once dispatch for explicitly identified browser commands."""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from omnigent.db.db_models import SqlSessionCommandReceipt, current_workspace_id
from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    run_write_transaction,
)
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.schemas import SessionEventInput
from omnigent.stores import ConversationStore


class SessionCommandReceipts:
    def __init__(self, location: str) -> None:
        self.session = make_named_managed_session_maker(
            get_or_create_engine(location),
            query_name_prefix="omnigent.session_command",
            immediate=True,
        )

    async def execute(
        self,
        session_id: str,
        actor: str | None,
        key: str,
        event: SessionEventInput,
        dispatch: Callable[[], Awaitable[dict[str, Any]]],
        preflight: Callable[[], Awaitable[None]] | None = None,
    ) -> dict[str, Any]:
        if not key.isascii() or not 1 <= len(key) <= 256 or not key.isprintable():
            raise OmnigentError("Invalid command identity", code=ErrorCode.INVALID_INPUT)
        operation = hashlib.sha256(key.encode()).hexdigest()
        identity = (current_workspace_id(), session_id, operation)
        fingerprint = hashlib.sha256(
            json.dumps(
                [actor, event.model_dump(mode="json")], sort_keys=True, separators=(",", ":")
            ).encode()
        ).hexdigest()

        def reserve(db: Session) -> dict[str, Any] | None:
            row = db.get(SqlSessionCommandReceipt, identity)
            if row is not None:
                if row.fingerprint != fingerprint:
                    raise OmnigentError(
                        "Command identity belongs to a different request.", code=ErrorCode.CONFLICT
                    )
                if row.acknowledgement is None:
                    raise OmnigentError(
                        "Command unconfirmed. Check session state before retrying.",
                        code=ErrorCode.COMMAND_OUTCOME_UNKNOWN,
                    )
                return json.loads(row.acknowledgement)
            db.add(
                SqlSessionCommandReceipt(
                    workspace_id=identity[0],
                    conversation_id=session_id,
                    operation_key=operation,
                    fingerprint=fingerprint,
                )
            )
            return None

        def reserve_once() -> dict[str, Any] | None:
            try:
                return run_write_transaction(self.session, "reserve", reserve)
            except IntegrityError:
                # Another database connection may have claimed the initially absent row.
                return run_write_transaction(self.session, "recheck_claim", reserve)

        def finish(db: Session, ack: dict[str, Any] | None) -> None:
            row = db.get(SqlSessionCommandReceipt, identity)
            if row is None or row.fingerprint != fingerprint:
                raise RuntimeError("Command reservation changed")
            if ack is None:
                db.delete(row)
            else:
                row.acknowledgement = json.dumps(ack, separators=(",", ":"))

        prior = await asyncio.to_thread(reserve_once)
        if prior is not None:
            return prior
        if preflight is not None:
            try:
                await preflight()
            except OmnigentError:
                await asyncio.to_thread(
                    run_write_transaction,
                    self.session,
                    "release_preflight",
                    lambda db: finish(db, None),
                )
                raise
        try:
            ack = await dispatch()
        except OmnigentError as exc:
            # These refusals precede dispatch; keep the identity usable on readdress.
            if exc.code in {ErrorCode.HOST_OFFLINE, ErrorCode.WRONG_REPLICA}:
                await asyncio.to_thread(
                    run_write_transaction,
                    self.session,
                    "release_undelivered",
                    lambda db: finish(db, None),
                )
            elif exc.http_status >= 500:
                raise OmnigentError(
                    f"Command delivery unconfirmed. {exc.message}",
                    code=ErrorCode.COMMAND_OUTCOME_UNKNOWN,
                ) from exc
            raise
        except Exception as exc:
            raise OmnigentError(
                "Command delivery unconfirmed. Check the session before retrying.",
                code=ErrorCode.COMMAND_OUTCOME_UNKNOWN,
            ) from exc
        await asyncio.to_thread(
            run_write_transaction,
            self.session,
            "acknowledge",
            lambda db: finish(db, None if ack.get("denied") else ack),
        )
        return ack


def require_failed_response(store: ConversationStore, session_id: str, response: str) -> None:
    """A stale error card cannot continue a later conversation turn."""
    errors = store.list_items(session_id, limit=1, order="desc", type="error").data
    latest = store.list_items(session_id, limit=1, order="desc", type="message").data
    error = errors[0] if errors else None
    if (
        error is None
        or error.response_id != response
        or getattr(error.data, "code", None)
        not in {"rate_limit_exceeded", "transient_upstream_error", "connection_error"}
        or (latest and (latest[0].position or 0) > (error.position or 0))
    ):
        raise OmnigentError(
            "Only the latest failed turn can be continued.", code=ErrorCode.CONFLICT
        )
