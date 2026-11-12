"""Persist personal orchestration admission in the existing preferences table."""

import json

from pydantic import StrictBool, TypeAdapter
from sqlalchemy import select
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session
from sqlalchemy.sql.dml import Insert

from omnigent.db.account_authority import require_active_account
from omnigent.db.db_models import SqlPreference, current_workspace_id
from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    run_write_transaction,
)
from omnigent.server.auth import RESERVED_USER_LOCAL

_KEY = "session_orchestration.v1"
_ENABLED = TypeAdapter(StrictBool)


class SqlAlchemyOrchestrationPreferenceStore:
    def __init__(self, storage_location: str) -> None:
        self._engine = get_or_create_engine(storage_location)
        self._session = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.orchestration_preference_store"
        )
        self._write_session = make_named_managed_session_maker(
            self._engine,
            query_name_prefix="omnigent.orchestration_preference_store",
            immediate=True,
        )

    def get_enabled(self, *, user_id: str | None) -> bool:
        with self._session("read_orchestration_preference") as session:
            raw = session.scalar(
                select(SqlPreference.value).where(
                    SqlPreference.workspace_id == current_workspace_id(),
                    SqlPreference.user_id == (RESERVED_USER_LOCAL if user_id is None else user_id),
                    SqlPreference.key == _KEY,
                )
            )
        return True if raw is None else _ENABLED.validate_json(raw)

    def set_enabled(self, enabled: bool, *, user_id: str | None) -> bool:
        enabled = _ENABLED.validate_python(enabled)
        encoded = json.dumps(enabled)

        def write(session: Session) -> bool:
            require_active_account(session, user_id)
            values = {
                "workspace_id": current_workspace_id(),
                "user_id": RESERVED_USER_LOCAL if user_id is None else user_id,
                "key": _KEY,
                "value": encoded,
            }
            stmt: Insert
            if self._engine.dialect.name == "mysql":
                stmt = (
                    mysql_insert(SqlPreference)
                    .values(**values)
                    .on_duplicate_key_update(value=encoded)
                )
            elif self._engine.dialect.name == "sqlite":
                stmt = (
                    sqlite_insert(SqlPreference)
                    .values(**values)
                    .on_conflict_do_update(
                        index_elements=["workspace_id", "user_id", "key"],
                        set_={"value": encoded},
                    )
                )
            else:
                stmt = (
                    pg_insert(SqlPreference)
                    .values(**values)
                    .on_conflict_do_update(
                        index_elements=["workspace_id", "user_id", "key"],
                        set_={"value": encoded},
                    )
                )
            session.execute(stmt)
            return enabled

        return run_write_transaction(self._write_session, "save_orchestration_preference", write)
