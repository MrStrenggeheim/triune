"""Legacy rows with full tool search text are bounded in place without touching messages."""

import sqlite3

from omnigent.db.search_text_backfill import backfill_search_text
from omnigent.db.utils import bound_tool_search_text, clear_engine_cache
from omnigent.entities.conversation import (
    FunctionCallOutputData,
    MessageData,
    NewConversationItem,
)
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore

_LEGACY_TEXT = "headterm " + "middleterm " * 2000 + "tailterm"


def _store_legacy_rows(db_path):
    clear_engine_cache()
    store = SqlAlchemyConversationStore(f"sqlite:///{db_path}")
    chat = store.create_conversation(title="Backfill")
    output, message = store.append(
        chat.id,
        [
            NewConversationItem(
                type="function_call_output",
                response_id="resp_1",
                data=FunctionCallOutputData(call_id="call_1", output=_LEGACY_TEXT),
            ),
            NewConversationItem(
                type="message",
                response_id="resp_1",
                data=MessageData(
                    role="user", content=[{"type": "input_text", "text": _LEGACY_TEXT}]
                ),
            ),
        ],
    )
    # Rows written before bounding stored the full tool text in both copies.
    with sqlite3.connect(db_path) as connection:
        connection.execute("UPDATE conversation_items SET search_text = ?", (_LEGACY_TEXT,))
        connection.execute("UPDATE conversation_items_fts SET search_text = ?", (_LEGACY_TEXT,))
    return store, chat.id, output.id, message.id


def _search_texts(db_path):
    with sqlite3.connect(db_path) as connection:
        items = sorted(
            length
            for (length,) in connection.execute(
                "SELECT length(search_text) FROM conversation_items"
            )
        )
        fts = sorted(
            length
            for (length,) in connection.execute(
                "SELECT length(search_text) FROM conversation_items_fts"
            )
        )
    return items, fts


def test_backfill_bounds_tool_rows_in_items_and_fts(tmp_path):
    db_path = tmp_path / "chat.db"
    store, chat_id, output_id, message_id = _store_legacy_rows(db_path)
    bounded_length = len(bound_tool_search_text(_LEGACY_TEXT))

    dry_run = backfill_search_text(db_path, dry_run=True)
    assert (dry_run.item_rows, dry_run.fts_rows) == (1, 1)
    assert _search_texts(db_path) == ([len(_LEGACY_TEXT)] * 2, [len(_LEGACY_TEXT)] * 2)

    result = backfill_search_text(db_path, pause_s=0)

    assert (result.item_rows, result.fts_rows) == (1, 1)
    assert _search_texts(db_path) == (
        [bounded_length, len(_LEGACY_TEXT)],
        [bounded_length, len(_LEGACY_TEXT)],
    )
    assert {item.id for item in store.search("tailterm", conversation_id=chat_id)} == {
        output_id,
        message_id,
    }
    rerun = backfill_search_text(db_path, pause_s=0)
    assert (rerun.item_rows, rerun.fts_rows) == (0, 0)
