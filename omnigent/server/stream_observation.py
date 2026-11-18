# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Bounded, opt-in browser convergence receipts for a timed deployment."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import os
import sqlite3
import time
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

_logger = logging.getLogger(__name__)

Counter = Annotated[int, Field(ge=0, le=2**53 - 1)]
Digest = Annotated[str, Field(pattern=r"^[0-9a-f]{32}$")]


class DisplayReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    seq: Counter
    at: Counter
    stage: Literal["received", "accepted", "displayed", "recovery"]
    kind: Literal["sync", "heartbeat", "item", "delta", "state", "render"] | None = None
    reason: Literal["diverged", "invalid_sync", "deadline", "transport"] | None = None
    item: Digest | None = None
    attempt: Digest | None = None
    view: Digest | None = None
    position: Annotated[int, Field(ge=-1, le=2**53 - 1)] | None = None
    revision: Counter | None = None
    ordinal: Counter | None = None
    visible: bool
    folded: bool = False


class DisplayBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    page: UUID
    dropped: Counter
    records: list[DisplayReceipt] = Field(min_length=1, max_length=64)


def stream_observation_capability() -> dict[str, int]:
    """Both a private output directory and a future UTC deadline enable collection."""
    try:
        until = int(os.environ.get("TRIUNE_STREAM_OBSERVE_UNTIL_MS", "0"))
    except ValueError:
        return {}
    if until <= time.time() * 1000 or not os.environ.get("TRIUNE_STREAM_OBSERVE_DIR"):
        return {}
    return {"transcript_observation_until_ms": until}


def save_display_batch(session_id: str, batch: DisplayBatch) -> None:
    if not stream_observation_capability():
        return
    directory = Path(os.environ["TRIUNE_STREAM_OBSERVE_DIR"])
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    conversation = hashlib.sha256(session_id.encode()).hexdigest()[:32]
    received = int(time.time() * 1000)
    with contextlib.closing(sqlite3.connect(directory / "display.sqlite3", timeout=2)) as db, db:
        # Bound the file at 256 MiB using SQLite's default 4 KiB pages.
        db.execute("PRAGMA max_page_count=65536")
        db.execute(
            "CREATE TABLE IF NOT EXISTS receipts (conversation TEXT, page TEXT, seq INTEGER,"
            "received INTEGER, dropped INTEGER, detail TEXT, PRIMARY KEY(conversation,page,seq))"
        )
        db.executemany(
            "INSERT OR IGNORE INTO receipts VALUES (?,?,?,?,?,?)",
            [
                (
                    conversation,
                    str(batch.page),
                    r.seq,
                    received,
                    batch.dropped,
                    r.model_dump_json(exclude_none=True),
                )
                for r in batch.records
            ],
        )


class WireObservation:
    """Batch metadata after successful writes so slow diagnostic storage cannot block a reader."""

    def __init__(self, directory: Path, until_ms: int) -> None:
        self.directory = directory
        self.until_ms = until_ms
        self.pending: list[tuple] = []
        self.dropped = 0
        self.worker: asyncio.Task | None = None

    def delivered(self, frame: dict, elapsed_ms: float, write_ms: float) -> None:
        now = int(time.time() * 1000)
        if now >= self.until_ms or frame.get("type") != "session.event":
            return
        event = frame.get("event")
        if not isinstance(event, dict):
            return
        conversation = hashlib.sha256(str(frame["session_id"]).encode()).hexdigest()[:32]
        membership = hashlib.sha256(str(frame.get("subscription_id", "")).encode()).hexdigest()[
            :32
        ]
        kind = event.get("type")
        if kind not in {
            "session.sync",
            "session.heartbeat",
            "session.snapshot_page",
            "response.output_item.done",
            "session.item.updated",
            "response.output_text.delta",
            "session.item.reference",
            "session.input.consumed",
        }:
            kind = "state"
        rows = (
            event.get("items", ())
            if kind == "session.snapshot_page"
            else (event.get("item") or event.get("data") or {},)
        )
        for row in rows:
            if len(self.pending) >= 1024:
                self.dropped += 1
                continue
            item = row if isinstance(row, dict) else {}
            item_id = item.get("id") or item.get("item_id") or event.get("item_id")
            item_key = (
                hashlib.sha256(item_id.encode()).hexdigest()[:32]
                if isinstance(item_id, str)
                else None
            )
            position = item.get("position", event.get("last_position"))
            revision = event.get("_change_revision", event.get("item_revision"))
            recorded = event.get("_recorded_at_ms")
            self.pending.append(
                (
                    now,
                    conversation,
                    membership,
                    kind,
                    item_key,
                    position if type(position) is int else None,
                    revision if type(revision) is int else None,
                    recorded if type(recorded) is int else None,
                    round(elapsed_ms, 2),
                    round(write_ms, 2),
                    self.dropped,
                )
            )
        if self.pending and self.worker is None:
            self.worker = asyncio.create_task(self._flush())

    async def _flush(self) -> None:
        try:
            while self.pending:
                await asyncio.sleep(0.25)
                rows, self.pending = self.pending, []
                try:
                    await asyncio.to_thread(self._save, rows)
                except (OSError, sqlite3.Error) as exc:
                    self.dropped += len(rows)
                    _logger.warning("Wire observation batch dropped (%s)", type(exc).__name__)
        finally:
            self.worker = None

    def _save(self, rows: list[tuple]) -> None:
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        with (
            contextlib.closing(sqlite3.connect(self.directory / "wire.sqlite3", timeout=2)) as db,
            db,
        ):
            db.execute("PRAGMA max_page_count=65536")
            db.execute(
                "CREATE TABLE IF NOT EXISTS writes (at INTEGER, conversation TEXT, "
                "membership TEXT, kind TEXT, item TEXT, position INTEGER, revision INTEGER, "
                "recorded_at_ms INTEGER, admission_and_write_ms REAL, "
                "write_ms REAL, dropped INTEGER)"
            )
            db.executemany("INSERT INTO writes VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)


def new_wire_observation() -> WireObservation | None:
    config = stream_observation_capability()
    if not config:
        return None
    return WireObservation(
        Path(os.environ["TRIUNE_STREAM_OBSERVE_DIR"]), config["transcript_observation_until_ms"]
    )
