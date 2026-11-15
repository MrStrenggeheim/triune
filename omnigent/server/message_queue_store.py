"""Durable after-turn FIFO, serialized on the conversation's existing row lock.

SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any, TypeVar

from sqlalchemy import BigInteger, Column, MetaData, Table, Text, insert, select, update
from sqlalchemy.orm import Session

from omnigent.db.db_models import SqlConversationMetadata, Uuid16, current_workspace_id
from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    run_write_transaction,
)

_T = TypeVar("_T")
queue_table = Table(
    "omnigent_message_queues",
    MetaData(),
    Column("workspace_id", BigInteger, primary_key=True),
    Column("conversation_id", Uuid16(), primary_key=True),
    Column("payload", Text, nullable=False),
)


class MessageQueueStore:
    def __init__(self, storage_location: str) -> None:
        self.session = make_named_managed_session_maker(
            get_or_create_engine(storage_location),
            query_name_prefix="omnigent.message_queue",
            immediate=True,
        )

    def mutate(
        self,
        session_id: str,
        operation: str,
        callback: Callable[[dict[str, Any], SqlConversationMetadata], _T],
        *,
        create: bool = True,
    ) -> _T | None:
        def write(session: Session) -> _T | None:
            conversation = session.scalar(
                select(SqlConversationMetadata)
                .where(
                    SqlConversationMetadata.workspace_id == current_workspace_id(),
                    SqlConversationMetadata.id == session_id,
                )
                .with_for_update()
            )
            if conversation is None:
                raise ValueError("Chat no longer exists")
            condition = (queue_table.c.workspace_id == current_workspace_id()) & (
                queue_table.c.conversation_id == session_id
            )
            raw = session.scalar(select(queue_table.c.payload).where(condition))
            if raw is None and not create:
                return None
            state = (
                json.loads(raw)
                if raw
                else {
                    "messages": [],
                    "turn": None,
                    "ready": False,
                    "inflight": None,
                }
            )
            result = callback(state, conversation)
            payload = json.dumps(state)
            if raw is None:
                session.execute(
                    insert(queue_table).values(
                        workspace_id=current_workspace_id(),
                        conversation_id=session_id,
                        payload=payload,
                    )
                )
            elif payload != raw:
                session.execute(update(queue_table).where(condition).values(payload=payload))
            return result

        return run_write_transaction(self.session, operation, write)

    def read(self, session_id: str) -> dict[str, Any]:
        with self.session("read") as session:
            raw = session.scalar(
                select(queue_table.c.payload).where(
                    queue_table.c.workspace_id == current_workspace_id(),
                    queue_table.c.conversation_id == session_id,
                )
            )
            return json.loads(raw) if raw else {"messages": [], "inflight": None}

    def session_ids(self) -> list[tuple[int, str]]:
        with self.session("recover_queues") as session:
            return [
                (row[0], row[1])
                for row in session.execute(
                    select(queue_table.c.workspace_id, queue_table.c.conversation_id).join(
                        SqlConversationMetadata,
                        (SqlConversationMetadata.workspace_id == queue_table.c.workspace_id)
                        & (SqlConversationMetadata.id == queue_table.c.conversation_id),
                    )
                )
            ]
