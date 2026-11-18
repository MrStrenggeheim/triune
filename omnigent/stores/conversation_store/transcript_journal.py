# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""SQLite change cursor for the negotiated local transcript feed."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import Engine

from omnigent.db.db_models import current_workspace_id, uuid_to_bytes
from omnigent.db.query_context import query_name_scope
from omnigent.db.utils import make_named_managed_session_maker
from omnigent.stores.conversation_store import PENDING_INPUT_RESPONSE_ID

_RETENTION = 256


@dataclass(frozen=True)
class TranscriptChange:
    revision: int
    item_id: str
    position: int
    resets_window: bool
    recorded_at_ms: int


class TranscriptJournal:
    """Keep a bounded index of item changes in the same transaction as each item."""

    def __init__(self, engine: Engine) -> None:
        self._session = make_named_managed_session_maker(
            engine, query_name_prefix="triune.transcript_journal"
        )
        pending = PENDING_INPUT_RESPONSE_ID
        with (
            query_name_scope("triune.transcript_journal.ensure_schema"),
            engine.begin() as connection,
        ):
            connection.exec_driver_sql(
                "CREATE TABLE IF NOT EXISTS triune_transcript_changes ("
                "workspace_id INTEGER NOT NULL, conversation_id BLOB NOT NULL, "
                "revision INTEGER NOT NULL, item_id BLOB NOT NULL, position INTEGER NOT NULL, "
                "resets_window INTEGER NOT NULL, recorded_at_ms INTEGER NOT NULL, "
                "PRIMARY KEY(workspace_id,conversation_id,revision)"
                ") WITHOUT ROWID"
            )
            for name, operation, row, condition, reset in (
                ("append", "INSERT", "NEW", f"NEW.response_id != '{pending}'", "0"),
                (
                    "amend",
                    "UPDATE OF response_id,position,type,data,status,created_by",
                    "NEW",
                    f"OLD.response_id != '{pending}' OR NEW.response_id != '{pending}'",
                    f"(NEW.response_id = '{pending}' OR OLD.position != NEW.position)",
                ),
                ("remove", "DELETE", "OLD", f"OLD.response_id != '{pending}'", "1"),
            ):
                identity = (
                    f"workspace_id={row}.workspace_id AND conversation_id={row}.conversation_id"
                )
                connection.exec_driver_sql(
                    f"CREATE TRIGGER IF NOT EXISTS triune_transcript_{name} AFTER {operation} "
                    f"ON conversation_items WHEN {condition} BEGIN "
                    "INSERT INTO triune_transcript_changes "
                    f"SELECT {row}.workspace_id,{row}.conversation_id,coalesce(max(revision),0)+1,"
                    f"{row}.id,{row}.position,{reset},"
                    "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) "
                    "FROM triune_transcript_changes "
                    f"WHERE {identity}; "
                    f"DELETE FROM triune_transcript_changes WHERE {identity} AND revision="
                    f"(SELECT max(revision)-{_RETENTION} FROM triune_transcript_changes "
                    f"WHERE {identity}); END"
                )
            connection.exec_driver_sql(
                "CREATE TRIGGER IF NOT EXISTS triune_transcript_cleanup "
                "AFTER DELETE ON conversations "
                "BEGIN DELETE FROM triune_transcript_changes "
                "WHERE workspace_id=OLD.workspace_id AND conversation_id=OLD.id; END"
            )

    def changes(self, conversation_id: str, since: int) -> list[TranscriptChange]:
        with self._session("read_changes") as session:
            rows = session.connection().exec_driver_sql(
                "SELECT revision, item_id, position, resets_window, recorded_at_ms "
                "FROM triune_transcript_changes "
                "WHERE workspace_id=? AND conversation_id=? AND revision>? ORDER BY revision",
                (current_workspace_id(), uuid_to_bytes(conversation_id), since),
            )
            return [
                TranscriptChange(revision, item_id.hex(), position, bool(reset), recorded_at_ms)
                for revision, item_id, position, reset, recorded_at_ms in rows
            ]

    def revision(self, conversation_id: str) -> int:
        with self._session("read_revision") as session:
            return (
                session.connection()
                .exec_driver_sql(
                    "SELECT coalesce(max(revision),0) FROM triune_transcript_changes "
                    "WHERE workspace_id=? AND conversation_id=?",
                    (current_workspace_id(), uuid_to_bytes(conversation_id)),
                )
                .scalar_one()
            )

    def item_version(self, conversation_id: str, item_id: str) -> tuple[int, int]:
        with self._session("read_item_version") as session:
            row = (
                session.connection()
                .exec_driver_sql(
                    "SELECT revision,recorded_at_ms FROM triune_transcript_changes "
                    "WHERE workspace_id=? AND conversation_id=? AND item_id=? "
                    "ORDER BY revision DESC LIMIT 1",
                    (
                        current_workspace_id(),
                        uuid_to_bytes(conversation_id),
                        uuid_to_bytes(item_id),
                    ),
                )
                .first()
            )
            return (row[0], row[1]) if row is not None else (0, 0)
