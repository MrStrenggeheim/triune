"""Real-layout coverage for queued attachment chips at responsive widths."""

from __future__ import annotations

import base64

import pytest
from playwright.sync_api import Page, expect

from tests.browser_ui.chat.session_contract import ChatSessionContract

_IMAGE = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
)
_LONG_TEXT = "Compare these screenshots. " * 30


@pytest.mark.parametrize(
    ("width", "text", "screenshot_name"),
    [
        pytest.param(1280, _LONG_TEXT, "Screenshot 2026-09-18 at 11.49.24 AM.png", id="desktop"),
        pytest.param(390, "Hey", "", id="phone"),
        pytest.param(
            320,
            _LONG_TEXT,
            "Screenshot 2026-09-18 at 11.49.24 AM.png",
            id="narrow-phone",
        ),
    ],
)
def test_queued_attachments_keep_their_real_layout_contract(
    page: Page,
    chat_session_contract: ChatSessionContract,
    width: int,
    text: str,
    screenshot_name: str,
) -> None:
    """Keep chips compact and editable without uploading queued files."""
    chat = chat_session_contract
    expected_names = [screenshot_name or "image.png", "after.png", "notes.txt"]
    page.set_viewport_size({"width": width, "height": 844})
    page.goto(chat.url)
    chat.wait_for_stream()

    composer = page.get_by_label("Message the agent")
    expect(composer).to_be_visible(timeout=20_000)
    composer.fill("Hold this turn open for the attachment queue test.")
    with page.expect_response(
        lambda response: response.url.endswith(f"/{chat.session_id}/events")
    ):
        page.get_by_role("button", name="Send", exact=True).click()

    page.locator('form.chat-composer-form input[type="file"]').set_input_files(
        [
            {"name": screenshot_name, "mimeType": "image/png", "buffer": _IMAGE},
            {"name": "after.png", "mimeType": "image/png", "buffer": _IMAGE},
            {"name": "notes.txt", "mimeType": "text/plain", "buffer": b"Notes"},
        ]
    )
    composer.fill(text)
    page.get_by_role("button", name="Send", exact=True).click()

    strip = page.get_by_test_id("composer-queued-strip")
    chip = strip.get_by_test_id("queued-message-attachments")
    expect(chip).to_be_visible()
    expect(chip).to_have_attribute("title", "\n".join(expected_names))
    expect(chip.get_by_text(expected_names[0], exact=True)).to_be_visible()
    expect(chip.get_by_text("+2", exact=True)).to_be_visible()
    assert len(chat.event_posts) == 1, "The attachment message was posted instead of queued"
    assert not chat.upload_requests, "Rendering queued attachments must not upload them"

    layout = chip.evaluate(
        """chip => {
            const text = chip.previousElementSibling;
            const chipBox = chip.getBoundingClientRect();
            const textBox = text?.getBoundingClientRect();
            const row = chip.closest('[role="listitem"]');
            const action = row.querySelector('[aria-label="Edit queued message"]');
            return {
                nameWidth: chip.querySelector('.truncate').clientWidth,
                textWidth: textBox?.width,
                sameLine: !textBox || Math.abs(
                    chipBox.y + chipBox.height / 2 - textBox.y - textBox.height / 2
                ) < 1,
                noOverlap: chipBox.right <= action.getBoundingClientRect().left,
                rowHeight: row.getBoundingClientRect().height,
            };
        }"""
    )
    assert layout["sameLine"], layout
    assert layout["noOverlap"], layout
    assert layout["nameWidth"] > 0, layout
    assert layout["rowHeight"] <= (48 if width < 768 else 28), layout
    if text:
        assert layout["textWidth"] >= 16, layout
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")

    strip.get_by_role("button", name="Edit queued message", exact=True).click()
    expect(strip).to_have_count(0)
    expect(composer).to_have_value(text.strip())
    for name in expected_names:
        expect(page.get_by_role("button", name=f"Remove {name}", exact=True)).to_be_visible()
    page.get_by_role("button", name="Send", exact=True).click()
    expect(chip).to_be_visible()
    expect(chip).to_have_attribute("title", "\n".join(expected_names))
    strip.get_by_role("button", name="Remove queued message", exact=True).click()
    expect(strip).to_have_count(0)
    assert len(chat.event_posts) == 1
    assert not chat.upload_requests


@pytest.mark.parametrize("width", [1280, 390], ids=["desktop", "phone"])
def test_queue_send_controls_preserve_restored_fifo_and_attachment(
    page: Page, chat_session_contract: ChatSessionContract, width: int
) -> None:
    chat = chat_session_contract
    chat.reject_uploads = False
    chat.contract.json(
        f"/v1/sessions/{chat.session_id}/resources/files/browser-upload-1",
        {"name": "first-notes.txt", "metadata": {"bytes": 21, "content_type": "text/plain"}},
    )
    page.set_viewport_size({"width": width, "height": 844})
    page.goto(chat.url)
    chat.wait_for_stream()
    composer = page.get_by_label("Message the agent")
    expect(composer).to_be_visible(timeout=20_000)
    composer.fill("Hold the current turn open.")
    with page.expect_response(
        lambda response: response.url.endswith(f"/{chat.session_id}/events")
    ):
        if width >= 768:
            composer.press("Enter")
        else:
            page.get_by_role("button", name="Send", exact=True).click()
    chat.emit_busy()
    page.locator('form.chat-composer-form input[type="file"]').set_input_files(
        {"name": "first-notes.txt", "mimeType": "text/plain", "buffer": b"queued original bytes"}
    )
    composer.fill("First queued message")
    if width >= 768:
        composer.press("Enter")
    else:
        page.get_by_role("button", name="Send", exact=True).click()
    strip = page.get_by_test_id("composer-queued-strip")
    expect(strip).to_contain_text("First queued message")
    composer.fill("Second queued message")
    if width >= 768:
        composer.press("Enter")
    else:
        page.get_by_role("button", name="Send", exact=True).click()
    expect(strip).to_contain_text("Second queued message")
    assert len(chat.event_posts) == 1
    page.reload()
    chat.wait_for_stream()
    expect(strip).to_contain_text("First queued message", timeout=20_000)
    expect(strip).to_contain_text("first-notes.txt")
    expect(composer).to_have_value("")
    with page.expect_response(
        lambda response: response.url.endswith(f"/{chat.session_id}/events")
    ):
        if width >= 768:
            composer.press("Enter")
        else:
            composer.press("Enter")
            assert len(chat.event_posts) == 1
            strip.get_by_role("button", name="Send queued message now", exact=True).first.click()
    expect(strip).not_to_contain_text("First queued message")
    expect(strip).to_contain_text("Second queued message")
    assert len(chat.event_posts) == 2
    event = chat.event_posts[-1]["body"]
    assert "First queued message" in str(event)
    assert "Second queued message" not in str(event)
    assert len(chat.upload_requests) == 1
    assert b'filename="first-notes.txt"' in chat.upload_requests[0]["body_bytes"]
    assert b"queued original bytes" in chat.upload_requests[0]["body_bytes"]
    # A newline gesture must not send the next queued item.
    composer.press("Shift+Enter")
    assert len(chat.event_posts) == 2
