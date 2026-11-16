# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
"""Built-SPA ordering and recovery on the shared transcript WebSocket."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from playwright.sync_api import Page, WebSocketRoute, expect

from tests.browser_ui.chat.session_contract import message_item
from tests.browser_ui.chat.test_unified_workspace import (
    WorkspaceJourney,
    _view,
)
from tests.browser_ui.chat.test_unified_workspace import (
    browser_errors as browser_errors,
)
from tests.browser_ui.chat.test_unified_workspace import (
    workspace_journey as workspace_journey,
)
from tests.browser_ui.conftest import BrowserContract


@pytest.mark.parametrize("arrival", ["preview-first", "committed-first"])
def test_shared_transcript_orders_and_recovers_without_reloading(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    browser_errors: list[str],
    output_path: str,
    arrival: str,
) -> None:
    """Two visible chats share a socket; late input and lost mutations converge."""
    first, second = workspace_journey.chats
    first.harness = "codex-native"
    q1 = {**message_item("q1", "user", "First request", response_id="turn1"), "position": 0}
    a1 = {
        **message_item("a1", "assistant", "First answer", response_id="turn1"),
        "position": 1,
        "phase": "final_answer",
    }
    q2 = {**message_item("q2", "user", "Second request", response_id="turn2"), "position": 2}
    a2 = {
        **message_item("a2", "assistant", "Second answer", response_id="turn2"),
        "position": 3,
        "phase": "final_answer",
        "stream_message_id": "native-a2",
    }
    first.set_items([a1, q1])
    second.set_items(
        [{**message_item("b1", "assistant", "Other chat answer", response_id="b1"), "position": 0}]
    )
    chats = {chat.session_id: chat for chat in [first, second]}
    revisions = {first.session_id: 2, second.session_id: 1}
    reset_revisions = {first.session_id: 0, second.session_id: 0}
    sockets: list[WebSocketRoute] = []
    commands: list[dict] = []

    def event(session_id: str, payload: dict) -> None:
        sockets[-1].send(
            json.dumps({"type": "session.event", "session_id": session_id, "event": payload})
        )

    def boundary(session_id: str) -> dict:
        items = sorted(chats[session_id]._items, key=lambda item: item["position"])
        return {
            "conversation_id": session_id,
            "last_position": items[-1]["position"] if items else -1,
            "last_item_id": items[-1]["id"] if items else None,
            "item_count": len(items),
            "item_revision": revisions[session_id],
            "reset_revision": reset_revisions[session_id],
            "stream_epoch": "browser-multiplex-epoch",
        }

    def attach(socket: WebSocketRoute) -> None:
        sockets.append(socket)

        def received(raw: str | bytes) -> None:
            message = json.loads(raw)
            commands.append(message)
            if message.get("type") == "subscribe":
                session_id = message["session_id"]
                assert session_id in chats
                state = boundary(session_id)
                event(
                    session_id, {"type": "session.sync", "phase": "start", "reset": True, **state}
                )
                for item in sorted(chats[session_id]._items, key=lambda item: item["position"]):
                    event(session_id, {"type": "response.output_item.done", "item": item})
                event(
                    session_id,
                    {"type": "session.sync", "phase": "complete", "reset": True, **state},
                )
            elif message.get("type") == "unsubscribe":
                socket.send(
                    json.dumps(
                        {"type": "session.unsubscribed", "session_id": message["session_id"]}
                    )
                )

        socket.on_message(received)
        socket.send(json.dumps({"type": "capabilities", "transcript_stream": 1}))

    browser_contract.websocket("**/v1/sessions/updates*", attach)
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(first.url)
    view = _view(page, "Chat A")
    expect(view.get_by_text("First answer", exact=True)).to_be_visible()
    view.get_by_label("Message the agent", exact=True).fill("Keep this unsent draft")
    page.locator(f'aside [data-sidebar-session-id="{second.session_id}"]').click(button="right")
    page.get_by_role("menuitem", name="Open to side", exact=True).click()
    expect(_view(page, "Chat B").get_by_text("Other chat answer", exact=True)).to_be_visible()
    assert len(sockets) == 1
    assert {
        message["session_id"] for message in commands if message.get("type") == "subscribe"
    } == set(chats)
    assert first.stream.connection_generation == second.stream.connection_generation == 0

    # A committed answer arriving before the consumed-input echo used to stay inverted.
    first.set_items([a2, q2, a1, q1])
    revisions[first.session_id] = 4
    if arrival == "preview-first":
        event(
            first.session_id,
            {
                "type": "response.output_text.delta",
                "message_id": "native-a2",
                "index": 0,
                "delta": "Second answer",
                "final": True,
            },
        )
    else:
        event(first.session_id, {"type": "response.output_item.done", "item": a2})
    event(
        first.session_id,
        {
            "type": "session.input.consumed",
            "data": {
                "item_id": "q2",
                "type": "message",
                "position": 2,
                "data": {"role": "user", "user_authored": True, "content": q2["content"]},
            },
        },
    )
    event(first.session_id, {"type": "response.output_item.done", "item": a2})
    event(
        first.session_id,
        {"type": "session.status", "conversation_id": first.session_id, "status": "idle"},
    )
    transcript = view.get_by_role("log")
    expect(transcript.locator('[data-search-item-id="a2"]')).to_have_count(1)

    def order() -> list[str]:
        return transcript.locator("[data-search-item-id]").evaluate_all(
            "nodes => nodes.map(node => node.dataset.searchItemId)"
        )

    assert order() == ["q1", "a1", "q2", "a2"]
    assert len(sockets) == 1
    expect(view.get_by_label("Message the agent", exact=True)).to_have_value(
        "Keep this unsent draft"
    )

    # Lost old-position edits/removals must recover despite an unchanged tail position.
    q1 = {**q1, "content": [{"type": "input_text", "text": "First request revised"}]}
    first.set_items([a2, q2, q1])
    revisions[first.session_id] = reset_revisions[first.session_id] = 5
    event(
        first.session_id,
        {"type": "session.heartbeat", "reconcile_required": True, **boundary(first.session_id)},
    )
    expect(transcript.get_by_text("First request revised", exact=True)).to_be_visible()
    expect(transcript.locator('[data-search-item-id="a1"]')).to_have_count(0)
    expected = order()
    assert expected == ["q1", "q2", "a2"]
    assert len(sockets) == 1
    expect(_view(page, "Chat B").get_by_text("Other chat answer", exact=True)).to_be_visible()
    page.get_by_role("button", name="Close Chat B", exact=True).click()
    expect(_view(page, "Chat B")).to_have_count(0)
    expect(view.get_by_label("Message the agent", exact=True)).to_have_value(
        "Keep this unsent draft"
    )
    page.screenshot(path=str(Path(output_path) / f"multiplex-{arrival}-recovered.png"))

    page.reload()
    expect(view.get_by_text("Second answer", exact=True)).to_be_visible()
    assert order() == expected
    expect(view.get_by_label("Message the agent", exact=True)).to_have_value(
        "Keep this unsent draft"
    )
    assert first.event_posts == second.event_posts == []
    assert browser_errors == []
