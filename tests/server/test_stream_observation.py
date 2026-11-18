# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import json
import sqlite3
import time
from uuid import uuid4

import pytest
from pydantic import ValidationError

from omnigent.server.stream_observation import (
    DisplayBatch,
    save_display_batch,
    stream_observation_capability,
)


def test_timed_display_receipts_are_bounded_and_idempotent(tmp_path, monkeypatch):
    page = uuid4()
    record = {"seq": 1, "at": 2, "stage": "displayed", "ordinal": 0, "visible": True}
    batch = DisplayBatch.model_validate({"page": page, "records": [record], "dropped": 0})
    monkeypatch.setenv("TRIUNE_STREAM_OBSERVE_DIR", str(tmp_path))
    monkeypatch.setenv("TRIUNE_STREAM_OBSERVE_UNTIL_MS", "0")
    save_display_batch("conversation", batch)
    assert list(tmp_path.iterdir()) == []
    until = int(time.time() * 1000) + 60_000
    monkeypatch.setenv("TRIUNE_STREAM_OBSERVE_UNTIL_MS", str(until))
    assert stream_observation_capability() == {"transcript_observation_until_ms": until}
    save_display_batch("conversation", batch)
    save_display_batch("conversation", batch)
    import contextlib

    with contextlib.closing(sqlite3.connect(tmp_path / "display.sqlite3")) as db:
        rows = db.execute("SELECT conversation,detail FROM receipts").fetchall()
    assert len(rows) == 1
    assert rows[0][0] != "conversation"
    assert json.loads(rows[0][1])["ordinal"] == 0
    for records in (
        [{**record, "content": "unwanted"}],
        [record] * 65,
        [{**record, "item": "a body"}],
    ):
        with pytest.raises(ValidationError):
            DisplayBatch.model_validate({"page": page, "records": records, "dropped": 0})


@pytest.mark.asyncio
async def test_physical_writer_persists_only_metadata_outside_delivery(tmp_path):
    from omnigent.server.stream_observation import WireObservation

    sink = WireObservation(tmp_path, int(time.time() * 1000) + 60000)
    sink.delivered(
        {
            "type": "session.event",
            "session_id": "session",
            "subscription_id": "attempt",
            "event": {
                "type": "response.output_item.done",
                "_change_revision": 7,
                "item": {"position": 12, "id": "item", "content": "private fixture"},
            },
        },
        10,
        1,
    )
    assert not (tmp_path / "wire.sqlite3").exists()
    assert sink.worker is not None
    await sink.worker
    import contextlib

    with contextlib.closing(sqlite3.connect(tmp_path / "wire.sqlite3")) as db:
        row = db.execute(
            "SELECT item,position,revision,admission_and_write_ms,write_ms FROM writes"
        ).fetchone()
    assert row[0] != "item"
    assert row[1:] == (12, 7, 10, 1)
    assert b"private fixture" not in (tmp_path / "wire.sqlite3").read_bytes()
