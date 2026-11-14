# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Native command producers publish inventory independently of turn completion."""

from __future__ import annotations

from pathlib import Path

import pytest

from omnigent.harnesses.codex_native import forwarder as fwd
from omnigent.harnesses.codex_native.command_processes import CodexCommandProcesses
from omnigent.terminals.history import MAX_OUTPUT_BYTES
from tests._helpers.polling import poll_until_async
from tests.harnesses.codex_native.forwarder._support import _RecordingClient
from tests.harnesses.codex_native.session._support import _write_forwarder_bridge


@pytest.mark.asyncio
async def test_background_output_flushes_without_an_active_assistant_turn(tmp_path: Path) -> None:
    client = _RecordingClient()
    state = fwd._CodexForwarderState(parent_session_id="parent", mcp_startup_settled=True)
    shell = {
        "id": "shell-one",
        "type": "commandExecution",
        "status": "inProgress",
        "command": "sleep 10",
    }
    await fwd._sync_command_processes(client, "parent", shell, state)
    _write_forwarder_bridge(
        tmp_path, active_turn_id="new-turn", session_id="parent", thread_id="thread"
    )
    coalescer = fwd._OutputTextDeltaCoalescer(client, "parent")
    try:
        await fwd._handle_event(
            client,
            session_id="parent",
            bridge_dir=tmp_path,
            event={
                "method": "item/commandExecution/outputDelta",
                "params": {
                    "threadId": "thread",
                    "turnId": "old-turn",
                    "itemId": "shell-one",
                    "delta": "LAST_OUTPUT\n",
                },
            },
            usage_coalescer=fwd._SessionUsageCoalescer(client, "parent"),
            elicitation_tracker=fwd._CodexElicitationTaskTracker(),
            expected_thread_id="thread",
            forwarder_state=state,
            delta_coalescer=coalescer,
        )
        await poll_until_async(
            lambda: any(
                body.get("data", {}).get("shell_resources", [{}])[0].get("output")
                == "LAST_OUTPUT\n"
                for _, body in client.posts
                if body["type"] == "external_session_background_tasks"
            ),
            timeout_s=2,
        )
        assert not any(body["type"] == "external_tool_output_delta" for _, body in client.posts)
    finally:
        await coalescer.close()


@pytest.mark.asyncio
async def test_completed_output_does_not_reappend_queued_deltas() -> None:
    client = _RecordingClient()
    state = fwd._CodexForwarderState()
    shell = {
        "id": "one",
        "type": "commandExecution",
        "command": "printf once",
        "status": "inProgress",
    }
    await fwd._sync_command_processes(client, "parent", shell, state)
    coalescer = fwd._OutputTextDeltaCoalescer(client, "parent")
    try:
        await coalescer.observe_shell_output(state.command_processes, "one", "ONCE")
        await fwd._sync_command_processes(
            client,
            "parent",
            {**shell, "status": "completed", "aggregatedOutput": "ONCE", "exitCode": 0},
            state,
        )
        await coalescer.flush()
        assert state.command_processes.resources["one"]["output"] == "ONCE"
        assert state.command_processes.resources["one"]["status"] == "completed"
    finally:
        await coalescer.close()


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
    first = inventory[0]["background_tasks"][0]
    assert {key: first[key] for key in ("id", "type", "status", "command")} == {
        "id": "native-call",
        "type": "shell",
        "status": "running",
        "command": "sleep 180",
    }
    assert first["source"] == "codex_native" and first["resource_id"] == "native-call"
    assert inventory[-1]["background_tasks"] == []
    assert {row["id"] for row in inventory[-1]["shell_resources"]} == {"native-call", "second"}
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


def test_command_output_and_ended_resources_remain_bounded_and_targeted() -> None:
    processes = CodexCommandProcesses()
    shell = {"type": "commandExecution", "id": "one", "command": "same", "status": "inProgress"}
    processes.observe(shell, session_id="chat")
    processes.observe({**shell, "id": "two"}, session_id="chat")
    processes.observe_output("one", "old\n" + "ä" * MAX_OUTPUT_BYTES + "\nactual output\n")
    assert processes.resources["one"]["output_preview"] == "actual output"
    assert len(processes.resources["one"]["output"].encode()) <= MAX_OUTPUT_BYTES
    assert processes.resources["two"]["output_preview"] is None
    ended = processes.observe(
        {**shell, "status": "completed", "exitCode": 7, "aggregatedOutput": ""}, session_id="chat"
    )
    assert ended["background_task_count"] == 1
    assert processes.resources["one"]["exit_code"] == 7
    assert processes.resources["one"]["output_preview"] == "actual output"
    assert processes.resources["one"]["resource_url"].endswith("/shells/codex_native/one")
    assert not processes.resources["one"]["can_stop"]
    assert processes.observe(shell, session_id="chat") is None
    assert processes.observe_output("missing", "never invent a shell") is None
    assert set(processes.commands) == {"two"}


def test_command_stop_requires_proven_vendor_support_and_handle() -> None:
    shell = {"type": "commandExecution", "id": "one", "command": "same", "status": "inProgress"}
    processes = CodexCommandProcesses()
    processes.observe(shell, session_id="chat", targeted_stop_supported=True)
    assert not processes.commands["one"]["can_stop"]
    processes.observe({**shell, "processId": "vendor-handle"}, session_id="chat")
    assert not processes.commands["one"]["can_stop"]
    processes.observe(
        {**shell, "processId": "vendor-handle"}, session_id="chat", targeted_stop_supported=True
    )
    assert processes.commands["one"]["can_stop"]
    assert processes.commands["one"]["stop_method"] == "POST"


def test_output_updates_coalesce_and_forward_only_changed_bounded_resource_output() -> None:
    processes = CodexCommandProcesses()
    shell = {"type": "commandExecution", "id": "one", "command": "same", "status": "inProgress"}
    processes.observe(shell, session_id="chat")
    processes.observe({**shell, "id": "two"}, session_id="chat")
    first = processes.observe_output("one", "first\n", now=10)
    assert len(first["shell_resources"]) == 1
    assert all("output" not in task for task in first["background_tasks"])
    assert processes.observe_output("one", "second\n", now=10.05) is None
    assert processes.observe_output("one", "third\n", now=10.1) is None
    flushed = processes.flush_output(now=10.21)
    assert len(flushed["shell_resources"]) == 1
    assert flushed["shell_resources"][0]["output"] == "first\nsecond\nthird\n"
    assert flushed["shell_resources"][0]["output_preview"] == "third"
    assert processes.flush_output(now=11) is None
