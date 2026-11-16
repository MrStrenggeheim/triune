# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
"""Verify shared Mermaid presentation through the compiled chat renderer."""

from pathlib import Path
from xml.etree import ElementTree

import pytest
from playwright.sync_api import Page, expect

from tests.browser_ui.chat.session_contract import ChatSessionContract, message_item


@pytest.mark.parametrize("width", [1280, 375], ids=["desktop-light", "phone-dark"])
def test_compiled_mermaid_depth_frame_and_svg_export(
    page: Page,
    chat_session_contract: ChatSessionContract,
    output_path: str,
    width: int,
) -> None:
    page.set_viewport_size({"width": width, "height": 900})
    page.emulate_media(color_scheme="dark" if width == 375 else "light")
    diagram = """flowchart TD
subgraph Outer[Outer group]
subgraph Middle[Middle group]
subgraph Inner[Inner group]
A[Square] --> B(Rounded)
end
B --> C{Decision}
end
C --> D([Ready])
end"""
    chat = chat_session_contract
    chat.set_items(
        [
            {
                **message_item(
                    "diagram", "assistant", f"```mermaid\n{diagram}\n```", response_id="diagram"
                ),
                "phase": "final_answer",
            }
        ]
    )
    page.goto(chat.url)
    frame = page.locator(".chat-mermaid").first
    svg = frame.locator('svg[id^="mermaid-"]')
    expect(svg).to_be_visible(timeout=30_000)
    expect(frame.get_by_role("region", name="Diagram preview", exact=True)).to_be_visible()
    geometry = frame.evaluate("""element => {
      const view = element.closest('[data-chat-surface], [data-workbench-view]');
      const viewport = visualViewport;
      const bounds = view.getBoundingClientRect();
      const available = Math.min(bounds.bottom, (viewport?.offsetTop ?? 0) +
        (viewport?.height ?? innerHeight)) - Math.max(bounds.top, viewport?.offsetTop ?? 0);
      return {available, height: element.getBoundingClientRect().height,
        width: element.getBoundingClientRect().width,
        fills: [...element.querySelectorAll('.cluster > rect:first-child')]
          .map(node => getComputedStyle(node).fill),
        labels: [...element.querySelectorAll('.nodeLabel')]
          .map(node => parseFloat(getComputedStyle(node).fontSize))};
    }""")
    assert geometry["height"] <= geometry["available"] * 0.6 + 2, geometry
    assert geometry["width"] <= width, geometry
    assert len(set(geometry["fills"])) >= 2, geometry
    assert geometry["labels"] and min(geometry["labels"]) >= 14, geometry
    expect(svg.locator(".triune-heading-foreground")).to_have_count(1)
    assert svg.locator(".triune-label-background").count() >= 3
    frame.get_by_role("button", name="Download diagram", exact=True).click()
    with page.expect_download() as download:
        page.get_by_text("SVG", exact=True).click()
    exported = Path(download.value.path()).read_text()
    parsed = ElementTree.fromstring(exported)
    assert parsed.tag.endswith("svg")
    assert "triune-heading-foreground" in exported
    assert not any(node.tag.rsplit("}", 1)[-1] in {"script", "iframe"} for node in parsed.iter())
    frame.get_by_role("button", name="View fullscreen", exact=True).click()
    expect(page.get_by_role("button", name="Exit fullscreen", exact=True)).to_be_visible()
    page.keyboard.press("Escape")
    expect(page.get_by_role("button", name="Exit fullscreen", exact=True)).to_have_count(0)
    page.screenshot(path=str(Path(output_path) / f"mermaid-{width}.png"))
