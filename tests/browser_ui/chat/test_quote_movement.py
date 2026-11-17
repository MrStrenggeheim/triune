# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Quote movement exercises browser caret layout through the shared composer."""

from __future__ import annotations

from pathlib import Path

import pytest
from playwright.sync_api import Page, expect

from tests.browser_ui.chat.session_contract import ChatSessionContract, message_item


@pytest.mark.parametrize("width", [1440, 390], ids=["desktop", "phone"])
def test_quote_moves_into_authored_text_and_undo_preserves_draft(
    page: Page, chat_session_contract: ChatSessionContract, output_path: str, width: int
) -> None:
    chat = chat_session_contract
    page.set_viewport_size({"width": width, "height": 900})
    page.emulate_media(reduced_motion="reduce")
    chat.set_items(
        [message_item("quote-source", "assistant", "Selected quotation", response_id="quote-turn")]
    )
    page.goto(chat.url)
    tail = page.get_by_label("Message the agent", exact=True)
    expect(tail).to_be_visible(timeout=30_000)
    tail.fill("Intro ")
    page.get_by_text("Selected quotation", exact=True).evaluate("""node => {
      const range = document.createRange(); range.selectNodeContents(node);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    }""")
    page.get_by_role("menuitem", name="Reply", exact=True).click()
    tail.fill("tail after")
    quote = page.get_by_test_id("composer-reply-quote")
    expect(quote).to_have_css("border-radius", "0px")
    expect(quote.get_by_role("button", name="Remove quote")).to_be_visible()
    handle = page.get_by_role("button", name="Move quote 1", exact=True)
    if width == 1440:
        target = tail.evaluate("""node => {
          const style = getComputedStyle(node), box = node.getBoundingClientRect();
          const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
          ctx.font = style.font;
          return { x:box.left + parseFloat(style.paddingLeft) + ctx.measureText('tail ').width,
            y:box.top + parseFloat(style.paddingTop) + parseFloat(style.lineHeight)/2 };
        }""")
        handle.hover()
        page.mouse.down()
        page.mouse.move(target["x"], target["y"], steps=8)
        expect(page.locator("[data-quote-insertion-caret]")).to_be_visible()
        page.mouse.up()
    else:
        handle.focus()
        handle.press("Enter")
        tail.focus()
        tail.evaluate("node => node.setSelectionRange(5,5)")
        tail.press("Enter")
    expect(page.get_by_label("Reply text before quote 1", exact=True)).to_have_value("Intro tail ")
    expect(tail).to_have_value("after")
    expect(quote).to_contain_text("Selected quotation")
    assert chat.event_posts == []
    artifacts = Path(output_path)
    artifacts.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(artifacts / "quote-at-caret.png"))
    tail.press("Control+z")
    expect(page.get_by_label("Reply text before quote 1", exact=True)).to_have_value("Intro ")
    expect(tail).to_have_value("tail after")
    assert chat.event_posts == []
