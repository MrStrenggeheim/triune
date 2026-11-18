# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
"""Built-SPA contracts for final recovery and native child activity identity."""

from __future__ import annotations

import json
import re
from itertools import pairwise
from pathlib import Path

import pytest
from playwright.sync_api import Page, expect

from tests.browser_ui.chat._geometry_helpers import open_live, settled_geometry
from tests.browser_ui.chat.session_contract import (
    ChatSessionContract,
    message_item,
    transcript_items,
)


def _native_message(item_id: str, text: str, response_id: str, phase: str) -> dict:
    return {
        **message_item(item_id, "assistant", text, response_id=response_id),
        "phase": phase,
        "agent": "Main",
        "model": "browser-model",
        "stream_message_id": f"native-{item_id}",
    }


def _complete(chat: ChatSessionContract, response_id: str) -> None:
    chat.emit(
        {
            "event": "response.completed",
            "data": {"id": response_id, "status": "completed", "output": []},
        }
    )
    chat.emit_idle(response_id)


@pytest.mark.parametrize("phase", ["commentary", "final_answer"])
@pytest.mark.parametrize("fold_narration", [False, True])
def test_expanded_turn_preserves_tool_and_message_order(
    page: Page,
    chat_session_contract: ChatSessionContract,
    phase: str,
    fold_narration: bool,
    pytestconfig: pytest.Config,
    output_path: str,
) -> None:
    chat = chat_session_contract
    turn = "chronology"
    saved_preference = str(fold_narration).lower()
    page.add_init_script(
        f"localStorage.setItem('omnigent:fold-assistant-narration', '{saved_preference}')"
    )

    def shell(call_id: str) -> list[dict]:
        identity = {"response_id": turn, "call_id": call_id, "status": "completed"}
        return [
            {
                **identity,
                "id": call_id,
                "type": "function_call",
                "name": "shell",
                "arguments": json.dumps({"command": f"echo {call_id}"}),
            },
            {
                **identity,
                "id": f"{call_id}-result",
                "type": "function_call_output",
                "output": "ok",
            },
        ]

    items = [
        message_item("question", "user", "Check ordering", response_id=turn),
        *shell("first-call"),
        _native_message("middle", "Middle message", turn, phase),
        *shell("second-call"),
        _native_message("answer", "Final message", turn, "final_answer"),
    ]
    chat.set_items(list(reversed([{**item, "position": i} for i, item in enumerate(items)])))
    page.goto(chat.url)
    middle = page.locator('[data-search-item-id="middle"]')
    answer = page.locator('[data-search-item-id="answer"]')
    expect(answer).to_be_visible()
    fold_middle = phase == "commentary" and fold_narration
    folds = page.get_by_test_id("turn-worked-fold")
    expect(folds).to_have_count(1 if fold_middle else 2)
    if fold_middle:
        expect(middle).to_have_count(0)
    else:
        expect(middle).to_be_visible()
    capture = pytestconfig.getoption("--screenshot") == "on"
    if capture:
        page.screenshot(path=str(Path(output_path) / "chronology-settled.png"))
    for fold in folds.all():
        fold.get_by_role("button").first.click()
    for summary in page.get_by_role("button", name="Ran 1 shell command", exact=True).all():
        summary.click()
    rows = [
        page.locator('[data-convergence-item-id="first-call"]'),
        middle,
        page.locator('[data-convergence-item-id="second-call"]'),
        answer,
    ]
    tops = []
    for row in rows:
        expect(row).to_be_visible()
        tops.append(row.evaluate("(node) => node.getBoundingClientRect().top"))
    assert all(before < after for before, after in pairwise(tops))
    if capture:
        page.screenshot(path=str(Path(output_path) / "chronology-expanded.png"))


def test_saved_final_recovers_on_healthy_stream_before_newer_turn_without_moving_reader(
    page: Page,
    chat_session_contract: ChatSessionContract,
    output_path: str,
) -> None:
    """Lose only the final item event; canonical recovery retains draft and reader."""
    chat = chat_session_contract
    chat.harness = "codex-native"
    history = transcript_items(12)
    user = message_item("older-user", "user", "Review navigation", response_id="older-turn")
    progress = _native_message(
        "older-progress", "Checking navigation.", "older-turn", "commentary"
    )
    final = _native_message(
        "older-final", "Navigation review is complete.", "older-turn", "final_answer"
    )
    newer_user = message_item(
        "newer-user", "user", "Review keyboard focus", response_id="newer-turn"
    )
    newer_final = _native_message(
        "newer-final",
        "\n\n".join(f"Settled keyboard review paragraph {index}." for index in range(24)),
        "newer-turn",
        "final_answer",
    )
    # The newer turn is already settled when the older turn's delayed preview arrives.
    chat.set_items([newer_final, newer_user, progress, user, *history])
    open_live(page, chat)
    transcript = page.get_by_role("log")
    expect(transcript.locator('[data-search-item-id="newer-final"]')).to_have_count(1)
    generation = chat.stream.connection_generation
    page.evaluate("() => { window.__recoveryDocument = document; }")
    composer = page.get_by_label("Message the agent")
    draft = "Unsent follow-up retained during recovery"
    composer.fill(draft)
    chat.emit_busy("older-turn")
    chat.emit(
        {
            "event": "response.output_text.delta",
            "data": {
                "message_id": final["stream_message_id"],
                "index": 0,
                "delta": final["content"][0]["text"],
                "final": True,
            },
        }
    )
    preview = transcript.locator('[data-search-item-id="live:native-older-final"]')
    expect(preview).to_have_count(1, timeout=10_000)
    expect(preview).to_contain_text("Navigation review is complete.")

    anchor = transcript.locator('[data-user-message-id="newer-user"]')
    anchor.scroll_into_view_if_needed()
    anchor.evaluate(
        """element => {
            const scroller = element.closest('[role="log"]').firstElementChild;
            scroller.dispatchEvent(new WheelEvent('wheel', {deltaY: -100}));
            scroller.scrollTop += element.getBoundingClientRect().top
                - scroller.getBoundingClientRect().top - 48;
            scroller.dispatchEvent(new Event('scroll'));
        }"""
    )
    settled_geometry(page)
    anchor_top = anchor.evaluate("element => element.getBoundingClientRect().top")
    scroller = transcript.locator(":scope > div").first
    assert scroller.evaluate("el => el.scrollHeight - el.clientHeight - el.scrollTop") > 100
    expect(composer).to_have_value(draft)
    page.screenshot(path=str(Path(output_path) / "recovery-preview-reader.png"))

    # Save the exact final, but never emit its committed item or send another input.
    chat.set_items([newer_final, newer_user, final, progress, user, *history])
    items_path = f"/v1/sessions/{chat.session_id}/items"
    with page.expect_request(lambda request: items_path in request.url, timeout=10_000):
        _complete(chat, "older-turn")

    committed = transcript.locator('[data-search-item-id="older-final"]')
    expect(committed).to_have_count(1, timeout=10_000)
    expect(preview).to_have_count(0)
    expect(transcript.get_by_text("Navigation review is complete.", exact=True)).to_have_count(1)
    expect(transcript.locator('[data-user-message-id="older-user"]')).to_have_count(1)
    assert committed.evaluate(
        """element => Boolean(element.compareDocumentPosition(
            document.querySelector('[data-user-message-id="newer-user"]')
        ) & Node.DOCUMENT_POSITION_FOLLOWING)"""
    )
    settled_geometry(page)
    assert abs(anchor.evaluate("el => el.getBoundingClientRect().top") - anchor_top) <= 2
    expect(composer).to_have_value(draft)
    expect(page.get_by_test_id("working-indicator")).to_be_hidden(timeout=10_000)
    assert chat.stream.connected
    assert chat.stream.connection_generation == generation == 1
    assert page.evaluate("document === window.__recoveryDocument")
    assert chat.event_posts == []
    page.screenshot(path=str(Path(output_path) / "recovery-canonical-reader-retained.png"))


def _activity_item(
    child_id: str,
    item_id: str,
    dispatch_id: str,
    phase: str,
    *,
    task: str = "Navigation review",
    task_input: str = "Original handoff",
) -> dict:
    return {
        "id": item_id,
        "type": "resource_event",
        "status": "completed",
        "response_id": f"activity_{item_id}",
        "created_at": 1_700_000_000,
        "event_type": f"session.subagent.{phase}",
        "resource_type": "session",
        "resource_id": child_id,
        "resource": {
            "agent_name": "Curie",
            "agent_name_source": "native",
            "agent_role": "worker",
            "title": task,
            "task_summary": task,
            "task_input": task_input,
            "task_input_ref": {"conversation_id": child_id, "item_id": dispatch_id},
            "dispatch_id": dispatch_id,
            "status": "completed" if phase == "returned" else "running",
        },
    }


def test_child_activity_keeps_one_card_per_id_in_plain_timeline_and_worked_fold(
    page: Page,
    chat_session_contract: ChatSessionContract,
    output_path: str,
) -> None:
    """Repeated dispatches update one child; identical labels never merge different IDs."""
    chat = chat_session_contract
    chat.harness = "codex-native"
    user = message_item("activity-user", "user", "Review navigation", response_id="prompt-turn")
    chat.set_items([user])
    open_live(page, chat)
    chat.emit_busy("activity-turn")
    events = [
        _activity_item("child-one", "spawn", "dispatch-1", "delegated"),
        _activity_item(
            "child-one",
            "steer-1",
            "steer-1",
            "delegated",
            task="Working agreement update",
            task_input="First steering details",
        ),
        _activity_item("child-two", "second-spawn", "another", "delegated"),
        _activity_item(
            "child-one",
            "steer-2",
            "steer-2",
            "delegated",
            task="Shared parse blocker",
            task_input="Second steering details",
        ),
        _activity_item("child-one", "late-old-return", "dispatch-1", "returned"),
        _activity_item("child-one", "last-return", "steer-2", "returned"),
        _activity_item("child-two", "second-return", "another", "returned"),
    ]
    transcript = page.get_by_role("log")
    cards = transcript.get_by_test_id("subagent-activity")
    first = transcript.locator(
        '[data-testid="subagent-activity"][data-child-session-id="child-one"]'
    )
    second = transcript.locator(
        '[data-testid="subagent-activity"][data-child-session-id="child-two"]'
    )

    def reveal_agent_groups() -> None:
        for group in transcript.get_by_role("button", name=re.compile(r"\d+ subagents?")).all():
            if group.get_attribute("aria-expanded") == "false":
                group.click()

    for index, item in enumerate(events):
        chat.emit({"event": "response.output_item.done", "data": {"item": item}})
        # The active tool tail stays plain until the grouping policy folds it.
        reveal_agent_groups()
        expect(first).to_have_count(1, timeout=10_000)
        expect(cards).to_have_count(2 if index >= 2 else 1)
        header = first.locator("[data-resource-row]")
        expect(header).to_contain_text("Curie")
        expect(header).to_contain_text("Navigation review")
        expect(header).not_to_contain_text("Working agreement update")
        expect(header).not_to_contain_text("Shared parse blocker")
        expect(transcript.get_by_test_id("turn-worked-fold")).to_have_count(0)
        if index >= 2:
            expect(second).to_have_count(1)
            expect(second.locator("[data-resource-row]")).to_contain_text("Navigation review")
    expect(first.get_by_role("status", name="Completed", exact=True)).to_be_visible()
    expect(second.get_by_role("status", name="Completed", exact=True)).to_be_visible()
    assert {"spawn", "steer-1", "steer-2", "late-old-return", "last-return"} <= set(
        json.loads(first.get_attribute("data-message-aliases") or "[]")
    )
    page.screenshot(path=str(Path(output_path) / "activity-plain-one-card-per-child.png"))

    final = _native_message(
        "activity-final", "Both navigation reviews are complete.", "activity-turn", "final_answer"
    )
    chat.set_items(list(reversed([user, *events, final])))
    chat.emit({"event": "response.output_item.done", "data": {"item": final}})
    _complete(chat, "activity-turn")
    fold = transcript.get_by_test_id("turn-worked-fold")
    expect(fold).to_have_count(1, timeout=10_000)
    expect(fold).to_have_attribute("data-state", "closed", timeout=10_000)
    answer = transcript.locator('[data-search-item-id="activity-final"]')
    expect(answer).to_be_visible()
    expect(answer).to_have_text("Both navigation reviews are complete.")
    expect(answer.locator('xpath=ancestor::*[@data-testid="turn-worked-fold"]')).to_have_count(0)
    page.screenshot(path=str(Path(output_path) / "activity-folded-final-outside-worked.png"))

    fold.get_by_role("button", name="Worked", exact=False).click()
    expect(fold).to_have_attribute("data-state", "open")
    group = fold.get_by_role("button", name=re.compile(r"\d+ subagents?"))
    expect(group).to_have_count(1)
    expect(group).to_have_attribute("aria-expanded", "false")
    expect(first).to_be_hidden()
    expect(second).to_be_hidden()
    reveal_agent_groups()
    expect(fold.get_by_test_id("subagent-activity")).to_have_count(2)
    expect(first).to_have_count(1)
    expect(second).to_have_count(1)
    expect(first.locator("[data-resource-row]")).to_contain_text("Navigation review")
    expect(second.locator("[data-resource-row]")).to_contain_text("Navigation review")
    first.get_by_role("button", name="Expand activity", exact=True).click()
    expect(first).to_contain_text("Original handoff")
    expect(first).to_contain_text("First steering details")
    expect(first).to_contain_text("Second steering details")
    expect(transcript.get_by_test_id("subagent-reply")).to_have_count(0)
    expect(answer).to_be_visible()
    assert chat.stream.connection_generation == 1
    assert chat.event_posts == []
    page.screenshot(path=str(Path(output_path) / "activity-expanded-one-card-per-child.png"))
