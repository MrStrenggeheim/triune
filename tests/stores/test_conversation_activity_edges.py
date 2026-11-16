# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Bounded branch/delegation reads preserve graph coverage and isolation."""

import pytest
from sqlalchemy import event, insert, inspect

from omnigent.db.db_models import SqlConversation, SqlConversationLabel, workspace_scope
from omnigent.entities import Conversation
from omnigent.server.descendant_activity import activity_descendants, descendant_activity
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore

_SOURCE = "omnigent.branch.source_conversation_id"


@pytest.fixture(params=["conversation_store", "split_db_conversation_store"])
def store(request: pytest.FixtureRequest) -> SqlAlchemyConversationStore:
    return request.getfixturevalue(request.param)


def test_activity_edges_deduplicate_before_budget_and_keep_stable_order(
    store: SqlAlchemyConversationStore,
) -> None:
    first, second = "e" * 32, "f" * 32
    children = [f"{i:032x}" for i in range(1, 5)]
    missing = "d" * 32
    with store._conv_engine.begin() as connection:
        connection.execute(
            insert(SqlConversation),
            [
                {
                    "id": child,
                    "root_conversation_id": child,
                    "parent_conversation_id": parent,
                    "title": "",
                    "created_at": created,
                    "updated_at": 0,
                }
                for child, parent, created in [
                    (children[0], first, 1),
                    (children[1], first, 2),
                    (children[2], second, 1),
                    (children[3], None, 1),
                ]
            ],
        )
        connection.execute(
            insert(SqlConversationLabel),
            [
                {"conversation_id": child, "key": _SOURCE, "value": parent, "updated_at": 1}
                for parent, child in [
                    (first, children[0]),  # Same canonical edge as delegation.
                    (first, children[2]),  # One child can be reached from both parents.
                    (first, children[3]),
                    (first, missing),  # Missing rows still need hydration/unknown coverage.
                    (second, first),  # Malformed cycles must remain visible to the traversal.
                ]
            ],
        )
        connection.execute(
            insert(SqlConversationLabel),
            [
                {
                    "conversation_id": children[1],
                    "key": "omnigent.fork.source_id",
                    "value": first,
                    "updated_at": 1,
                    "workspace_id": 0,
                },
                {
                    "conversation_id": children[1],
                    "key": _SOURCE,
                    "value": first,
                    "updated_at": 1,
                    "workspace_id": 12,
                },
            ],
        )
    ordered = [
        (first, children[1]),
        (first, children[0]),
        (second, children[2]),
        (first, children[2]),
        (first, children[3]),
        (first, missing),
        (second, first),
    ]
    for limit in range(1, len(ordered) + 2):
        expected = {first: [], second: []}
        for parent, child in ordered[:limit]:
            expected[parent].append(child)
        actual = store.list_activity_child_ids([first, second, first], limit=limit)
        assert actual == (expected, limit >= len(ordered))
        assert store.list_activity_child_ids([second, first], limit=limit)[0] == expected
    assert store.list_activity_child_ids([], limit=0) == ({}, True)
    assert store.list_activity_child_ids([first], limit=0) == ({first: []}, False)
    assert store.list_activity_child_ids([first], limit=-1) == ({first: []}, False)
    with workspace_scope(12):
        assert store.list_activity_child_ids([first]) == ({first: [children[1]]}, True)


@pytest.mark.asyncio
@pytest.mark.parametrize("bound", [{}, {"max_nodes": 3}, {"max_depth": 1}])
async def test_activity_edges_retain_acl_cycles_shared_budget_and_unknown(
    store: SqlAlchemyConversationStore, bound: dict[str, int]
) -> None:
    root = store.create_conversation()
    child = store.create_conversation(parent_conversation_id=root.id)
    store.set_labels(child.id, {_SOURCE: root.id})
    branch = store.create_conversation(labels={_SOURCE: child.id})
    private = store.create_conversation(labels={_SOURCE: root.id})
    hidden = store.create_conversation(parent_conversation_id=private.id)
    store.set_labels(root.id, {_SOURCE: branch.id})
    store.set_session_live_status(hidden.id, "running")

    def authorize(rows: list[Conversation], _: set[str]) -> set[str]:
        return {row.id for row in rows if row.id != private.id}

    result = await activity_descendants([root, child], store, authorize, **bound)
    assert all(hidden.id not in {row.id for row in value.rows} for value in result.values())
    assert all(private.id not in {row.id for row in value.rows} for value in result.values())
    if bound:
        assert all(not value.complete for value in result.values())
    else:
        assert result[root.id].complete
        assert {row.id for row in result[root.id].rows} == {child.id, branch.id}

    def status(_: str, live: str | None) -> str:
        return "running" if live == "running" else "idle"

    projected = await descendant_activity([root, child], store, status, authorize, **bound)
    assert projected[root.id] is (None if bound else False)
    store.set_session_live_status(child.id, "running")
    assert (await descendant_activity([root], store, status, authorize, **bound))[root.id] is True
    store.set_labels(branch.id, {_SOURCE: "a" * 32})
    store.set_labels("b" * 32, {_SOURCE: root.id})
    assert (await activity_descendants([root], store, authorize))[root.id].complete is False


def test_activity_edge_work_is_bounded_with_large_unrelated_and_matching_sets(
    store: SqlAlchemyConversationStore,
) -> None:
    if store._conv_engine.dialect.name != "sqlite":
        pytest.skip("SQLite operation-count/EXPLAIN check")
    if not any(
        index["name"] == "ix_conversation_labels_key_value"
        for index in inspect(store._conv_engine).get_indexes("conversation_labels")
    ):
        pytest.skip("Indexed operation bound requires the independent inverse-index migration")
    parent = "f" * 32
    with store._conv_engine.begin() as connection:
        connection.execute(
            insert(SqlConversation),
            [
                {
                    "id": f"{i:032x}",
                    "root_conversation_id": f"{i:032x}",
                    "parent_conversation_id": parent,
                    "title": "",
                    "created_at": i,
                    "updated_at": 0,
                }
                for i in range(6000)
            ],
        )
        connection.execute(
            insert(SqlConversationLabel),
            [
                {
                    "conversation_id": f"{i:032x}",
                    "key": f"unrelated-{key}",
                    "value": "other",
                    "updated_at": 0,
                }
                for i in range(2000)
                for key in range(14)
            ]
            + [
                {"conversation_id": f"{i:032x}", "key": _SOURCE, "value": parent, "updated_at": 0}
                for i in range(6000)
            ],
        )
    steps = 0
    queries = []

    def tick() -> int:
        nonlocal steps
        steps += 1
        return 0

    def before(connection, cursor, statement, params, context, many):
        if statement.lstrip().upper().startswith("SELECT"):
            queries.append((statement, params))
            cursor.connection.set_progress_handler(tick, 1)

    event.listen(store._conv_engine, "before_cursor_execute", before)
    try:
        result, complete = store.list_activity_child_ids([parent], limit=8)
    finally:
        event.remove(store._conv_engine, "before_cursor_execute", before)
        with store._conv_engine.connect() as connection:
            connection.connection.driver_connection.set_progress_handler(None, 0)
    assert len(result[parent]) == 8
    assert not complete
    assert len(queries) == 2
    assert steps < 2000, f"Unbounded SQL work: {steps} VM steps"
    with store._conv_engine.connect() as connection:
        plans = [
            str(connection.exec_driver_sql("EXPLAIN QUERY PLAN " + sql, params).all())
            for sql, params in queries
        ]
    assert "idx_conversations_parent" in plans[0]
    assert "ix_conversation_labels_key_value" in plans[1]
    assert all("TEMP B-TREE" not in plan for plan in plans)
