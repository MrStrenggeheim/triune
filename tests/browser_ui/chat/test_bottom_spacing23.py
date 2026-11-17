# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Bottom geometry across accepted input, reload, receipt and completion."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from playwright.sync_api import Page, expect

from tests.browser_ui.chat.session_contract import (
    ChatSessionContract,
    message_item,
    transcript_items,
)


def record_tail_geometry(page: Page, *, scroll_to_bottom: bool = True) -> dict:
    return page.evaluate(
        """async scrollToBottom => {
          const log = [...document.querySelectorAll('[role="log"]')]
            .find(node => node.getBoundingClientRect().height > 0);
          const scroller = log.firstElementChild;
          if (scrollToBottom) scroller.scrollTop = scroller.scrollHeight;
          await new Promise(resolve =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const content = scroller.firstElementChild;
          const selector = '[data-testid="message-bubble"], [data-testid="working-indicator"]';
          const items = [...content.querySelectorAll(selector)]
            .filter(node => node.getBoundingClientRect().height > 0);
          const last = items.at(-1);
          if (!last) throw new Error('No displayed transcript item');
          const rect = node => { if (!node) return null; const r = node.getBoundingClientRect();
            return {top:r.top,bottom:r.bottom,height:r.height}; };
          const item = rect(last), body = rect(content), viewport = rect(scroller);
          const padding = parseFloat(getComputedStyle(content).paddingBottom);
          const composer = document.querySelector('.chat-composer-form');
          const shelf = document.querySelector('[data-testid="composer-attention-shelf"]');
          const tail = content.lastElementChild;
          return {item,body,viewport,padding,composer:rect(composer),shelf:rect(shelf),
            contentExcess:body.bottom-padding-item.bottom,
            viewportGap:viewport.bottom-item.bottom,
            scrollRange:scroller.scrollHeight-scroller.clientHeight,
            distanceToBottom:scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop,
            tail:{tag:tail.tagName,testid:tail.dataset.testid??null,
              display:getComputedStyle(tail).display,height:tail.getBoundingClientRect().height}};
        }""",
        scroll_to_bottom,
    )


def record_side_tail_geometry(page: Page) -> dict:
    return page.evaluate(
        """async () => {
          const pane = [...document.querySelectorAll('.side-chat-backdrop')]
            .find(node => node.getBoundingClientRect().height > 0);
          if (!pane) throw new Error('No visible side-chat pane');
          const scroller = pane.firstElementChild;
          scroller.scrollTop = scroller.scrollHeight;
          await new Promise(resolve =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const selector = '[data-testid="message-bubble"], [data-testid="working-indicator"]';
          const items = [...scroller.querySelectorAll(selector)]
            .filter(node => node.getBoundingClientRect().height > 0);
          const last = items.at(-1);
          if (!last) throw new Error('No displayed side-chat item');
          const item = last.getBoundingClientRect(), viewport = scroller.getBoundingClientRect();
          return {viewportGap:viewport.bottom-item.bottom,
            padding:parseFloat(getComputedStyle(scroller).paddingBottom),
            scrollRange:scroller.scrollHeight-scroller.clientHeight};
        }"""
    )


@pytest.mark.parametrize(
    "width,density,theme", [(1440, "comfortable", "light"), (390, "compact", "dark")]
)
@pytest.mark.parametrize("history_turns", [0, 10], ids=["short", "long"])
def test_tail_spacing_survives_pending_reload_and_completion(
    page: Page,
    chat_session_contract: ChatSessionContract,
    output_path: str,
    width: int,
    density: str,
    theme: str,
    history_turns: int,
) -> None:
    chat = chat_session_contract
    chat.harness = "codex-native"
    chat.contract.json(f"/v1/sessions/{chat.session_id}/codex_goal", {"goal": None})
    todos = [{"content": "Inspect spacing", "status": "in_progress", "activeForm": "Inspecting"}]
    chat.update_session(labels={"omnigent.wrapper": "codex-native-ui"}, todos=todos)
    original = message_item("spacing-original", "user", "Inspect spacing", response_id="initial")
    history = transcript_items(history_turns)
    chat.set_items([original, *history])
    page.set_viewport_size({"width": width, "height": 1000})
    page.emulate_media(reduced_motion="reduce", color_scheme=theme)
    page.add_init_script(
        "localStorage.setItem('omnigent:always-steer', 'true');"
        f"localStorage.setItem('omnigent:list-density', {json.dumps(density)});"
        f"localStorage.setItem('web-theme', {json.dumps(theme)});"
    )
    artifacts = Path(output_path)
    artifacts.mkdir(parents=True, exist_ok=True)
    measurements = {}

    def capture(phase: str, *, scroll: bool = True) -> None:
        measurements[phase] = record_tail_geometry(page, scroll_to_bottom=scroll)
        (artifacts / "tail-geometry.json").write_text(json.dumps(measurements, indent=2) + "\n")

    page.goto(chat.url)
    composer = page.get_by_label("Message the agent")
    expect(composer).to_be_visible(timeout=30_000)
    chat.wait_for_stream()
    expect(page.locator('[data-message-id="spacing-original"]')).to_be_visible()
    capture("initial")
    chat.emit_busy("spacing-turn")
    expect(page.get_by_test_id("working-indicator")).to_be_visible()
    capture("working")
    actions = page.get_by_test_id("header-conversation-actions")
    actions.click()
    page.get_by_role("menuitem", name="Hide activity shelf", exact=True).click()
    capture("working-shelf-hidden")
    actions.click()
    page.get_by_role("menuitem", name="Show activity shelf", exact=True).click()
    capture("working-shelf-shown")
    pending = []
    for index in (1, 2):
        text = f"Spacing follow-up {index}"
        pending.append(
            {
                "pending_id": f"spacing-pending-{index}",
                "sent_mid_turn": True,
                "content": [{"type": "input_text", "text": text}],
            }
        )
        chat.event_ack = {"queued": True, "pending_id": f"spacing-pending-{index}"}
        composer.fill(text)
        with page.expect_response(
            lambda response: response.url.endswith(f"/{chat.session_id}/events")
        ):
            page.get_by_role("button", name="Send", exact=True).click()
        expect(page.locator('[data-role="user"]').filter(has_text=text)).to_have_count(1)
    capture("pending")
    chat.update_session(pending_inputs=pending)
    page.reload()
    chat.wait_for_stream()
    expect(
        page.locator('[data-role="user"]').filter(has_text="Spacing follow-up 2")
    ).to_have_count(1)
    capture("reload-running")
    consumed = []
    for index, item in enumerate(pending, 1):
        saved = message_item(
            f"spacing-consumed-{index}",
            "user",
            item["content"][0]["text"],
            response_id="spacing-turn",
        )
        consumed.append(saved)
        chat.emit(
            {
                "event": "session.input.consumed",
                "data": {
                    "type": "session.input.consumed",
                    "data": {
                        "item_id": saved["id"],
                        "type": "message",
                        "cleared_pending_id": item["pending_id"],
                        "data": {
                            "role": "user",
                            "user_authored": True,
                            "content": saved["content"],
                        },
                    },
                },
            }
        )
        expect(page.locator(f'[data-message-id="{saved["id"]}"]')).to_have_count(1)
    chat.update_session(pending_inputs=[])
    chat.set_items([*reversed(consumed), original, *history])
    capture("consumed-working")
    answer = message_item(
        "spacing-answer", "assistant", "Spacing complete.", response_id="spacing-turn"
    )
    chat.emit({"event": "response.output_item.done", "data": {"item": answer}})
    chat.set_items([answer, *reversed(consumed), original, *history])
    chat.emit_idle("spacing-turn")
    expect(page.get_by_test_id("working-indicator")).to_have_count(0)
    capture("complete")
    page.reload()
    chat.wait_for_stream()
    expect(page.locator('[data-message-id="spacing-consumed-2"]')).to_have_count(1)
    capture("reload-complete")
    composer.fill("\n".join(f"Draft line {index}" for index in range(12)))
    capture("resized-composer", scroll=False)
    page.screenshot(path=str(artifacts / "tail-complete.png"), full_page=True)
    for phase, geometry in measurements.items():
        assert geometry["contentExcess"] == pytest.approx(0, abs=1), (phase, geometry)
        assert geometry["viewportGap"] == pytest.approx(geometry["padding"], abs=2), (
            phase,
            geometry,
        )
        assert geometry["distanceToBottom"] <= 2, (phase, geometry)
