# Modified for Triune.

"""Bounded captured terminal activity, independent of live registry membership."""

from __future__ import annotations

import sqlite3
import threading
from contextlib import closing
from pathlib import Path
from typing import Literal, NotRequired, TypedDict

from pydantic import BaseModel, ConfigDict

from omnigent.process_logging import data_dir, redact_log_text

MAX_ENTRIES = 128
MAX_OUTPUT_BYTES = 8192
MAX_TOTAL_ENTRIES = 4096


class ActivityCoverage(TypedDict):
    """Capture sources and explicit retention limits."""

    terminals: str
    history: str
    output: str
    non_tty_commands: str
    native_vendor_shells: str
    max_entries: int
    max_output_bytes: int
    children: NotRequired[str]
    max_sessions: NotRequired[int]


class ActivityPage(TypedDict):
    """Bounded response shared by runner and server activity routes."""

    data: list[dict[str, object]]
    coverage: ActivityCoverage
    warning: str


class ActivityEntry(BaseModel):
    """A launch's owner and a session's explicit usage reference."""

    model_config = ConfigDict(extra="ignore")

    id: str
    kind: Literal["terminal", "command"] = "terminal"
    session_id: str
    terminal_id: str | None = None
    name: str
    state: Literal["running", "idle", "exited", "disconnected", "unknown"]
    started_at: float | None = None
    ended_at: float | None = None
    exit_status: int | None = None
    output: str | None = None
    owner_kind: Literal["chat", "workspace"] = "chat"
    owner_id: str
    workspace_id: str | None = None
    parent_agent_id: str | None = None
    source: Literal["codex_native", "claude_native", "registered_terminal"] | None = None
    source_call_id: str | None = None


def bounded_output(text: str | None) -> str | None:
    """Redact before truncating, so a cut cannot remove a secret's prefix."""
    if not text:
        return None
    return redact_log_text(text).encode("utf-8")[-MAX_OUTPUT_BYTES:].decode("utf-8", "ignore")


class TerminalHistory:
    """Bounded journal shared by runners using the same runtime data directory."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path if path is not None else data_dir() / "terminal-activity.sqlite3"
        self._lock = threading.Lock()

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.touch(mode=0o600, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=5)
        connection.execute(
            "CREATE TABLE IF NOT EXISTS activity "
            "(session_id TEXT NOT NULL, id TEXT NOT NULL, started_at REAL NOT NULL, "
            "payload TEXT NOT NULL, PRIMARY KEY(session_id, id))"
        )
        return connection

    def record(self, entry: ActivityEntry) -> None:
        """Persist one bounded observation and prune oldest references atomically."""
        entry = entry.model_copy(update={"output": bounded_output(entry.output)})
        with self._lock, closing(self._connect()) as connection, connection:
            connection.execute(
                "INSERT INTO activity VALUES (?, ?, ?, ?) "
                "ON CONFLICT(session_id, id) DO UPDATE SET payload=excluded.payload",
                (entry.session_id, entry.id, entry.started_at or 0, entry.model_dump_json()),
            )
            connection.execute(
                "DELETE FROM activity WHERE session_id=? AND id NOT IN "
                "(SELECT id FROM activity WHERE session_id=? "
                "ORDER BY started_at DESC, id DESC LIMIT ?)",
                (entry.session_id, entry.session_id, MAX_ENTRIES),
            )
            connection.execute(
                "DELETE FROM activity WHERE rowid NOT IN "
                "(SELECT rowid FROM activity ORDER BY started_at DESC, id DESC LIMIT ?)",
                (MAX_TOTAL_ENTRIES,),
            )

    def list(self, session_id: str) -> list[ActivityEntry]:
        """Read captured evidence without inferring process liveness from disk."""
        with self._lock, closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT payload FROM activity WHERE session_id=? "
                "ORDER BY started_at DESC, id DESC LIMIT ?",
                (session_id, MAX_ENTRIES),
            ).fetchall()
        return [ActivityEntry.model_validate_json(row[0]) for row in rows]


def activity_page(entries: list[ActivityEntry], *, available: bool) -> ActivityPage:
    """Describe capture limits explicitly, including uninstrumented vendor shells."""
    return {
        "data": [entry.model_dump(exclude_none=True) for entry in entries[:MAX_ENTRIES]],
        "coverage": {
            "terminals": "captured" if available else "unavailable",
            "history": "bounded",
            "output": "bounded_snapshots",
            "non_tty_commands": "unavailable",
            "native_vendor_shells": "unknown",
            "max_entries": MAX_ENTRIES,
            "max_output_bytes": MAX_OUTPUT_BYTES,
        },
        "warning": ("History is bounded. Unrecorded vendor shell sessions are unknown."),
    }
