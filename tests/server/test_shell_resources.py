# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Exact shell records retain output and never inherit stale Stop permissions."""

import json
from pathlib import Path

import pytest

from omnigent.db.db_models import workspace_scope
from omnigent.native.shell_resources import shell_output_preview, shell_resource_path
from omnigent.server.schemas import BackgroundTaskInfo
from omnigent.server.shell_resources import SessionShellResources, registered_shell_resource
from omnigent.stores.artifact_store.local import LocalArtifactStore
from omnigent.terminals.history import MAX_OUTPUT_BYTES, ActivityEntry


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
        "can_stop": True,
    }
    await service.capture("chat", [row, {**row, "source": "claude_native"}])
    await service.capture("chat", [{**row, "status": "stopped", "output": None}])
    await service.capture("chat", [])
    restarted = SessionShellResources(LocalArtifactStore(str(tmp_path)))
    retained = await restarted.capture("chat", [])
    assert len(retained) == 2 and all(not row["can_stop"] for row in retained)
    stopped = await restarted.get("chat", "codex_native", "one")
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
