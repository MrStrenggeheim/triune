# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
"""Built-SPA ordering and recovery on the shared transcript WebSocket."""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
from playwright.sync_api import Page, WebSocketRoute, expect

from tests.browser_ui.chat.session_contract import message_item
from tests.browser_ui.chat.test_recovery_activity_contract import _activity_item
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


@pytest.mark.parametrize("width", [1440, 390], ids=["desktop", "phone"])
@pytest.mark.parametrize("versioned", [False, True], ids=["legacy", "feed2"])
def test_readiness_heartbeat_waits_for_history_then_displays_live_progress(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    browser_errors: list[str],
    width: int,
    versioned: bool,
) -> None:
    """A delayed initial replay must keep its subscription after the ready heartbeat."""
    chat = workspace_journey.chats[0]
    saved = {
        **message_item("ready-saved", "assistant", "Saved reply", response_id="ready-turn"),
        "position": 0,
        "phase": "final_answer",
    }
    chat.set_items([saved])
    history_reads = []
    page.on(
        "request",
        lambda request: (
            history_reads.append(request.url)
            if urlparse(request.url).path.endswith(f"/sessions/{chat.session_id}/items")
            else None
        ),
    )
    sockets: list[WebSocketRoute] = []
    subscriptions: list[dict] = []
    boundary = {
        "conversation_id": chat.session_id,
        "last_position": 0,
        "last_item_id": saved["id"],
        "item_count": 1,
        "item_revision": 1,
        "reset_revision": 0,
        "stream_epoch": "feed2:browser" if versioned else "ready-first-browser",
    }

    def event(payload: dict) -> None:
        sockets[-1].send(
            json.dumps(
                {
                    "type": "session.event",
                    "session_id": chat.session_id,
                    "event": payload,
                    **(
                        {"subscription_id": subscriptions[-1]["subscription_id"]}
                        if versioned
                        else {}
                    ),
                }
            )
        )

    def attach(socket: WebSocketRoute) -> None:
        sockets.append(socket)

        def received(raw: str | bytes) -> None:
            command = json.loads(raw)
            if command.get("type") == "subscribe":
                subscriptions.append(command)
                event({"type": "session.heartbeat", **boundary})

        socket.on_message(received)
        socket.send(
            json.dumps(
                {
                    "type": "capabilities",
                    "transcript_stream": 1,
                    **(
                        {
                            "transcript_window": 1,
                            "transcript_feed": 2,
                            "transcript_feed_default": 2,
                        }
                        if versioned
                        else {}
                    ),
                }
            )
        )

    browser_contract.websocket("**/v1/sessions/updates*", attach)
    page.add_init_script("""(() => {
      window.__readyHeartbeatCount = 0;
      const Original = window.WebSocket;
      window.WebSocket = class extends Original {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', event => {
            if (typeof event.data !== 'string') return;
            const frame = JSON.parse(event.data);
            if (frame.type === 'session.event' && frame.event?.type === 'session.heartbeat')
              window.__readyHeartbeatCount++;
          });
        }
      };
    })()""")
    page.set_viewport_size({"width": width, "height": 844 if width == 390 else 1000})
    page.goto(chat.url)
    page.wait_for_function("window.__readyHeartbeatCount > 0")
    # Hold replay after readiness, allowing the client to process that frame alone.
    page.wait_for_timeout(250)
    assert len(subscriptions) == 1
    event({"type": "session.sync", "phase": "start", "reset": True, **boundary})
    event(
        {"type": "session.snapshot_page", "items": [saved]}
        if versioned
        else {"type": "response.output_item.done", "item": saved}
    )
    event({"type": "session.sync", "phase": "complete", "reset": True, **boundary})
    view = _view(page, "Chat A")
    expect(view.get_by_text("Saved reply", exact=True)).to_be_visible()
    composer = view.get_by_label("Message the agent", exact=True)
    composer.fill("Preserve my draft")
    # A visible window must keep its multiplex membership when another window
    # gains focus. The legacy SSE origin-slot policy remains a separate contract.
    page.evaluate("window.dispatchEvent(new Event('blur'))")
    canonical = [saved]
    for position in (1, 2):
        live = {
            **message_item(
                f"ready-live-{position}",
                "assistant",
                f"Live progress {position}",
                response_id=f"ready-live-turn-{position}",
            ),
            "position": position,
            "phase": "commentary",
        }
        canonical.append(live)
        event(
            {
                "type": "response.output_item.done",
                "item": live,
                **({"_change_revision": position + 1} if versioned else {}),
            }
        )
        expect(view.get_by_text(f"Live progress {position}", exact=True)).to_be_visible()
    if versioned:
        event(
            {
                "type": "session.heartbeat",
                **boundary,
                "item_count": 3,
                "last_position": 2,
                "item_revision": 3,
                "last_item_id": canonical[-1]["id"],
                "reconcile_required": False,
            }
        )
        page.wait_for_function("window.__readyHeartbeatCount === 2")
        # The sidebar may read one latest item for its preview.
        assert all(parse_qs(urlparse(url).query).get("limit") == ["1"] for url in history_reads)
    assert len(subscriptions) == 1
    expect(composer).to_have_value("Preserve my draft")
    page.evaluate("window.dispatchEvent(new Event('focus'))")
    expect(view.get_by_text("Live progress 2", exact=True)).to_be_visible()
    assert len(subscriptions) == 1

    # A replacement socket and changed epoch still need a completed replay;
    # readiness must neither clear displayed history nor restart the membership.
    if versioned:
        event(
            {
                "type": "session.status",
                "conversation_id": chat.session_id,
                "status": "running",
                "response_id": "away-turn",
            }
        )
        expect(view.get_by_test_id("working-indicator")).to_be_visible()
        page.evaluate("""() => {
            Object.defineProperty(document, 'hidden', {value: true, configurable: true});
            Object.defineProperty(document, 'visibilityState', {
                value: 'hidden', configurable: true
            });
            document.dispatchEvent(new Event('visibilitychange'));
        }""")
        canonical.append(
            {
                **message_item(
                    "ready-final", "assistant", "Finished while away", response_id="away-turn"
                ),
                "position": 3,
                "phase": "final_answer",
            }
        )
        chat.set_items(list(reversed(canonical)))
        # The runner finishes during the gap. Only the metadata read can report the idle state.
        chat.update_session(status="running", active_response_id="away-turn")
    boundary.update(
        last_position=canonical[-1]["position"],
        last_item_id=canonical[-1]["id"],
        item_count=len(canonical),
        item_revision=len(canonical),
        stream_epoch="feed2:reconnected" if versioned else "ready-first-reconnected",
    )
    sockets[-1].close(code=1012, reason="Fixture server restart")
    if versioned:
        page.evaluate("""() => {
            delete document.hidden;
            delete document.visibilityState;
            document.dispatchEvent(new Event('visibilitychange'));
        }""")
    page.wait_for_function("n => window.__readyHeartbeatCount >= n", arg=3 if versioned else 2)
    page.wait_for_timeout(250)
    assert len(subscriptions) == 2
    expect(view.get_by_text("Live progress 2", exact=True)).to_be_visible()
    event({"type": "session.sync", "phase": "start", "reset": True, **boundary})
    for item in canonical:
        event({"type": "response.output_item.done", "item": item})
    event({"type": "session.sync", "phase": "complete", "reset": True, **boundary})
    expect(view.get_by_text("Saved reply", exact=True)).to_have_count(1)
    if versioned:
        expect(view.get_by_text("Finished while away", exact=True)).to_be_visible()
        expect(view.get_by_test_id("working-indicator")).to_be_visible()
        chat.update_session(status="idle", active_response_id=None)
        expect(view.get_by_test_id("working-indicator")).to_have_count(0, timeout=12_000)
    for position in (1, 2):
        expect(view.get_by_text(f"Live progress {position}", exact=True)).to_have_count(1)
    expect(composer).to_have_value("Preserve my draft")
    assert len(subscriptions) == 2
    diagnostic_key = "triune:convergence:v1"
    page.wait_for_function(
        """key => {
          const records = JSON.parse(localStorage.getItem(key) || '{}').records || [];
          return records.some(row => row.stage === 'displayed' && row.itemId === 'ready-live-2'
            && typeof row.attemptId === 'string');
        }""",
        arg=diagnostic_key,
    )
    before_reload = page.evaluate("key => localStorage.getItem(key)", diagnostic_key)
    assert len(before_reload.encode()) <= 64_000
    assert all(
        text not in before_reload for text in ("Saved reply", "Live progress", "Preserve my draft")
    )
    retained_attempts = {
        row["attemptId"] for row in json.loads(before_reload)["records"] if row.get("attemptId")
    }
    page.reload()
    page.wait_for_function("window.__readyHeartbeatCount >= 1")
    event({"type": "session.sync", "phase": "start", "reset": True, **boundary})
    for item in canonical:
        event({"type": "response.output_item.done", "item": item})
    event({"type": "session.sync", "phase": "complete", "reset": True, **boundary})
    expect(view.get_by_text("Live progress 2", exact=True)).to_be_visible()
    expect(composer).to_have_value("Preserve my draft")
    page.wait_for_function(
        """({key, previous}) => {
          const records = JSON.parse(localStorage.getItem(key) || '{}').records || [];
          return records.some(row => row.stage === 'displayed' && row.attemptId
            && !previous.includes(row.attemptId));
        }""",
        arg={"key": diagnostic_key, "previous": sorted(retained_attempts)},
    )
    records = page.evaluate("key => JSON.parse(localStorage.getItem(key)).records", diagnostic_key)
    assert retained_attempts & {row.get("attemptId") for row in records}
    assert {"received", "accepted", "displayed"} <= {row["stage"] for row in records}
    assert browser_errors == []


@pytest.mark.parametrize(
    ("arrival", "input_order", "echo_type"),
    [
        ("preview-first", ("canonical", "consumed", "ack"), "done"),
        ("preview-first", ("consumed", "canonical", "ack"), "updated"),
        ("committed-first", ("ack", "canonical", "consumed"), "done"),
        ("committed-first", ("consumed", "ack", "canonical"), "updated"),
        ("committed-first", ("canonical", "ack"), "done"),
    ],
    ids=[
        "canonical-consumed-ack",
        "consumed-canonical-ack",
        "ack-canonical-consumed",
        "consumed-ack-canonical",
        "native-alias-lost-consumed",
    ],
)
def test_shared_transcript_orders_and_recovers_without_reloading(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    browser_errors: list[str],
    output_path: str,
    arrival: str,
    input_order: tuple[str, ...],
    echo_type: str,
) -> None:
    """Two visible chats share a socket; late input and lost mutations converge."""
    first, second = workspace_journey.chats
    first.harness = "codex-native"
    q1 = {**message_item("q1", "user", "First request", response_id="turn1"), "position": 10}
    a1 = {
        **message_item("a1", "assistant", "First answer", response_id="turn1"),
        "position": 11,
        "phase": "final_answer",
    }
    q2 = {**message_item("q2", "user", "Second request", response_id="turn2"), "position": 12}
    a2 = {
        **message_item("a2", "assistant", "Second answer", response_id="turn2"),
        "position": 13,
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
                event(session_id, {"type": "session.heartbeat", **state})
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
    # STREAM-CONTENT-11 browser coverage: actual optimistic input and native content updates.
    pending_send = []

    def hold_input(route) -> None:
        first.event_posts.append({"url": route.request.url, "body": route.request.post_data_json})
        pending_send.append(route)

    browser_contract.route(
        browser_contract._matcher(f"/v1/sessions/{first.session_id}/events"), hold_input
    )
    composer = view.get_by_label("Message the agent", exact=True)
    try:
        composer.fill("Second request")
        with page.expect_request(
            lambda request: (
                request.method == "POST"
                and request.url.endswith(f"/v1/sessions/{first.session_id}/events")
            )
        ):
            composer.press("Enter")
        expect(view.get_by_text("Second request", exact=True)).to_be_visible()
        assert len(pending_send) == 1
        stable_id = first.event_posts[0]["body"]["data"]["stable_id"]
        assert isinstance(stable_id, str) and stable_id
        if "consumed" not in input_order:
            q2 = {**q2, "id": "native-q2", "input_stable_id": stable_id}
        else:
            q2 = {**q2, "id": stable_id}

        def assert_pending_before(reply) -> None:
            pending = view.get_by_text("Second request", exact=True)
            assert pending.evaluate(
                "(node, reply) => !!(node.compareDocumentPosition(reply) "
                "& Node.DOCUMENT_POSITION_FOLLOWING)",
                reply.element_handle(),
            )
            expect(
                _view(page, "Chat B").get_by_text("Other chat answer", exact=True)
            ).to_be_visible()
            expect(
                _view(page, "Chat B").get_by_text("Second preview (gap)", exact=True)
            ).to_have_count(0)

        if arrival == "preview-first":
            preview = view.locator('[data-search-item-id="live:native-a2"]')

            def delta(index: int, text: str, final: bool = False) -> None:
                event(
                    first.session_id,
                    {
                        "type": "response.output_text.delta",
                        "message_id": "native-a2",
                        "index": index,
                        "delta": text,
                        "final": final,
                    },
                )

            delta(0, "Second ")
            expect(preview).to_contain_text("Second")
            assert_pending_before(preview)
            delta(1, "preview")
            expect(preview).to_contain_text("Second preview")
            assert_pending_before(preview)
            delta(1, "preview")  # Duplicate index must not append the suffix twice.
            delta(0, "Second ")  # Replay the same indexed prefix over the actual socket.
            delta(1, "preview")
            page.wait_for_timeout(100)
            expect(preview).to_contain_text("Second preview")
            expect(preview).not_to_contain_text("previewpreview")
            delta(3, " (gap)")  # Missing index 2 deliberately leaves incomplete preview text.
            expect(preview).to_contain_text("Second preview (gap)")
            delta(4, "", final=True)
            assert_pending_before(preview)
            page.screenshot(
                path=str(Path(output_path) / "native-preview-gap-before-canonical.png")
            )
        else:
            event(first.session_id, {"type": "response.output_item.done", "item": a2})
        if arrival == "committed-first":
            assert_pending_before(view.locator('[data-search-item-id="a2"]'))
        first.set_items([a2, q2, a1, q1])
        revisions[first.session_id] = 4
        transcript = view.get_by_role("log")

        def checkpoint(label: str, *, user_count: int = 1) -> None:
            # A rendered done frame drains earlier frames before negative assertions.
            marker = f"Second answer ({label})"
            event(
                first.session_id,
                {
                    "type": "response.output_item.done",
                    "item": {**a2, "content": [{"type": "output_text", "text": marker}]},
                },
            )
            expect(transcript.get_by_text(marker, exact=True)).to_be_visible(timeout=5_000)
            expect(transcript.get_by_text("Second request", exact=True)).to_have_count(
                user_count, timeout=5_000
            )
            expect(
                page.get_by_text("Activity update is unavailable in the loaded history.")
            ).to_have_count(0)

        for step in input_order:
            if step == "ack":
                pending_send[0].fulfill(json={"queued": True, "item_id": "pending-q2"})
                pending_send.pop(0)
                expect(composer).to_have_value("")
                composer.fill("Keep this unsent draft")
            elif step == "canonical":
                # Generic user updated frames are ignored; consumed must establish the item.
                if echo_type == "updated":
                    expect(
                        transcript.locator(f'[data-user-message-id="{q2["id"]}"]')
                    ).to_have_count(1, timeout=5_000)
                event(first.session_id, {"type": f"response.output_item.{echo_type}", "item": q2})
            else:
                event(
                    first.session_id,
                    {
                        "type": "session.input.consumed",
                        "data": {
                            "item_id": q2["id"],
                            "cleared_pending_id": "pending-q2",
                            "response_id": "turn2",
                            "type": "message",
                            "position": 12,
                            "data": {
                                "role": "user",
                                "user_authored": True,
                                "content": q2["content"],
                            },
                        },
                    },
                )
            checkpoint(step)
    finally:
        # Release a held POST even when a preview or duplicate-bubble assertion fails.
        while pending_send:
            pending_send.pop(0).fulfill(json={"queued": True, "item_id": "pending-q2"})
    for replay_type in ("done", "updated"):
        # Updated is only an ignored replay control after canonical done, not generic support.
        event(first.session_id, {"type": f"response.output_item.{replay_type}", "item": q2})
        checkpoint(f"replayed-{replay_type}")
    event(first.session_id, {"type": "response.output_item.done", "item": a2})
    event(
        first.session_id,
        {"type": "session.status", "conversation_id": first.session_id, "status": "idle"},
    )
    expect(transcript.locator('[data-search-item-id="a2"]')).to_have_count(1)
    expect(transcript.locator('[data-search-item-id="a2"]')).to_contain_text("Second answer")
    expect(transcript.locator('[data-search-item-id="live:native-a2"]')).to_have_count(0)
    expect(transcript.get_by_text("Second preview (gap)", exact=True)).to_have_count(0)
    expect(transcript.get_by_text("Second request", exact=True)).to_have_count(1)

    def order() -> list[str]:
        return transcript.locator("[data-search-item-id]").evaluate_all(
            "nodes => nodes.map(node => node.dataset.searchItemId)"
        )

    assert order() == ["q1", "a1", q2["id"], "a2"]
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
    assert expected == ["q1", q2["id"], "a2"]
    # An older positioned activity update must not enter legacy window recovery.
    activity = {
        **_activity_item("old-child", "older-worker-card", "worker-dispatch", "returned"),
        "position": 5,
    }
    first.set_items([a2, q2, q1, activity])
    revisions[first.session_id] = reset_revisions[first.session_id] = 6
    for _ in range(2):
        event(first.session_id, {"type": "response.output_item.updated", "item": activity})
    activity_group = transcript.get_by_role("button", name=re.compile(r"\d+ subagents?"))
    expect(activity_group).to_be_visible()
    activity_group.click()
    expect(transcript.get_by_test_id("subagent-activity")).to_have_count(1)
    expect(transcript.get_by_text("Curie", exact=True)).to_be_visible()
    expect(
        page.get_by_text("Activity update is unavailable in the loaded history.")
    ).to_have_count(0)
    expected = order()
    assert transcript.get_by_test_id("subagent-activity").evaluate("""element =>
      !!(element.compareDocumentPosition(document.querySelector('[data-search-item-id="q1"]'))
        & Node.DOCUMENT_POSITION_FOLLOWING)""")
    assert len(sockets) == 1
    expect(_view(page, "Chat B").get_by_text("Other chat answer", exact=True)).to_be_visible()

    # Terminal cache notifications and their saved rows are not missing child activity.
    for index in range(2):
        resource = {
            "id": f"terminal_bash_{index}",
            "object": "session.resource",
            "type": "terminal",
            "session_id": first.session_id,
            "name": f"bash:{index}",
            "environment": f"env_terminal_bash_{index}",
            "metadata": {"terminal_name": "bash", "session_key": str(index), "running": True},
        }
        terminal_item = {
            "id": f"terminal-created-{index}",
            "type": "resource_event",
            "status": "completed",
            "response_id": first.session_id,
            "position": 15 + index,
            "created_at": 1_700_000_000,
            "event_type": "session.resource.created",
            "resource_type": "terminal",
            "resource_id": resource["id"],
            "resource": resource,
        }
        first.set_items([terminal_item, *first._items])
        event(first.session_id, {"type": "session.resource.created", "resource": resource})
        event(first.session_id, {"type": "response.output_item.done", "item": terminal_item})
        checkpoint(f"terminal-{index}")
    revisions[first.session_id] = 8
    event(first.session_id, {"type": "response.output_item.done", "item": a2})
    expect(transcript.get_by_text("Second answer", exact=True)).to_be_visible()
    expected = order()
    page.get_by_role("button", name="Close Chat B", exact=True).click()
    expect(_view(page, "Chat B")).to_have_count(0)
    expect(view.get_by_label("Message the agent", exact=True)).to_have_value(
        "Keep this unsent draft"
    )
    page.screenshot(path=str(Path(output_path) / f"multiplex-{arrival}-recovered.png"))

    page.reload()
    expect(view.get_by_text("Second answer", exact=True)).to_be_visible()
    assert order() == expected
    expect(transcript.get_by_text("Second request", exact=True)).to_have_count(1)
    expect(transcript.locator(f'[data-user-message-id="{q2["id"]}"]')).to_have_count(1)

    # Text equality must not collapse two intentionally distinct canonical inputs.
    repeated = {
        **message_item("q2-distinct", "user", "Second request", response_id="turn3"),
        "position": 14,
    }
    first.set_items([repeated, *first._items])
    revisions[first.session_id] = 9
    event(first.session_id, {"type": "response.output_item.done", "item": repeated})
    checkpoint("distinct-inputs", user_count=2)
    event(first.session_id, {"type": "response.output_item.done", "item": a2})
    expect(transcript.get_by_text("Second answer", exact=True)).to_be_visible()
    expected = order()
    page.reload()
    expect(view.get_by_text("Second answer", exact=True)).to_be_visible()
    assert order() == expected
    expect(transcript.get_by_text("Second request", exact=True)).to_have_count(2)
    for item_id in (q2["id"], "q2-distinct"):
        expect(transcript.locator(f'[data-user-message-id="{item_id}"]')).to_have_count(1)
    expect(
        page.get_by_text("Activity update is unavailable in the loaded history.")
    ).to_have_count(0)
    expect(view.get_by_label("Message the agent", exact=True)).to_have_value(
        "Keep this unsent draft"
    )
    assert len(first.event_posts) == 1
    assert "Second request" in json.dumps(first.event_posts[0]["body"])
    assert second.event_posts == []
    assert browser_errors == []


@pytest.mark.parametrize("width", [1440, 390], ids=["desktop", "phone"])
def test_bounded_initial_history_preserves_an_older_reader_window(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    browser_errors: list[str],
    output_path: str,
    width: int,
    request: pytest.FixtureRequest,
) -> None:
    """Cold replay is bounded; older navigation extends subsequent reset coverage."""
    chat = workspace_journey.chats[0]
    items = [
        {
            **message_item(
                f"window-{index}",
                "user" if index % 2 == 0 else "assistant",
                f"History item {index}",
                response_id=f"window-turn-{index // 2}",
            ),
            "position": index,
            **({"phase": "final_answer"} if index % 2 else {}),
        }
        for index in range(10_000)
    ]
    chat.set_items(list(reversed(items)))
    subscriptions: list[dict] = []
    pages: list[dict] = []
    sockets: list[WebSocketRoute] = []
    replay_sizes: list[int] = []
    resumed_frame_counts: list[int] = []
    transport_ledger: list[dict] = []
    phase = "initial"

    def save_transport_ledger() -> None:
        Path(output_path).mkdir(parents=True, exist_ok=True)
        (Path(output_path) / "bounded-history-transport.json").write_text(
            json.dumps(
                {"transport": transport_ledger, "resumed_frame_counts": resumed_frame_counts},
                indent=2,
            )
        )

    request.addfinalizer(save_transport_ledger)

    def send_message(socket: WebSocketRoute, payload: dict) -> None:
        transport_ledger.append(
            {
                "phase": phase,
                "socket": sockets.index(socket),
                "direction": "out",
                "message": payload,
            }
        )
        socket.send(json.dumps(payload))

    revision = 10_000
    other = workspace_journey.chats[1]

    def item_page(request) -> dict:
        query = parse_qs(urlparse(request.url).query)
        limit = int(query.get("limit", ["100"])[0])
        cursor = query.get("after", [None])[0]
        before = next((item["position"] for item in items if item["id"] == cursor), 10_000)
        selected = [item for item in items if item["position"] < before][-limit:]
        pages.append({"before": before, "count": len(selected)})
        return {
            "object": "list",
            "data": list(reversed(selected)),
            "has_more": bool(selected and selected[0]["position"] > 0),
            "first_id": selected[-1]["id"] if selected else None,
            "last_id": selected[0]["id"] if selected else None,
        }

    browser_contract.json(f"/v1/sessions/{chat.session_id}/items", item_page)

    def send_event(socket: WebSocketRoute, payload: dict) -> None:
        send_message(
            socket, {"type": "session.event", "session_id": chat.session_id, "event": payload}
        )

    def checkpoint() -> dict:
        return {
            "conversation_id": chat.session_id,
            "last_position": items[-1]["position"],
            "last_item_id": items[-1]["id"],
            "item_count": len(items),
            "item_revision": revision,
            "reset_revision": revision,
            "stream_epoch": "bounded-history-browser",
        }

    def attach(socket: WebSocketRoute) -> None:
        sockets.append(socket)
        transport_ledger.append(
            {"phase": phase, "socket": sockets.index(socket), "event": "attach"}
        )

        def received(raw: str | bytes) -> None:
            message = json.loads(raw)
            transport_ledger.append(
                {
                    "phase": phase,
                    "socket": sockets.index(socket),
                    "direction": "in",
                    "message": message,
                }
            )
            if message.get("type") != "subscribe":
                return
            if message["session_id"] == other.session_id:
                other_item = {**other._items[0], "position": 0}
                other_boundary = {
                    "conversation_id": other.session_id,
                    "last_position": other_item.get("position", 0),
                    "last_item_id": other_item["id"],
                    "item_count": 1,
                    "item_revision": 1,
                    "reset_revision": 0,
                    "stream_epoch": "bounded-history-other",
                }
                send_message(
                    socket,
                    {
                        "type": "session.event",
                        "session_id": other.session_id,
                        "event": {"type": "session.heartbeat", **other_boundary},
                    },
                )
                send_message(
                    socket,
                    {
                        "type": "session.event",
                        "session_id": other.session_id,
                        "event": {
                            **other_boundary,
                            "type": "session.sync",
                            "phase": "start",
                            "reset": True,
                        },
                    },
                )
                send_message(
                    socket,
                    {
                        "type": "session.event",
                        "session_id": other.session_id,
                        "event": {"type": "response.output_item.done", "item": other_item},
                    },
                )
                send_message(
                    socket,
                    {
                        "type": "session.event",
                        "session_id": other.session_id,
                        "event": {
                            **other_boundary,
                            "type": "session.sync",
                            "phase": "complete",
                            "reset": True,
                        },
                    },
                )
                return
            subscriptions.append(message)
            send_event(socket, {"type": "session.heartbeat", **checkpoint()})
            if (
                message.get("after_position") == items[-1]["position"]
                and message.get("after_revision") == revision
                and message.get("stream_epoch") == "bounded-history-browser"
            ):
                resumed_frame_counts.append(0)
                send_event(
                    socket,
                    {**checkpoint(), "type": "session.sync", "phase": "start", "reset": False},
                )
                send_event(
                    socket,
                    {
                        **checkpoint(),
                        "type": "session.sync",
                        "phase": "complete",
                        "reset": False,
                    },
                )
                return
            start = message.get("window_start_position", 9_900)
            selected = [item for item in items if item["position"] >= start]
            replay_sizes.append(len(selected))
            boundary = {
                **checkpoint(),
                "type": "session.sync",
                "reset": True,
                "window_start_position": start,
                "window_item_count": len(selected),
                "has_older_items": start > 0,
                "first_item_id": selected[0]["id"] if selected else None,
            }
            send_event(socket, {**boundary, "phase": "start"})
            for item in selected:
                send_event(socket, {"type": "response.output_item.done", "item": item})
            send_event(socket, {**boundary, "phase": "complete"})

        socket.on_message(received)
        send_message(
            socket, {"type": "capabilities", "transcript_stream": 1, "transcript_window": 1}
        )

    browser_contract.websocket("**/v1/sessions/updates*", attach)
    page.set_viewport_size({"width": width, "height": 844 if width == 390 else 1000})
    page.goto(chat.url)
    view = _view(page, "Chat A")
    expect(view.get_by_text("History item 9999", exact=True)).to_be_visible()
    assert subscriptions[0].get("initial_limit") == 100
    assert replay_sizes == [100]
    assert all(page["count"] <= 100 for page in pages)
    composer = view.get_by_label("Message the agent", exact=True)
    composer.fill("Retain this history draft")

    # The standard message deep-link path must page beyond the initial window.
    phase = "deep-link"
    page.goto(chat.url + "?message=window-9870")
    target = view.get_by_text("History item 9870", exact=True)
    expect(target).to_be_visible()
    expect(view.get_by_text("History item 9871", exact=True)).to_be_visible()
    expect(composer).to_have_value("Retain this history draft")
    assert any(page["before"] <= 9_900 for page in pages)
    # The virtualizer mounts overscan rows before the deep-link scroll reaches the reader.
    expect(target).to_be_in_viewport(ratio=1)
    page.wait_for_function(
        """() => {
          const el = document.querySelector('[data-user-message-id="window-9870"]');
          if (!el) return false;
          const top = el.getBoundingClientRect().top;
          const previous = window.__readerBeforeReset;
          const count = previous?.top === top ? previous.count + 1 : 0;
          window.__readerBeforeReset = {top, count};
          return window.__readerBeforeReset.count >= 3;
        }""",
        polling="raf",
    )
    target_top = target.bounding_box()["y"]
    old_subscription_count = len(subscriptions)
    items[9_870] = {
        **items[9_870],
        "content": [{"type": "input_text", "text": "History item 9870 revised"}],
    }
    del items[9_871]
    revision += 1
    phase = "reconcile"
    send_event(
        sockets[-1], {"type": "session.heartbeat", "reconcile_required": True, **checkpoint()}
    )
    expect(view.get_by_text("History item 9870 revised", exact=True)).to_be_visible()
    expect(view.get_by_text("History item 9871", exact=True)).to_have_count(0)
    revised_top = view.get_by_text("History item 9870 revised", exact=True).bounding_box()["y"]
    assert revised_top == pytest.approx(target_top, abs=8)
    assert len(subscriptions) > old_subscription_count
    assert subscriptions[-1]["window_start_position"] <= 9_870
    assert max(replay_sizes) < len(items)
    expect(composer).to_have_value("Retain this history draft")

    # A retained A -> B -> A reader resumes from its validated cursor without history frames.
    if page.get_by_role("button", name="Open navigation", exact=True).is_visible():
        page.get_by_role("button", name="Open navigation", exact=True).click()
    phase = "away"
    page.locator(f'aside [data-sidebar-session-id="{other.session_id}"]').click()
    expect(_view(page, "Chat B").get_by_text("Answer from Chat B", exact=True)).to_be_visible()
    if page.get_by_role("button", name="Open navigation", exact=True).is_visible():
        page.get_by_role("button", name="Open navigation", exact=True).click()
    phase = "return"
    return_resume_start = len(resumed_frame_counts)
    transport_ledger.append(
        {"phase": phase, "event": "return-start", "resume_index": return_resume_start}
    )
    page.locator(f'aside [data-sidebar-session-id="{chat.session_id}"]').click()
    expect(
        _view(page, "Chat A").get_by_text("History item 9870 revised", exact=True)
    ).to_be_visible()
    expect(composer).to_have_value("Retain this history draft")
    assert resumed_frame_counts[return_resume_start:] == [0]
    assert browser_errors == []
    page.screenshot(path=str(Path(output_path) / "bounded-history-reader-after-reset.png"))
