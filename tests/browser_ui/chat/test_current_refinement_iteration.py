# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Current refinements through the built SPA with explicit browser contracts.

These journeys prove rendering and interactions, not native CLI delivery.
"""

from __future__ import annotations

import io
import json
import re
import time
from collections.abc import Iterator
from itertools import pairwise
from pathlib import Path

import pytest
from PIL import Image, ImageDraw
from playwright.sync_api import Locator, Page, Route, expect

from tests.browser_ui.chat._geometry_helpers import (
    TOLERANCE,
    assert_activity_entry,
    assert_no_overlap,
    assert_same_vertical_center,
    assert_within_viewport,
    box,
)
from tests.browser_ui.chat.session_contract import list_payload, message_item
from tests.browser_ui.chat.test_unified_workspace import (
    WorkspaceJourney,
    _capture,
    _navigate_chat,
    _view,
)
from tests.browser_ui.chat.test_unified_workspace import browser_errors as browser_errors
from tests.browser_ui.chat.test_unified_workspace import workspace_journey as workspace_journey
from tests.browser_ui.conftest import BrowserContract


@pytest.fixture(
    params=[
        ("desktop", "light"),
        pytest.param(
            ("mobile", "dark"),
            marks=pytest.mark.browser_context_args(has_touch=True, is_mobile=True),
        ),
    ],
    ids=lambda value: "-".join(value),
)
def appearance(page: Page, request: pytest.FixtureRequest) -> str:
    device, theme = request.param
    page.set_viewport_size(
        {
            "width": 390 if device == "mobile" else 1440,
            "height": 844 if device == "mobile" else 1000,
        }
    )
    page.emulate_media(color_scheme=theme, reduced_motion="reduce")
    density = "compact" if device == "mobile" else "comfortable"
    page.add_init_script(
        f"""if (localStorage.getItem('omnigent:list-density') === null) {{
            localStorage.setItem('omnigent:list-density', '{density}');
        }}"""
    )
    return f"{device}-{theme}"


@pytest.fixture(autouse=True)
def _no_browser_errors(
    page: Page,
    browser_errors: list[str],
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
) -> Iterator[None]:
    for chat in workspace_journey.chats:
        browser_contract.json(
            f"/v1/sessions/{chat.session_id}/resources/environments/default",
            {"metadata": {"root": workspace_journey.workspace["root"]}},
        )
        browser_contract.json(f"/v1/sessions/{chat.session_id}/resources/github", {"metadata": {}})
    errors: list[str] = []
    page.on(
        "console",
        lambda message: (
            errors.append(f"{message.text} {message.location.get('url', '')}")
            if message.type == "error"
            else None
        ),
    )
    yield
    assert browser_errors == []
    assert errors == [], "Browser console errors: " + "\n".join(errors)


def _assert_footerless_card(card: Locator, *, controls: int) -> dict:
    expect(card.get_by_role("button", name=re.compile(r"^Copy(?: link)?$"))).to_have_count(0)
    expect(card.get_by_test_id("message-timestamp")).to_have_count(0)
    actions = card.locator(".resource-actions").locator("a, button")
    expect(actions).to_have_count(controls)
    assert actions.last.get_attribute("aria-controls")
    geometry = card.locator(".activity-row").evaluate(
        """element => {
          const row = element.querySelector('[data-resource-row]');
          const style = getComputedStyle(element);
          return {card: element.getBoundingClientRect().toJSON(),
            row: row.getBoundingClientRect().toJSON(),
            padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
            border: parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)};
        }"""
    )
    assert geometry["card"]["height"] == pytest.approx(
        geometry["row"]["height"] + geometry["padding"] + geometry["border"], abs=TOLERANCE
    ), geometry
    return geometry


def _assert_stable_disclosure(card: Locator) -> dict:
    """Compare header-relative bounds so transcript scrolling cannot mask a layout shift."""
    disclosure = card.get_by_role(
        "button", name=re.compile(r"^(Expand|Collapse) activity(?: · .+)?$")
    )
    expanded = disclosure.get_attribute("aria-expanded") == "true"

    def measure() -> dict:
        return card.locator("[data-resource-row]").evaluate(
            """row => {
              const header = row.getBoundingClientRect();
              return {height: header.height,
                parts: [...row.querySelectorAll(
                  '.resource-icon, .activity-status-slot, ' +
                  '.resource-actions button, .resource-actions a'
                )].map(element => {
                  const bounds = element.getBoundingClientRect();
                  return {x: bounds.x - header.x, y: bounds.y - header.y,
                    width: bounds.width, height: bounds.height};
                })};
            }"""
        )

    before = measure()
    disclosure.click()
    expect(disclosure).to_have_attribute("aria-expanded", str(not expanded).lower())
    after = measure()
    assert after["height"] == pytest.approx(before["height"], abs=TOLERANCE), (before, after)
    assert len(after["parts"]) == len(before["parts"])
    for initial, changed in zip(before["parts"], after["parts"], strict=True):
        assert changed == pytest.approx(initial, abs=TOLERANCE), (before, after)
    disclosure.click()
    expect(disclosure).to_have_attribute("aria-expanded", str(expanded).lower())
    return {"before": before, "after": after}


def _assert_opaque_popup(popup: Locator, output_path: str, name: str) -> None:
    expect(popup).to_be_visible()
    styles = popup.evaluate(
        """element => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d');
          context.fillStyle = getComputedStyle(element).backgroundColor;
          context.fillRect(0, 0, 1, 1);
          const ancestors = [];
          for (let node = element; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            ancestors.push({tag: node.tagName, className: node.className,
              backgroundColor: style.backgroundColor, opacity: style.opacity,
              backdropFilter: style.backdropFilter || style.webkitBackdropFilter || 'none',
              filter: style.filter});
          }
          return {backgroundAlpha: context.getImageData(0, 0, 1, 1).data[3] / 255,
            ancestors};
        }"""
    )
    Path(output_path).mkdir(parents=True, exist_ok=True)
    (Path(output_path) / f"{name}-popup-style.json").write_text(
        json.dumps(styles, indent=2) + "\n"
    )
    assert styles["backgroundAlpha"] == 1, styles
    for ancestor in styles["ancestors"]:
        assert float(ancestor["opacity"]) == 1, ancestor
        assert ancestor["backdropFilter"] == "none", ancestor
        assert ancestor["filter"] == "none", ancestor


def test_provenance_peer_directions_and_reload(
    page: Page, workspace_journey: WorkspaceJourney, output_path: str, appearance: str
) -> None:
    first, second = workspace_journey.chats
    first.update_session(sub_agent_name="Orion", agent_name="Orion")
    second.update_session(sub_agent_name="Jules", agent_name="Jules")
    quotation = "[System: timer build fired]"
    recovery = "Please continue from where you left off."
    human = message_item("human-quotation", "user", quotation, response_id="human")
    human_recovery = message_item("human-recovery", "user", recovery, response_id="human-recovery")
    assistant = message_item(
        "ordinary-answer", "assistant", "Ordinary assistant answer.", response_id="ordinary"
    )
    unknown = {
        **message_item("unknown-account", "user", quotation, response_id="import"),
        "user_authored": False,
        "created_by": "owner@example.test",
    }
    system = {
        **message_item("recovery-control", "user", recovery, response_id="control"),
        "user_authored": False,
        "communication": {
            "kind": "system",
            "message_id": "recovery-control",
            "source_title": "Session recovery",
            "destination_conversation_id": first.session_id,
            "delivery_state": "confirmed",
        },
    }
    incoming = {
        **message_item(
            "received-report", "user", "Checked the requested workspace.", response_id="received"
        ),
        "user_authored": False,
        "communication": {
            "kind": "peer",
            "message_id": "received-report",
            "source_conversation_id": second.session_id,
            "source_agent_name": "Jules",
            "source_title": "Chat B",
            "destination_conversation_id": first.session_id,
            "delivery_state": "confirmed",
        },
    }
    outgoing = {
        **message_item(
            "sent-request",
            "assistant",
            "Please inspect the original scope.\nPreserve the captured source.\n"
            "Keep the linked chat.\nExpanded peer detail.",
            response_id="sent",
        ),
        "communication": {
            "kind": "peer",
            "message_id": "sent-request",
            "source_conversation_id": first.session_id,
            "source_agent_name": "Orion",
            "source_title": "Chat A",
            "destination_conversation_id": second.session_id,
            "delivery_state": "confirmed",
        },
    }
    tasks = [
        {
            "id": f"audit-{phase}",
            "type": "resource_event",
            "status": "completed",
            "response_id": f"audit-{phase}",
            "event_type": f"session.subagent.{phase}",
            "resource_type": "session",
            "resource_id": second.session_id,
            "resource": {
                "agent_name": "Jules",
                "dispatch_id": "card-audit",
                "task_summary": "Shared card audit",
                "task_input": "Inspect the compact cards.\n\nFull captured assignment.",
                **(
                    {
                        "status": "completed",
                        "result_finality": "final_answer",
                        "turn_id": "audit-turn",
                        "result_text": (
                            "Compact **cards pass**.\nSecond line.\nThird line.\n\n"
                            "| Check | Result |\n| --- | --- |\n| Footer | Absent |"
                        ),
                    }
                    if phase == "returned"
                    else {}
                ),
            },
        }
        for phase in ("delegated", "returned")
    ]
    first.set_items(
        list(
            reversed(
                [human, human_recovery, assistant, unknown, system, incoming, outgoing, *tasks]
            )
        )
    )
    second.set_items([{**outgoing, "id": "received-request"}])
    page.goto(first.url)
    chat = _view(page, "Chat A")
    expect(chat.get_by_label("Message the agent")).to_be_visible(timeout=30_000)
    measurements = {}
    for reload in (False, True):
        if reload:
            page.reload()
        for item_id in ("human-quotation", "human-recovery"):
            bubble = chat.locator(f'[data-message-id="{item_id}"]')
            expect(bubble).to_have_attribute("data-role", "user")
            expect(bubble.get_by_role("button", name="Copy", exact=True)).to_have_count(1)
        expect(
            chat.locator('[data-message-id="ordinary"]').get_by_role(
                "button", name="Copy", exact=True
            )
        ).to_have_count(1)
        external = chat.locator('[data-message-id="unknown-account"]')
        expect(external).to_have_attribute("data-role", "external")
        expect(external).to_contain_text(quotation)
        expect(external.get_by_test_id("message-author")).to_have_count(0)
        control = chat.locator('[data-message-id="recovery-control"]')
        expect(control).to_have_attribute("data-role", "system")
        _assert_footerless_card(control, controls=1)
        control.get_by_role("button", name="Expand activity", exact=True).click()
        expect(control).to_contain_text(recovery)
        control.get_by_role("button", name="Collapse activity", exact=True).click()
        if not reload:
            measurements["system-expansion"] = _assert_stable_disclosure(control)
        received = chat.locator('[data-message-id="received-report"]')
        sent = chat.locator('[data-message-id="sent-request"]')
        for card, direction, attribution, name in (
            (received, "received", "Chat B from Chat B", "Chat B"),
            (sent, "sent", "Chat A sent to Chat B", "Chat A"),
        ):
            expect(card).to_have_attribute("data-direction", direction)
            expect(
                card.get_by_role(
                    "button", name=f"Expand activity · Chat B {direction}", exact=True
                )
            ).to_be_visible()
            assert_activity_entry(card.locator("[data-resource-row]"))
            expect(card.get_by_role("status")).to_have_count(0)
            expect(card.locator("[data-resource-row]")).to_contain_text(attribution)
            expect(card.locator("strong")).to_have_text(name)
            expect(card.get_by_role("link", name="Chat B", exact=True)).to_have_attribute(
                "href", f"/c/{second.session_id}"
            )
            measurements[f"{direction}-{'reload' if reload else 'initial'}"] = (
                _assert_footerless_card(card, controls=3)
            )
            if not reload:
                measurements[f"{direction}-expansion"] = _assert_stable_disclosure(card)
        expect(chat.get_by_test_id("peer-message")).to_have_count(2)
        task = chat.get_by_test_id("subagent-activity")
        if not task.is_visible():
            chat.get_by_role("button", name="1 subagent", exact=True).click()
        expect(task).to_have_count(1)
        assert_activity_entry(task.locator("[data-resource-row]"))
        expect(task.get_by_role("status", name="Completed", exact=True)).to_be_visible()
        expect(chat.get_by_test_id("subagent-reply")).to_have_count(0)
        _assert_footerless_card(task, controls=3)
        if not reload:
            measurements["task-expansion"] = _assert_stable_disclosure(task)
            task.get_by_role("button", name="Expand activity · Chat B task", exact=True).click()
            expect(task).to_contain_text("Full captured assignment.")
            expect(task.get_by_role("table")).to_contain_text("FooterAbsent")
            _capture(page, output_path, f"{appearance}-expanded-task-and-reply")
            task.get_by_role("button", name="Collapse activity · Chat B task", exact=True).click()
            actions = sent.locator(".resource-actions").locator("a, button")
            fills = []
            for action in actions.all():
                action.hover()
                action.evaluate(
                    """element => Promise.all(element.getAnimations().map(
                        animation => animation.finished.catch(() => {})))"""
                )
                fills.append(
                    action.evaluate("element => getComputedStyle(element).backgroundColor")
                )
            assert len(set(fills)) == 1, fills
            expect(sent).not_to_contain_text("Expanded peer detail.")
            disclosure = sent.get_by_role(
                "button", name="Expand activity · Chat B sent", exact=True
            )
            disclosure.click()
            expect(sent).to_contain_text("Expanded peer detail.")
            glyph = sent.locator(".resource-actions button[aria-controls] svg").evaluate(
                """element => ({duration: getComputedStyle(element).transitionDuration,
                    rotate: getComputedStyle(element).rotate,
                    transform: getComputedStyle(element).transform})"""
            )
            assert float(glyph["duration"].removesuffix("s")) <= 0.00001 and (
                glyph["rotate"] == "90deg" or glyph["transform"].startswith("matrix(0, 1")
            ), glyph
            sent.get_by_role("button", name="Collapse activity · Chat B sent", exact=True).click()
        sent.scroll_into_view_if_needed()
        _capture(
            page, output_path, f"{appearance}-footerless-peer-{'reload' if reload else 'initial'}"
        )
    Path(output_path).mkdir(parents=True, exist_ok=True)
    (Path(output_path) / "card-geometry.json").write_text(
        json.dumps(measurements, indent=2) + "\n"
    )
    _navigate_chat(page, second)
    received = _view(page, "Chat B").get_by_test_id("peer-message")
    expect(received.locator("[data-resource-row]")).to_contain_text("Chat A from Chat A")
    _assert_footerless_card(received, controls=3)
    page.reload()
    expect(received).to_have_attribute("data-direction", "received")


def test_settings_controls_density_and_attachment_geometry(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    appearance: str,
) -> None:
    first = workspace_journey.chats[0]
    image = Image.new("RGB", (960, 180), "#f5f5f5")
    draw = ImageDraw.Draw(image)
    draw.text((24, 24), "Aspect-fit attachment: 960 x 180", fill="#252525")
    draw.rectangle((24, 80, 930, 150), fill="#68518b")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    png = buffer.getvalue()
    resource = f"/v1/sessions/{first.session_id}/resources/files/refinement-image"
    browser_contract.json(
        resource,
        {
            "id": "refinement-image",
            "name": "wide-summary.png",
            "metadata": {"bytes": len(png), "content_type": "image/png"},
        },
    )
    browser_contract.route(
        browser_contract._matcher(resource + "/content"),
        lambda route: route.fulfill(body=png, content_type="image/png"),
    )
    attachment = message_item(
        "image-message",
        "user",
        "Keep the image and its file actions together.",
        response_id="image-turn",
    )
    attachment["content"].append(
        {"type": "input_image", "file_id": "refinement-image", "filename": "wide-summary.png"}
    )
    first.set_items([attachment])
    page.goto(first.base_url + "/settings/appearance")
    expect(page.get_by_role("heading", name="Appearance", exact=True)).to_be_visible(
        timeout=30_000
    )
    theme = appearance.rsplit("-", 1)[1]
    page.get_by_test_id(f"theme-{theme}").click()
    expect(page.get_by_role("radiogroup", name="Mode", exact=True)).to_be_visible()
    expect(page.get_by_role("radiogroup", name="Terminal theme", exact=True)).to_be_visible()
    for obsolete in ("Workspace panel", "Default Workspace tab"):
        expect(page.get_by_role("radiogroup", name=obsolete, exact=True)).to_have_count(0)
    expect(page.get_by_test_id("settings-group-workspace")).to_have_count(0)
    assert page.locator("html").evaluate("element => element.classList.contains('dark')") == (
        theme == "dark"
    )
    _capture(page, output_path, f"{appearance}-approved-theme-controls")
    density = page.get_by_role("group", name="List density", exact=True)
    density.scroll_into_view_if_needed()
    comfortable = density.get_by_role("button", name="Comfortable", exact=True)
    compact = density.get_by_role("button", name="Compact", exact=True)
    comfortable.click()
    expect(comfortable).to_have_attribute("aria-pressed", "true")
    compact.click()
    expect(compact).to_have_attribute("aria-pressed", "true")
    expect(page.locator("html")).to_have_attribute("data-list-density", "compact")
    assert_same_vertical_center(box(comfortable), box(compact))
    assert_no_overlap(box(comfortable), box(compact))
    for choice in (comfortable, compact):
        assert_within_viewport(box(choice), page.viewport_size["width"])
    _capture(page, output_path, f"{appearance}-approved-settings")
    page.reload()
    expect(page.get_by_test_id("list-density-compact")).to_have_attribute("aria-pressed", "true")
    page.goto(first.url)
    chat = _view(page, "Chat A")
    preview = chat.get_by_role("img", name="wide-summary.png", exact=True)
    expect(preview).to_be_visible(timeout=30_000)
    expect(preview).to_have_js_property("naturalWidth", 960)
    card = chat.get_by_test_id("chat-attachment").filter(
        has=page.get_by_role("img", name="wide-summary.png", exact=True)
    )
    title = card.get_by_role("button", name="wide-summary.png", exact=True)
    footer = title.locator("xpath=../..")
    stage = preview.locator("xpath=../..")
    preview.scroll_into_view_if_needed()
    card_bounds, image_bounds, footer_bounds = box(card), box(preview), box(footer)
    stage_bounds = box(stage)
    assert image_bounds["width"] / image_bounds["height"] == pytest.approx(960 / 180, rel=0.01)
    assert image_bounds["height"] <= 180 + TOLERANCE
    gap = footer_bounds["y"] - image_bounds["y"] - image_bounds["height"]
    assert gap == pytest.approx(0, abs=TOLERANCE), (image_bounds, footer_bounds)
    assert image_bounds["x"] - card_bounds["x"] == pytest.approx(1, abs=TOLERANCE)
    assert image_bounds["y"] - card_bounds["y"] == pytest.approx(1, abs=TOLERANCE)
    assert stage_bounds["width"] == pytest.approx(image_bounds["width"], abs=TOLERANCE)
    assert card_bounds["height"] == pytest.approx(
        image_bounds["height"] + footer_bounds["height"] + 2, abs=2
    )
    expect(stage).to_have_css("padding", "0px")
    expect(stage).to_have_css("background-color", "rgba(0, 0, 0, 0)")
    expect(footer).to_have_css("padding", "12px")
    assert_within_viewport(card_bounds, page.viewport_size["width"])
    expect(
        card.get_by_role("button", name="Download wide-summary.png", exact=True)
    ).to_be_enabled()
    expect(
        card.get_by_role("button", name="More actions for wide-summary.png", exact=True)
    ).to_be_visible()
    Path(output_path).mkdir(parents=True, exist_ok=True)
    (Path(output_path) / "attachment-geometry.json").write_text(
        json.dumps({"image": image_bounds, "footer": footer_bounds, "card": card_bounds}, indent=2)
        + "\n"
    )
    _capture(page, output_path, f"{appearance}-aspect-fit-image-footer")
    page.reload()
    expect(preview).to_have_js_property("naturalWidth", 960)
    expect(
        card.get_by_role("button", name="Download wide-summary.png", exact=True)
    ).to_be_enabled()


@pytest.mark.parametrize("width", [390, 1440], ids=["mobile", "desktop"])
def test_portrait_and_tiny_image_footer_containment(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    width: int,
) -> None:
    first = workspace_journey.chats[0]
    page.set_viewport_size({"width": width, "height": 844 if width == 390 else 1000})
    page.emulate_media(color_scheme="light", reduced_motion="reduce")
    attachment = message_item(
        "narrow-images",
        "user",
        "Portrait and tiny attachment footers",
        response_id="narrow-images",
    )
    sizes = [("portrait", 100, 1000), ("tiny", 1, 1)]
    originals: dict[str, bytes] = {}
    for name, image_width, image_height in sizes:
        image = Image.new("RGBA", (image_width, image_height), (104, 81, 139, 128))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        png = buffer.getvalue()
        originals[f"{name}.png"] = png
        resource = f"/v1/sessions/{first.session_id}/resources/files/{name}"
        browser_contract.json(
            resource,
            {"name": f"{name}.png", "metadata": {"bytes": len(png), "content_type": "image/png"}},
        )
        browser_contract.route(
            browser_contract._matcher(resource + "/content"),
            lambda route, _request, content=png: route.fulfill(
                body=content, content_type="image/png"
            ),
        )
        attachment["content"].append(
            {"type": "input_image", "file_id": name, "filename": f"{name}.png"}
        )
    first.set_items([attachment])
    page.goto(first.url)
    chat = _view(page, "Chat A")
    batch = chat.get_by_role("group", name="Media previews", exact=True)
    expect(batch).to_have_count(1)
    expect(batch.get_by_test_id("chat-attachment")).to_have_count(2)
    expect(batch).to_have_css("flex-wrap", "nowrap")
    expect(batch).to_have_css("overflow-x", "auto")
    for name, image_width, image_height in sizes:
        preview = chat.get_by_role("img", name=f"{name}.png", exact=True)
        expect(preview).to_be_visible(timeout=30_000)
        expect(preview).to_have_js_property("naturalWidth", image_width)
        expect(preview).to_have_js_property("naturalHeight", image_height)
    page.evaluate(
        "() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
    )

    def measure() -> list[dict]:
        return chat.get_by_test_id("chat-attachment").evaluate_all(
            """cards => cards.map(card => {
              const rect = element => element.getBoundingClientRect().toJSON();
              const bounds = card.getBoundingClientRect();
              const image = card.querySelector('img');
              const buttons = [...card.querySelectorAll('button')].filter(button =>
                /^(Download |More actions for )/.test(button.getAttribute('aria-label') || ''));
              const title = [...card.querySelectorAll('button')].find(button =>
                button.textContent.trim() === image.alt);
              const titleBounds = title.getBoundingClientRect();
              const titleHit = document.elementFromPoint(
                titleBounds.x + titleBounds.width / 2, titleBounds.y + titleBounds.height / 2);
              const stage = image.parentElement.parentElement;
              const footer = title.parentElement.parentElement;
              return {
                name: image.alt, card: rect(card), image: rect(image), title: rect(title),
                stage: rect(stage), stagePadding: getComputedStyle(stage).padding,
                stageBackground: getComputedStyle(stage).backgroundColor,
                topRadius: getComputedStyle(stage).borderTopLeftRadius,
                footer: rect(footer), footerPadding: getComputedStyle(footer).padding,
                bottomRadius: getComputedStyle(footer).borderBottomLeftRadius,
                footerParts: [...footer.children].map(rect),
                naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
                titleHitTarget: titleBounds.width > 0 && !!titleHit && title.contains(titleHit),
                clientWidth: card.clientWidth, scrollWidth: card.scrollWidth,
                minWidth: getComputedStyle(card).minWidth,
                maxWidth: getComputedStyle(card).maxWidth,
                objectFit: getComputedStyle(image).objectFit,
                controls: buttons.map(button => {
                  const value = button.getBoundingClientRect();
                  const hit = document.elementFromPoint(
                    value.x + value.width / 2, value.y + value.height / 2);
                  return {name: button.getAttribute('aria-label'), box: rect(button),
                    contained: value.left >= bounds.left && value.right <= bounds.right + 1 &&
                      value.top >= bounds.top && value.bottom <= bounds.bottom + 1,
                    hitTarget: !!hit && button.contains(hit)};
                })
              };
            })"""
        )

    measurements = measure()
    _capture(page, output_path, f"narrow-images-{width}-current")
    evidence = Path(output_path)
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / "narrow-image-geometry.json").write_text(
        json.dumps({"viewport_width": width, "images": measurements}, indent=2) + "\n"
    )
    assert len(measurements) == 2
    assert measurements[0]["stage"]["y"] == pytest.approx(
        measurements[1]["stage"]["y"], abs=TOLERANCE
    )
    assert (
        measurements[0]["card"]["x"] + measurements[0]["card"]["width"]
        <= (measurements[1]["card"]["x"])
    )
    for row in measurements:
        assert row["stage"]["height"] == pytest.approx(256, abs=TOLERANCE), row
        # The original action pair needs 74px inside the card at extreme ratios.
        assert row["stage"]["width"] == pytest.approx(
            max(74, 256 * row["naturalWidth"] / row["naturalHeight"]), abs=TOLERANCE
        ), row
        assert row["stagePadding"] == "0px", row
        assert row["stageBackground"] == "rgba(0, 0, 0, 0)", row
        assert row["footerPadding"] == "12px", row
        assert float(row["topRadius"].removesuffix("px")) > 0, row
        assert float(row["bottomRadius"].removesuffix("px")) > 0, row
        assert row["footer"]["y"] == pytest.approx(
            row["stage"]["y"] + row["stage"]["height"], abs=TOLERANCE
        ), row
        assert row["card"]["height"] == pytest.approx(
            row["stage"]["height"] + row["footer"]["height"] + 2, abs=2
        ), row
        assert row["image"]["height"] <= min(256, row["naturalHeight"]) + TOLERANCE, row
        assert row["image"]["width"] <= row["naturalWidth"] + TOLERANCE, row
        assert row["image"]["width"] / row["image"]["height"] == pytest.approx(
            row["naturalWidth"] / row["naturalHeight"], rel=0.01
        ), row
        if row["name"] == "tiny.png":
            assert row["image"]["width"] == pytest.approx(1, abs=0.1), row
            assert row["image"]["height"] == pytest.approx(1, abs=0.1), row
        assert row["scrollWidth"] <= row["clientWidth"] + TOLERANCE, row
        assert row["titleHitTarget"], row
        for part in row["footerParts"]:
            assert part["x"] >= row["footer"]["x"], row
            assert part["x"] + part["width"] <= (
                row["footer"]["x"] + row["footer"]["width"] + TOLERANCE
            ), row
            assert part["y"] >= row["footer"]["y"], row
            assert part["y"] + part["height"] <= (
                row["footer"]["y"] + row["footer"]["height"] + TOLERANCE
            ), row
        assert len(row["controls"]) == 2, row
        assert all(control["contained"] and control["hitTarget"] for control in row["controls"]), (
            row
        )
        assert_within_viewport(row["card"], width)
        download = chat.get_by_role("button", name=f"Download {row['name']}", exact=True)
        expect(download).to_be_enabled()
        with page.expect_download() as downloaded:
            download.click()
        assert downloaded.value.suggested_filename == row["name"]
        assert Path(downloaded.value.path()).read_bytes() == originals[row["name"]]

    # Retain the scroller before the modal hides its tabpanel from role queries.
    transcript = chat.locator('[role="log"] > div').first.element_handle()
    assert transcript is not None
    # Delay the existing history contract after the transcript has rendered.
    pending_history: list[Route] = []
    browser_contract.route(
        browser_contract._matcher(f"/v1/sessions/{first.session_id}/items"),
        lambda route: pending_history.append(route),
    )
    chat.get_by_role("button", name="Zoom image: portrait.png", exact=True).click()
    gallery = page.get_by_role("dialog")
    stage = gallery.get_by_test_id("lightbox-stage")
    preview = gallery.get_by_role("img", name="portrait.png", exact=True)
    expect(preview).to_have_js_property("naturalHeight", 1000)
    original_preview = preview.element_handle()
    loading_stage, loading_image = box(stage), box(preview)
    expect(gallery.get_by_role("status")).to_have_text("Loading chat images…")
    skeletons = gallery.locator('[data-lightbox-controls] div[aria-hidden="true"] > span')
    expect(skeletons).to_have_count(3)
    skeleton = box(skeletons.first)
    assert skeleton["width"] == 64 and skeleton["height"] == 48, skeleton
    loading_status = box(gallery.get_by_role("status"))
    assert loading_status["width"] <= 1 and loading_status["height"] <= 1, loading_status
    expect(gallery.get_by_role("group", name="Chat images", exact=True)).to_have_count(0)
    assert pending_history, "Gallery must request the authorized message inventory"
    for request in pending_history:
        request.fulfill(json=list_payload([attachment]))
    expect(gallery.get_by_text("1 / 2", exact=True)).to_be_visible()
    assert preview.evaluate("(node, original) => node === original", original_preview)
    assert box(stage) == pytest.approx(loading_stage, abs=TOLERANCE)
    assert box(preview) == pytest.approx(loading_image, abs=TOLERANCE)
    roll = gallery.get_by_role("group", name="Chat images", exact=True)

    def selected_center() -> dict:
        page.wait_for_function("""() => {
          const roll = document.querySelector('[aria-label="Chat images"]');
          const selected = roll?.querySelector('[aria-current="true"]');
          if (!selected) return false;
          const frame = roll.getBoundingClientRect(), slot = selected.getBoundingClientRect();
          return Math.abs(slot.x + slot.width / 2 - frame.x - frame.width / 2) <= 1;
        }""")
        frame, slot = box(roll), box(roll.locator('[aria-current="true"]'))
        assert slot["x"] + slot["width"] / 2 == pytest.approx(
            frame["x"] + frame["width"] / 2, abs=TOLERANCE
        )
        return {"roll": frame, "selected": slot}

    def click_disabled_arrow(label: str, count: str) -> None:
        arrow = gallery.get_by_role("button", name=label, exact=True)
        expect(arrow).to_be_disabled()
        assert arrow.evaluate("""node => {
          const bounds = node.getBoundingClientRect();
          return node.contains(document.elementFromPoint(
            bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
        }"""), label
        bounds = box(arrow)
        for _ in range(2):
            page.mouse.click(bounds["x"] + bounds["width"] / 2, bounds["y"] + bounds["height"] / 2)
        expect(gallery).to_be_visible()
        expect(gallery.get_by_text(count, exact=True)).to_be_visible()
        expect(gallery.get_by_role("button", name="Close", exact=True)).to_be_visible()

    first_center = selected_center()
    click_disabled_arrow("Previous image", "1 / 2")
    expect(stage).to_have_css("cursor", "default")
    preview.click()
    expect(gallery.get_by_role("button", name="Close", exact=True)).to_have_count(0)
    assert box(stage) == pytest.approx(loading_stage, abs=TOLERANCE)
    assert box(preview) == pytest.approx(loading_image, abs=TOLERANCE)
    gallery.press("Tab")
    expect(gallery.get_by_role("button", name="Close", exact=True)).to_be_visible()
    assert transcript.evaluate("node => node.isConnected")
    background = transcript.evaluate("node => [scrollY, node.scrollTop]")
    roll_bounds = box(roll)
    page.mouse.move(
        roll_bounds["x"] + roll_bounds["width"] / 2,
        roll_bounds["y"] + roll_bounds["height"] / 2,
    )
    page.mouse.wheel(0, 80)
    page.wait_for_function("document.querySelector('[aria-label=\"Chat images\"]').scrollLeft > 0")
    expect(gallery.get_by_role("button", name="Reset zoom", exact=True)).to_have_text("100%")
    assert transcript.evaluate("node => [scrollY, node.scrollTop]") == background
    image_bounds = box(preview)
    page.mouse.move(
        image_bounds["x"] + image_bounds["width"] / 2,
        image_bounds["y"] + image_bounds["height"] / 2,
    )
    page.mouse.wheel(0, -80)
    expect(gallery.get_by_role("button", name="Reset zoom", exact=True)).to_have_text("150%")
    gallery.get_by_role("button", name="Reset zoom", exact=True).click()
    gallery.get_by_role("button", name="Next image", exact=True).click()
    expect(gallery.get_by_role("img", name="tiny.png", exact=True)).to_have_js_property(
        "naturalWidth", 1
    )
    expect(gallery.get_by_text("2 / 2", exact=True)).to_be_visible()
    last_center = selected_center()
    click_disabled_arrow("Next image", "2 / 2")
    gallery.press("ArrowLeft")
    expect(gallery.get_by_role("img", name="portrait.png", exact=True)).to_have_js_property(
        "naturalHeight", 1000
    )
    gallery.get_by_role("button", name="View image 2: tiny.png", exact=True).click()
    with page.expect_download() as selected_download:
        gallery.get_by_role("button", name="Download image", exact=True).click()
    assert Path(selected_download.value.path()).read_bytes() == originals["tiny.png"]
    (evidence / "gallery-overlay-geometry.json").write_text(
        json.dumps(
            {
                "viewport_width": width,
                "loading_stage": loading_stage,
                "loading_image": loading_image,
                "skeleton": skeleton,
                "first_center": first_center,
                "last_center": last_center,
            },
            indent=2,
        )
        + "\n"
    )
    gallery.get_by_role("button", name="Close", exact=True).click()
    expect(gallery).to_have_count(0)


def test_shelf_resource_rows_and_question_drafts(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    appearance: str,
) -> None:
    first, second = workspace_journey.chats
    shell_path = f"/v1/sessions/{first.session_id}/resources/shells/codex_native/checks"
    retained_output = "Exact retained checks output: workspace-a / codex_native / checks\n"
    shell = {
        "id": "checks",
        "type": "shell",
        "source": "codex_native",
        "resource_id": "checks",
        "session_id": first.session_id,
        "command": "pnpm test",
        "description": "Focused checks",
        "output_preview": "Checks are running",
        "status": "running",
        "resource_url": shell_path,
        "can_open": True,
        "can_stop": True,
        "stop_url": shell_path + "/stop",
        "stop_method": "POST",
    }
    child = {
        "id": "refinement-helper",
        "title": "Hilbert",
        "agent_name": "Hilbert",
        "session_name": "Hilbert",
        "task_summary": "Inspect resource controls",
        "busy": True,
        "current_task_status": "in_progress",
        "pending_elicitations_count": 0,
        "labels": {},
    }
    offline: dict = {}
    pending_stop: list[Route] = []
    browser_contract.route(
        browser_contract._matcher(shell_path + "/stop"), lambda route: pending_stop.append(route)
    )
    first.update_session(background_task_count=1, background_tasks=[shell])
    browser_contract.json(
        f"/v1/sessions/{first.session_id}/resources/shells",
        lambda _request: {**list_payload([shell]), **offline},
    )
    browser_contract.json(
        shell_path,
        lambda _request: {**shell, "output": retained_output, **offline},
    )
    manual_creates: list[str] = []
    page.on(
        "request",
        lambda request: (
            manual_creates.append(request.url)
            if request.method == "POST" and re.search(r"/terminals(?:\?|$)", request.url)
            else None
        ),
    )
    browser_contract.json(f"/v1/sessions/{first.session_id}/child_sessions", list_payload([child]))
    browser_contract.json(f"/v1/sessions/{child['id']}/child_sessions", list_payload([]))
    browser_contract.json(
        f"/v1/sessions/{child['id']}",
        {**first.session_snapshot(), "id": child["id"], "title": "Hilbert", "status": "running"},
    )
    page.goto(first.url)
    editor = _view(page, "Chat A").get_by_label("Message the agent")
    editor.fill("Retained composer draft")
    first.wait_for_stream()
    questions = [
        {
            "id": "coverage",
            "header": "Coverage",
            "question": "Which checks should run?",
            "options": [
                {"label": "Focused", "description": "Changed controls"},
                {"label": "All", "description": "Full suite"},
            ],
            "multiSelect": False,
        },
        {
            "id": "timing",
            "question": "When should checks run?",
            "options": [{"label": "After review"}],
            "multiSelect": False,
        },
        {
            "id": "targets",
            "question": "Which surfaces need checks?",
            "options": [{"label": "Desktop"}, {"label": "Phone"}],
            "multiSelect": True,
        },
    ]
    resolves: list[dict] = []

    def resolve(route: Route) -> None:
        resolves.append(route.request.post_data_json)
        route.fulfill(json={"status": "ok"})

    browser_contract.route(
        browser_contract._matcher(
            f"/v1/sessions/{first.session_id}/elicitations/refinement-question/resolve"
        ),
        resolve,
    )
    first.emit(
        {
            "event": "response.elicitation_request",
            "data": {
                "type": "response.elicitation_request",
                "elicitation_id": "refinement-question",
                "params": {
                    "mode": "form",
                    "message": "Choose checks",
                    "phase": "tool_call",
                    "policy_name": "native",
                    "requestedSchema": {},
                    "ask_user_question": {"questions": questions},
                },
            },
        }
    )
    shelf = page.get_by_test_id("composer-attention-shelf")
    question = shelf.get_by_role("button", name="Questions: 1", exact=True)
    question.click()
    panel = page.get_by_role("dialog", name="Questions", exact=True)
    form = panel.get_by_test_id("ask-user-question-form")
    expect(form.locator("legend")).to_have_text("Which checks should run?")
    expect(form.locator("legend")).to_have_css("font-weight", "600")
    expect(panel.locator("[data-resource-row]")).to_have_count(0)
    expect(panel.get_by_test_id("ask-user-question-progress")).to_have_count(0)
    expect(form.get_by_text("Coverage", exact=True)).to_have_count(0)
    expect(panel).not_to_contain_text("Requested by")
    expect(panel).not_to_contain_text("Submit sends")
    expect(form.get_by_role("button", name="Skip (0/3)", exact=True)).to_be_enabled()
    expect(form.get_by_role("button", name=re.compile(r"^Submit"))).to_have_count(0)
    _assert_opaque_popup(panel, output_path, f"{appearance}-questions")
    pending_geometry = box(panel)
    custom = form.get_by_role("textbox", name="Custom answer text", exact=True)
    custom.fill("Run focused checks and preserve this answer")
    custom_node = custom.element_handle()
    page.keyboard.press("Escape")
    expect(form).to_be_hidden()
    expect(editor).to_have_value("Retained composer draft")
    question.click()
    expect(custom).to_have_value("Run focused checks and preserve this answer")
    assert custom_node and custom_node.evaluate("element => element.isConnected")
    expect(form.get_by_role("radio", name="Custom answer", exact=True)).to_be_checked()
    expect(form.get_by_role("button", name="Next (1/3)", exact=True)).to_be_enabled()
    form.get_by_role("button", name="Next (1/3)", exact=True).click()
    expect(form.locator("legend")).to_have_text("When should checks run?")
    expect(form.get_by_text("Coverage", exact=True)).to_have_count(0)
    expect(form.get_by_text("timing", exact=True)).to_have_count(0)
    expect(form.get_by_role("button", name="Skip (1/3)", exact=True)).to_be_enabled()
    form.get_by_role("button", name="Previous", exact=True).click()
    expect(custom).to_have_value("Run focused checks and preserve this answer")
    form.get_by_role("button", name="Next (1/3)", exact=True).click()
    form.get_by_role("button", name="Skip (1/3)", exact=True).click()
    expect(form.locator("legend")).to_have_text("Which surfaces need checks?")
    form.get_by_role("checkbox", name="Desktop", exact=True).check()
    form.get_by_role("checkbox", name="Phone", exact=True).check()
    expect(form.get_by_role("button", name="Submit (2/3)", exact=True)).to_be_enabled()
    footer = [
        box(form.get_by_role("button", name=name, exact=True))
        for name in ("Previous", "Decline", "Submit (2/3)")
    ]
    for left, right in pairwise(footer):
        assert_same_vertical_center(left, right)
        assert_no_overlap(left, right)
    for control in footer:
        assert_within_viewport(control, page.viewport_size["width"])
    assert resolves == []
    _capture(page, output_path, f"{appearance}-reopened-question-draft")
    form.get_by_role("button", name="Submit (2/3)", exact=True).click()
    expect(question).to_have_count(0)
    assert resolves == [
        {
            "action": "accept",
            "content": {
                "coverage": "Run focused checks and preserve this answer",
                "targets": ["Desktop", "Phone"],
            },
        }
    ]
    receipt = {
        "id": "refinement-question-receipt",
        "type": "resource_event",
        "status": "completed",
        "response_id": "refinement-question-submission",
        "resource_type": "question_batch",
        "event_type": "session.question.answered",
        "resource": {
            "version": 1,
            "session_id": first.session_id,
            "elicitation_id": "refinement-question",
            "submission_id": "refinement-question-submission",
            "action": "accept",
            "questions": [
                {
                    "id": item["id"],
                    "question": item["question"],
                    **({"header": item["header"]} if "header" in item else {}),
                    "answered": item["id"] in resolves[0]["content"],
                    **(
                        {"answer": resolves[0]["content"][item["id"]]}
                        if item["id"] in resolves[0]["content"]
                        else {}
                    ),
                }
                for item in questions
            ],
        },
    }
    first.set_items([receipt])
    first.emit({"event": "response.output_item.done", "data": {"item": receipt}})
    first.emit({"event": "response.output_item.done", "data": {"item": receipt}})
    answered = _view(page, "Chat A").get_by_test_id("approval-card")
    expect(answered).to_have_count(1)
    expect(answered).to_have_attribute("data-state", "responded")
    expect(answered.locator("strong")).to_have_text("Answered")
    answered_progress = answered.get_by_test_id("ask-user-question-progress")
    previous = answered.get_by_role("button", name="Previous question", exact=True)
    for _ in range(2):
        if previous.is_enabled():
            previous.click()
    expect(answered_progress).to_have_text("Question 1 of 3")
    answered.get_by_role("button", name="Next question", exact=True).click()
    expect(answered_progress).to_have_text("Question 2 of 3")
    expect(answered).to_contain_text("Unanswered")
    previous.click()
    expect(answered_progress).to_have_text("Question 1 of 3")
    expect(answered).to_contain_text("Run focused checks and preserve this answer")
    expect(_view(page, "Chat A").locator('[data-role="user"]')).to_have_count(0)
    answered_geometry = _assert_stable_disclosure(answered)
    (Path(output_path) / "question-header-geometry.json").write_text(
        json.dumps({"pending": pending_geometry, "answered": answered_geometry}, indent=2) + "\n"
    )
    _capture(page, output_path, f"{appearance}-one-answered-batch")
    page.keyboard.press("Escape")
    shelf.get_by_test_id("subagent-task-pill").click()
    agent_row = page.locator("[data-resource-row]:visible").filter(
        has=page.get_by_role("link", name="Hilbert", exact=True)
    )
    expect(agent_row).to_contain_text("Inspect resource controls")
    expect(agent_row).to_contain_text("Running")
    assert_activity_entry(agent_row)
    page.keyboard.press("Escape")
    shelf.get_by_test_id("background-task-pill").click()
    shell_popup = page.get_by_role("dialog", name="1 background task", exact=True)
    _assert_opaque_popup(shell_popup, output_path, f"{appearance}-shells")
    shell_row = shell_popup.locator("[data-resource-row]").filter(
        has=page.get_by_role("button", name="pnpm test", exact=True)
    )
    expect(shell_row).to_contain_text("Running")
    expect(
        shell_row.get_by_role("button", name="Stop actions for pnpm test", exact=True)
    ).to_be_visible()
    assert_activity_entry(shell_row)
    _capture(page, output_path, f"{appearance}-shelf-shell-resource")
    shell_row.get_by_role("button", name="Open shell beside · pnpm test", exact=True).click()
    page.keyboard.press("Escape")
    shell_view = _view(page, "pnpm test")
    expect(shell_view.get_by_label("Retained shell output", exact=True)).to_have_text(
        retained_output, timeout=15_000
    )
    expect(shell_view.get_by_text("Read-only output", exact=True)).to_be_visible()
    expect(page.get_by_role("tab", name="pnpm test", exact=True)).to_have_count(1)
    if appearance.startswith("desktop"):
        assert_no_overlap(box(_view(page, "Chat A")), box(shell_view))
    assert manual_creates == []
    assert workspace_journey.attachments == []
    _capture(page, output_path, f"{appearance}-exact-retained-shell-beside")
    page.get_by_role("tab", name="Chat A", exact=True).click()
    shelf.get_by_test_id("background-task-pill").click()
    shell_row.get_by_role("button", name="Show pnpm test in Orchestration", exact=True).click()
    page.keyboard.press("Escape")
    orchestration = _view(page, "Orchestration")
    source = orchestration.get_by_role("button", name=re.compile("^Choose orchestration source"))
    expect(source).to_contain_text("Chat A")

    def activity_filter(name: str, *, select: bool = False) -> None:
        inline = orchestration.get_by_role("button", name=name, exact=True)
        collapsed = not inline.is_visible()
        if collapsed:
            orchestration.get_by_role("button", name="Orchestration options", exact=True).click()
            control = page.get_by_role("menuitemradio", name=name, exact=True)
        else:
            control = inline
        if select:
            control.click()
        else:
            expect(control).to_have_attribute(
                "aria-checked" if collapsed else "aria-pressed", "true"
            )
            if collapsed:
                page.keyboard.press("Escape")

    activity_filter("Shells")
    focused = orchestration.locator('[data-shell-id="codex_native:checks"] [data-resource-row]')
    expect(focused).to_have_class(re.compile(r"\bring-1\b"))
    expect(page.get_by_role("tab", name="Orchestration", exact=True)).to_have_count(1)
    page.get_by_role("tab", name="Chat A", exact=True).click()
    shelf.get_by_test_id("background-task-pill").click()
    shell_row.get_by_role("button", name="Show pnpm test in Orchestration", exact=True).click()
    page.keyboard.press("Escape")
    expect(page.get_by_role("tab", name="Orchestration", exact=True)).to_have_count(1)
    expect(focused).to_have_class(re.compile(r"\bring-1\b"))
    activity_filter("All", select=True)
    agents = orchestration.get_by_role("list", name="Agents", exact=True)
    shells = orchestration.get_by_role("list", name="Shells", exact=True)
    expect(agents).to_contain_text("Hilbert")
    expect(shells).to_contain_text("pnpm test")
    for rows in (agents, shells):
        row = rows.locator("[data-resource-row]")
        expect(row).to_have_count(1)
        expect(row).to_contain_text("Running")
        assert_activity_entry(row)
        assert_within_viewport(box(row), page.viewport_size["width"])
    _capture(page, output_path, f"{appearance}-shared-orchestration-resources")
    live_row = shells.locator("[data-resource-row]")
    status = live_row.get_by_role("button", name="Stop actions for pnpm test", exact=True)
    page.mouse.move(0, 0)
    expect(status).to_have_accessible_description("Running")
    reserve = box(status)["width"]
    live_row.hover()
    samples = status.evaluate(
        """async element => {
          const read = delay => ({delay, width: element.getBoundingClientRect().width,
            running: getComputedStyle(element.querySelector('[role=status]')).visibility,
            stop: getComputedStyle(element.querySelector('.resource-stop-label')).visibility});
          const result = [read(0)];
          await new Promise(resolve => setTimeout(resolve, 50)); result.push(read(50));
          await new Promise(resolve => setTimeout(resolve, 150)); result.push(read(200));
          return result;
        }"""
    )
    coarse = page.evaluate("matchMedia('(pointer: coarse)').matches")
    for sample in samples:
        assert sample["running"] == ("visible" if coarse else "hidden"), sample
        assert sample["stop"] == ("hidden" if coarse else "visible"), sample
        assert sample["width"] == pytest.approx(reserve, abs=TOLERANCE), sample
    _capture(page, output_path, f"{appearance}-stop-swap")
    if coarse:
        bounds = box(status)
        page.touchscreen.tap(bounds["x"] - 9, bounds["y"] + bounds["height"] / 2)
        page.get_by_role("menuitem", name="Stop pnpm test", exact=True).tap()
    else:
        status.focus()
        page.keyboard.press("Tab")
        page.keyboard.press("Shift+Tab")
        expect(status).to_be_focused()
        expect(status.locator(".resource-stop-label")).to_be_visible()
        page.keyboard.press("Enter")
        expect(page.get_by_role("menuitem", name="Stop pnpm test", exact=True)).to_be_visible()
        page.keyboard.press("Escape")
        status.click()
    expect(status).to_be_disabled()
    assert len(pending_stop) == 1
    shell.update(status="stopped", exit_code=-1, can_stop=False)
    pending_stop.pop().fulfill(json=shell)
    expect(live_row.get_by_role("status", name="Stopped", exact=True)).to_be_visible()
    expect(
        live_row.get_by_role("button", name="Stop actions for pnpm test", exact=True)
    ).to_have_count(0)
    offline.update(availability="offline", warning="Showing retained shells.")
    page.get_by_role("tab", name="Chat A", exact=True).click()
    shelf.get_by_test_id("background-task-pill").click()
    shell_popup.get_by_role("button", name="Open shell beside · pnpm test", exact=True).click()
    page.keyboard.press("Escape")
    shell_view.get_by_role("button", name="Refresh shell output", exact=True).click()
    expect(shell_view.get_by_role("status", name="Stopped", exact=True)).to_be_visible()
    expect(shell_view.get_by_label("Retained shell output", exact=True)).to_have_text(
        retained_output
    )
    page.get_by_role("banner", name="Application").get_by_role(
        "button", name="Notifications", exact=True
    ).click()
    notices = page.get_by_role("dialog", name="Notifications", exact=True)
    expect(notices.get_by_text("Shell runtime offline", exact=True).first).to_be_visible()
    expect(
        notices.get_by_text(
            "Showing retained output. Refresh after the runtime reconnects.", exact=True
        ).first
    ).to_be_visible()
    notices.get_by_role("button", name="Close notifications", exact=True).click()
    expect(shell_view.get_by_role("alert")).to_have_count(0)
    assert manual_creates == [] and workspace_journey.attachments == []
    (Path(output_path) / "stop-label-timing.json").write_text(json.dumps(samples, indent=2) + "\n")
    _capture(page, output_path, f"{appearance}-offline-retained-shell")
    page.get_by_role("tab", name="Orchestration", exact=True).click()
    source.press("Enter")
    page.get_by_role("option", name="Chat B", exact=True).click()
    expect(source).to_contain_text("Chat B")
    expect(
        orchestration.get_by_role("list", name="Shells", exact=True).locator("[data-resource-row]")
    ).to_have_count(0)
    page.get_by_role("tab", name="Chat A", exact=True).click()
    page.get_by_role("tab", name="Orchestration", exact=True).click()
    expect(source).to_contain_text("Chat B")
    activity_filter("All")
    page.get_by_role("button", name="Close Orchestration", exact=True).click()
    _navigate_chat(page, second)
    _navigate_chat(page, first)
    expect(page.get_by_role("tab", name="Orchestration", exact=True)).to_have_count(0)
    assert manual_creates == []
    assert workspace_journey.attachments == []
    page.get_by_role("tab", name="Chat A", exact=True).click()
    expect(editor).to_have_value("Retained composer draft")
    assert first.event_posts == []
    page.reload()
    expect(answered).to_have_count(1)
    expect(answered.locator("strong")).to_have_text("Answered")
    expect(answered.get_by_test_id("ask-user-question-progress")).to_have_text("Question 1 of 3")
    expect(editor).to_have_value("Retained composer draft")


@pytest.mark.parametrize(
    "appearance",
    [
        ("desktop", "dark"),
        pytest.param(
            ("mobile", "light"),
            marks=pytest.mark.browser_context_args(has_touch=True, is_mobile=True),
        ),
        pytest.param(
            ("mobile", "dark"),
            marks=pytest.mark.browser_context_args(has_touch=True, is_mobile=True),
        ),
    ],
    ids=["desktop-dark", "mobile-light-touch", "mobile-dark-touch"],
    indirect=True,
)
def test_notice_popup_transport_fixture(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    appearance: str,
) -> None:
    """Scripted API notices prove browser transport and dismissal, not native capture."""
    first, second = workspace_journey.chats
    second.update_session(owner="local", archived=False)
    first.update_session(
        last_total_tokens=81_920,
        context_window=256_000,
        total_cost_usd=0.84,
        usage_by_model={
            "gpt-5.1-codex": {
                "input_tokens": 136_000,
                "output_tokens": 12_000,
                "total_tokens": 148_000,
                "cache_read_input_tokens": 96_000,
                "cache_creation_input_tokens": None,
                "total_cost_usd": 0.84,
            }
        },
    )
    observed_at = int(time.time())
    quotas = [
        {
            "id": f"fixture-{window}",
            "provider": "OpenAI",
            "window": window,
            "used_percent": percent,
            "reset_at": observed_at + reset_offset,
            "window_minutes": minutes,
            "status": None,
            "observed_at": observed_at - 180,
            "source_kind": "native",
        }
        for window, percent, reset_offset, minutes in (
            ("5 hours", 28, 7200, 300),
            ("Weekly", 61, -3600, 10_080),
        )
    ]
    notice = {
        "id": "fixture-usage-window",
        "revision": "one",
        "provider": "Codex",
        "title": "Usage limit approaching",
        "message": "Captured usage window is nearly full.",
        "severity": "warning",
        "created_at": 1_700_000_000,
        "requires_action": False,
    }
    path = f"/v1/sessions/{first.session_id}/runtime-notices"
    browser_contract.json(path, lambda _request: {**list_payload([notice]), "quotas": quotas})
    page.clock.install()
    page.goto(first.url)
    editor = _view(page, "Chat A").get_by_label("Message the agent")
    editor.fill("Keep this draft while reading notices")
    trigger = page.get_by_role("button", name="Notices: 1", exact=True)
    usage = page.get_by_role("button", name="Usage", exact=True)
    expect(usage).to_be_visible()
    header = _view(page, "Chat A").locator(".workspace-control-header")
    expect(header.get_by_role("button", name="Notices: 1", exact=True)).to_have_count(1)
    expect(header.get_by_role("button", name="Usage", exact=True)).to_have_count(1)
    shelf = page.get_by_test_id("composer-attention-shelf")
    expect(shelf.get_by_role("button", name=re.compile(r"^(Usage|Notices)"))).to_have_count(0)
    usage.click()
    usage_popup = page.get_by_role("dialog", name="Conversation usage", exact=True)
    for label in ("Context usage", "Session accounting", "Provider quotas"):
        expect(usage_popup.get_by_role("region", name=label, exact=True)).to_be_visible()
    expect(usage_popup.get_by_role("heading", name="Usage", exact=True)).to_be_visible()
    context = usage_popup.get_by_role("region", name="Context usage", exact=True)
    expect(context).to_contain_text(re.compile(r"81\.9k / 256k tokens", re.IGNORECASE))
    context_bar = context.get_by_role("progressbar", name="Context used", exact=True)
    expect(context_bar).to_have_attribute("aria-valuenow", "32")
    expect(context_bar).to_have_attribute("aria-valuetext", "32% used")
    assert box(context_bar)["height"] == pytest.approx(3, abs=TOLERANCE)
    accounting = usage_popup.get_by_role("region", name="Session accounting", exact=True)
    cost = accounting.locator("dl > div").filter(has=page.get_by_text("Session cost", exact=True))
    tokens = accounting.locator("dl > div").filter(
        has=page.get_by_text("Session tokens", exact=True)
    )
    expect(cost.locator("dd")).to_have_text("$0.84 USD")
    expect(tokens.locator("dd")).to_have_text(re.compile(r"148k", re.IGNORECASE))
    assert_same_vertical_center(box(cost), box(tokens))
    assert_no_overlap(box(cost), box(tokens))
    expect(accounting).to_contain_text("This session, including descendants")
    token_details = accounting.get_by_role("button", name="Token breakdown", exact=True)
    expect(token_details).to_have_attribute("aria-expanded", "false")
    expect(accounting.get_by_role("heading", name="gpt-5.1-codex", exact=True)).to_be_hidden()
    provider = usage_popup.get_by_role("region", name="Provider quotas", exact=True)
    for window, percent in (("5 hours", 28), ("Weekly", 61)):
        expect(provider.get_by_text(f"OpenAI · {window}", exact=True)).to_be_visible()
        quota_bar = provider.get_by_role(
            "progressbar", name=f"OpenAI {window} allowance used", exact=True
        )
        expect(quota_bar).to_have_attribute("aria-valuenow", str(percent))
        assert box(quota_bar)["height"] == pytest.approx(3, abs=TOLERANCE)
    expect(provider.get_by_text("Current availability unconfirmed", exact=True)).to_have_count(1)
    observation_details = provider.get_by_role("button", name="Observation details", exact=True)
    expect(observation_details).to_have_attribute("aria-expanded", "false")
    expect(provider.get_by_text("Reported window: 300 minutes", exact=True)).to_be_hidden()
    _assert_opaque_popup(usage_popup, output_path, f"{appearance}-usage")
    assert_within_viewport(box(usage_popup), page.viewport_size["width"])
    _capture(page, output_path, f"{appearance}-compact-usage")
    token_details.click()
    expect(token_details).to_have_attribute("aria-expanded", "true")
    expect(accounting.get_by_role("heading", name="gpt-5.1-codex", exact=True)).to_be_visible()
    for label, value in (("Input", "136,000"), ("Output", "12,000"), ("Cache read", "96,000")):
        row = accounting.locator("dl > div").filter(has=page.get_by_text(label, exact=True))
        expect(row.locator("dd")).to_have_text(value)
    expect(accounting.get_by_text("Cache write", exact=True)).to_have_count(0)
    token_details.click()
    observation_details.click()
    expect(observation_details).to_have_attribute("aria-expanded", "true")
    expect(provider.get_by_text("Reported window: 300 minutes", exact=True)).to_be_visible()
    expect(provider.get_by_text("Source: native", exact=True)).to_have_count(2)
    _capture(page, output_path, f"{appearance}-usage-observation-details")
    page.keyboard.press("Escape")
    trigger.click()
    popup = page.get_by_role("dialog", name="Agent notices", exact=True)
    expect(popup).to_contain_text("Codex · Usage limit approaching")
    expect(popup).to_contain_text(notice["message"])
    expect(popup.get_by_role("button", name="Open Agent CLI", exact=True)).to_be_visible()
    expect(
        popup.get_by_role("button", name=re.compile("Submit|Approve|Switch model"))
    ).to_have_count(0)
    _assert_opaque_popup(popup, output_path, f"{appearance}-notices")
    assert_within_viewport(box(popup), page.viewport_size["width"])
    _capture(page, output_path, f"{appearance}-notice-popup-transport-fixture")
    popup.get_by_role("button", name="Dismiss", exact=True).click()
    expect(trigger).to_have_count(0)
    expect(editor).to_have_value("Keep this draft while reading notices")
    with page.expect_response(lambda response: response.url.split("?")[0].endswith(path)):
        page.reload()
    expect(page.get_by_role("button", name="Notices: 1", exact=True)).to_have_count(0)
    notice.update(revision="two", message="A new usage-window observation is available.")
    page.reload()
    trigger.click()
    expect(popup).to_contain_text(notice["message"])
    page.keyboard.press("Escape")
    # A normal sidebar action reaches the same notification frame as history.
    if appearance.startswith("mobile"):
        page.get_by_role("button", name="Open navigation", exact=True).click()
    row = page.locator(f'aside [data-sidebar-session-id="{second.session_id}"]')
    row.hover()
    row.get_by_role("button", name="Conversation actions", exact=True).click()
    page.clock.pause_at(page.evaluate("Date.now() + 1000"))
    page.get_by_role("menuitem", name="Archive", exact=True).click()
    page.clock.run_for(100)
    notification = page.get_by_test_id("archive-undo-toast-item")
    expect(notification).to_be_visible()
    if appearance.startswith("mobile"):
        scrim = page.get_by_role("button", name="Close sidebar", exact=True)
        scrim.click(position={"x": box(scrim)["width"] - 8, "y": 200})
        page.clock.run_for(100)
    bell = page.get_by_role("banner", name="Application").get_by_role(
        "button", name="Notifications", exact=True
    )
    preview = page.get_by_role("region", name="Notifications", exact=True)
    expect(preview.get_by_test_id("archive-undo-toast-item")).to_be_visible()
    notification_id = notification.get_attribute("data-notification-id")
    assert notification_id
    retained_card = page.locator(f'[data-notification-id="{notification_id}"]')
    expect(retained_card).to_have_count(1)
    bell_bounds, preview_bounds = box(bell), box(preview)
    assert preview_bounds["y"] == pytest.approx(
        bell_bounds["y"] + bell_bounds["height"] + 12, abs=TOLERANCE
    ), (bell_bounds, preview_bounds)
    assert preview_bounds["x"] + preview_bounds["width"] == pytest.approx(
        min(bell_bounds["x"] + bell_bounds["width"], page.viewport_size["width"] - 16),
        abs=TOLERANCE,
    ), (bell_bounds, preview_bounds)
    assert_no_overlap(bell_bounds, preview_bounds)
    assert_within_viewport(preview_bounds, page.viewport_size["width"])

    def notification_geometry(card: Locator, *, history: bool = False) -> dict:
        close = card.locator("[data-close-button]")
        expect(close).to_have_count(1)
        target = box(close)
        surface = box(close.locator("[data-close-surface]"))
        assert surface["width"] == pytest.approx(24, abs=TOLERANCE)
        assert surface["height"] == pytest.approx(24, abs=TOLERANCE)
        assert target["width"] == pytest.approx(
            44 if appearance.startswith("mobile") else 24, abs=TOLERANCE
        )
        assert_same_vertical_center(box(card.locator(".notification-icon")), target)
        assert_same_vertical_center(box(card.locator(".notification-title")), target)
        assert_no_overlap(box(card.locator(".notification-body")), target)
        assert_within_viewport(box(card), page.viewport_size["width"])
        expect(card.locator("time")).to_have_count(1 if history else 0)
        if history:
            for action in card.locator(".notification-actions button").all():
                assert_no_overlap(box(card.locator("time")), box(action))
        return {"card": box(card), "target": target, "surface": surface}

    notification_measurements = {
        "id": notification_id,
        "bell": bell_bounds,
        "viewport": preview_bounds,
        "configuredWidth": preview.evaluate("element => element.style.width"),
        "popup": notification_geometry(notification),
    }
    _capture(page, output_path, f"{appearance}-notification-popup-geometry")
    page.clock.run_for(1000)
    expect(notification).to_be_visible()
    expect(notification.get_by_role("button", name="Undo", exact=True)).to_be_visible()
    bell.click()
    page.clock.run_for(100)
    center = page.get_by_role("dialog", name="Notifications", exact=True)
    expect(preview).to_be_hidden()
    _assert_opaque_popup(center, output_path, f"{appearance}-notifications")
    history_card = center.get_by_test_id("archive-undo-toast-item")
    expect(history_card).to_have_attribute("data-notification-id", notification_id)
    expect(retained_card).to_have_count(1)
    expect(history_card.get_by_role("button", name="Undo", exact=True)).to_be_visible()
    expect(history_card.get_by_role("button", name="View archived", exact=True)).to_be_visible()
    center_bounds = box(center)
    assert (
        center.evaluate("element => element.style.width")
        == notification_measurements["configuredWidth"]
    )
    assert center_bounds["width"] == pytest.approx(preview_bounds["width"], abs=TOLERANCE)
    notification_measurements["feed"] = center_bounds
    notification_measurements["history"] = notification_geometry(history_card, history=True)
    header = center.locator(".notification-center-header")
    for action in header.get_by_role("button").all():
        assert_same_vertical_center(box(header), box(action))
    center.get_by_role("button", name="Close notifications", exact=True).click()
    expect(preview).to_be_hidden()
    expect(retained_card).to_have_count(0)
    bell.click()
    page.clock.run_for(100)
    expect(history_card).to_have_attribute("data-notification-id", notification_id)
    expect(history_card.get_by_role("button", name="Undo", exact=True)).to_be_visible()
    center.get_by_role("button", name="Close notifications", exact=True).click()
    page.clock.fast_forward(6000)
    expect(preview).to_be_hidden()
    expect(retained_card).to_have_count(0)
    bell.click()
    page.clock.run_for(100)
    expect(history_card).to_have_attribute("data-notification-id", notification_id)
    expect(retained_card).to_have_count(1)
    expect(history_card.get_by_role("button", name="Restore", exact=True)).to_be_visible()
    notification_measurements["expiredHistory"] = notification_geometry(history_card, history=True)
    with page.expect_response(
        lambda response: (
            response.request.method == "PATCH"
            and response.url.endswith(f"/v1/sessions/{second.session_id}")
        )
    ):
        history_card.get_by_role("button", name=re.compile(r"^(Undo|Restore)$")).click()
    expect(editor).to_have_value("Keep this draft while reading notices")
    center.get_by_role("button", name="Close notifications", exact=True).click()
    expect(preview).to_be_hidden()
    expect(retained_card).to_have_count(0)
    page.clock.resume()
    (Path(output_path) / "notification-geometry.json").write_text(
        json.dumps(notification_measurements, indent=2) + "\n"
    )
    assert second.session_patches == [{"archived": True}, {"archived": False}]
    page.goto(second.url)
    expect(_view(page, "Chat B").get_by_label("Message the agent")).to_be_visible()
    expect(page.get_by_role("button", name="Notices: 1", exact=True)).to_have_count(0)
    assert first.event_posts == [] and second.event_posts == []


def _finish_finite_control_motion(control: Locator) -> None:
    control.evaluate("""async element => {
      await Promise.all(element.getAnimations({subtree: true})
        .filter(animation => animation.effect &&
          Number.isFinite(animation.effect.getTiming().iterations))
        .map(animation => animation.finished.catch(() => {})));
    }""")


def _assert_centered_control_popup(
    page: Page, popup: Locator, trigger: Locator, *, column: Locator | None = None
) -> dict:
    expect(popup).to_be_visible()
    _finish_finite_control_motion(popup)
    popup_box, trigger_box = box(popup), box(trigger)
    left, right = 8.0, float(page.viewport_size["width"] - 8)
    if column is not None:
        bounds = column.evaluate("""element => {
          const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
          return {left:rect.left + (parseFloat(style.paddingLeft) || 0),
            right:rect.right - (parseFloat(style.paddingRight) || 0)};
        }""")
        left, right = max(left, bounds["left"]), min(right, bounds["right"])
    assert popup_box["width"] <= right - left + TOLERANCE, popup_box
    expected_left = max(
        left,
        min(
            trigger_box["x"] + trigger_box["width"] / 2 - popup_box["width"] / 2,
            right - popup_box["width"],
        ),
    )
    assert popup_box["x"] == pytest.approx(expected_left, abs=TOLERANCE)
    expect(popup).to_have_attribute("data-align", "center")
    assert_within_viewport(popup_box, page.viewport_size["width"])
    return {"popup": popup_box, "trigger": trigger_box, "bounds": [left, right]}


def test_iteration5_composer_mention_safety_and_local_caret(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    appearance: str,
) -> None:
    Path(output_path).mkdir(parents=True, exist_ok=True)
    first, second = workspace_journey.chats
    first.harness = "claude-native"
    first.set_items(
        [
            message_item("caret-quote", "assistant", "Quote local caret proof", response_id="q"),
            message_item(
                "caret-history", "assistant", "History paragraph.\n\n" * 90, response_id="h"
            ),
        ]
    )
    listing = list_payload([{"path": "notes.py", "name": "notes.py", "type": "file", "bytes": 20}])
    for environment in (
        f"/v1/sessions/{first.session_id}/resources/environments/default",
        "/v1/workbench-workspaces/workspace-files/resources/environments/default",
    ):
        browser_contract.json(environment + "/filesystem", listing)
    browser_contract.json(
        "/v1/context-references/chats",
        {
            "data": [{"id": second.session_id, "title": "Chat B", "parent_id": None}],
            "has_more": False,
            "next_cursor": None,
        },
    )
    page.goto(first.url)
    chat = _view(page, "Chat A")
    editor = chat.get_by_label("Message the agent", exact=True)
    expect(editor).to_be_visible()
    first.wait_for_stream()
    editor.evaluate("""element => {
      const form = element.closest('form'); form.dataset.testSubmits = '0';
      form.addEventListener('submit', () => {
        form.dataset.testSubmits = String(Number(form.dataset.testSubmits) + 1);
      });
    }""")
    page.locator('input[type="file"]').first.set_input_files(
        {"name": "keep.txt", "mimeType": "text/plain", "buffer": b"retained file"}
    )
    expect(chat.get_by_role("button", name="Remove keep.txt", exact=True)).to_be_visible()
    editor.fill("Keep @notes")
    picker = chat.locator("[data-context-reference-picker]")
    expect(picker.get_by_role("tablist")).to_have_count(0)
    picker.get_by_role("button", name="notes.py", exact=True).click()
    expect(editor).to_have_value("Keep ")
    expect(chat.get_by_text("@notes.py", exact=True)).to_be_visible()
    editor.fill("Keep @Chat")
    chat_choice = picker.get_by_role("button", name="Chat B", exact=True)
    expect(chat_choice).to_be_visible()
    editor.press("Enter")
    if appearance.startswith("mobile"):
        expect(editor).to_have_value("Keep @Chat\n")
        expect(picker).to_have_count(0)
        assert first.event_posts == []
        editor.fill("Keep @Chat")
        chat_choice.click()
    expect(picker).to_have_count(0)
    expect(chat.get_by_role("link", name="@Chat B")).to_have_attribute("href", second.url)
    expect(chat.get_by_role("button", name="Remove keep.txt", exact=True)).to_be_visible()
    assert editor.evaluate("element => element.closest('form').dataset.testSubmits") == "0"
    assert first.event_posts == []

    editor.focus()
    draft = "\n".join(
        f"Draft line {index}: keep wrapped caret content " * 2 for index in range(22)
    )
    editor.fill(draft)
    page.evaluate(
        "() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
    )
    editor.evaluate(
        """element => {
          element.setSelectionRange(element.value.length, element.value.length);
          element.scrollTop = element.scrollHeight;
        }"""
    )
    transcript = chat.locator('[role="log"] > div').first
    before = transcript.evaluate("element => element.scrollTop")
    root_before = page.evaluate("document.scrollingElement.scrollTop")
    editor.press("Alt+Enter")
    expect(editor).to_have_value(draft + "\n")
    page.evaluate(
        "() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
    )
    caret = editor.evaluate("""element => ({scrollTop:element.scrollTop,
      remaining:element.scrollHeight - element.clientHeight - element.scrollTop,
      lineHeight:parseFloat(getComputedStyle(element).lineHeight),
      selection:[element.selectionStart, element.selectionEnd]})""")
    assert caret["scrollTop"] > 0 and caret["remaining"] <= TOLERANCE, caret
    assert caret["selection"] == [len(draft) + 1, len(draft) + 1], caret
    assert transcript.evaluate("element => element.scrollTop") == pytest.approx(
        before, abs=TOLERANCE
    )
    assert page.evaluate("document.scrollingElement.scrollTop") == root_before

    chat.get_by_text("Quote local caret proof", exact=True).evaluate("""element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    }""")
    page.get_by_role("menu", name="Selected text", exact=True).get_by_role(
        "menuitem", name="Reply", exact=True
    ).click()
    quoted = chat.get_by_label("Reply text before quote 1", exact=True)
    expect(quoted).to_have_value(draft + "\n")
    quoted.evaluate("""element => {
      element.focus({preventScroll:true});
      element.setSelectionRange(element.value.length, element.value.length);
      const area = element.closest('[data-composer-input-area]');
      area.scrollTop += element.getBoundingClientRect().bottom
        - area.getBoundingClientRect().bottom
        - parseFloat(getComputedStyle(element).lineHeight);
    }""")
    before = transcript.evaluate("element => element.scrollTop")
    root_before = page.evaluate("document.scrollingElement.scrollTop")
    quoted.press("Alt+Enter")
    expect(quoted).to_have_value(draft + "\n\n")
    page.evaluate(
        "() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
    )
    quote_geometry = quoted.evaluate("""element => {
      const area = element.closest('[data-composer-input-area]');
      return {field:element.getBoundingClientRect().toJSON(),
        area:area.getBoundingClientRect().toJSON(),
        inputScroll:element.scrollTop, areaScroll:area.scrollTop,
        selection:[element.selectionStart,element.selectionEnd]};
    }""")
    assert quote_geometry["inputScroll"] == 0 and quote_geometry["areaScroll"] > 0, quote_geometry
    assert quote_geometry["field"]["bottom"] <= quote_geometry["area"]["bottom"] + TOLERANCE
    assert quote_geometry["selection"] == [len(draft) + 2, len(draft) + 2]
    assert transcript.evaluate("element => element.scrollTop") == pytest.approx(
        before, abs=TOLERANCE
    )
    assert page.evaluate("document.scrollingElement.scrollTop") == root_before
    assert first.event_posts == []
    (Path(output_path) / f"{appearance}-composer-caret.json").write_text(
        json.dumps({"textarea": caret, "quote": quote_geometry}, indent=2) + "\n"
    )
    _capture(page, output_path, f"{appearance}-composer-mention-caret")


def test_iteration5_settled_shelf_manual_reveal_and_answer_focus(
    page: Page,
    workspace_journey: WorkspaceJourney,
    browser_contract: BrowserContract,
    output_path: str,
    appearance: str,
) -> None:
    Path(output_path).mkdir(parents=True, exist_ok=True)
    first = workspace_journey.chats[0]
    first.update_session(
        todos=[{"content": "Control proof", "status": "in_progress", "activeForm": ""}],
        background_task_count=0,
        background_tasks=[],
    )
    page.goto(first.url)
    chat = _view(page, "Chat A")
    editor = chat.get_by_label("Message the agent", exact=True)
    editor.fill("Retain shelf draft")
    first.wait_for_stream()
    shelf = chat.get_by_test_id("composer-attention-shelf")
    expect(shelf.get_by_role("button", name="Plan: 0 of 1 completed", exact=True)).to_be_visible()
    todos = [{"content": "Control proof", "status": "completed", "activeForm": ""}]
    first.update_session(todos=todos)
    first.emit(
        {
            "event": "session.todos",
            "data": {"type": "session.todos", "conversation_id": first.session_id, "todos": todos},
        }
    )
    expect(shelf).to_be_hidden()
    assert (
        shelf.evaluate(
            "element => element.closest('.composer-shelf-presence').getBoundingClientRect().height"
        )
        == 0
    )
    actions = chat.get_by_test_id("header-conversation-actions")
    actions.click()
    page.get_by_role("menuitem", name="Open plan", exact=True).click()
    plan = page.get_by_role("dialog", name="Plan", exact=True)
    expect(plan).to_contain_text("Control proof")
    page.keyboard.press("Escape")
    actions.click()
    page.get_by_role("menuitem", name="Hide activity shelf", exact=True).click()
    expect(shelf).to_be_hidden()

    resolves: list[dict] = []

    def resolve(route: Route) -> None:
        resolves.append(route.request.post_data_json)
        route.fulfill(json={"status": "ok"})

    browser_contract.route(
        browser_contract._matcher(
            f"/v1/sessions/{first.session_id}/elicitations/idle-question/resolve"
        ),
        resolve,
    )
    first.emit(
        {
            "event": "response.elicitation_request",
            "data": {
                "type": "response.elicitation_request",
                "elicitation_id": "idle-question",
                "params": {
                    "mode": "form",
                    "message": "Choose scope",
                    "phase": "tool_call",
                    "policy_name": "native",
                    "requestedSchema": {},
                    "ask_user_question": {
                        "questions": [
                            {
                                "id": "scope",
                                "question": "Which scope?",
                                "options": [{"label": "Focused"}],
                                "multiSelect": False,
                            }
                        ]
                    },
                },
            },
        }
    )
    question = shelf.get_by_role("button", name="Questions: 1", exact=True)
    expect(question).to_be_visible()
    question.click()
    panel = page.get_by_role("dialog", name="Questions", exact=True)
    popup_geometry = _assert_centered_control_popup(
        page, panel, question, column=chat.locator(".composer-shelf-stack")
    )
    custom = panel.get_by_role("textbox", name="Custom answer text", exact=True)
    custom.fill("Retain this unsent answer")
    custom.focus()
    focus = custom.evaluate("""element => {
      const inner = getComputedStyle(element), outer = getComputedStyle(element.closest('label'));
      return {visible:element.matches(':focus-visible'), innerShadow:inner.boxShadow,
        innerOutline:inner.outlineStyle, outerShadow:outer.boxShadow};
    }""")
    assert focus["visible"] and focus["innerShadow"] == "none", focus
    assert focus["innerOutline"] == "none" and focus["outerShadow"] != "none", focus
    answer_node = custom.element_handle()
    page.keyboard.press("Escape")
    actions.click()
    page.get_by_role("menuitem", name="Hide activity shelf", exact=True).click()
    expect(shelf).to_be_hidden()
    actions.click()
    page.get_by_role("menuitem", name="Show activity shelf", exact=True).click()
    question.click()
    expect(custom).to_have_value("Retain this unsent answer")
    assert answer_node and answer_node.evaluate("element => element.isConnected")
    page.keyboard.press("Escape")
    actions.click()
    page.get_by_role("menuitem", name="Hide activity shelf", exact=True).click()
    expect(shelf).to_be_hidden()
    first.emit(
        {
            "event": "response.elicitation_request",
            "data": {
                "type": "response.elicitation_request",
                "elicitation_id": "new-idle-approval",
                "params": {
                    "mode": "form",
                    "message": "Approve focused checks",
                    "phase": "tool_call",
                    "policy_name": "native",
                    "requestedSchema": {},
                },
            },
        }
    )
    expect(shelf.get_by_role("button", name="Approvals: 1", exact=True)).to_be_visible()
    expect(editor).to_have_value("Retain shelf draft")
    assert resolves == [] and first.event_posts == []
    (Path(output_path) / f"{appearance}-shelf-focus.json").write_text(
        json.dumps({"popup": popup_geometry, "focus": focus}, indent=2) + "\n"
    )
    _capture(page, output_path, f"{appearance}-shelf-idle-reveal-focus")
    actions.click()
    page.get_by_role("menuitem", name="Open activity resources", exact=True).click()
    expect(_view(page, "Orchestration")).to_be_visible()


def test_iteration5_header_usage_held_paint_and_popup_bounds(
    page: Page,
    workspace_journey: WorkspaceJourney,
    output_path: str,
    appearance: str,
) -> None:
    Path(output_path).mkdir(parents=True, exist_ok=True)
    first = workspace_journey.chats[0]
    first.update_session(last_total_tokens=8192, context_window=256000)
    page.goto(first.url)
    chat = _view(page, "Chat A")
    usage = chat.get_by_role("button", name="Usage", exact=True)
    expect(usage).to_be_visible()

    def paint(control: Locator) -> dict:
        _finish_finite_control_motion(control)
        return control.evaluate("""element => {
          const surface = element.querySelector('[data-header-action-surface]') || element;
          const glyph = surface.querySelector('svg'), style = getComputedStyle(element);
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d'); context.fillStyle = style.backgroundColor;
          context.fillRect(0,0,1,1);
          return {target:element.getBoundingClientRect().toJSON(),
            surface:surface.getBoundingClientRect().toJSON(),
            glyph:glyph.getBoundingClientRect().toJSON(),
            outerAlpha:context.getImageData(0,0,1,1).data[3],
            color:getComputedStyle(surface).backgroundColor,
            padding:[style.paddingLeft,style.paddingRight],gap:style.columnGap,
            iconPadding:getComputedStyle(glyph).paddingLeft};
        }""")

    rest = paint(usage)
    usage.hover()
    hover = paint(usage)
    page.mouse.down()
    try:
        held = paint(usage)
        assert held["color"] != hover["color"], (hover, held)
        assert held["surface"]["width"] == pytest.approx(24, abs=TOLERANCE)
        assert held["surface"]["height"] == pytest.approx(24, abs=TOLERANCE)
        assert held["glyph"]["width"] == pytest.approx(16, abs=TOLERANCE)
        _capture(page, output_path, f"{appearance}-usage-held-paint")
    finally:
        page.mouse.up()
    popup = page.get_by_role("dialog", name="Conversation usage", exact=True)
    usage_bounds = _assert_centered_control_popup(page, popup, usage)
    opened = paint(usage)
    for state in (hover, held, opened):
        assert state["target"] == pytest.approx(rest["target"], abs=TOLERANCE)
        assert state["surface"] == pytest.approx(rest["surface"], abs=TOLERANCE)
        assert state["outerAlpha"] == 0, state
    page.keyboard.press("Escape")
    open_button = page.get_by_role("button", name="Open view", exact=True, include_hidden=True)
    open_rest = paint(open_button)
    assert open_rest["glyph"]["width"] == pytest.approx(16, abs=TOLERANCE)
    assert open_rest["iconPadding"] == "1px", open_rest
    if appearance.startswith("mobile"):
        assert open_rest["target"]["width"] >= 44 and open_rest["target"]["height"] >= 44
    else:
        assert open_rest["padding"] == ["6px", "10px"] and open_rest["gap"] == "4px"
        assert open_rest["target"]["height"] == pytest.approx(28, abs=TOLERANCE)
    open_button.hover()
    open_hover = paint(open_button)
    page.mouse.down()
    try:
        open_held = paint(open_button)
    finally:
        page.mouse.up()
    for state in (open_hover, open_held):
        assert state["target"] == pytest.approx(open_rest["target"], abs=TOLERANCE)
    open_popup = page.locator('[data-slot="dropdown-menu-content"][data-state="open"]')
    open_bounds = _assert_centered_control_popup(page, open_popup, open_button)
    page.keyboard.press("Escape")
    (Path(output_path) / f"{appearance}-header-controls.json").write_text(
        json.dumps(
            {
                "usage": {"rest": rest, "hover": hover, "held": held, "open": opened},
                "usagePopup": usage_bounds,
                "open": open_rest,
                "openPopup": open_bounds,
            },
            indent=2,
        )
        + "\n"
    )
