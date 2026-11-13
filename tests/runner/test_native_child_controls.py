"""Native child control crosses the parent transport without touching its turn."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from omnigent.harnesses.claude_native import bridge as claude_bridge
from omnigent.harnesses.codex_native import bridge, side_chat
from omnigent.harnesses.codex_native.app_server import CodexAppServerResponseError
from omnigent.runner import create_runner_app
from omnigent.runner.native import child_controls
from tests.runner.conftest import _runner_client


def _native_client(*, state: str = "idle", side: bool = True, v2: bool | None = None):
    async def request(method: str, params: dict[str, Any]):
        if method == "thread/read":
            return {
                "result": {
                    "thread": {
                        "id": "native-child",
                        "parentThreadId": "native-parent",
                        "ephemeral": side,
                        "forkedFromId": "native-parent" if side else None,
                        "status": {"type": state},
                        "cliVersion": "0.164.0",
                        **({"canAcceptDirectInput": not v2} if v2 is not None else {}),
                    }
                }
            }
        if method == "thread/turns/list":
            return {"result": {"data": [{"id": "child-turn", "status": "inProgress"}]}}
        if method == "config/read":
            return {"result": {"config": {"features": {"multi_agent_v2": v2}}}}
        return {"result": {"turn": {"id": "new-child-turn"}}}

    return AsyncMock(request=AsyncMock(side_effect=request))


@pytest.mark.parametrize(
    "state,side,v2,reply,steer,stop,reason",
    [
        ("idle", True, None, True, False, False, None),
        ("active", True, None, False, True, True, None),
        ("idle", False, False, True, False, False, None),
        ("active", False, False, False, True, True, None),
        ("idle", False, True, False, False, False, "native_direct_input_unavailable"),
        ("active", False, True, False, False, True, "native_direct_input_unavailable"),
        ("idle", False, None, False, False, False, "native_input_support_unknown"),
        ("notLoaded", True, None, False, False, False, "native_child_not_loaded"),
    ],
)
async def test_capabilities_require_loaded_runtime_and_known_input_support(
    state,
    side,
    v2,
    reply,
    steer,
    stop,
    reason,
):
    client = _native_client(state=state, side=side, v2=v2)
    result = await side_chat.child_control_capabilities(client, "native-child", "native-parent")
    assert (result["can_reply"], result["can_steer"], result["can_stop"]) == (reply, steer, stop)
    assert result["version"] == 1 and result["reason"] == reason
    assert all(
        call.args[0] not in {"turn/start", "turn/steer", "turn/interrupt"}
        for call in client.request.await_args_list
    )


@pytest.mark.parametrize(
    "agent_type", ["Explore", "Plan", "general-purpose", "custom-reviewer", None]
)
def test_claude_exposes_only_controls_its_parent_bridge_can_invoke(agent_type):
    result = claude_bridge.child_control_capabilities(agent_type)
    assert not any(result[name] for name in ("can_reply", "can_steer", "can_stop"))
    assert result["reason"] == (
        "native_child_one_shot"
        if agent_type in {"Explore", "Plan"}
        else "native_parent_send_message_unavailable"
    )


@pytest.mark.parametrize("version,matching", [("v1", True), ("v2", True), ("v1", False)])
async def test_child_input_uses_recorded_version_when_native_capability_is_absent(
    tmp_path: Path,
    version: str,
    matching: bool,
):
    path = tmp_path / "child.jsonl"
    path.write_text(
        json.dumps(
            {
                "type": "session_meta",
                "payload": {
                    "id": "native-child" if matching else "unrelated",
                    "multi_agent_version": version,
                },
            }
        )
        + "\n"
    )
    client = _native_client(side=False)
    request = client.request.side_effect

    async def with_rollout(method, params):
        result = await request(method, params)
        if method == "thread/read":
            result["result"]["thread"]["path"] = str(path)
        return result

    client.request.side_effect = with_rollout
    result = await side_chat.child_control_capabilities(client, "native-child", "native-parent")
    assert result["can_reply"] == (matching and version == "v1")
    if matching and version == "v2":
        assert result["reason"] == "native_v2_targeted_input_unavailable"


@pytest.mark.parametrize(
    "case", ["reply", "steer", "stop", "changed", "unrelated", "mapping", "offline", "refusal"]
)
async def test_mapped_http_controls_preserve_parent_and_report_acceptance(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    case: str,
):
    parent_id, child_id = "a" * 32, "b" * 32
    monkeypatch.setattr(bridge, "_BRIDGE_ROOT", tmp_path / "bridges")
    bridge_dir = bridge.bridge_dir_for_bridge_id(parent_id)
    parent_state = bridge.CodexNativeBridgeState(
        session_id=parent_id,
        socket_path="ws://127.0.0.1:9999",
        thread_id="native-parent",
        codex_home=str(tmp_path / "codex"),
        active_turn_id="parent-turn",
    )
    if case != "offline":
        bridge.write_bridge_state(bridge_dir, parent_state)
    native_client = _native_client(state="idle" if case == "reply" else "active")
    request = native_client.request.side_effect

    async def native_request(method, params):
        if case == "refusal" and method == "turn/steer":
            raise CodexAppServerResponseError({"code": -32600, "message": "turn changed"})
        response = await request(method, params)
        if case == "unrelated" and method == "thread/read":
            response["result"]["thread"].update(parentThreadId="other", forkedFromId="other")
        return response

    native_client.request.side_effect = native_request
    monkeypatch.setattr(child_controls, "client_for_transport", lambda *a, **kw: native_client)
    child = {
        "id": child_id,
        "kind": "sub_agent",
        "parent_session_id": parent_id,
        "labels": {
            "omnigent.wrapper": "codex-native-ui-subagent",
            "omnigent.codex_native.subagent_thread_id": "native-child",
        },
    }

    def server(request: httpx.Request):
        return httpx.Response(
            200,
            json={
                "data": [] if case == "mapping" else [child],
                "labels": {},
            },
        )

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(server), base_url="http://server"
    ) as upstream:
        app = create_runner_app(server_client=upstream, auth_token="runner-token")
        path = f"/v1/sessions/{parent_id}/native-children/{child_id}"
        async with _runner_client(app) as client:
            assert (await client.get(path + "/capabilities")).status_code == 401
            response = await client.post(
                path + "/control",
                headers={"Authorization": "Bearer runner-token"},
                json={
                    "action": "stop" if case == "stop" else "message",
                    "content": [{"type": "input_text", "text": "  Keep indentation"}],
                    "stable_id": "c" * 32,
                    **({"expected_turn_id": "old-turn"} if case == "changed" else {}),
                },
            )
    assert response.status_code == {
        "mapping": 404,
        "offline": 409,
        "unrelated": 409,
        "changed": 409,
        "refusal": 409,
    }.get(case, 202), response.text
    writes = [
        call for call in native_client.request.await_args_list if call.args[0].startswith("turn/")
    ]
    if case in {"reply", "steer", "stop"}:
        assert response.json()["accepted"] is True and response.json()["consumed"] is False
        assert len(writes) == 1
        method, params = writes[0].args
        assert (
            method
            == {"reply": "turn/start", "steer": "turn/steer", "stop": "turn/interrupt"}[case]
        )
        assert params["threadId"] == "native-child"
        if case != "stop":
            assert params["clientUserMessageId"] == "omnigent-input:" + "c" * 32
            assert params["input"][0]["text"] == "  Keep indentation"
        if case == "steer":
            assert params["expectedTurnId"] == "child-turn"
    elif case != "refusal":
        assert not writes
    if case != "offline":
        assert bridge.read_bridge_state(bridge_dir) == parent_state
