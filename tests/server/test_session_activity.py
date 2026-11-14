# Modified for Triune.

"""Activity snapshots retain captured evidence across server and runner loss."""

import json
from pathlib import Path

import httpx
import pytest

from omnigent.server.session_activity import SessionActivityService
from omnigent.stores.artifact_store.local import LocalArtifactStore
from omnigent.terminals.history import ActivityEntry, activity_page


@pytest.mark.asyncio
async def test_server_restart_retains_ended_output_and_disconnects_live_entries(
    tmp_path: Path,
) -> None:
    artifacts = LocalArtifactStore(str(tmp_path))
    entries = [
        ActivityEntry(
            id="old",
            session_id="chat",
            terminal_id="terminal_bash_main",
            name="bash",
            owner_id="chat",
            state="exited",
            started_at=1,
            ended_at=2,
            exit_status=7,
            output="captured error",
        ),
        ActivityEntry(
            id="live",
            session_id="chat",
            name="bash",
            owner_id="chat",
            state="running",
            started_at=3,
        ),
    ]
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json=activity_page(entries, available=True))
        ),
        base_url="http://runner",
    ) as runner:
        page = await SessionActivityService(artifacts).page("chat", runner_client=runner)
        assert page["data"][0]["state"] == "running"
    restarted = SessionActivityService(LocalArtifactStore(str(tmp_path)))
    offline = await restarted.page("chat")
    rows = {entry["id"]: entry for entry in offline["data"]}
    assert rows["old"]["state"] == "exited"
    assert rows["old"]["output"] == "captured error"
    assert rows["old"]["exit_status"] == 7
    assert rows["live"]["state"] == "disconnected"
    assert "ended_at" not in rows["live"]
    assert offline["coverage"]["non_tty_commands"] == "unavailable"
    assert offline["coverage"]["native_vendor_shells"] == "unknown"
    assert (await restarted.page("different"))["data"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", ["disconnect", "malformed", "other-chat", "legacy-runner"])
async def test_failed_capture_uses_history_without_claiming_exit(
    tmp_path: Path, fault: str
) -> None:
    artifacts = LocalArtifactStore(str(tmp_path))
    service = SessionActivityService(artifacts)
    entry = ActivityEntry(
        id="live", session_id="chat", name="bash", owner_id="chat", state="running"
    )
    artifacts.put(
        service._key("chat"),
        json.dumps(activity_page([entry], available=True)).encode(),
    )

    def response(request: httpx.Request) -> httpx.Response:
        if fault == "disconnect":
            raise httpx.ConnectError("offline", request=request)
        if fault == "malformed":
            return httpx.Response(200, json={"data": ["invalid"]})
        if fault == "other-chat":
            return httpx.Response(
                200,
                json=activity_page(
                    [entry.model_copy(update={"session_id": "other"})], available=True
                ),
            )
        return httpx.Response(404)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(response), base_url="http://runner"
    ) as runner:
        page = await service.page("chat", runner_client=runner)
    assert page["data"][0]["state"] == "disconnected"
    assert "ended_at" not in page["data"][0]
    assert page["warning"]


def _command_items(response_id: str, output: str | None, *, tool: str = "shell"):
    from omnigent.entities import ConversationItem

    call = ConversationItem(
        id=f"call-{response_id}",
        type="function_call",
        status="completed",
        response_id=response_id,
        created_at=10,
        data={
            "agent": "codex-native-ui",
            "name": tool,
            "call_id": "reused-call",
            "arguments": json.dumps({"command": "printf hello"}),
        },
    )
    if output is None:
        return [call]
    result = ConversationItem(
        id=f"result-{response_id}",
        type="function_call_output",
        status="completed",
        response_id=response_id,
        created_at=11,
        data={"call_id": "reused-call", "output": output},
    )
    return [result, call]


def test_native_recorded_commands_keep_completion_separate_from_shells() -> None:
    from omnigent.server.session_activity import recorded_commands

    items = [
        *_command_items("pending", None),
        *_command_items("success", "hello"),
        *_command_items("failed", "error\n[exit code: 7]"),
        *_command_items("structured", '{"exit_code":0,"stdout":"ok"}', tool="exec_command"),
        *_command_items("not-shell", "file changed", tool="apply_patch"),
    ]
    rows = recorded_commands(items, "child")
    assert len(rows) == 4
    assert len({row.id for row in rows}) == 4
    assert all(row.kind == "command" and row.terminal_id is None for row in rows)
    assert all(row.session_id == row.owner_id == "child" for row in rows)
    assert rows[0].state == "unknown" and rows[0].ended_at is None
    assert rows[1].state == "exited" and rows[1].exit_status is None
    assert rows[2].exit_status == 7
    assert rows[3].exit_status == 0
    assert all(
        row.source == "codex_native" and row.source_call_id == "reused-call" for row in rows[:3]
    )
    assert rows[3].source_call_id is None


@pytest.mark.asyncio
async def test_native_persisted_commands_available_without_runner(tmp_path: Path) -> None:
    from omnigent.entities import PagedList

    class Store:
        def list_items(self, *args, **kwargs):
            return PagedList(data=_command_items("completed", "retained output"), has_more=False)

    service = SessionActivityService(LocalArtifactStore(str(tmp_path)))
    page = await service.page("child", conversation_store=Store(), parent_agent_id="child")
    assert page["data"][0]["kind"] == "command"
    assert page["data"][0]["state"] == "exited"
    assert page["data"][0]["parent_agent_id"] == "child"
    assert page["data"][0]["output"] == "retained output"
    assert page["data"][0]["source"] == "codex_native"
    assert page["data"][0]["source_call_id"] == "reused-call"
    assert page["coverage"]["non_tty_commands"] == "persisted_tools"
    restarted = await SessionActivityService(LocalArtifactStore(str(tmp_path))).page("child")
    assert restarted["data"][0]["kind"] == "command"
    assert restarted["data"][0]["output"] == "retained output"
    assert restarted["data"][0]["source_call_id"] == "reused-call"


@pytest.mark.parametrize("metadata", [True, False])
def test_claude_activity_uses_native_task_id_without_equating_equal_commands(
    metadata: bool,
) -> None:
    from omnigent.entities import ConversationItem
    from omnigent.server.session_activity import recorded_commands

    items = []
    for key in ("one", "two"):
        output, call = _command_items(key, "same captured output", tool="Bash")
        call_payload = call.model_dump(mode="json")
        call_payload["data"].update(agent="claude-native-ui", call_id=f"tool-use-{key}")
        result_payload = output.model_dump(mode="json")
        result_payload["data"]["call_id"] = f"tool-use-{key}"
        if metadata:
            result_payload["data"].update(
                source="claude_native", source_call_id=f"background-{key}"
            )
        else:
            result_payload["data"]["output"] = json.dumps(
                {"backgroundTaskId": f"background-{key}", "stdout": "same captured output"}
            )
        # Round-trip the persisted item schema; a raw producer-only extra must not suffice.
        items.extend(
            [
                ConversationItem.model_validate(result_payload),
                ConversationItem.model_validate(call_payload),
            ]
        )
    rows = recorded_commands(items, "chat")
    assert [row.source for row in rows] == ["claude_native", "claude_native"]
    assert [row.source_call_id for row in rows] == (
        ["background-one", "background-two"] if metadata else [None, None]
    )
    assert rows[0].name == rows[1].name
    assert len({row.id for row in rows}) == 2


def test_legacy_claude_text_and_unidentified_shells_remain_unlinked() -> None:
    from omnigent.entities import ConversationItem
    from omnigent.server.session_activity import recorded_commands

    items = _command_items("legacy", "Background task id: not-structured", tool="Bash")
    payload = items[-1].model_dump(mode="json")
    payload["data"]["agent"] = "claude-native-ui"
    row = recorded_commands([items[0], ConversationItem.model_validate(payload)], "chat")[0]
    assert row.source == "claude_native" and row.source_call_id is None
    payload["data"].update(agent="unknown", name="shell")
    unknown = recorded_commands([ConversationItem.model_validate(payload)], "chat")[0]
    assert unknown.source is None and unknown.source_call_id is None


def test_completed_exec_tool_with_continuing_process_is_not_an_exited_command() -> None:
    from omnigent.server.session_activity import recorded_commands

    for output in ('{"session_id":42,"output":"working"}', "Process running with session ID 42"):
        row = recorded_commands(_command_items("background", output, tool="exec_command"), "chat")[
            0
        ]
        assert row.kind == "command"
        assert row.state == "unknown"
        assert row.ended_at is None
        assert row.exit_status is None


@pytest.mark.asyncio
async def test_agent_primary_terminal_is_absent_from_legacy_activity_shell_ledger(
    tmp_path: Path,
) -> None:
    artifacts = LocalArtifactStore(str(tmp_path))
    service = SessionActivityService(artifacts)
    entries = [
        ActivityEntry(
            id=name,
            session_id="chat",
            terminal_id=terminal_id,
            name=name,
            owner_id="chat",
            state="exited",
            output=f"{name} output",
        )
        for name, terminal_id in [
            ("agent", "terminal_codex_main"),
            ("shell", "terminal_bash_main"),
        ]
    ]
    artifacts.put(
        service._key("chat"), json.dumps(activity_page(entries, available=True)).encode()
    )
    page = await service.page("chat")
    assert [row["id"] for row in page["data"]] == ["shell"]
    assert page["data"][0]["output"] == "shell output"
