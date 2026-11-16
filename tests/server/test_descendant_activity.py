# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Activity metadata never needs transcript reads or recursive permission calls."""

from __future__ import annotations

import pytest

from omnigent.entities import Conversation
from omnigent.server.descendant_activity import descendant_activity
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore


@pytest.mark.asyncio
async def test_mixed_descendants_persisted_status_cycles_and_acl(db_uri: str) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    root = store.create_conversation(kind="default", agent_id="a" * 32)
    child = store.create_conversation(
        kind="sub_agent", parent_conversation_id=root.id, agent_id="a" * 32
    )
    branch = store.fork_conversation(child.id)
    grandchild = store.create_conversation(
        kind="sub_agent", parent_conversation_id=branch.id, agent_id="a" * 32
    )
    store.set_session_live_status(grandchild.id, "waiting")
    private = store.fork_conversation(root.id)
    store.set_session_live_status(private.id, "running")

    def status(_id: str, persisted: str | None):
        return "running" if persisted in ("waiting", "running") else "idle"

    def authorize(rows: list[Conversation], _authorized: set[str]):
        return {row.id for row in rows if row.id != private.id}

    assert await descendant_activity([root], store, status, authorize) == {root.id: True}
    store.set_session_live_status(grandchild.id, "idle")
    assert await descendant_activity([root], store, status, authorize) == {root.id: False}
    # Canonical branch provenance can form a malformed cycle; it must terminate.
    store.set_labels(root.id, {"omnigent.branch.source_conversation_id": branch.id})
    assert await descendant_activity([root], store, status, authorize) == {root.id: False}
    assert await descendant_activity([root], store, status, authorize, max_depth=1) == {
        root.id: None
    }
