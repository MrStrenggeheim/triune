# Modified for Triune.

"""Captured shell history survives registry replacement without inventing exits."""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from omnigent.inner.datamodel import TerminalEnvSpec
from omnigent.inner.terminal import TerminalCreateResult
from omnigent.terminals.history import (
    MAX_ENTRIES,
    MAX_OUTPUT_BYTES,
    ActivityEntry,
    TerminalHistory,
)
from omnigent.terminals.registry import TerminalRegistry
from tests.runner.helpers import make_test_terminal_instance


def test_bounded_history_and_output_are_session_scoped(tmp_path: Path) -> None:
    path = tmp_path / "activity.sqlite3"
    history = TerminalHistory(path)
    for index in range(MAX_ENTRIES + 3):
        history.record(
            ActivityEntry(
                id=str(index),
                session_id="chat",
                name="bash",
                state="exited",
                owner_id="chat",
                started_at=index,
                output="é" * MAX_OUTPUT_BYTES,
                source="codex_native",
                source_call_id=f"native-{index}",
            )
        )
    history.record(
        ActivityEntry(
            id="other",
            session_id="other",
            name="bash",
            state="running",
            owner_id="other",
        )
    )
    rows = TerminalHistory(path).list("chat")
    assert len(rows) == MAX_ENTRIES
    assert rows[-1].id == "3"
    assert all(
        row.source == "codex_native" and row.source_call_id == f"native-{row.id}" for row in rows
    )
    assert all(len((row.output or "").encode()) <= MAX_OUTPUT_BYTES for row in rows)
    assert len(history.list("other")) == 1
    assert history.list("other")[0].source is None
    assert history.list("other")[0].source_call_id is None


@pytest.mark.asyncio
async def test_transfer_records_usage_without_reassigning_creator_or_future_output(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    history = TerminalHistory(tmp_path / "activity.sqlite3")
    registry = TerminalRegistry(history=history)
    instance = make_test_terminal_instance("bash", "s1", tmp_path)

    async def launch(**kwargs: object) -> None:
        instance.lifecycle_trace.launch_environment(instance.diagnostic_id)

    instance.launch = AsyncMock(side_effect=launch)  # type: ignore[method-assign]
    monkeypatch.setattr(
        "omnigent.terminals.registry.create_terminal_instance",
        lambda *args, **kwargs: TerminalCreateResult(instance, None),
    )
    await registry.launch("creator", "bash", "s1", TerminalEnvSpec(command="bash"))
    instance._remember_pane_snapshot("before transfer")
    assert registry.transfer("creator", "consumer", "bash", "s1")
    creator = registry.activity_entries("creator")[0]
    assert creator.owner_id == "creator"
    assert creator.state == "disconnected"
    assert creator.ended_at is None
    instance._remember_pane_snapshot("consumer-only output")
    instance._notify_activity("exited")
    consumer = registry.activity_entries("consumer")[0]
    assert consumer.id == creator.id
    assert consumer.owner_id == "creator"
    assert consumer.session_id == "consumer"
    assert consumer.output == "consumer-only output"
    assert "consumer-only" not in (registry.activity_entries("creator")[0].output or "")
    restarted = TerminalRegistry(history=TerminalHistory(history.path))
    assert restarted.activity_entries("consumer")[0].state == "exited"


@pytest.mark.asyncio
@pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux not installed")
async def test_real_shell_command_completion_relaunch_and_restart(tmp_path: Path) -> None:
    history = TerminalHistory(tmp_path / "activity.sqlite3")
    registry = TerminalRegistry(history=history)
    spec = TerminalEnvSpec(command="bash", args=["--noprofile", "--norc"])
    try:
        instance = await registry.launch("chat", "bash", "main", spec)
        await instance.send("printf 'command-%s\\n' done", keys="Enter")

        async with asyncio.timeout(5):
            while True:
                await instance.read()
                if "command-done" in (instance.last_pane_text() or ""):
                    break
                await asyncio.sleep(0.05)
        assert await instance.is_alive()
        assert registry.activity_entries("chat")[0].ended_at is None
        await registry.close("chat", "bash", "main")
        ended = registry.activity_entries("chat")[0]
        assert ended.state == "exited"
        assert ended.ended_at is not None
        assert "command-done" in (ended.output or "")
        second = await registry.launch("chat", "bash", "main", spec)
        assert second is not instance
        rows = registry.activity_entries("chat")
        assert len(rows) == 2
        assert len({row.id for row in rows}) == 2
        restarted = TerminalRegistry(history=TerminalHistory(history.path))
        states = {row.id: row.state for row in restarted.activity_entries("chat")}
        assert states[ended.id] == "exited"
        assert sorted(states.values()) == ["disconnected", "exited"]
    finally:
        await registry.shutdown()


def test_global_retention_and_redaction_before_truncation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from omnigent.terminals import history as history_module
    from omnigent.terminals.history import bounded_output

    monkeypatch.setattr(history_module, "MAX_TOTAL_ENTRIES", 4)
    history = TerminalHistory(tmp_path / "activity.sqlite3")
    for index in range(6):
        history.record(
            ActivityEntry(
                id=str(index),
                session_id=str(index),
                name="bash",
                state="exited",
                owner_id=str(index),
                started_at=index,
            )
        )
    assert history.list("0") == history.list("1") == []
    assert len(history.list("2")) == 1
    secret = "q" * (2 * MAX_OUTPUT_BYTES)
    assert secret[-100:] not in bounded_output(f"token={secret}")


@pytest.mark.asyncio
@pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux not installed")
async def test_confirmed_pane_exit_retains_status_and_output_after_cleanup(tmp_path: Path) -> None:
    history = TerminalHistory(tmp_path / "activity.sqlite3")
    registry = TerminalRegistry(history=history)
    try:
        instance = await registry.launch(
            "chat",
            "bash",
            "exit",
            TerminalEnvSpec(
                command="bash",
                args=["-c", "sleep 0.2; printf 'final output\\n'; exit 7"],
                keep_alive_after_exit=True,
            ),
        )
        async with asyncio.timeout(5):
            while await instance.is_alive():
                await asyncio.sleep(0.05)
        await registry.close("chat", "bash", "exit")
        row = TerminalRegistry(history=TerminalHistory(history.path)).activity_entries("chat")[0]
        assert row.state == "exited"
        assert row.exit_status == 7
        assert row.ended_at is not None
        assert "final output" in (row.output or "")
    finally:
        await registry.shutdown()
