# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Claude's authenticated paste and hook confirm the saved peer without replay."""

import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from omnigent.entities.conversation import MessageData, NewConversationItem
from omnigent.harnesses.claude_native import bridge, forwarder
from omnigent.native.communication import peer_model_content
from omnigent.native.input_diagnostics import input_delivery_scope
from omnigent.runtime import pending_inputs
from omnigent.server.startup_inputs import ManagedStartupInputs
from omnigent.stores.conversation_store import PENDING_INPUT_RESPONSE_ID
from tests.server.integration.test_session_orchestration import (
    auth_app as auth_app,
)
from tests.server.integration.test_session_orchestration import (
    peers as peers,
)
from tests.server.integration.test_session_orchestration import (
    startup_permissions as startup_permissions,
)
from tests.server.integration.test_session_orchestration import (
    submitted_peer as submitted_peer,
)
from tests.server.integration.test_sessions_attribution import _bind_runner


@pytest.mark.asyncio
@pytest.mark.parametrize("restart", [False, True])
async def test_claude_peer_paste_hook_forwarder_confirms_one_durable_input(
    auth_client, submitted_peer, db_uri, tmp_path, monkeypatch, restart
):
    _, target, store, saved, _ = submitted_peer
    auth_client.headers.update(_bind_runner(db_uri, target["id"]))
    monkeypatch.setattr(bridge, "_TRUSTED_PARENT", tmp_path)
    bridge_dir = tmp_path / "bridge"
    monkeypatch.setattr(bridge, "_BRIDGE_ROOT", bridge_dir)
    bridge.record_hook_event(
        bridge_dir, {"hook_event_name": "SessionStart", "session_id": "native-peer"}
    )
    body = "\n\n".join(
        part["text"] for part in peer_model_content(saved.data.content, saved.data.communication)
    )
    loaded = []
    monkeypatch.setattr(bridge, "_clear_composer", lambda *_: None)
    monkeypatch.setattr(bridge, "_capture_pane", lambda *_: "draft")
    monkeypatch.setattr(bridge, "_draft_in_input_box", lambda *_: True)
    monkeypatch.setattr(bridge, "_verify_submit_accepted", lambda *_a, **_k: True)
    monkeypatch.setattr(bridge.time, "sleep", lambda *_: None)

    def tmux(_socket, *args):
        if args[0] == "load-buffer":
            loaded.append(Path(args[-1]).read_bytes().decode().replace("\r", "\n").rstrip("\n"))
        if args[-1] == "Enter":
            bridge.record_hook_event(
                bridge_dir,
                {
                    "hook_event_name": "UserPromptSubmit",
                    "session_id": "native-peer",
                    "prompt_id": "prompt-peer",
                    "prompt": loaded[-1],
                },
            )

    monkeypatch.setattr(bridge, "_run_tmux", tmux)
    with input_delivery_scope(
        {
            "input_stable_id": saved.id,
            "delivery_attempt_id": "b" * 32,
            "communication": saved.data.communication.model_dump(),
        }
    ):
        bridge._paste_and_submit(bridge_dir, "/tmp/fake", "main", text=body, needle="peer")
    assert len(loaded) == 1 and loaded[0] != body
    _, [echo] = bridge._transcript_items_from_entry(
        {
            "type": "user",
            "uuid": "echo-peer",
            "sessionId": "native-peer",
            "promptId": "prompt-peer",
            "message": {"role": "user", "content": loaded[0]},
        },
        line_number=1,
        record_offset=None,
        agent_name="claude-native-ui",
        current_response_id=None,
    )
    if restart:
        pending_inputs.reset_for_tests()
    human_content = [{"type": "input_text", "text": "Later human input"}]
    [human] = store.append(
        target["id"],
        [
            NewConversationItem(
                type="message",
                status="in_progress",
                response_id=PENDING_INPUT_RESPONSE_ID,
                data=MessageData(role="user", content=human_content),
            )
        ],
    )
    later = pending_inputs.record(target["id"], human_content, stable_id=human.id)
    host_id = "e" * 32
    store.set_host_id(target["id"], host_id, "/test")
    manager = ManagedStartupInputs(store, Mock())
    dispatched = []

    async def dispatch(context, session_id, event):
        dispatched.append(event.data["stable_id"])
        assert await context.claim(store, session_id)
        return {"pending_id": later}

    manager.dispatch = dispatch
    connection = SimpleNamespace(host_id=host_id)
    # The delivered peer blocks the later human until this exact receipt arrives.
    assert not await manager._recover_session(SimpleNamespace(), target["id"], connection)
    assert not dispatched
    received, waiting = bridge.apply_native_input_receipt(bridge_dir, echo)
    assert not waiting and received.input_stable_id == saved.id
    assert received.data["content"] == [{"type": "input_text", "text": body}]
    await forwarder._post_external_conversation_item(
        auth_client, session_id=target["id"], item=received
    )
    await forwarder._post_external_conversation_item(
        auth_client, session_id=target["id"], item=received
    )
    row = store.get_item(target["id"], saved.id)
    assert row.created_at == saved.created_at and row.position == saved.position
    assert row.data.communication.delivery_state == "confirmed"
    assert row.data.communication.receipt == "transcript"
    assert row.data.content == saved.data.content
    assert [item.id for item in store.list_pending_inputs(target["id"])] == [human.id]
    assert pending_inputs.pending_ids(target["id"]) == [later]
    assert await manager._recover_session(SimpleNamespace(), target["id"], connection)
    await asyncio.gather(*manager._deliveries.values())
    assert dispatched == [human.id]
    await manager.shutdown()
    snapshot = (await auth_client.get(f"/v1/sessions/{target['id']}/items")).json()["data"]
    assert sum(item["id"] == saved.id for item in snapshot) == 1
