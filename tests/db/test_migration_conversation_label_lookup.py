# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Inverse label index upgrades preserve rows and existing label keys."""

from contextlib import nullcontext
from importlib import import_module
from pathlib import Path
from unittest.mock import MagicMock

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateIndex

from omnigent.db.db_models import SqlConversationLabel
from omnigent.db.utils import _build_alembic_config
from omnigent.stores.conversation_store.schema import ensure_activity_label_index
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore

_MIGRATION = "omnigent.db.migrations.versions.bq1a2b3c4d5e_index_conversation_labels_by_value"
_INDEX = "ix_conversation_labels_key_value"
_COLUMNS = ["workspace_id", "key", "value", "conversation_id"]


def test_label_index_upgrade_retry_and_downgrade_preserve_rows() -> None:
    migration = import_module(_MIGRATION)
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection, Operations.context(MigrationContext.configure(connection)):
        connection.exec_driver_sql(
            "CREATE TABLE conversation_labels (workspace_id INTEGER, conversation_id BLOB, "
            "key VARCHAR(128), value VARCHAR(256), updated_at INTEGER, "
            "PRIMARY KEY (workspace_id, conversation_id, key))"
        )
        connection.exec_driver_sql(
            "INSERT INTO conversation_labels VALUES (0, X'01', 'k', 'v', 1)"
        )
        before = connection.exec_driver_sql("SELECT * FROM conversation_labels").all()
        migration.upgrade()
        migration.upgrade()
        assert (
            sa.inspect(connection).get_indexes("conversation_labels")[0]["column_names"]
            == _COLUMNS
        )
        migration.downgrade()
        assert sa.inspect(connection).get_indexes("conversation_labels") == []
        migration.upgrade()
        assert connection.exec_driver_sql("SELECT * FROM conversation_labels").all() == before
    engine.dispose()


def test_existing_single_database_upgrades_at_startup(tmp_path: Path) -> None:
    uri = f"sqlite:///{tmp_path / 'single.db'}"
    engine = sa.create_engine(uri)
    config = _build_alembic_config(uri)
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "mq1b2c3d4e5f")
        connection.execute(
            sa.insert(SqlConversationLabel),
            {"conversation_id": "1" * 32, "key": "k", "value": "v", "updated_at": 1},
        )
    engine.dispose()
    store = SqlAlchemyConversationStore(uri)
    assert (
        sa.inspect(store._engine).get_indexes("conversation_labels")[0]["column_names"] == _COLUMNS
    )
    with store._conv_engine.connect() as connection:
        assert connection.execute(sa.select(SqlConversationLabel.value)).all() == [("v",)]


def test_existing_split_database_recovers_missing_index(tmp_path: Path) -> None:
    uri = f"sqlite:///{tmp_path / 'metadata.db'}"
    ap_uri = f"sqlite:///{tmp_path / 'conversations.db'}"
    store = SqlAlchemyConversationStore(uri, ap_uri)
    child = store.create_conversation(labels={"k": "v"})
    index = next(i for i in SqlConversationLabel.__table__.indexes if i.name == _INDEX)
    index.drop(store._conv_engine)
    # create_all skips an existing labels table; startup must add its missing index.
    reopened = SqlAlchemyConversationStore(uri, ap_uri)
    ensure_activity_label_index(reopened._conv_engine)
    assert (
        sa.inspect(reopened._conv_engine).get_indexes("conversation_labels")[0]["column_names"]
        == _COLUMNS
    )
    assert reopened.get_conversation(child.id).labels == {"k": "v"}


@pytest.mark.parametrize("invalid", [None, '"tenant"."failed_index"'])
def test_postgres_index_builds_concurrently_and_recovers_invalid(
    monkeypatch: pytest.MonkeyPatch, invalid: str | None
) -> None:
    migration = import_module(_MIGRATION)
    index = next(i for i in SqlConversationLabel.__table__.indexes if i.name == _INDEX)
    create = str(CreateIndex(index, if_not_exists=True).compile(dialect=postgresql.dialect()))
    expected = create.replace("CREATE INDEX", "CREATE INDEX CONCURRENTLY", 1)
    connection = MagicMock()
    connection.execute.return_value.scalar.return_value = invalid
    engine = MagicMock()
    engine.dialect.name = "postgresql"
    engine.connect.return_value.execution_options.return_value.__enter__.return_value = connection
    ensure_activity_label_index(engine)
    engine.connect.return_value.execution_options.assert_called_once_with(
        isolation_level="AUTOCOMMIT"
    )
    ddl = [call.args[0] for call in connection.exec_driver_sql.call_args_list]
    assert ddl == ([f"DROP INDEX CONCURRENTLY {invalid}"] if invalid else []) + [expected]
    query, params = connection.execute.call_args.args
    assert "i.indrelid = to_regclass(:table)" in str(query)
    assert params == {"table": "conversation_labels", "name": _INDEX}

    operations = MagicMock()
    operations.get_bind.return_value = connection
    connection.dialect.name = "postgresql"
    operations.get_context.return_value.autocommit_block.return_value = nullcontext()
    monkeypatch.setattr(migration, "op", operations)
    migration.upgrade()
    assert [str(call.args[0]) for call in operations.execute.call_args_list] == ddl
