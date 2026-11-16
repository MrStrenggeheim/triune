# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Exact search reveal through the real transcript and virtualizer, with mocked APIs."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from playwright.sync_api import Page, expect

from tests.browser_ui.chat.session_contract import ChatSessionContract, list_payload, message_item
from tests.browser_ui.chat.test_unified_workspace import (
    WorkspaceJourney,
    _navigate_chat,
    _view,
)
from tests.browser_ui.chat.test_unified_workspace import browser_errors as browser_errors
from tests.browser_ui.chat.test_unified_workspace import workspace_journey as workspace_journey


@pytest.mark.parametrize("width", [1280, 390], ids=["desktop", "phone"])
def test_search_visible_final_with_folded_narration(
    page: Page, chat_session_contract: ChatSessionContract, width: int
) -> None:
    page.set_viewport_size({"width": width, "height": 844 if width == 390 else 720})
    chat = chat_session_contract
    chat.contract.json(f"/v1/sessions/{chat.session_id}/runtime-notices", {"data": []})
    query = "needle"
    text = "Final needle then needle."
    narration = "Earlier folded needle narration." if width == 390 else "Earlier folded narration."
    chat.set_items(
        [
            message_item("answer", "assistant", text, response_id="fold-response"),
            message_item("narration", "assistant", narration, response_id="fold-response"),
            message_item("request", "user", "Find the answer.", response_id="fold-response"),
        ]
    )
    page.add_init_script("localStorage.setItem('omnigent:fold-assistant-narration', 'true')")
    payload = {
        "data": [
            {
                "session_id": chat.session_id,
                "title": "Search fixture",
                "item_id": "answer",
                "role": "assistant",
                "created_at": 1,
                "text": text,
                "text_start": 0,
                "content_hash": "fixture",
                "snippet": text,
                "snippet_start": 0,
                "ranges": [{"start": 6, "end": 12}, {"start": 18, "end": 24}],
                "occurrence_count": 2,
            }
        ],
        "has_more": False,
        "next_cursor": None,
    }
    if width == 390:
        start = narration.index(query)
        payload["data"].append(
            {
                **payload["data"][0],
                "item_id": "narration",
                "text": narration,
                "snippet": narration,
                "ranges": [{"start": start, "end": start + len(query)}],
                "occurrence_count": 1,
            }
        )
    chat.contract.json("/v1/sessions/search/messages", payload)
    page.goto(chat.url)
    composer = page.get_by_label("Message the agent", exact=True)
    expect(composer).to_be_visible(timeout=20_000)
    composer.fill("Retained draft")
    expect(page.get_by_test_id("turn-worked-fold")).to_have_attribute("data-state", "closed")
    page.keyboard.press("ControlOrMeta+f")
    search = page.get_by_role("region", name="Chat search")
    search.get_by_label("Search chats", exact=True).fill(query)
    page.wait_for_function("CSS.highlights.get('chat-search-active')?.size === 1", timeout=5_000)
    _assert_exact_centered(page, "answer", 6, require_centered=False)
    expect(page.get_by_test_id("turn-worked-fold")).to_have_attribute("data-state", "closed")
    if width == 390:
        search.get_by_role("button").filter(has_text=narration).click()
        sidebar = page.get_by_role("complementary", name="Conversations", include_hidden=True)
        expect(sidebar).to_have_attribute("aria-hidden", "true")
        expect(page.get_by_test_id("turn-worked-fold")).to_have_attribute("data-state", "open")
        _assert_exact_centered(page, "narration", narration.index(query), require_centered=False)
    expect(composer).to_have_value("Retained draft")
    expect(page.get_by_test_id("context-search-bar")).not_to_contain_text("unavailable")


def test_search_virtual_reveal_original_source_and_cancel(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_errors: list[str],
    output_path: str,
) -> None:
    """Retain exact source navigation through restore, late resize, remount and real input."""
    chat, other = workspace_journey.chats
    chat.contract.json(f"/v1/sessions/{chat.session_id}/runtime-notices", {"data": []})
    for session in (chat, other):
        session.contract.json(
            f"/v1/sessions/{session.session_id}/resources/environments/default/search",
            list_payload([]),
        )
    text = "Final needle then needle."
    narration = "[label](https://example.test/needle)"
    rows = []
    for index in range(60):
        # Assistant response IDs alone do not separate user turns in the renderer.
        rows.append(
            message_item(
                f"request-{index}", "user", f"Request {index}.", response_id=f"turn-{index}"
            )
        )
        if index == 12:
            rows.extend(
                [
                    message_item("narration", "assistant", narration, response_id="target-turn"),
                    message_item("answer", "assistant", text, response_id="target-turn"),
                ]
            )
        else:
            rows.append(
                message_item(
                    f"ordinary-{index}",
                    "assistant",
                    f"Turn {index}.\n\n"
                    + "\n\n".join(f"Paragraph {line} with ordinary text." for line in range(10)),
                    response_id=f"turn-{index}",
                )
            )
    chat.set_items(list(reversed(rows)))
    page.add_init_script("localStorage.setItem('omnigent:fold-assistant-narration', 'true')")
    hits = []
    for item_id, source, starts in [
        ("answer", text, [6, 18]),
        ("narration", narration, [narration.index("needle")]),
    ]:
        hits.append(
            {
                "session_id": chat.session_id,
                "title": "Search fixture",
                "item_id": item_id,
                "role": "assistant",
                "created_at": 1,
                "text": source,
                "text_start": 0,
                "content_hash": "fixture",
                "snippet": source,
                "snippet_start": 0,
                "ranges": [{"start": start, "end": start + 6} for start in starts],
                "occurrence_count": len(starts),
            }
        )
    chat.contract.json(
        "/v1/sessions/search/messages", {"data": hits, "has_more": False, "next_cursor": None}
    )
    page.goto(chat.url)
    composer = _view(page, "Chat A").get_by_label("Message the agent", exact=True)
    expect(composer).to_be_visible(timeout=20_000)
    composer.fill("Retained virtual-search draft")
    expect(page.locator('[data-message-id="target-turn"]')).to_have_count(0)
    page.keyboard.press("ControlOrMeta+f")
    search = page.get_by_role("region", name="Chat search")
    query = search.get_by_label("Search chats", exact=True)
    query.fill("needle")
    _assert_exact_centered(page, "answer", 6)
    expect(query).to_be_focused()
    expect(page.get_by_test_id("turn-worked-fold")).to_have_attribute("data-state", "closed")
    bar = page.get_by_test_id("context-search-bar")
    bar.get_by_role("button", name="Next match", exact=True).click()
    _assert_exact_centered(page, "answer", 18)
    bar.get_by_role("button", name="Next match", exact=True).click()
    _assert_exact_centered(page, "narration", narration.index("needle"))
    expect(page.locator('[data-search-item-id="narration"] [data-chat-plain-text]')).to_have_text(
        narration
    )
    expect(page.get_by_test_id("turn-worked-fold")).to_have_attribute("data-state", "open")
    scroller = page.locator(f'[data-conversation-scope="{chat.session_id}"] [role="log"] > div')
    # A real wheel releases the active reveal before moving its row out of the window.
    scroller.hover()
    page.mouse.wheel(0, scroller.evaluate("el => el.scrollHeight"))
    expect(page.locator('[data-message-id="target-turn"]')).to_have_count(0)
    bar.get_by_role("button", name="Next match", exact=True).click()
    _assert_exact_centered(page, "answer", 6)
    expect(page.get_by_test_id("turn-worked-fold")).to_have_attribute("data-state", "open")

    # Warm a different saved anchor before palette navigation reactivates this retained chat.
    bar.get_by_role("button", name="Close search", exact=True).click()
    scroller.evaluate("el => { el.scrollTop = el.scrollHeight * 0.72; }")
    expect(page.locator('[data-message-id="target-turn"]')).to_have_count(0)
    _navigate_chat(page, other)
    page.keyboard.press("ControlOrMeta+k")
    palette = page.get_by_role("dialog", name="Command palette", exact=True)
    palette.get_by_test_id("command-palette-input").fill("needle")
    palette.locator('[data-search-result="message"]').filter(has_text=text).click()
    expect(palette).to_have_count(0)
    expect(page).to_have_url(chat.url)
    _assert_exact_centered(page, "answer", 6)

    # In-flow height changes exercise the browser's ResizeObserver and virtual measurements.
    samples = scroller.evaluate("""scroller => new Promise(resolve => {
        const owner = scroller.querySelector('[data-search-item-id="answer"]');
        const spacer = document.createElement('div');
        spacer.setAttribute('aria-hidden', 'true');
        spacer.style.height = '0px';
        owner.prepend(spacer);
        const samples = [];
        const start = performance.now();
        let step = 0;
        let changedAt = 0;
        function tick(now) {
            const elapsed = now - start;
            if (step < 2 && elapsed >= [450, 1000][step]) {
                spacer.style.height = `${++step * 120}px`;
                changedAt = elapsed;
            }
            const range = [...(CSS.highlights.get('chat-search-active') ?? [])][0];
            const rect = range?.getBoundingClientRect();
            const view = scroller.getBoundingClientRect();
            const item = range?.startContainer.parentElement.closest('[data-search-item-id]');
            const body = item?.querySelector('.message-markdown, [data-chat-plain-text]');
            let offset = null;
            if (body && range) {
                const prefix = range.cloneRange(); prefix.selectNodeContents(body);
                prefix.setEnd(range.startContainer, range.startOffset);
                offset = prefix.toString().length;
            }
            samples.push({elapsed, step, changedAt, offset, item: item?.dataset.searchItemId,
                text: range?.toString(), connected: !!range?.startContainer.isConnected,
                scrollTop: scroller.scrollTop,
                contentTop: rect ? rect.top - view.top + scroller.scrollTop : null,
                error: rect ? rect.top + rect.height/2 - view.top - view.height/2 : null});
            if (elapsed < 1800) requestAnimationFrame(tick); else resolve(samples);
        }
        requestAnimationFrame(tick);
    })""")
    evidence = Path(output_path) / "search-delayed-geometry-restore.json"
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_text(json.dumps(samples, indent=2) + "\n")
    for step in range(3):
        settled = [
            sample
            for sample in samples
            if sample["step"] == step
            and (step == 0 or sample["elapsed"] - sample["changedAt"] >= 350)
        ]
        assert len(settled) >= 3, samples
        assert all(
            sample["connected"]
            and sample["item"] == "answer"
            and sample["text"] == "needle"
            and sample["offset"] == 6
            and sample["error"] is not None
            and abs(sample["error"]) <= 1
            for sample in settled
        ), settled
        assert (
            max(sample["scrollTop"] for sample in settled)
            - min(sample["scrollTop"] for sample in settled)
            <= 1
        ), settled
    assert samples[-1]["contentTop"] - samples[0]["contentTop"] >= 239, samples
    _assert_exact_centered(page, "answer", 6)
    query.focus()
    expect(query).to_be_focused()
    scroller.hover()
    scroller.evaluate("""el => {
        el.addEventListener('wheel', event => {
            el.dataset.searchWheelTrusted = String(event.isTrusted);
        }, {once: true});
    }""")
    before_wheel = scroller.evaluate("el => el.scrollTop")
    bar.get_by_role("button", name="Next match", exact=True).evaluate("button => button.click()")
    page.evaluate("""() => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    })""")
    expect(bar.get_by_role("status")).to_have_text("2 of 3")
    page.mouse.wheel(0, 97)
    expect(scroller).to_have_attribute("data-search-wheel-trusted", "true")
    page.wait_for_function(
        "before => document.querySelector('[role=\"log\"] > div').scrollTop > before + 50",
        arg=before_wheel,
    )
    cancelled_top = scroller.evaluate("el => el.scrollTop")
    page.wait_for_timeout(500)  # Observe cancellation across several alignment polls.
    wheel_drift = abs(scroller.evaluate("el => el.scrollTop") - cancelled_top)
    print(
        f"search actual wheel: delta_px={cancelled_top - before_wheel:.6f}, "
        f"drift_px={wheel_drift:.6f}"
    )
    assert wheel_drift < 1
    expect(query).to_be_focused()
    query.press("Enter")
    expect(bar.get_by_role("status")).to_have_text("3 of 3")
    query.press("Enter")
    expect(bar.get_by_role("status")).to_have_text("1 of 3")
    _assert_exact_centered(page, "answer", 6)
    expect(query).to_be_focused()
    expect(composer).to_have_value("Retained virtual-search draft")
    expect(bar).not_to_contain_text("unavailable")
    assert chat.event_posts == []
    assert other.event_posts == []
    assert browser_errors == []


def _assert_exact_centered(
    page: Page, item_id: str, source_offset: int, *, require_centered: bool = True
) -> None:
    page.wait_for_function(
        """({item, offset, centered}) => {
        const range = [...(CSS.highlights.get('chat-search-active') ?? [])][0];
        if (!range || range.toString() !== 'needle') return false;
        const owner = range.startContainer.parentElement.closest('[data-search-item-id]');
        if (owner?.dataset.searchItemId !== item) return false;
        const body = owner.querySelector('.message-markdown, [data-chat-plain-text]');
        const before = document.createRange(); before.selectNodeContents(body);
        before.setEnd(range.startContainer, range.startOffset);
        if (before.toString().length !== offset) return false;
        const rect = range.getBoundingClientRect();
        const view = document.querySelector('[role="log"] > div').getBoundingClientRect();
        return rect.height > 0 && (centered
            ? Math.abs(rect.top + rect.height/2 - view.top - view.height/2) <= 1
            : rect.top >= view.top && rect.bottom <= view.bottom);
    }""",
        arg={"item": item_id, "offset": source_offset, "centered": require_centered},
        timeout=5_000,
    )
    drift = page.evaluate("""() => new Promise(resolve => {
        const samples = [];
        function tick() {
            const range = [...CSS.highlights.get('chat-search-active')][0];
            const rect = range.getBoundingClientRect();
            const view = document.querySelector('[role="log"] > div').getBoundingClientRect();
            samples.push(rect.top + rect.height/2 - view.top - view.height/2);
            if (samples.length < 30) requestAnimationFrame(tick); else resolve(samples);
        }
        requestAnimationFrame(tick);
    })""")
    spread = max(drift) - min(drift)
    print(
        f"search geometry: viewport={page.viewport_size}, item={item_id}, "
        f"offset={source_offset}, frames={len(drift)}, drift_px={spread:.6f}"
    )
    assert spread < 1, drift
