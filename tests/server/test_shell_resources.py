# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Exact shell records retain output and never inherit stale Stop permissions."""

import asyncio
import json
import threading
from pathlib import Path

import pytest

from omnigent.db.db_models import current_workspace_id, workspace_scope
from omnigent.native.shell_resources import shell_output_preview, shell_resource_path
from omnigent.server.schemas import BackgroundTaskInfo
from omnigent.server.shell_resources import SessionShellResources, registered_shell_resource
from omnigent.stores.artifact_store.local import LocalArtifactStore
from omnigent.terminals.history import MAX_OUTPUT_BYTES, ActivityEntry
from tests._helpers.polling import poll_until_async


async def test_snapshot_restart_keeps_ended_shells_and_distinguishes_same_named_resources(
    tmp_path: Path,
) -> None:
    service = SessionShellResources(LocalArtifactStore(str(tmp_path)))
    row = {
        "id": "one",
        "source": "codex_native",
        "resource_id": "one",
        "command": "same",
        "status": "running",
        "output": "old\nactual line\n",
        "turn_id": "codex_turn",
        "can_stop": True,
    }
    await service.capture("chat", [row, {**row, "source": "claude_native"}])
    await service.capture("chat", [{**row, "status": "stopped", "output": None, "turn_id": None}])
    await service.capture("chat", [])
    restarted = SessionShellResources(LocalArtifactStore(str(tmp_path)))
    retained = await restarted.capture("chat", [])
    assert len(retained) == 2 and all(not row["can_stop"] for row in retained)
    stopped = await restarted.get("chat", "codex_native", "one")
    assert stopped["turn_id"] == "codex_turn"
    assert stopped["status"] == "stopped" and stopped["output_preview"] == "actual line"
    await restarted.capture("chat", [row])
    assert (await restarted.get("chat", "codex_native", "one"))["status"] == "stopped"
    await restarted.capture("chat", [{**row, "status": "failed", "exit_code": -1}])
    assert (await restarted.get("chat", "codex_native", "one"))["status"] == "stopped"
    assert await restarted.get("other", "codex_native", "one") is None


@pytest.mark.parametrize(
    "row",
    [
        {"source": "unknown", "resource_id": "one"},
        {"source": "codex_native", "resource_id": ""},
        {"source": "codex_native", "resource_id": "one", "session_id": "other"},
    ],
)
async def test_capture_rejects_missing_identity_or_cross_session_evidence(row) -> None:
    with pytest.raises(ValueError):
        await SessionShellResources().capture("chat", [row])


def test_previews_strip_control_sequences_bound_unicode_and_preserve_legacy_defaults() -> None:
    assert shell_output_preview("prior\n\x1b[31mlast actual line\x1b[0m\n\n") == "last actual line"
    assert len(shell_output_preview("ü" * MAX_OUTPUT_BYTES)) == 512
    assert shell_output_preview(None) is None
    legacy = BackgroundTaskInfo(id="old", command="same")
    assert legacy.source is None and not legacy.can_stop and not legacy.can_open
    assert (
        shell_resource_path("chat space", "codex_native", "id?x")
        == "/v1/sessions/chat%20space/resources/shells/codex_native/id%3Fx"
    )


@pytest.mark.parametrize("state", ["running", "exited", "disconnected"])
def test_registered_terminal_uses_exact_resource_and_retained_output(state: str) -> None:
    entry = ActivityEntry(
        id="launch",
        session_id="chat",
        terminal_id="terminal_shell_one",
        name="shell",
        state=state,
        owner_id="chat",
        output="captured output",
    )
    row = registered_shell_resource(entry, can_stop=True)
    assert row["output_preview"] == "captured output"
    assert row["resource_url"].endswith("/shells/registered_terminal/launch")
    assert row["terminal_id"] == "terminal_shell_one"
    assert row["can_stop"] == (state == "running")
    if row["can_stop"]:
        assert row["stop_method"] == "POST"
        assert row["stop_url"].endswith("/shells/registered_terminal/launch/stop")


async def test_reused_terminal_slot_keeps_each_launch_and_its_output() -> None:
    service = SessionShellResources()
    old = ActivityEntry(
        id="launch-old",
        session_id="chat",
        terminal_id="same-terminal-slot",
        name="shell",
        state="exited",
        owner_id="chat",
        output="old output",
    )
    new = old.model_copy(update={"id": "launch-new", "state": "running", "output": "new output"})
    rows = await service.capture(
        "chat", [registered_shell_resource(old), registered_shell_resource(new, can_stop=True)]
    )
    assert {row["resource_id"] for row in rows} == {"launch-old", "launch-new"}
    assert (await service.get("chat", "registered_terminal", "launch-old"))[
        "output"
    ] == "old output"
    assert (await service.get("chat", "registered_terminal", "launch-new"))[
        "output"
    ] == "new output"


async def test_identical_imported_session_and_shell_ids_are_isolated_by_workspace(
    tmp_path: Path,
) -> None:
    artifacts = LocalArtifactStore(str(tmp_path))
    service = SessionShellResources(artifacts)
    for workspace_id in (1, 2):
        with workspace_scope(workspace_id):
            assert await service.get("same-chat", "codex_native", "same-item") is None
            await service.capture(
                "same-chat",
                [
                    {
                        "source": "codex_native",
                        "resource_id": "same-item",
                        "status": "completed",
                        "output": f"workspace-{workspace_id}",
                    }
                ],
            )
    restarted = SessionShellResources(artifacts)
    for workspace_id in (1, 2):
        with workspace_scope(workspace_id):
            assert (await service.get("same-chat", "codex_native", "same-item"))[
                "output"
            ] == f"workspace-{workspace_id}"
            assert (await restarted.get("same-chat", "codex_native", "same-item"))[
                "output"
            ] == f"workspace-{workspace_id}"


@pytest.mark.parametrize(
    "terminal_id", ["terminal_codex_main", "terminal_claude_main", "terminal_tui_main"]
)
async def test_primary_agent_captures_are_filtered_even_from_old_retained_artifacts(
    tmp_path: Path, terminal_id: str
) -> None:
    artifacts = LocalArtifactStore(str(tmp_path))
    service = SessionShellResources(artifacts)
    stale = {
        "source": "registered_terminal",
        "resource_id": "primary-launch",
        "terminal_id": terminal_id,
        "session_id": "chat",
        "status": "running",
        "can_stop": True,
        "output": "agent CLI output",
    }
    artifacts.put(service._key("chat"), json.dumps([stale]).encode())
    assert await service.capture("chat", [stale]) == []
    assert await service.get("chat", "registered_terminal", "primary-launch") is None
    entry = ActivityEntry(
        id="primary-launch",
        session_id="chat",
        terminal_id=terminal_id,
        name="agent",
        state="running",
        owner_id="chat",
    )
    with pytest.raises(ValueError):
        registered_shell_resource(entry, can_stop=True)


@pytest.mark.parametrize("cancel_first", [False, True])
@pytest.mark.parametrize("fail_first", [False, True])
async def test_capture_serializes_offloop_validation_and_drains_cancellation(
    monkeypatch: pytest.MonkeyPatch, cancel_first: bool, fail_first: bool
) -> None:
    """A waiting update cannot overtake or overlap a slow or cancelled validator."""
    service = SessionShellResources()
    original = SessionShellResources._validated
    entered = threading.Event()
    release = threading.Event()
    observed: list[str] = []
    main_thread = threading.get_ident()

    def gated(session_id: str, records: list[object]):
        assert threading.get_ident() != main_thread
        raw = records[0]
        assert isinstance(raw, dict)
        value = raw["output"]
        assert isinstance(value, str)
        observed.append(value)
        if value == "older":
            entered.set()
            assert release.wait(2), "test did not release validator"
            if fail_first:
                raise ValueError("synthetic invalid snapshot")
        return original(session_id, records)

    monkeypatch.setattr(SessionShellResources, "_validated", staticmethod(gated))
    row = {"source": "codex_native", "resource_id": "one", "status": "running"}
    first = asyncio.create_task(service.capture("chat", [{**row, "output": "older"}]))
    second = None
    try:
        await poll_until_async(entered.is_set, timeout_s=1, interval_s=0.001)
        second = asyncio.create_task(service.capture("chat", [{**row, "output": "newer"}]))
        if cancel_first:
            first.cancel()
            await asyncio.sleep(0)
            first.cancel()
        # A real event-loop probe continues while the validator is held in its thread.
        for _ in range(3):
            await asyncio.sleep(0.001)
        assert observed == ["older"]
        assert not first.done() and not second.done()
        assert service._recent.get("chat") is None
        release.set()
        if cancel_first:
            with pytest.raises(asyncio.CancelledError):
                await first
        elif fail_first:
            with pytest.raises(ValueError, match="synthetic invalid snapshot"):
                await first
        else:
            assert (await first)[0]["output"] == "older"
        assert (await second)[0]["output"] == "newer"
        assert observed == ["older", "newer"]
        assert (await service.get("chat", "codex_native", "one"))["output"] == "newer"
    finally:
        release.set()
        await asyncio.gather(first, *([second] if second else []), return_exceptions=True)


@pytest.mark.parametrize(
    "text",
    [
        " \tpassword is missing; api key is missing\r\n",
        '\tpassword = "canary secret" \t\nAuthorization:\tBearer short-value\n',
        "token=" + "canary-value" * 2000,
        "ssh://user:canary-password@host.example/path\n" + "aB3" * 16,
        "x" + "bearer " + "q" * (MAX_OUTPUT_BYTES - 7),
        "x" + "sk-" + "q" * 24 + "\n" * (MAX_OUTPUT_BYTES - 27),
        "ü" * 4095 + "\n\x1b[31mlast line\x1b[0m\n\n",
        None,
    ],
    ids=[
        "diagnostic-prose",
        "quotes-tabs-crlf",
        "secret-before-tail-cut",
        "url-opaque",
        "bearer-clipping-boundary",
        "provider-clipping-boundary",
        "unicode-ansi",
        "preview-fallback",
    ],
)
async def test_offloop_capture_preserves_exact_redacted_bytes_and_restart(
    tmp_path: Path, text: str | None
) -> None:
    """Fresh and retained validation preserve complete output and the second preview scan."""
    row = {
        "source": "codex_native",
        "resource_id": "one",
        "status": "completed",
        "output": text,
        "output_preview": "preview password=canary-value\n",
    }
    store = LocalArtifactStore(str(tmp_path))
    service = SessionShellResources(store)
    expected = SessionShellResources._validated("chat", [row])
    serialized = json.dumps(expected).encode()
    assert json.dumps(await service.capture("chat", [row])).encode() == serialized
    assert store.get(service._key("chat")) == serialized
    restarted = SessionShellResources(store)
    retained_expected = SessionShellResources._validated("chat", expected)
    assert (
        json.dumps(await restarted.capture("chat", [])).encode()
        == json.dumps(retained_expected).encode()
    )
    if text and text.startswith("xbearer"):
        assert expected[0]["output_preview"] == "bearer [REDACTED]"
    if text and text.startswith("xsk-"):
        assert expected[0]["output_preview"] == "[REDACTED]"


async def test_concurrent_capture_preserves_workspace_context_and_session_isolation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = SessionShellResources(LocalArtifactStore(str(tmp_path)))
    original = SessionShellResources._validated
    entered = threading.Event()
    release = threading.Event()
    observed: list[int] = []
    main_thread = threading.get_ident()

    def contextual(session_id: str, records: list[object]):
        assert threading.get_ident() != main_thread
        workspace_id = current_workspace_id()
        observed.append(workspace_id)
        if workspace_id == 1:
            entered.set()
            assert release.wait(2), "test did not release workspace validator"
        return original(session_id, records)

    monkeypatch.setattr(SessionShellResources, "_validated", staticmethod(contextual))
    row = {"source": "codex_native", "resource_id": "same-id", "status": "completed"}
    with workspace_scope(1):
        first = asyncio.create_task(service.capture("same-chat", [{**row, "output": "one"}]))
    second = None
    try:
        await poll_until_async(entered.is_set, timeout_s=1, interval_s=0.001)
        with workspace_scope(2):
            second = asyncio.create_task(service.capture("same-chat", [{**row, "output": "two"}]))
        await asyncio.sleep(0)
        assert observed == [1]
        release.set()
        await asyncio.gather(first, second)
    finally:
        release.set()
        await asyncio.gather(first, *([second] if second else []), return_exceptions=True)
    assert observed == [1, 2]
    for workspace_id, output in [(1, "one"), (2, "two")]:
        with workspace_scope(workspace_id):
            assert (await service.get("same-chat", "codex_native", "same-id"))["output"] == output
            assert await service.get("different-chat", "codex_native", "same-id") is None
            # Restart also exercises validation of retained rows with copied context.
            restarted = SessionShellResources(service.artifact_store)
            assert (await restarted.get("same-chat", "codex_native", "same-id"))[
                "output"
            ] == output


async def test_invalid_offloop_batch_preserves_previous_snapshot_and_record_limit(
    tmp_path: Path,
) -> None:
    store = LocalArtifactStore(str(tmp_path))
    service = SessionShellResources(store)
    row = {"source": "codex_native", "resource_id": "one", "status": "running", "output": "old"}
    await service.capture("chat", [row])
    previous = store.get(service._key("chat"))
    with pytest.raises(ValueError, match="session mismatch"):
        await service.capture("chat", [{**row, "output": "new"}, {**row, "session_id": "other"}])
    assert store.get(service._key("chat")) == previous
    assert (await service.get("chat", "codex_native", "one"))["output"] == "old"
    rows = [{**row, "resource_id": str(index)} for index in range(100)]
    assert len(await service.capture("chat", [*rows, "ignored beyond record bound"])) == 100
