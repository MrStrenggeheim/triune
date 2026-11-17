# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Index pending input pages in submission order without scanning history.

Additive; PostgreSQL builds concurrently and retries failed invalid builds.
Existing split conversation databases receive the same index at store startup.
"""

import sqlalchemy as sa
from alembic import op

revision = "pq1a2b3c4d5e"
down_revision = "ad1b2c3d4e5f"
branch_labels = None
depends_on = None

_INDEX = "ix_conversation_items_pending_position"
_TABLE = "conversation_items"
_COLUMNS = ["workspace_id", "conversation_id", "response_id", "position", "id"]


def upgrade() -> None:
    dialect = op.get_bind().dialect.name
    if dialect != "postgresql":
        op.create_index(_INDEX, _TABLE, _COLUMNS, if_not_exists=dialect == "sqlite")
        return
    with op.get_context().autocommit_block():
        # Retry only an invalid build on the resolved table, not another schema's index.
        invalid = (
            op.get_bind()
            .execute(
                sa.text(
                    "SELECT i.indexrelid::regclass::text FROM pg_index i "
                    "JOIN pg_class c ON c.oid = i.indexrelid "
                    "WHERE i.indrelid = to_regclass(:table) AND c.relname = :name "
                    "AND NOT i.indisvalid"
                ),
                {"table": _TABLE, "name": _INDEX},
            )
            .scalar()
        )
        if invalid:
            op.execute(f"DROP INDEX CONCURRENTLY {invalid}")
        op.execute(
            f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {_INDEX} ON {_TABLE} ({', '.join(_COLUMNS)})"
        )


def downgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        with op.get_context().autocommit_block():
            op.drop_index(_INDEX, table_name=_TABLE, postgresql_concurrently=True, if_exists=True)
    else:
        op.drop_index(_INDEX, table_name=_TABLE, if_exists=op.get_bind().dialect.name == "sqlite")
