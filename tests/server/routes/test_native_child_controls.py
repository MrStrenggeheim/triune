"""Web events reach the parent's native connection with child identity intact."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest

from omnigent.harnesses.codex_native import bridge
from omnigent.runner import create_runner_app
from omnigent.runner.native import child_controls
from omnigent.runtime import pending_inputs
from omnigent.server.auth import LEVEL_READ
from omnigent.server.routes import sessions
from omnigent.server.routes._sessions import orchestration
from omnigent.server.routes.sessions import routes_events
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.stores.permission_store.sqlalchemy_store import SqlAlchemyPermissionStore
from tests.runner.conftest import _runner_client
from tests.runner.test_native_child_controls import _native_client
from tests.server.helpers import create_test_agent


@pytest.mark.parametrize("action", ["reply", "steer", "stop", "v2", "changed", "claude"])
async def test_browser_child_event_uses_native_parent_with_truthful_receipts(
    client: httpx.AsyncClient,
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    action: str,
):
    agent = await create_test_agent(client)
    store = SqlAlchemyConversationStore(db_uri)
    parent = store.create_conversation(agent_id=agent["id"])
    child = store.create_conversation(
        agent_id=agent["id"],
        kind="sub_agent",
        parent_conversation_id=parent.id,
        sub_agent_name="general-purpose",
        labels={
            "omnigent.wrapper": "claude-code-native-ui-subagent"
            if action == "claude"
            else "codex-native-ui-subagent",
            "omnigent.codex_native.subagent_thread_id": "native-child",
        },
    )
    for row in (parent, child):
        store.set_runner_id(row.id, "test-runner")
    monkeypatch.setattr(bridge, "_BRIDGE_ROOT", tmp_path / "bridges")
    bridge_dir = bridge.bridge_dir_for_bridge_id(parent.id)
    parent_state = bridge.CodexNativeBridgeState(
        session_id=parent.id,
        socket_path="ws://127.0.0.1:9999",
        thread_id="native-parent",
        codex_home=str(tmp_path / "codex"),
        active_turn_id="parent-turn",
    )
    bridge.write_bridge_state(bridge_dir, parent_state)
    native = _native_client(
        state="idle" if action in {"reply", "changed"} else "active",
        side=action != "v2",
        v2=True if action == "v2" else None,
    )
    monkeypatch.setattr(child_controls, "client_for_transport", lambda *a, **kw: native)
    initialize = AsyncMock()
    stop_parent = AsyncMock()
    monkeypatch.setattr(routes_events, "_ensure_runner_session_initialized", initialize)
    monkeypatch.setattr(routes_events, "_stop_host_runner_intentionally", stop_parent)
    runner = create_runner_app(server_client=client)
    stable_id = "d" * 32
    content = [{"type": "input_text", "text": "  Targeted instruction"}]
    payload = (
        {
            "type": "message",
            "data": {
                "role": "user",
                "content": content,
                "stable_id": stable_id,
                "native_child_action": "steer" if action in {"steer", "changed"} else "message",
            },
        }
        if action != "stop"
        else {"type": "stop_session"}
    )
    async with _runner_client(runner) as runner_client:
        monkeypatch.setattr(sessions, "_get_runner_client", AsyncMock(return_value=runner_client))
        response = await client.post(f"/v1/sessions/{child.id}/events", json=payload)
        assert response.status_code == (409 if action in {"v2", "changed", "claude"} else 202), (
            response.text
        )
        capability_response = await client.get(
            f"/v1/sessions/{child.id}/native-child-capabilities"
        )
        assert capability_response.status_code == 200, capability_response.text
        assert capability_response.json()["version"] == 1
        assert capability_response.json()["can_stop"] == (action in {"steer", "stop", "v2"})
        initialize.assert_not_awaited()
        stop_parent.assert_not_awaited()
        assert not store.list_items(child.id).data
        if action in {"reply", "steer"}:
            pending = pending_inputs.snapshot_for(child.id)
            assert len(pending) == 1 and pending[0]["content"] == content
            assert response.json()["pending_id"] == pending[0]["pending_id"]
            repeated = await client.post(f"/v1/sessions/{child.id}/events", json=payload)
            assert repeated.status_code == 202 and repeated.json() == response.json()
            conflicting = {
                **payload,
                "data": {
                    **payload["data"],
                    "content": [{"type": "input_text", "text": "different"}],
                },
            }
            assert (
                await client.post(f"/v1/sessions/{child.id}/events", json=conflicting)
            ).status_code == 409
            writes = [
                call for call in native.request.await_args_list if call.args[0].startswith("turn/")
            ]
            assert len(writes) == 1
            capabilities = await orchestration._native_child_capabilities_for_snapshot(
                store.get_conversation(child.id),
                store,
                None,
            )
            assert capabilities["version"] == 1
            assert capabilities["can_reply" if action == "reply" else "can_steer"]
        else:
            assert not pending_inputs.snapshot_for(child.id)
    assert bridge.read_bridge_state(bridge_dir) == parent_state


async def test_native_child_capabilities_require_read_and_actions_require_edit(
    auth_client: httpx.AsyncClient,
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
):
    store = SqlAlchemyConversationStore(db_uri)
    parent = store.create_conversation()
    child = store.create_conversation(
        kind="sub_agent",
        parent_conversation_id=parent.id,
        sub_agent_name="Explore",
        labels={"omnigent.wrapper": "claude-code-native-ui-subagent"},
    )
    permissions = SqlAlchemyPermissionStore(db_uri)
    reader = "native-reader@example.test"
    permissions.ensure_user(reader)
    permissions.grant(reader, parent.id, LEVEL_READ)
    lookup = AsyncMock()
    monkeypatch.setattr(sessions, "_get_runner_client", lookup)
    path = f"/v1/sessions/{child.id}"
    response = await auth_client.get(
        path + "/native-child-capabilities",
        headers={"X-Forwarded-Email": reader},
    )
    assert response.status_code == 200
    assert response.json()["reason"] == "native_child_one_shot"
    for identity in ("unrelated@example.test",):
        response = await auth_client.get(
            path + "/native-child-capabilities",
            headers={"X-Forwarded-Email": identity},
        )
        assert response.status_code == 404
    response = await auth_client.post(
        path + "/events",
        headers={"X-Forwarded-Email": reader},
        json={"type": "stop_session"},
    )
    assert response.status_code == 403
    lookup.assert_not_awaited()
