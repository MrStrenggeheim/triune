"""Author-private uploads remain hidden until their accepted input is dispatched.

SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from omnigent.db.db_models import SqlFile, current_workspace_id
from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    run_write_transaction,
)
from omnigent.errors import ErrorCode, OmnigentError

QUEUE_AUTHOR = "omnigent.queue_author"


def private_queue_metadata(metadata: dict[str, Any] | None, user_id: str | None) -> dict[str, Any]:
    return {**(metadata or {}), QUEUE_AUTHOR: user_id or "local"}


def queue_file_visible(stored: Any, user_id: str | None) -> bool:
    metadata = stored.source_metadata or {}
    return QUEUE_AUTHOR not in metadata or metadata[QUEUE_AUTHOR] == (user_id or "local")


def require_queue_file_visible(stored: Any, user_id: str | None) -> None:
    if not queue_file_visible(stored, user_id):
        raise OmnigentError("File not found", code=ErrorCode.NOT_FOUND)


def publish_queue_attachments(
    file_store: Any,
    session_id: str,
    content: Any,
    user_id: str | None,
) -> None:
    """Promote only the sending author's private uploads at the actual dispatch boundary."""
    if file_store is None or not isinstance(content, list):
        return
    ids = {
        block["file_id"]
        for block in content
        if isinstance(block, dict) and isinstance(block.get("file_id"), str)
    }
    if not ids:
        return
    session_maker = make_named_managed_session_maker(
        get_or_create_engine(file_store.storage_location),
        query_name_prefix="omnigent.queue_attachments",
        immediate=True,
    )

    def publish(session: Session) -> None:
        rows = session.scalars(
            select(SqlFile)
            .where(
                SqlFile.workspace_id == current_workspace_id(),
                SqlFile.session_id == session_id,
                SqlFile.id.in_(ids),
            )
            .with_for_update()
        ).all()
        for row in rows:
            metadata = json.loads(row.source_metadata) if row.source_metadata else {}
            if QUEUE_AUTHOR not in metadata:
                continue
            if metadata[QUEUE_AUTHOR] != (user_id or "local"):
                raise OmnigentError("File not found", code=ErrorCode.NOT_FOUND)
            del metadata[QUEUE_AUTHOR]
            row.source_metadata = json.dumps(metadata) if metadata else None

    run_write_transaction(session_maker, "publish", publish)
