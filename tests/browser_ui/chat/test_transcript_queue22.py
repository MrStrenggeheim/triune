# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Compiled transcript transitions through the existing controlled backend contract."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from playwright.sync_api import Page, expect

from tests.browser_ui.chat.session_contract import ChatSessionContract, message_item


@pytest.mark.parametrize("width", [1440, 390], ids=["desktop", "phone"])
def test_pending_group_receipts_and_permission_copy(
    page: Page, chat_session_contract: ChatSessionContract, output_path: str, width: int
) -> None:
    chat = chat_session_contract
    chat.harness = "codex-native"
    chat.update_session(
        labels={
            "omnigent.wrapper": "codex-native-ui",
            "omnigent.codex_native.next_turn_permissions_v1": "full-access",
        }
    )
    chat.contract.json(
        f"/v1/sessions/{chat.session_id}/codex_goal",
        {
            "goal": {
                "thread_id": "native-thread",
                "objective": "Verify the release",
                "status": "active",
                "tokens_used": 0,
                "time_used_seconds": 0,
            }
        },
    )
    page.set_viewport_size({"width": width, "height": 1000})
    page.emulate_media(reduced_motion="reduce", color_scheme="dark" if width < 500 else "light")
    page.add_init_script("localStorage.setItem('omnigent:always-steer', 'true')")
    text = "Repeated follow-up"
    original = message_item("original", "user", text, response_id="original-turn")
    chat.set_items([original])
    page.goto(chat.url)
    composer = page.get_by_label("Message the agent")
    expect(composer).to_be_visible(timeout=30_000)
    chat.wait_for_stream()
    chip = page.get_by_test_id("composer-permission-chip")
    expect(chip).to_have_text("Full Access")
    goal = page.get_by_test_id("composer-goal-mode")
    expect(goal).to_be_visible()
    shelf = page.get_by_test_id("composer-attention-shelf")
    expect(shelf).to_be_visible()
    assert shelf.locator('[data-testid="composer-goal-mode"]').count() == 1
    for density in ("comfortable", "compact"):
        page.locator("html").evaluate("(node, value) => node.dataset.listDensity = value", density)
        inset = shelf.evaluate(
            "node => { const box = node.closest('.composer-shelf-content'); "
            "return parseFloat(getComputedStyle(box).paddingTop); }"
        )
        assert inset == (4 if density == "comfortable" else 2)
    baseline = page.locator('[data-message-id="original"]').bounding_box()
    assert baseline is not None
    chat.emit_busy("busy-turn")
    working = page.get_by_test_id("working-indicator")
    expect(working).to_be_visible()
    expect(chip).to_have_text("Full Access")
    chip.click()
    menu = page.get_by_test_id("composer-permission-menu")
    expect(menu.get_by_text("Only applies next turn", exact=True)).to_be_visible()
    page.keyboard.press("Escape")
    stable_ids = []
    for index in (1, 2):
        chat.event_ack = {"queued": True, "pending_id": f"pending-{index}"}
        composer.fill(text)
        with page.expect_response(
            lambda response: response.url.endswith(f"/{chat.session_id}/events")
        ):
            page.get_by_role("button", name="Send", exact=True).click()
        stable_ids.append(chat.event_posts[-1]["body"]["data"]["stable_id"])
    assert len(set(stable_ids)) == 2
    group = page.get_by_test_id("awaiting-agent-messages")
    users = group.locator('[data-role="user"]')
    hint = page.get_by_test_id("message-awaiting-agent")
    expect(users).to_have_count(2)
    expect(hint).to_have_count(1)
    boxes = [locator.bounding_box() for locator in (working, hint, users.nth(0), users.nth(1))]
    assert all(box is not None for box in boxes)
    working_box, hint_box, first, second = boxes
    assert working_box["y"] + working_box["height"] <= hint_box["y"]
    assert hint_box["y"] + hint_box["height"] <= first["y"]
    assert second["y"] - first["y"] - first["height"] == pytest.approx(8, abs=1)
    for box in (first, second):
        assert box["x"] == pytest.approx(baseline["x"], abs=1)
        assert box["width"] == pytest.approx(baseline["width"], abs=1)
    artifacts = Path(output_path)
    artifacts.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(artifacts / "pending.png"), full_page=True)
    (artifacts / "geometry.json").write_text(
        json.dumps({"baseline": baseline, "pending": boxes}, indent=2)
    )
    pending = [
        {
            "pending_id": f"pending-{index}",
            "item_id": stable_ids[index - 1],
            "sent_mid_turn": True,
            "content": [{"type": "input_text", "text": text}],
        }
        for index in (1, 2)
    ]
    chat.update_session(pending_inputs=pending)
    page.reload()
    chat.wait_for_stream()
    expect(users).to_have_count(2)
    committed = []
    for index in (1, 2):
        item = message_item(stable_ids[index - 1], "user", text, response_id="busy-turn")
        committed.append(item)
        chat.emit(
            {
                "event": "session.input.consumed",
                "data": {
                    "type": "session.input.consumed",
                    "data": {
                        "item_id": item["id"],
                        "type": "message",
                        "cleared_pending_id": f"pending-{index}",
                        "data": {
                            "role": "user",
                            "content": item["content"],
                            "user_authored": True,
                        },
                    },
                },
            }
        )
        consumed = page.locator(f'[data-message-id="{stable_ids[index - 1]}"]')
        expect(consumed).to_be_visible()
        expect(users).to_have_count(2 - index)
        bounds = consumed.bounding_box()
        indicator = working.bounding_box()
        assert bounds is not None and indicator is not None
        assert bounds["y"] + bounds["height"] <= indicator["y"]
        assert bounds["x"] == pytest.approx(baseline["x"], abs=1)
    expect(hint).to_have_count(0)
    chat.emit_idle("busy-turn")
    expect(working).to_have_count(0)
    expect(chip).to_have_text("Full Access")
    chip.click()
    expect(menu.get_by_text("Only applies next turn", exact=True)).to_have_count(0)
    page.keyboard.press("Escape")
    page.screenshot(path=str(artifacts / "consumed.png"), full_page=True)


@pytest.mark.parametrize("width", [1440, 390], ids=["desktop", "phone"])
def test_tool_readers_stay_capped_after_expansion(
    page: Page, chat_session_contract: ChatSessionContract, output_path: str, width: int
) -> None:
    chat = chat_session_contract
    page.set_viewport_size({"width": width, "height": 900})
    command = "printf 'line\\n'"
    output = "\n".join(f"Line {index}" for index in range(150))
    chat.set_items(
        [
            {
                "id": "tool-result",
                "response_id": "tool-turn",
                "type": "function_call_output",
                "call_id": "tool-call",
                "output": output,
            },
            {
                "id": "tool-call-item",
                "response_id": "tool-turn",
                "type": "function_call",
                "call_id": "tool-call",
                "name": "shell",
                "arguments": json.dumps({"command": command}),
                "status": "completed",
            },
            message_item("tool-user", "user", "Show output", response_id="tool-turn"),
        ]
    )
    page.goto(chat.url)
    expect(page.get_by_label("Message the agent")).to_be_visible(timeout=30_000)
    worked = page.get_by_text("Worked", exact=True)
    if worked.count():
        worked.click()
    group = page.get_by_text("Ran 1 shell command", exact=True)
    if group.count():
        group.click()
    trigger = page.locator('[data-slot="collapsible-trigger"]').filter(has_text=command)
    expect(trigger).to_have_count(1)
    trigger.click()
    expand = page.get_by_role("button", name="Expand", exact=True)
    expect(expand).to_have_count(1)
    box = page.locator("[data-tool-reading-box]").last
    before = box.bounding_box()
    assert before is not None and before["height"] <= 321
    expect(box.get_by_text(re.compile(r"[1-9][0-9,]* characters hidden"))).to_be_visible()
    expand.click()
    expect(page.get_by_role("button", name="Collapse", exact=True)).to_be_visible()
    after = box.bounding_box()
    assert after is not None and after["height"] == pytest.approx(before["height"], abs=1)
    scroll = box.locator("div.overflow-auto").first
    scroll.evaluate("node => node.scrollTop = node.scrollHeight")
    last_line = box.get_by_text("Line 149", exact=False)
    expect(last_line).to_be_visible()
    assert scroll.evaluate("node => node.scrollTop > 0")
    last_bounds, viewport = last_line.bounding_box(), scroll.bounding_box()
    assert last_bounds is not None and viewport is not None
    assert last_bounds["y"] >= viewport["y"] - 1
    assert last_bounds["y"] + last_bounds["height"] <= viewport["y"] + viewport["height"] + 1
    Path(output_path).mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(Path(output_path) / "tool-expanded.png"), full_page=True)
