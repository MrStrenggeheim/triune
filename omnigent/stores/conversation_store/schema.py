# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Additive schema maintenance for existing split conversation databases."""

from typing import cast

from sqlalchemy import Engine, Table, text
from sqlalchemy.schema import CreateIndex

from omnigent.db.db_models import SqlConversationLabel
from omnigent.db.query_context import query_name_scope


def ensure_activity_label_index(engine: Engine) -> None:
    """Add the inverse label index where create_all skips an existing table."""
    table = cast(Table, SqlConversationLabel.__table__)
    index = next(
        index for index in table.indexes if index.name == "ix_conversation_labels_key_value"
    )
    with query_name_scope("omnigent.database.ensure_activity_label_index"):
        if engine.dialect.name == "postgresql":
            with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
                invalid = connection.execute(
                    text(
                        "SELECT i.indexrelid::regclass::text FROM pg_index i "
                        "JOIN pg_class c ON c.oid = i.indexrelid "
                        "WHERE i.indrelid = to_regclass(:table) AND c.relname = :name "
                        "AND NOT i.indisvalid"
                    ),
                    {"table": index.table.name, "name": index.name},
                ).scalar()
                if invalid:
                    connection.exec_driver_sql(f"DROP INDEX CONCURRENTLY {invalid}")
                connection.exec_driver_sql(
                    f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {index.name} "
                    f"ON {index.table.name} ({', '.join(column.name for column in index.columns)})"
                )
        elif engine.dialect.name == "sqlite":
            with engine.begin() as connection:
                connection.execute(CreateIndex(index, if_not_exists=True))
        else:
            index.create(engine, checkfirst=True)
