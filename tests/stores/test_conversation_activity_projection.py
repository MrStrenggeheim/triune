# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Activity-only reads retain fresh list facts across single and split databases."""

from dataclasses import fields

import pytest
from sqlalchemy import delete, event, insert, update

from omnigent.db.db_models import (
    SqlConversation,
    SqlConversationMetadata,
    workspace_scope,
)
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore


@pytest.fixture(params=["conversation_store", "split_db_conversation_store"])
def store(request: pytest.FixtureRequest) -> SqlAlchemyConversationStore:
    return request.getfixturevalue(request.param)


def test_activity_projection_matches_light_read_and_preserves_branch_validation(
    store: SqlAlchemyConversationStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = store.create_conversation()
    child = store.create_conversation(
        parent_conversation_id=root.id,
        labels={
            "omnigent.branch.source_conversation_id": root.id,
            "omnigent.branch.inherited_item_count": "-1",
            "omnigent.side_chat.source_id": "legacy-source",
            "omnigent.pinned.local": "100",
            "omnigent.pinned.other": "200",
            "omni_project": "A project",
            "private-label": "must still pass through the viewer filter",
        },
    )
    store.set_runner_id(child.id, "runner-projection")
    store.set_pending_elicitation_count(child.id, 9)
    store.set_session_live_status(child.id, "waiting")
    store.set_session_state(child.id, {"private-policy": "not an activity field"})
    with store._conv_engine.begin() as connection:
        connection.execute(
            update(SqlConversation)
            .where(SqlConversation.id == child.id)
            .values(archived=True, session_overrides='{"model_override":"private-model"}')
        )
    with store._engine.begin() as connection:
        connection.execute(
            update(SqlConversationMetadata)
            .where(SqlConversationMetadata.id == child.id)
            .values(workspace_transition='{"private":"transition"}', project_id="a" * 32)
        )
    original = store.get_conversations([child.id], include_execution_state=False)[child.id]

    def no_general_hydration(*args, **kwargs):
        pytest.fail("Activity reads must not hydrate general conversation metadata")

    monkeypatch.setattr(store, "get_conversations", no_general_hydration)
    import omnigent.stores.conversation_store.sqlalchemy_store as module

    monkeypatch.setattr(module, "_to_conversation", no_general_hydration)
    monkeypatch.setattr(module, "_decode_session_overrides", no_general_hydration)
    projected = store.get_activity_conversations([child.id, child.id, "f" * 32])
    assert list(projected) == [child.id]
    row = projected[child.id]
    activity_fields = {
        "id",
        "created_at",
        "updated_at",
        "root_conversation_id",
        "parent_conversation_id",
        "kind",
        "agent_id",
        "runner_id",
        "labels",
        "archived",
        "live_status",
        "pending_elicitation_count",
        "project_id",
    }
    for name in activity_fields:
        assert getattr(row, name) == getattr(original, name), name
    assert row.branch == original.branch
    assert row.branch.source_conversation_id == "legacy-source"
    assert row.session_state == {}
    assert row.workspace_transition is None
    assert row.model_override is None
    # Non-activity fields must not accidentally reappear in this projection.
    defaults = type(row)(id=row.id, created_at=0, updated_at=0, root_conversation_id=row.id)
    for field in fields(row):
        if field.name not in activity_fields:
            assert getattr(row, field.name) == getattr(defaults, field.name), field.name
    store.set_labels(child.id, {"omnigent.branch.inherited_item_count": "0"})
    store.set_session_live_status(child.id, "failed")
    refreshed = store.get_activity_conversations([child.id])[child.id]
    assert refreshed.live_status == "failed"
    assert refreshed.branch.source_conversation_id == root.id


def test_activity_projection_tenant_scope_missing_metadata_and_empty_reads(
    store: SqlAlchemyConversationStore,
) -> None:
    first = store.create_conversation()
    with store._engine.begin() as connection:
        connection.execute(
            delete(SqlConversationMetadata).where(SqlConversationMetadata.id == first.id)
        )
    with workspace_scope(17):
        with store._conv_engine.begin() as connection:
            connection.execute(
                insert(SqlConversation),
                {
                    "id": first.id,
                    "root_conversation_id": first.id,
                    "created_at": 17,
                    "updated_at": 17,
                    "title": "",
                    "workspace_id": 17,
                },
            )
        store.set_labels(first.id, {"omni_project": "other tenant"})
        with store._engine.begin() as connection:
            connection.execute(
                insert(SqlConversationMetadata), {"id": first.id, "workspace_id": 17}
            )
        store.set_session_live_status(first.id, "running")
        other = store.get_activity_conversations([first.id])[first.id]
        assert other.updated_at == 17
        assert other.live_status == "running"
        assert other.labels == {"omni_project": "other tenant"}
    row = store.get_activity_conversations([first.id])[first.id]
    assert row.updated_at == first.updated_at
    assert row.live_status is None
    assert row.runner_id is None
    assert row.pending_elicitation_count is None
    assert row.labels == {}

    def no_query(*args, **kwargs):
        pytest.fail("An empty projection must not query")

    engines = {store._engine, store._conv_engine}
    for engine in engines:
        event.listen(engine, "before_cursor_execute", no_query)
    try:
        assert store.get_activity_conversations([]) == {}
    finally:
        for engine in engines:
            event.remove(engine, "before_cursor_execute", no_query)


def test_activity_projection_bounds_parameters_and_excludes_unused_columns(
    store: SqlAlchemyConversationStore,
) -> None:
    ids = [f"{index:032x}" for index in range(1, 508)]
    with store._conv_engine.begin() as connection:
        connection.execute(
            insert(SqlConversation),
            [
                {
                    "id": key,
                    "root_conversation_id": key,
                    "created_at": 1,
                    "updated_at": 2,
                    "title": "",
                }
                for key in ids
            ],
        )
    selected = []

    def before(connection, cursor, statement, parameters, context, many):
        if statement.lstrip().upper().startswith("SELECT"):
            assert len(parameters) <= 501  # 500 IDs and the workspace predicate.
            selected.append(statement)

    engines = {store._engine, store._conv_engine}
    for engine in engines:
        event.listen(engine, "before_cursor_execute", before)
    try:
        rows = store.get_activity_conversations([*ids, *ids[:3]])
    finally:
        for engine in engines:
            event.remove(engine, "before_cursor_execute", before)
    assert set(rows) == set(ids)
    assert len(selected) == 6  # AP facts, labels, metadata for each of two batches.
    for statement in selected:
        for omitted in [
            "session_overrides",
            "session_state",
            "session_usage",
            "workspace_transition",
            "inference_snapshot",
            "terminal_launch_args",
            "task_summary",
        ]:
            assert omitted not in statement
