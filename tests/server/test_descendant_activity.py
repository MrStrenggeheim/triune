# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Activity metadata never needs transcript reads or recursive permission calls."""

from __future__ import annotations

import pytest

from omnigent.entities import Conversation
from omnigent.server.descendant_activity import activity_descendants, descendant_activity
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore


@pytest.mark.asyncio
async def test_mixed_descendants_persisted_status_cycles_and_acl(
    db_uri: str, monkeypatch: pytest.MonkeyPatch
) -> None:
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
    hidden = store.create_conversation(
        kind="sub_agent", parent_conversation_id=private.id, agent_id="a" * 32
    )

    def no_transcript(*args, **kwargs):
        pytest.fail("Activity projection must not read transcripts")

    monkeypatch.setattr(store, "list_items", no_transcript)

    def status(_id: str, persisted: str | None):
        return "running" if persisted in ("waiting", "running") else "idle"

    def authorize(rows: list[Conversation], _authorized: set[str]):
        return {row.id for row in rows if row.id != private.id}

    assert await descendant_activity([root], store, status, authorize) == {root.id: True}
    projected = (await activity_descendants([root], store, authorize))[root.id]
    assert projected.complete is True
    assert {row.id for row in projected.rows} == {child.id, branch.id, grandchild.id}
    assert private.id not in {row.id for row in projected.rows}
    assert hidden.id not in {row.id for row in projected.rows}
    store.set_session_live_status(grandchild.id, "idle")
    assert await descendant_activity([root], store, status, authorize) == {root.id: False}
    # Canonical branch provenance can form a malformed cycle; it must terminate.
    store.set_labels(root.id, {"omnigent.branch.source_conversation_id": branch.id})
    assert await descendant_activity([root], store, status, authorize) == {root.id: False}
    assert await descendant_activity([root], store, status, authorize, max_depth=1) == {
        root.id: None
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", [False, True])
async def test_descendant_batches_reuse_overlapping_roots_and_keep_all_facts(
    db_uri: str, monkeypatch: pytest.MonkeyPatch, missing: bool
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    root = store.create_conversation(kind="default", agent_id="a" * 32)
    child = store.create_conversation(
        kind="sub_agent", parent_conversation_id=root.id, agent_id="a" * 32
    )
    grandchild = store.create_conversation(
        kind="sub_agent", parent_conversation_id=child.id, agent_id="a" * 32
    )
    leaf = store.create_conversation(
        kind="sub_agent", parent_conversation_id=grandchild.id, agent_id="a" * 32
    )
    store.set_session_live_status(child.id, "running")
    store.set_session_live_status(leaf.id, "failed")
    loaded: list[str] = []
    batches: list[list[str]] = []
    get_rows = store.get_conversations
    get_edges = store.list_activity_child_ids

    def load(ids: list[str]):
        loaded.extend(ids)
        rows = get_rows(ids)
        if missing:
            rows.pop(leaf.id, None)
        return rows

    def edges(ids: list[str], *, limit: int):
        batches.append(ids)
        return get_edges(ids, limit=limit)

    monkeypatch.setattr(store, "get_conversations", load)
    monkeypatch.setattr(store, "list_activity_child_ids", edges)
    result = await activity_descendants(
        [root, child], store, lambda rows, _: {row.id for row in rows}
    )
    assert loaded == [grandchild.id, leaf.id]
    assert batches == [[root.id, child.id], [grandchild.id]] + ([] if missing else [[leaf.id]])
    assert {row.id for row in result[root.id].rows} == {
        child.id,
        grandchild.id,
        *([] if missing else [leaf.id]),
    }
    assert {row.id for row in result[child.id].rows} == {
        grandchild.id,
        *([] if missing else [leaf.id]),
    }
    assert all(nested.complete is not missing for nested in result.values())


@pytest.mark.asyncio
@pytest.mark.parametrize("budget", [{"max_nodes": 2}, {"max_depth": 1}])
@pytest.mark.parametrize("running", [False, True])
async def test_descendant_limits_preserve_known_positive_and_unknown(
    db_uri: str, budget: dict[str, int], running: bool
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    root = store.create_conversation(kind="default", agent_id="a" * 32)
    child = store.create_conversation(
        kind="sub_agent", parent_conversation_id=root.id, agent_id="a" * 32
    )
    store.create_conversation(kind="sub_agent", parent_conversation_id=child.id, agent_id="a" * 32)
    store.set_session_live_status(child.id, "running" if running else "idle")

    def authorize(rows: list[Conversation], _: set[str]):
        return {row.id for row in rows}

    nested = (await activity_descendants([root], store, authorize, **budget))[root.id]
    assert nested.complete is False
    assert [row.id for row in nested.rows] == [child.id]
    assert await descendant_activity(
        [root],
        store,
        lambda _, status: "running" if status == "running" else "idle",
        authorize,
        **budget,
    ) == {root.id: True if running else None}
