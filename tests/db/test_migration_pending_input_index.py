# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Ordered pending-input index upgrades preserve history and prior indexes."""

from importlib import import_module
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory

from omnigent.db.db_models import SqlConversationItem
from omnigent.db.utils import _build_alembic_config, clear_engine_cache
from omnigent.entities.conversation import MessageData, NewConversationItem
from omnigent.stores.conversation_store import PENDING_INPUT_RESPONSE_ID
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore

_REVISION = "pq1a2b3c4d5e"
_PRIOR = "ad1b2c3d4e5f"
_INDEX = "ix_conversation_items_pending_position"
_COLUMNS = ["workspace_id", "conversation_id", "response_id", "position", "id"]


def test_pending_index_upgrade_retry_and_downgrade_preserve_rows_and_indexes(tmp_path: Path):
    uri = f"sqlite:///{tmp_path / 'roundtrip.db'}"
    config = _build_alembic_config(uri)
    scripts = ScriptDirectory.from_config(config)
    assert scripts.get_heads() == [_REVISION]
    assert scripts.get_revision(_REVISION).down_revision == _PRIOR
    engine = sa.create_engine(uri)
    migration = import_module(
        "omnigent.db.migrations.versions.pq1a2b3c4d5e_index_pending_conversation_inputs"
    )
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, _PRIOR)
        connection.execute(
            sa.insert(SqlConversationItem),
            [
                {
                    "workspace_id": workspace,
                    "conversation_id": "1" * 32,
                    "id": "2" * 32,
                    "created_at": 1,
                    "response_id": response,
                    "position": 0,
                    "status": 2,
                    "type": 1,
                    "data": '{"role":"user","content":[]}',
                    "search_text": "",
                }
                for workspace, response in [(0, "history"), (17, PENDING_INPUT_RESPONSE_ID)]
            ],
        )
        rows = connection.execute(sa.select(SqlConversationItem)).all()
        prior_indexes = sa.inspect(connection).get_indexes("conversation_items")
        prior_pk = sa.inspect(connection).get_pk_constraint("conversation_items")
        assert _INDEX not in {index["name"] for index in prior_indexes}
        command.upgrade(config, "head")
        with Operations.context(MigrationContext.configure(connection)):
            migration.upgrade()  # Retry after DDL completed but before revision recording.
        index = next(
            i
            for i in sa.inspect(connection).get_indexes("conversation_items")
            if i["name"] == _INDEX
        )
        assert index["column_names"] == _COLUMNS and not index["unique"]
        assert connection.execute(sa.select(SqlConversationItem)).all() == rows
        command.downgrade(config, _PRIOR)
        with Operations.context(MigrationContext.configure(connection)):
            migration.downgrade()  # Retry interrupted downgrade after its index was dropped.
        assert sa.inspect(connection).get_indexes("conversation_items") == prior_indexes
        assert sa.inspect(connection).get_pk_constraint("conversation_items") == prior_pk
        assert connection.execute(sa.select(SqlConversationItem)).all() == rows
        command.upgrade(config, "head")
        assert connection.execute(sa.select(SqlConversationItem)).all() == rows
    engine.dispose()


@pytest.mark.parametrize("split", [False, True])
def test_existing_pending_store_recovers_index_at_startup(tmp_path: Path, split: bool):
    uri = f"sqlite:///{tmp_path / 'metadata.db'}"
    conv_uri = f"sqlite:///{tmp_path / 'conversations.db'}" if split else None
    store = SqlAlchemyConversationStore(uri, conv_uri)
    conversation = store.create_conversation()
    saved = store.append(
        conversation.id,
        [
            NewConversationItem(
                type="message",
                response_id=PENDING_INPUT_RESPONSE_ID,
                status="in_progress",
                data=MessageData(role="user", content=[]),
            )
        ],
    )
    if split:
        index = next(i for i in SqlConversationItem.__table__.indexes if i.name == _INDEX)
        index.drop(store._conv_engine)
    else:
        config = _build_alembic_config(uri)
        with store._engine.begin() as connection:
            config.attributes["connection"] = connection
            command.downgrade(config, _PRIOR)
    clear_engine_cache()
    for _ in range(2):
        reopened = SqlAlchemyConversationStore(uri, conv_uri)
        indexes = sa.inspect(reopened._conv_engine).get_indexes("conversation_items")
        assert next(i for i in indexes if i["name"] == _INDEX)["column_names"] == _COLUMNS
        assert reopened.list_pending_inputs_page(conversation.id) == (saved, None)
    clear_engine_cache()
