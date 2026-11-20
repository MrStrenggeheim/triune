# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Bound the stored search text of existing tool-produced items in a SQLite chat database.

New items already store bounded tool search text (``bound_tool_search_text``).
This one-off backfill applies the same bound to older rows in small write
transactions, so it can run against a live WAL database without holding the
writer lock for long.

Pass 1 rewrites ``conversation_items.search_text`` for tool-produced types.
Pass 2 bounds the matching FTS5 rows of tool-produced items, so message
text stays complete and only tool rows shrink.
Freed pages return to the database freelist; ``VACUUM`` while the server is
stopped shrinks the file itself.

Usage: ``python -m omnigent.db.search_text_backfill --db ~/.omnigent/chat.db``
"""

from __future__ import annotations

import argparse
import logging
import sqlite3
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from omnigent.db.enum_codecs import encode_item_type
from omnigent.db.utils import (
    TOOL_SEARCH_TEXT_HEAD_CHARS,
    TOOL_SEARCH_TEXT_TAIL_CHARS,
    TOOL_SEARCH_TEXT_TYPES,
    bound_tool_search_text,
)

_logger = logging.getLogger(__name__)

# Rows longer than this may need bounding; shorter rows are left untouched.
_LONG_TEXT_CHARS = TOOL_SEARCH_TEXT_HEAD_CHARS + TOOL_SEARCH_TEXT_TAIL_CHARS


@dataclass
class BackfillResult:
    """Counts and character totals removed by one backfill run."""

    item_rows: int = 0
    item_chars_removed: int = 0
    fts_rows: int = 0
    fts_chars_removed: int = 0


def _connect(db_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(db_path, timeout=20, isolation_level=None)
    connection.execute("PRAGMA busy_timeout=20000")
    return connection


def _bound_item_rows(
    connection: sqlite3.Connection,
    *,
    batch_size: int,
    pause_s: float,
    dry_run: bool,
    result: BackfillResult,
) -> None:
    type_codes = sorted(encode_item_type(name) for name in TOOL_SEARCH_TEXT_TYPES)
    placeholders = ", ".join("?" for _ in type_codes)
    select = (
        "SELECT rowid, search_text FROM conversation_items "
        f"WHERE rowid > ? AND type IN ({placeholders}) AND length(search_text) > ? "
        "ORDER BY rowid LIMIT ?"
    )
    last_rowid = 0
    while True:
        rows = connection.execute(
            select, (last_rowid, *type_codes, _LONG_TEXT_CHARS, batch_size)
        ).fetchall()
        if not rows:
            return
        last_rowid = rows[-1][0]
        updates = []
        for rowid, search_text in rows:
            bounded = bound_tool_search_text(search_text)
            if bounded != search_text:
                updates.append((bounded, rowid))
                result.item_chars_removed += len(search_text) - len(bounded)
        result.item_rows += len(updates)
        if updates and not dry_run:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.executemany(
                    "UPDATE conversation_items SET search_text = ? WHERE rowid = ?", updates
                )
            except BaseException:
                connection.execute("ROLLBACK")
                raise
            connection.execute("COMMIT")
            time.sleep(pause_s)


def _hex_id_to_blob(value: str) -> bytes | None:
    try:
        return uuid.UUID(hex=value).bytes
    except ValueError:
        return None


def _align_fts_rows(
    connection: sqlite3.Connection,
    *,
    batch_size: int,
    pause_s: float,
    dry_run: bool,
    result: BackfillResult,
) -> None:
    workspace_ids = [
        row[0]
        for row in connection.execute("SELECT DISTINCT workspace_id FROM conversation_items")
    ]
    if not workspace_ids:
        return
    workspace_placeholders = ", ".join("?" for _ in workspace_ids)
    tool_type_codes = {encode_item_type(name) for name in TOOL_SEARCH_TEXT_TYPES}
    item_lookup = (
        "SELECT type, search_text FROM conversation_items "
        f"WHERE workspace_id IN ({workspace_placeholders}) AND conversation_id = ? AND id = ?"
    )
    last_id = 0
    while True:
        rows = connection.execute(
            "SELECT id, c0, c1, c2 FROM conversation_items_fts_content "
            "WHERE id > ? AND length(c2) > ? ORDER BY id LIMIT ?",
            (last_id, _LONG_TEXT_CHARS, batch_size),
        ).fetchall()
        if not rows:
            return
        last_id = rows[-1][0]
        updates = []
        for fts_rowid, item_id, conversation_id, fts_text in rows:
            item_blob = _hex_id_to_blob(str(item_id))
            conversation_blob = _hex_id_to_blob(str(conversation_id))
            if item_blob is None or conversation_blob is None:
                continue
            item_row = connection.execute(
                item_lookup, (*workspace_ids, conversation_blob, item_blob)
            ).fetchone()
            if item_row is None or item_row[1] is None:
                continue
            item_type, expected_text = item_row
            if item_type in tool_type_codes:
                expected_text = bound_tool_search_text(expected_text)
            if len(expected_text) < len(fts_text):
                updates.append((expected_text, fts_rowid))
                result.fts_chars_removed += len(fts_text) - len(expected_text)
        result.fts_rows += len(updates)
        if updates and not dry_run:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.executemany(
                    "UPDATE conversation_items_fts SET search_text = ? WHERE rowid = ?", updates
                )
            except BaseException:
                connection.execute("ROLLBACK")
                raise
            connection.execute("COMMIT")
            time.sleep(pause_s)


def backfill_search_text(
    db_path: Path,
    *,
    batch_size: int = 200,
    pause_s: float = 0.05,
    dry_run: bool = False,
) -> BackfillResult:
    """
    Bound tool search text in ``conversation_items`` and its FTS5 copy.

    :param db_path: SQLite chat database, e.g. ``~/.omnigent/chat.db``.
    :param batch_size: Rows rewritten per write transaction.
    :param pause_s: Pause after each write transaction so other writers interleave.
    :param dry_run: Count what would change without writing.
    :returns: Rows changed and characters removed in each table.
    """
    result = BackfillResult()
    connection = _connect(db_path)
    try:
        options = {"batch_size": batch_size, "pause_s": pause_s, "dry_run": dry_run}
        _bound_item_rows(connection, result=result, **options)
        has_fts = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE name = 'conversation_items_fts_content'"
        ).fetchone()
        if has_fts:
            _align_fts_rows(connection, result=result, **options)
    finally:
        connection.close()
    return result


def main(argv: list[str] | None = None) -> int:
    """Run the backfill from the command line and print its counts."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, required=True, help="SQLite chat database path")
    parser.add_argument("--batch-size", type=int, default=200)
    parser.add_argument("--pause", type=float, default=0.05, help="seconds between batches")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    started = time.monotonic()
    result = backfill_search_text(
        args.db.expanduser(),
        batch_size=args.batch_size,
        pause_s=args.pause,
        dry_run=args.dry_run,
    )
    _logger.info(
        "%s: item rows %d (-%d chars), fts rows %d (-%d chars) in %.0f s",
        "dry run" if args.dry_run else "bounded",
        result.item_rows,
        result.item_chars_removed,
        result.fts_rows,
        result.fts_chars_removed,
        time.monotonic() - started,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
