# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

"""Runner resource routes use the mapped native thread and preserve the parent."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from omnigent.harnesses.codex_native.app_server import CodexAppServerResponseError
from omnigent.harnesses.codex_native.bridge import CodexNativeBridgeState
from omnigent.runner.native import shell_resources
from omnigent.terminals.history import ActivityEntry


@pytest.mark.parametrize(
    "case",
    ["stop", "read", "missing", "offline", "wrong-owner", "claude", "child", "unrelated-child"],
)
async def test_native_shell_resource_controls_never_interrupt_an_agent_turn(
    monkeypatch, case: str
) -> None:
    child = case in {"child", "unrelated-child"}
    labels = (
        {
            "omnigent.wrapper": "codex-native-ui-subagent",
            "omnigent.codex_native.subagent_thread_id": "child-thread",
        }
        if child
        else {}
    )
    session = {"id": "chat", "parent_session_id": "parent", "labels": labels}
    state = CodexNativeBridgeState(
        session_id="wrong" if case == "wrong-owner" else "parent" if child else "chat",
        socket_path="socket",
        thread_id="parent-thread",
        codex_home="home",
    )
    bridge = AsyncMock(return_value=None if case == "offline" else state)
    calls = []

    async def request(method, params):
        calls.append((method, params))
        assert params["threadId"] == ("child-thread" if child else "parent-thread")
        if method == "thread/backgroundTerminals/list":
            return {
                "result": {
                    "data": []
                    if case == "missing"
                    else [{"itemId": "one", "processId": "vendor-id", "command": "same"}]
                }
            }
        if method == "thread/backgroundTerminals/terminate":
            if params["processId"] == "triune-invalid-process-id":
                raise CodexAppServerResponseError(
                    {
                        "code": -32600,
                        "message": (
                            "invalid background terminal process id: invalid digit found in string"
                        ),
                    }
                )
            assert params["processId"] == "vendor-id"
            return {"result": {"terminated": True}}
        assert method == "thread/turns/list"
        return {
            "result": {
                "data": [
                    {
                        "items": [
                            {
                                "id": "one",
                                "type": "commandExecution",
                                "status": "inProgress",
                                "command": "same",
                                "aggregatedOutput": "captured actual output\n",
                            }
                        ]
                    }
                ]
            }
        }

    native = AsyncMock(request=AsyncMock(side_effect=request))
    monkeypatch.setattr(shell_resources, "client_for_transport", lambda *args, **kwargs: native)
    monkeypatch.setattr(
        shell_resources.side_chat,
        "child_control_capabilities",
        AsyncMock(
            return_value={
                "state": "unknown" if case == "unrelated-child" else "active",
                "reason": "native_parent_mismatch",
            }
        ),
    )
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=session)),
        base_url="http://server",
    ) as server:
        controls = shell_resources.NativeShellResources(server, bridge)
        response = await controls.handle(
            "chat",
            "claude_native" if case == "claude" else "codex_native",
            "one",
            stop=case != "read",
        )
    assert response.status_code == (
        409 if case in {"missing", "offline", "wrong-owner", "claude", "unrelated-child"} else 200
    )
    assert not any(method == "turn/interrupt" for method, params in calls)
    if case in {"offline", "wrong-owner", "claude", "unrelated-child"}:
        assert calls == []
    if case == "read":
        assert json.loads(bytes(response.body))["output_preview"] == "captured actual output"
    if case == "child":
        assert bridge.await_args.args == ("parent",)
        assert all(params["threadId"] == "child-thread" for _, params in calls)


async def test_registered_rows_offer_only_independent_live_terminal_stop() -> None:
    entries = [
        ActivityEntry(
            id=key,
            session_id="chat",
            terminal_id=f"terminal_{key}",
            name="same",
            state="exited" if key == "ended" else "running",
            owner_id="chat",
            output=f"{key} output",
        )
        for key in ("required", "auxiliary", "ended")
    ]
    registry = SimpleNamespace(
        terminal_registry=SimpleNamespace(activity_entries=lambda session_id: entries),
        terminal_resource_role=lambda session_id, terminal_id: None,
        get_terminal_resource=AsyncMock(
            side_effect=lambda session_id, terminal_id: (
                None if terminal_id == "terminal_ended" else object()
            )
        ),
        terminal_can_stop_independently=lambda session_id, terminal_id: (
            terminal_id == "terminal_auxiliary"
        ),
    )
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"id": "chat"})),
        base_url="http://server",
    ) as server:
        controls = shell_resources.NativeShellResources(
            server, AsyncMock(return_value=None), registry
        )
        page = await controls.page("chat")
    rows = {row["resource_id"]: row for row in json.loads(bytes(page.body))["data"]}
    assert not rows["required"]["can_stop"]
    assert rows["auxiliary"]["can_stop"]
    assert rows["auxiliary"]["stop_method"] == "POST"
    assert rows["auxiliary"]["terminal_id"] == "terminal_auxiliary"
    assert rows["ended"]["status"] == "exited"
    assert rows["ended"]["can_open"] and not rows["ended"]["can_stop"]
    assert rows["ended"]["output_preview"] == "ended output"


@pytest.mark.parametrize("stale", [False, True])
async def test_registered_stop_uses_launch_guard_and_preserves_a_replacement(stale: bool) -> None:
    entry = ActivityEntry(
        id="launch-one",
        session_id="chat",
        terminal_id="slot-one",
        name="shell",
        state="running",
        owner_id="chat",
        output="actual output",
    )
    registry = SimpleNamespace(
        terminal_registry=SimpleNamespace(activity_entries=lambda session_id: [entry]),
        terminal_resource_role=lambda session_id, terminal_id: None,
        get_terminal_resource=AsyncMock(return_value=object()),
        terminal_can_stop_independently=lambda session_id, terminal_id: True,
        close_terminal=AsyncMock(return_value=not stale),
    )
    async with httpx.AsyncClient() as server:
        controls = shell_resources.NativeShellResources(server, AsyncMock(), registry)
        result = await controls.handle("chat", "registered_terminal", "launch-one", stop=True)
    assert result.status_code == (409 if stale else 200)
    registry.close_terminal.assert_awaited_once_with(
        "chat", "slot-one", expected_activity_id="launch-one"
    )


@pytest.mark.parametrize(
    "terminal_id,role",
    [
        ("terminal_codex_main", "codex-native"),
        ("terminal_codex_main", None),
        ("terminal_claude_main", "claude-native"),
        ("terminal_tui_main", "omnigent-repl"),
        ("custom-slot", "codex-native"),
    ],
)
async def test_primary_agent_terminal_is_not_a_shell_or_a_stoppable_resource(
    terminal_id, role
) -> None:
    entry = ActivityEntry(
        id="primary-launch",
        session_id="chat",
        terminal_id=terminal_id,
        name="agent",
        state="running",
        owner_id="chat",
    )
    registry = SimpleNamespace(
        terminal_registry=SimpleNamespace(activity_entries=lambda session_id: [entry]),
        terminal_resource_role=lambda session_id, resource_id: role,
        get_terminal_resource=AsyncMock(return_value=object()),
        terminal_can_stop_independently=lambda *args: True,
        close_terminal=AsyncMock(return_value=True),
    )
    async with httpx.AsyncClient() as server:
        controls = shell_resources.NativeShellResources(server, AsyncMock(), registry)
        assert await controls.registered("chat") == []
        response = await controls.handle(
            "chat", "registered_terminal", "primary-launch", stop=True
        )
    assert response.status_code == 409
    registry.close_terminal.assert_not_awaited()
