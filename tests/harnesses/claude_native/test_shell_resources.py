# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Claude native rows use structured task identities and truthful TUI capabilities."""

from omnigent.harnesses.claude_native.shell_resources import ClaudeShellResources


def test_claude_hooks_keep_captured_output_and_ended_shells_without_enabling_sdk_controls() -> (
    None
):
    shells = ClaudeShellResources("chat")
    rows = shells.observe_hook(
        {
            "hook_event_name": "PostToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": "same", "description": "Shell"},
            "tool_response": {
                "backgroundTaskId": "one",
                "stdout": "actual output\n",
                "stderr": "",
            },
        }
    )
    assert rows[0]["output_preview"] == "actual output"
    assert rows[0]["resource_id"] == "one" and rows[0]["source"] == "claude_native"
    assert not rows[0]["can_stop"] and rows[0]["stop_url"] is None
    assert rows[0]["stop_disabled_reason"] == "native_tui_control_transport_unavailable"
    shells.observe_hook(
        {
            "hook_event_name": "Stop",
            "background_tasks": [{"id": "one", "type": "shell", "status": "running"}],
        }
    )
    assert shells.resources["one"]["output_preview"] == "actual output"
    shells.observe_transcript(
        {"type": "system", "subtype": "task_notification", "task_id": "one", "status": "completed"}
    )
    assert shells.resources["one"]["status"] == "completed"
    assert shells.resources["one"]["output_preview"] == "actual output"
    assert len(shells.observe_hook({"hook_event_name": "Stop", "background_tasks": []})) == 1
    assert shells.observe({"id": "one", "type": "shell", "status": "running"}) is None


def test_claude_never_joins_shells_by_description_or_parses_handles_from_output_prose() -> None:
    shells = ClaudeShellResources("chat")
    for task_id in ("one", "two"):
        shells.observe({"id": task_id, "type": "shell", "status": "running", "command": "same"})
    shells.observe_hook(
        {
            "hook_event_name": "PostToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": "same"},
            "tool_response": {"stdout": "Background task id: fake"},
        }
    )
    shells.observe_transcript(
        {
            "type": "system",
            "subtype": "task_notification",
            "task_id": "unknown",
            "status": "completed",
        }
    )
    assert set(shells.resources) == {"one", "two"}
    assert all(
        row["status"] == "running" and row["output_preview"] is None
        for row in shells.resources.values()
    )
    assert shells.observe({"id": "agent", "type": "subagent", "status": "running"}) is None


def test_transcript_bash_result_joins_the_explicit_tool_use_and_native_task_ids() -> None:
    shells = ClaudeShellResources("chat")
    shells.observe_transcript(
        {
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "name": "Bash",
                        "id": "call-one",
                        "input": {"command": "same"},
                    },
                    {
                        "type": "tool_use",
                        "name": "Bash",
                        "id": "call-two",
                        "input": {"command": "same"},
                    },
                ]
            }
        }
    )
    shells.observe_transcript(
        {
            "message": {
                "content": [
                    {"type": "tool_result", "tool_use_id": "call-two", "content": "display prose"}
                ]
            },
            "toolUseResult": {"backgroundTaskId": "task-two", "stdout": "captured second output"},
        }
    )
    assert set(shells.resources) == {"task-two"}
    assert shells.resources["task-two"]["output_preview"] == "captured second output"
    assert set(shells.bash_calls) == {"call-one"}
