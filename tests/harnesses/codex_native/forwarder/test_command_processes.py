# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Native command producers publish inventory independently of turn completion."""

from __future__ import annotations

from pathlib import Path

import pytest

from omnigent.harnesses.codex_native import forwarder as fwd
from tests.harnesses.codex_native.forwarder._support import _RecordingClient
from tests.harnesses.codex_native.session._support import _write_forwarder_bridge


@pytest.mark.asyncio
@pytest.mark.parametrize("terminal_status", ["completed", "failed", "declined"])
async def test_native_command_exit_after_turn_completion_clears_only_its_shell(
    tmp_path: Path, terminal_status: str
) -> None:
    client = _RecordingClient()
    state = fwd._CodexForwarderState(parent_session_id="parent", mcp_startup_settled=True)
    tracker = fwd._CodexElicitationTaskTracker()
    _write_forwarder_bridge(
        tmp_path, active_turn_id="turn", session_id="parent", thread_id="thread"
    )

    async def emit(method, item=None):
        params = {"threadId": "thread", "turnId": "turn"}
        if item is not None:
            params["item"] = item
        else:
            params["turn"] = {"id": "turn", "status": "completed", "items": []}
        await fwd._handle_event(
            client,
            session_id="parent",
            bridge_dir=tmp_path,
            event={"method": method, "params": params},
            usage_coalescer=fwd._SessionUsageCoalescer(client, "parent"),
            elicitation_tracker=tracker,
            expected_thread_id="thread",
            forwarder_state=state,
        )

    shell = {
        "id": "native-call",
        "type": "commandExecution",
        "source": "unifiedExecStartup",
        "processId": "77949",
        "command": "sleep 180",
        "status": "inProgress",
    }
    await emit("item/started", shell)
    await emit("item/started", shell)
    await emit("item/started", {**shell, "id": "second", "processId": "77950"})
    await emit("turn/completed")
    assert len(state.command_processes.commands) == 2
    await emit("item/completed", {**shell, "id": "poll", "source": "unifiedExecInteraction"})
    assert len(state.command_processes.commands) == 2
    await emit("item/completed", {**shell, "status": terminal_status, "exitCode": 0})
    await emit("item/completed", {**shell, "id": "second", "status": "completed"})
    await emit("item/completed", {**shell, "id": "second", "status": "completed"})
    inventory = [
        body["data"]
        for _, body in client.posts
        if body["type"] == "external_session_background_tasks"
    ]
    assert [snapshot["background_task_count"] for snapshot in inventory] == [1, 2, 1, 0]
    assert inventory[0]["background_tasks"] == [
        {"id": "native-call", "type": "shell", "status": "running", "command": "sleep 180"}
    ]
    assert inventory[-1]["background_tasks"] == []
    assert all("status" not in snapshot for snapshot in inventory)
    await tracker.close()


@pytest.mark.asyncio
async def test_child_shells_do_not_replace_the_parent_inventory(tmp_path: Path) -> None:
    client = _RecordingClient()
    state = fwd._CodexForwarderState(parent_session_id="parent", mcp_startup_settled=True)
    state.note_child_thread("child-thread", "child")
    tracker = fwd._CodexElicitationTaskTracker()
    try:
        for thread in ("parent-thread", "child-thread"):
            await fwd._handle_event(
                client,
                session_id="parent",
                bridge_dir=tmp_path,
                event={
                    "method": "item/started",
                    "params": {
                        "threadId": thread,
                        "turnId": "turn",
                        "item": {
                            "id": "call",
                            "type": "commandExecution",
                            "command": "sleep 180",
                            "status": "inProgress",
                        },
                    },
                },
                usage_coalescer=fwd._SessionUsageCoalescer(client, "parent"),
                elicitation_tracker=tracker,
                expected_thread_id="parent-thread",
                forwarder_state=state,
            )
        inventory = [
            (path, body)
            for path, body in client.posts
            if body["type"] == "external_session_background_tasks"
        ]
        assert [path for path, _ in inventory] == [
            "/v1/sessions/parent/events",
            "/v1/sessions/child/events",
        ]
        assert all(body["data"]["background_task_count"] == 1 for _, body in inventory)
    finally:
        await tracker.close()
        await state.close_child_streams()
