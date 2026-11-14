# Modified for Triune.

"""Transcript delivery tests for Claude-native forwarding."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from omnigent.harnesses.claude_native import forwarder
from omnigent.harnesses.claude_native.bridge import (
    read_transcript_items_from_offset,
    read_transcript_items_since_with_position,
    record_hook_event,
)
from omnigent.harnesses.claude_native.forwarder import (
    forward_claude_transcript_to_session,
)
from tests.harnesses.claude_native.forwarder._support import (
    _get_recorded_item_request,
    _get_recorded_request,
    _start_recording_server,
)


@pytest.mark.parametrize("reader", ["line", "byte"])
async def test_shell_resources_hold_failed_delivery_and_restore_native_ids_across_restart(
    tmp_path: Path, reader: str
) -> None:
    transcript = tmp_path / "shells.jsonl"
    calls = {
        "type": "assistant",
        "uuid": "calls",
        "message": {
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": f"call-{key}",
                    "name": "Bash",
                    "input": {"command": "same command"},
                }
                for key in ("one", "two")
            ],
        },
    }
    transcript.write_text(json.dumps(calls) + "\n")
    posted = []

    def transport(request):
        assert request.headers["authorization"] == "Bearer scoped-owner"
        posted.append(json.loads(request.content))
        return httpx.Response(500 if len(posted) == 1 else 202)

    def read(offset=0, line=0):
        if reader == "line":
            return read_transcript_items_since_with_position(
                transcript, line, agent_name="claude-native-ui"
            )
        return read_transcript_items_from_offset(
            transcript, offset, start_line=line, agent_name="claude-native-ui"
        )

    async def forward(client, result):
        return await forwarder._forward_shell_resources(
            client=client,
            session_id="chat",
            bridge_dir=tmp_path / "bridge",
            retry_tracker=forwarder._PostRetryTracker(base_delay_s=0),
            transcript_entries=[
                record.shell_entry
                for record in result.record_items
                if record.shell_entry is not None
            ],
        )

    async with httpx.AsyncClient(
        base_url="http://server",
        headers={"Authorization": "Bearer scoped-owner"},
        transport=httpx.MockTransport(transport),
    ) as client:
        first = read()
        assert await forward(client, first)
        assert posted == []
        with transcript.open("a") as handle:
            for key in ("one", "two"):
                handle.write(
                    json.dumps(
                        {
                            "type": "user",
                            "uuid": f"result-{key}",
                            "is_meta": True,
                            "message": {
                                "role": "user",
                                "content": [
                                    {
                                        "type": "tool_result",
                                        "tool_use_id": f"call-{key}",
                                        "content": "tool result display",
                                    }
                                ],
                            },
                            "toolUseResult": {
                                "backgroundTaskId": f"task-{key}",
                                "stdout": f"actual {key}\n",
                            },
                        }
                    )
                    + "\n"
                )
        results = read(first.byte_offset, first.line_cursor)
        assert not await forward(client, results)
        assert await forward(client, results)
        assert len(posted) == 2
        rows = {row["resource_id"]: row for row in posted[-1]["data"]["shell_resources"]}
        assert set(rows) == {"task-one", "task-two"}
        assert rows["task-one"]["command"] == rows["task-two"]["command"] == "same command"
        assert rows["task-one"]["output_preview"] == "actual one"
        assert rows["task-two"]["output_preview"] == "actual two"
        assert all(not row["can_stop"] and row["session_id"] == "chat" for row in rows.values())
        assert await forward(client, results)
        assert len(posted) == 2
        with transcript.open("a") as handle:
            handle.write(
                json.dumps(
                    {
                        "type": "system",
                        "subtype": "task_notification",
                        "task_id": "task-one",
                        "status": "completed",
                    }
                )
                + "\n"
            )
        completion = read(results.byte_offset, results.line_cursor)
        assert await forward(client, completion)
        assert posted[-1]["data"]["background_task_count"] == 1
        retained = {row["resource_id"]: row for row in posted[-1]["data"]["shell_resources"]}
        assert retained["task-one"]["status"] == "completed"
        assert retained["task-one"]["output_preview"] == "actual one"
        assert retained["task-two"]["status"] == "running"


@pytest.mark.asyncio
async def test_forwarder_posts_visible_transcript_items(tmp_path: Path) -> None:
    """
    The background forwarder reads Claude JSONL and posts Omnigent items.

    This catches the real-Claude failure where a terminal-originated
    prompt/tool/output sequence was written to Claude's transcript
    but no process tailed that transcript into the Omnigent session
    stream.
    """
    bridge_dir = tmp_path / "bridge"
    transcript_path = tmp_path / "session.jsonl"
    transcript_path.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "type": "user",
                        "uuid": "user-1",
                        "message": {"role": "user", "content": "read TODO"},
                    }
                ),
                json.dumps(
                    {
                        "type": "assistant",
                        "uuid": "assistant-tool-1",
                        "message": {
                            "role": "assistant",
                            "content": [
                                {
                                    "type": "tool_use",
                                    "id": "toolu_read_1",
                                    "name": "Read",
                                    "input": {"file_path": "TODO.md"},
                                }
                            ],
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "user",
                        "uuid": "tool-result-1",
                        "parentUuid": "assistant-tool-1",
                        "message": {
                            "role": "user",
                            "content": [
                                {
                                    "type": "tool_result",
                                    "tool_use_id": "toolu_read_1",
                                    "content": "todo contents",
                                }
                            ],
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "attachment",
                        "uuid": "queued-stop",
                        "attachment": {
                            "type": "queued_command",
                            "prompt": "STOP",
                            "commandMode": "prompt",
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "assistant",
                        "uuid": "assistant-text-1",
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "hello from transcript"}],
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "user",
                        "subtype": "local_command",
                        "uuid": "bash-input-1",
                        "content": "<bash-input>pwd</bash-input>",
                    }
                ),
                json.dumps(
                    {
                        "type": "user",
                        "subtype": "local_command",
                        "uuid": "bash-output-1",
                        "content": (
                            "<bash-stdout>/tmp/project</bash-stdout><bash-stderr></bash-stderr>"
                        ),
                    }
                ),
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    record_hook_event(
        bridge_dir,
        {
            "hook_event_name": "Stop",
            "session_id": "claude-session",
            "transcript_path": str(transcript_path),
        },
    )
    server, thread, base_url = _start_recording_server()
    task = asyncio.create_task(
        forward_claude_transcript_to_session(
            base_url=base_url,
            headers={},
            session_id="conv_abc",
            bridge_dir=bridge_dir,
            agent_name="claude-native-ui",
            start_at_end=False,
            poll_interval_s=0.01,
        )
    )
    try:
        # Collect the seven transcript items. The transcript path publishes no
        # session status at all — Claude's status file owns the badge — which
        # ``test_forwarder_publishes_no_status_for_assistant_output`` asserts
        # directly.
        requests = [await _get_recorded_item_request(server) for _index in range(7)]
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        server.shutdown()
        server.server_close()
        thread.join(timeout=5.0)

    assert [request["path"] for request in requests] == ["/v1/sessions/conv_abc/events"] * 7
    assert [request["body"]["type"] for request in requests] == ["external_conversation_item"] * 7
    posted = [request["body"]["data"] for request in requests]
    assert [item["item_type"] for item in posted] == [
        "message",
        "function_call",
        "function_call_output",
        "message",
        "message",
        "terminal_command",
        "terminal_command",
    ]
    # Every item carries its server-side idempotency key: a retried or
    # concurrently re-posted record must dedupe on the server.
    assert all(isinstance(item.get("source_id"), str) and item["source_id"] for item in posted)
    assert posted[0]["item_data"] == {
        "role": "user",
        "content": [{"type": "input_text", "text": "read TODO"}],
    }
    assert posted[1]["item_data"]["name"] == "Read"
    assert posted[1]["item_data"]["call_id"] == "toolu_read_1"
    assert posted[2]["item_data"] == {"call_id": "toolu_read_1", "output": "todo contents"}
    assert posted[3]["item_data"] == {
        "role": "user",
        "content": [{"type": "input_text", "text": "STOP"}],
    }
    assert posted[4]["item_data"] == {
        "role": "assistant",
        "agent": "claude-native-ui",
        "content": [{"type": "output_text", "text": "hello from transcript"}],
    }
    assert posted[5]["item_data"] == {"kind": "input", "input": "pwd"}
    assert posted[6]["item_data"] == {
        "kind": "output",
        "stdout": "/tmp/project",
        "stderr": "",
    }
    assert posted[1]["response_id"] == posted[2]["response_id"]
    assert posted[3]["response_id"] != posted[2]["response_id"]
    assert posted[4]["response_id"] != posted[2]["response_id"]
    assert posted[5]["response_id"] == posted[6]["response_id"]
    assert posted[5]["response_id"] != posted[4]["response_id"]
    assert posted[1]["response_id"].startswith("resp_claude_")


@pytest.mark.asyncio
async def test_forwarder_posts_web_injected_terminal_transcript_items(tmp_path: Path) -> None:
    """
    Web-injected messages still surface only after Claude records them.

    The ``claude-native`` executor no longer owns transcript streaming
    for Omnigent turns. This fails if a leftover pause/cursor path suppresses
    terminal-originated output after a web message was typed into Claude.
    """
    bridge_dir = tmp_path / "bridge"
    transcript_path = tmp_path / "session.jsonl"
    transcript_path.write_text(
        json.dumps(
            {
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "owned by executor"}],
                }
            }
        )
        + "\n",
        encoding="utf-8",
    )
    record_hook_event(
        bridge_dir,
        {
            "hook_event_name": "Stop",
            "session_id": "claude-session",
            "transcript_path": str(transcript_path),
        },
    )
    server, thread, base_url = _start_recording_server()
    task = asyncio.create_task(
        forward_claude_transcript_to_session(
            base_url=base_url,
            headers={},
            session_id="conv_abc",
            bridge_dir=bridge_dir,
            agent_name="claude-native-ui",
            start_at_end=False,
            poll_interval_s=0.01,
        )
    )
    try:
        # The item posts FIRST: the transcript path publishes no status at all
        # (Claude's status file owns the badge), so nothing precedes it.
        request = await _get_recorded_request(server)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        server.shutdown()
        server.server_close()
        thread.join(timeout=5.0)

    assert request["path"] == "/v1/sessions/conv_abc/events"
    assert request["body"]["type"] == "external_conversation_item"
    assert request["body"]["data"]["item_type"] == "message"
    assert request["body"]["data"]["item_data"] == {
        "role": "assistant",
        "agent": "claude-native-ui",
        "content": [{"type": "output_text", "text": "owned by executor"}],
    }
