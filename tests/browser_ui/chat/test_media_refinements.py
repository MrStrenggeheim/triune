# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Compiled media geometry and controls with the existing chat wire fixture."""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from PIL import Image
from playwright.sync_api import Page, expect

from tests.browser_ui.chat.session_contract import ChatSessionContract, message_item


@pytest.mark.parametrize("width", [1440, 390], ids=["desktop", "phone"])
def test_preview_footer_density_and_gallery_controls(
    page: Page, chat_session_contract: ChatSessionContract, output_path: str, width: int
) -> None:
    chat = chat_session_contract
    page.set_viewport_size({"width": width, "height": 900})
    page.emulate_media(reduced_motion="reduce")
    item = message_item("media-user", "user", "", response_id="media-turn")
    for name in ("first", "second"):
        buffer = io.BytesIO()
        Image.new("RGBA", (480, 320), (104, 81, 139, 100)).save(buffer, format="PNG")
        png = buffer.getvalue()
        route = f"/v1/sessions/{chat.session_id}/resources/files/{name}"
        chat.contract.json(
            route,
            {"name": f"{name}.png", "metadata": {"bytes": len(png), "content_type": "image/png"}},
        )
        chat.contract.route(
            chat.contract._matcher(route + "/content"),
            lambda route, _request, data=png: route.fulfill(body=data, content_type="image/png"),
        )
        item["content"].append({"type": "input_image", "file_id": name, "filename": f"{name}.png"})
    chat.set_items([item])
    page.goto(chat.url)
    expect(page.get_by_label("Message the agent")).to_be_visible(timeout=30_000)
    image = page.get_by_role("img", name="first.png", exact=True)
    expect(image).to_have_js_property("naturalWidth", 480)
    footer = page.locator(".chat-attachment-footer").first
    heights = {}
    for density in ("comfortable", "compact"):
        page.locator("html").evaluate(
            "(node, density) => node.dataset.listDensity = density", density
        )
        heights[density] = footer.evaluate("node => node.getBoundingClientRect().height")
        expect(footer.get_by_role("button", name="Download first.png")).to_be_enabled()
        assert footer.evaluate("node => node.scrollWidth <= node.clientWidth + 1")
    assert heights["compact"] < heights["comfortable"]
    page.get_by_role("button", name="Zoom image: first.png", exact=True).click()
    dialog = page.get_by_role("dialog")
    expect(dialog.get_by_text("1 / 2", exact=True)).to_be_visible()
    roll = dialog.get_by_role("group", name="Chat images")
    expect(roll).to_have_css("scrollbar-width", "none")
    controls = [
        dialog.get_by_role("button", name=name, exact=True)
        for name in ("Next image", "Download image", "Close", "Zoom in")
    ]
    boxes = [control.bounding_box() for control in controls]
    assert all(box is not None for box in boxes)
    for box in boxes:
        assert box["width"] == pytest.approx(boxes[0]["width"], abs=1)
        assert box["height"] == pytest.approx(boxes[0]["height"], abs=1)
    artifacts = Path(output_path)
    artifacts.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(artifacts / "gallery-controls.png"))
    dialog.get_by_test_id("lightbox-stage").click(position={"x": 4, "y": 60})
    expect(dialog).to_have_count(0)
    page.screenshot(path=str(artifacts / "compact-footer.png"))
