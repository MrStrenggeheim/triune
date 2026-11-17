# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Shared transcript composition: media boundaries, card alignment and table replay."""

from __future__ import annotations

import io
import json
import re
from pathlib import Path

import pytest
from PIL import Image
from playwright.sync_api import Page, expect

from tests.browser_ui.chat.session_contract import ChatSessionContract, message_item


@pytest.mark.parametrize("width", [1440, 390], ids=["desktop", "phone"])
def test_media_slots_agent_bar_and_table_survive_reload(
    page: Page, chat_session_contract: ChatSessionContract, output_path: str, width: int
) -> None:
    chat = chat_session_contract
    page.set_viewport_size({"width": width, "height": 1100})
    page.emulate_media(reduced_motion="reduce")
    table = "| Punctuation | Meaning |\n| --- | --- |\n| **,** | comma |\n| **:** | colon |"
    items = [
        message_item("request", "user", "Show the inspection", response_id="turn"),
        {
            "id": "command",
            "type": "function_call",
            "call_id": "command-call",
            "name": "shell",
            "arguments": json.dumps({"command": "printf audit"}),
            "status": "completed",
            "response_id": "turn",
        },
        {
            "id": "command-output",
            "type": "function_call_output",
            "call_id": "command-call",
            "output": "audit",
            "response_id": "turn",
        },
        {
            "id": "agent-event",
            "type": "resource_event",
            "status": "completed",
            "response_id": "turn",
            "event_type": "session.subagent.delegated",
            "resource_type": "session",
            "resource_id": "inspection-child",
            "resource": {
                "agent_name": "Inspector",
                "dispatch_id": "inspection",
                "task_summary": "Inspect media geometry",
                "task_input": "Check **preview alignment** and preserve every file.",
            },
        },
    ]
    buffer = io.BytesIO()
    Image.new("RGBA", (240, 160), (104, 81, 139, 80)).save(buffer, format="PNG")
    for name in ("first", "second", "third", "fourth", "fifth", "notes"):
        is_image = name != "notes"
        filename = name + (".png" if is_image else ".txt")
        mime = "image/png" if is_image else "text/plain"
        body = buffer.getvalue() if is_image else b"Nonvisual boundary"
        resource = f"/v1/sessions/{chat.session_id}/resources/files/{name}"
        chat.contract.json(
            resource, {"name": filename, "metadata": {"bytes": len(body), "content_type": mime}}
        )
        chat.contract.route(
            chat.contract._matcher(resource + "/content"),
            lambda route, _request, data=body, content_type=mime: route.fulfill(
                body=data, content_type=content_type
            ),
        )
    for name in ("first", "second", "third", "separator", "fourth", "notes", "fifth"):
        if name == "separator":
            items.append(
                message_item(name, "assistant", "Visible media boundary", response_id="turn")
            )
            continue
        if name in ("second", "third", "fifth"):
            source = f"/v1/sessions/{chat.session_id}/resources/files/{name}/content"
            markdown = (
                f"![{name}][preview]\n\n[preview]: {source}"
                if name == "third"
                else f"![{name}]({source})"
            )
            items.append(
                message_item("media-" + name, "assistant", markdown, response_id="image-" + name)
            )
            continue
        item = message_item("media-" + name, "assistant", "", response_id="attachment-" + name)
        item["content"] = [
            {
                "type": "output_file",
                "file_id": name,
                "filename": name + (".txt" if name == "notes" else ".png"),
            }
        ]
        items.append(item)
    items.append(message_item("table", "assistant", table, response_id="turn"))
    chat.set_items(list(reversed(items)))
    page.goto(chat.url)
    expect(page.get_by_label("Message the agent")).to_be_visible(timeout=30_000)
    for name in ("first", "second", "third", "fourth", "fifth"):
        expect(page.get_by_role("img", name=name + ".png", exact=True)).to_have_js_property(
            "naturalWidth", 240
        )
    rows = page.locator("[data-media-batch]")
    expect(rows).to_have_count(1)
    expect(rows.get_by_role("img")).to_have_count(3)
    expect(rows.get_by_test_id("assistant-text-section")).to_have_count(3)
    assert rows.get_by_test_id("assistant-text-section").evaluate_all(
        "nodes => nodes.map(node => node.dataset.searchItemId)"
    ) == ["media-first", "media-second", "media-third"]
    for name in ("fourth", "fifth"):
        assert page.get_by_role("img", name=name + ".png", exact=True).evaluate(
            "node => node.closest('[data-media-batch]') === null"
        )
    first = rows.get_by_role("img", name="first.png", exact=True).bounding_box()
    second = rows.get_by_role("img", name="second.png", exact=True).bounding_box()
    assert first and second
    assert first["y"] == pytest.approx(second["y"], abs=1)
    assert first["x"] + first["width"] <= second["x"] + 1
    expect(page.get_by_role("table").locator('[data-streamdown="strong"],strong')).to_have_count(2)
    expect(page.get_by_role("table")).not_to_contain_text("**")
    for fold in page.get_by_role("button", name="Worked", exact=True).all():
        if fold.get_attribute("aria-expanded") != "true":
            fold.click()
    for summary in page.get_by_role(
        "button", name=re.compile(r"^(Ran 1 shell command(?:, 1 subagent)?|1 subagent)$")
    ).all():
        if summary.get_attribute("aria-expanded") != "true":
            summary.click()
    tool = page.locator('[data-slot="collapsible-trigger"]').filter(has_text="printf audit")
    expect(tool).to_have_count(1)
    card = page.get_by_test_id("subagent-activity")
    expect(card).to_have_count(1)
    geometry = []
    for theme, density in (("light", "comfortable"), ("dark", "compact")):
        page.locator("html").evaluate(
            "(node, values) => {node.classList.toggle('dark',values[0]==='dark');"
            "node.dataset.listDensity=values[1]}",
            [theme, density],
        )
        icon = tool.locator(":scope > svg").first.bounding_box()
        accent = card.locator(":scope > .activity-row--message")
        border = accent.bounding_box()
        assert icon and border
        color = accent.evaluate("""node => {
          const probe=document.createElement('i');
          probe.style.borderLeftColor='color-mix(in oklab, var(--primary) 60%, transparent)';
          node.append(probe);
          const expected=getComputedStyle(probe).borderLeftColor;
          probe.remove();
          return {actual:getComputedStyle(node).borderLeftColor,expected,
            width:parseFloat(getComputedStyle(node).borderLeftWidth)};
        }""")
        assert border["x"] + color["width"] / 2 == pytest.approx(
            icon["x"] + icon["width"] / 2, abs=1
        )
        assert color["actual"] == color["expected"]
        geometry.append(
            {"theme": theme, "density": density, "icon": icon, "border": border, "color": color}
        )
    header = card.locator(".activity-message-header")
    header_before = header.bounding_box()
    expect(header.locator(".resource-description")).to_be_visible()
    expect(header.locator(".resource-description")).not_to_contain_text("**")
    card.get_by_role("button", name="Expand activity", exact=True).click()
    expect(header.locator(".resource-description")).to_have_count(0)
    header_after = header.bounding_box()
    assert header_before and header_after
    assert header_after["height"] == pytest.approx(header_before["height"], abs=1)
    for control in header.locator("button,a").all():
        bounds = control.bounding_box()
        assert bounds
        assert bounds["y"] + bounds["height"] / 2 == pytest.approx(
            header_after["y"] + header_after["height"] / 2, abs=1
        )
    artifacts = Path(output_path)
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / "composition-geometry.json").write_text(json.dumps(geometry, indent=2))
    page.screenshot(path=str(artifacts / "transcript-composition.png"), full_page=True)
    page.reload()
    expect(page.get_by_role("table").locator('[data-streamdown="strong"],strong')).to_have_count(2)
    expect(page.get_by_role("table")).not_to_contain_text("**")
    expect(rows).to_have_count(1)
