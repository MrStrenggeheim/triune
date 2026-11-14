# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Current refinements through the built SPA with explicit browser contracts.

These journeys prove rendering and interactions, not native CLI delivery.
"""

from __future__ import annotations

import io
import json
import re
from collections.abc import Iterator
from pathlib import Path

import pytest
from PIL import Image, ImageDraw
from playwright.sync_api import Locator, Page, Route, expect

from tests.browser_ui.chat._geometry_helpers import (
    TOLERANCE,
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
    params=[("desktop", "light"), ("desktop", "dark"), ("mobile", "light"), ("mobile", "dark")],
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
    page.emulate_media(color_scheme=theme)
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
        received = chat.locator('[data-message-id="received-report"]')
        sent = chat.locator('[data-message-id="sent-request"]')
        for card, direction, attribution, name in (
            (received, "received", "Jules from Chat B", "Jules"),
            (sent, "sent", "Orion sent to Chat B", "Orion"),
        ):
            expect(card).to_have_attribute("data-direction", direction)
            expect(card.locator("[data-resource-row]")).to_contain_text(attribution)
            expect(card.locator("strong")).to_have_text(name)
            expect(card.get_by_role("link", name="Chat B", exact=True)).to_have_attribute(
                "href", f"/c/{second.session_id}"
            )
            measurements[f"{direction}-{'reload' if reload else 'initial'}"] = (
                _assert_footerless_card(card, controls=3)
            )
        expect(chat.get_by_test_id("peer-message")).to_have_count(2)
        expect(chat.get_by_test_id("subagent-activity")).to_have_count(1)
        task = chat.get_by_test_id("subagent-activity")
        expect(task.get_by_role("status", name="Completed", exact=True)).to_be_visible()
        reply = chat.get_by_test_id("subagent-reply")
        expect(reply).to_have_count(1)
        _assert_footerless_card(task, controls=3)
        _assert_footerless_card(reply, controls=3)
        if not reload:
            task.get_by_role("button", name="Expand activity", exact=True).click()
            expect(task).to_contain_text("Full captured assignment.")
            _capture(page, output_path, f"{appearance}-expanded-task")
            task.get_by_role("button", name="Collapse activity", exact=True).click()
            reply.get_by_role("button", name="Expand activity", exact=True).click()
            expect(reply.get_by_role("table")).to_contain_text("FooterAbsent")
            _capture(page, output_path, f"{appearance}-expanded-reply")
            reply.get_by_role("button", name="Collapse activity", exact=True).click()
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
            disclosure = sent.get_by_role("button", name="Expand activity", exact=True)
            disclosure.click()
            expect(sent).to_contain_text("Expanded peer detail.")
            glyph = sent.locator(".resource-actions button[aria-controls] svg").evaluate(
                """element => ({duration: getComputedStyle(element).transitionDuration,
                    rotate: getComputedStyle(element).rotate,
                    transform: getComputedStyle(element).transform})"""
            )
            assert glyph["duration"] == "0s" and (
                glyph["rotate"] == "90deg" or glyph["transform"].startswith("matrix(0, 1")
            ), glyph
            sent.get_by_role("button", name="Collapse activity", exact=True).click()
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
    expect(received.locator("[data-resource-row]")).to_contain_text("Orion from Chat A")
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
    preview.scroll_into_view_if_needed()
    card_bounds, image_bounds, footer_bounds = box(card), box(preview), box(footer)
    assert image_bounds["width"] / image_bounds["height"] == pytest.approx(960 / 180, rel=0.01)
    assert image_bounds["height"] <= 180 + TOLERANCE
    gap = footer_bounds["y"] - image_bounds["y"] - image_bounds["height"]
    assert 0 <= gap <= 12 + TOLERANCE, (image_bounds, footer_bounds)
    assert card_bounds["height"] == pytest.approx(
        image_bounds["height"] + footer_bounds["height"] + 34, abs=2
    )
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
    page.emulate_media(color_scheme="light")
    attachment = message_item(
        "narrow-images",
        "user",
        "Portrait and tiny attachment footers",
        response_id="narrow-images",
    )
    sizes = [("portrait", 100, 1000), ("tiny", 1, 1)]
    originals: dict[str, bytes] = {}
    for name, image_width, image_height in sizes:
        image = Image.new("RGB", (image_width, image_height), "#68518b")
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
              return {
                name: image.alt, card: rect(card), image: rect(image), title: rect(title),
                footer: rect(title.parentElement.parentElement),
                footerParts: [...title.parentElement.parentElement.children].map(rect),
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
    for row in measurements:
        assert row["image"]["height"] <= min(256, row["naturalHeight"]) + TOLERANCE, row
        assert row["image"]["width"] <= row["naturalWidth"] + TOLERANCE, row
        assert row["image"]["width"] / row["image"]["height"] == pytest.approx(
            row["naturalWidth"] / row["naturalHeight"], rel=0.01
        ), row
        assert row["scrollWidth"] <= row["clientWidth"] + TOLERANCE, row
        assert row["titleHitTarget"], row
        for part in row["footerParts"]:
            assert_same_vertical_center(row["footer"], part)
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
                    "ask_user_question": {
                        "questions": [
                            {
                                "id": "coverage",
                                "question": "Which checks should run?",
                                "options": [
                                    {"label": "Focused", "description": "Changed controls"},
                                    {"label": "All", "description": "Full suite"},
                                ],
                                "multiSelect": False,
                            }
                        ]
                    },
                },
            },
        }
    )
    shelf = page.get_by_test_id("composer-attention-shelf")
    question = shelf.get_by_role("button", name="Questions: 1", exact=True)
    question.click()
    form = page.get_by_test_id("ask-user-question-form")
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
    _capture(page, output_path, f"{appearance}-reopened-question-draft")
    page.keyboard.press("Escape")
    shelf.get_by_test_id("subagent-task-pill").click()
    agent_row = page.locator("[data-resource-row]:visible").filter(
        has=page.get_by_role("link", name="Hilbert", exact=True)
    )
    expect(agent_row).to_contain_text("Inspect resource controls")
    expect(agent_row).to_contain_text("Running")
    agent_height = box(agent_row)["height"]
    page.keyboard.press("Escape")
    shelf.get_by_test_id("background-task-pill").click()
    shell_popup = page.get_by_role("dialog", name="1 background task", exact=True)
    shell_row = shell_popup.locator("[data-resource-row]").filter(
        has=page.get_by_role("button", name="pnpm test", exact=True)
    )
    expect(shell_row).to_contain_text("Running")
    expect(
        shell_row.get_by_role("button", name="Actions for pnpm test", exact=True)
    ).to_be_visible()
    shelf_height = box(shell_row)["height"]
    assert shelf_height == pytest.approx(agent_height, abs=TOLERANCE)
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
    expect(orchestration.get_by_role("button", name="Shells", exact=True)).to_have_attribute(
        "aria-pressed", "true"
    )
    focused = orchestration.locator('[data-shell-id="codex_native:checks"] [data-resource-row]')
    expect(focused).to_have_class(re.compile(r"\bring-1\b"))
    expect(page.get_by_role("tab", name="Orchestration", exact=True)).to_have_count(1)
    page.get_by_role("tab", name="Chat A", exact=True).click()
    shelf.get_by_test_id("background-task-pill").click()
    shell_row.get_by_role("button", name="Show pnpm test in Orchestration", exact=True).click()
    page.keyboard.press("Escape")
    expect(page.get_by_role("tab", name="Orchestration", exact=True)).to_have_count(1)
    expect(focused).to_have_class(re.compile(r"\bring-1\b"))
    orchestration.get_by_role("button", name="All", exact=True).click()
    agents = orchestration.get_by_role("list", name="Agents", exact=True)
    shells = orchestration.get_by_role("list", name="Shells", exact=True)
    expect(agents).to_contain_text("Hilbert")
    expect(shells).to_contain_text("pnpm test")
    for rows in (agents, shells):
        row = rows.locator("[data-resource-row]")
        expect(row).to_have_count(1)
        expect(row).to_contain_text("Running")
        assert box(row)["height"] == pytest.approx(shelf_height, abs=TOLERANCE)
        assert_within_viewport(box(row), page.viewport_size["width"])
    _capture(page, output_path, f"{appearance}-shared-orchestration-resources")
    live_row = shells.locator("[data-resource-row]")
    status = live_row.get_by_role("button", name="Actions for pnpm test", exact=True)
    page.mouse.move(0, 0)
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
    for sample in samples:
        assert sample["running"] == "hidden" and sample["stop"] == "visible", sample
        assert sample["width"] == pytest.approx(reserve, abs=TOLERANCE), sample
    _capture(page, output_path, f"{appearance}-stop-swap")
    status.click()
    expect(status).to_be_disabled()
    assert len(pending_stop) == 1
    shell.update(status="stopped", exit_code=-1, can_stop=False)
    pending_stop.pop().fulfill(json=shell)
    expect(live_row.get_by_role("status", name="Stopped", exact=True)).to_be_visible()
    expect(live_row.get_by_role("button", name="Actions for pnpm test", exact=True)).to_have_count(
        0
    )
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
    expect(page.get_by_text("Shell runtime offline", exact=True).first).to_be_visible()
    expect(
        page.get_by_text(
            "Showing retained output. Refresh after the runtime reconnects.", exact=True
        ).first
    ).to_be_visible()
    expect(shell_view.get_by_role("alert")).to_have_count(0)
    assert manual_creates == [] and workspace_journey.attachments == []
    (Path(output_path) / "stop-label-timing.json").write_text(json.dumps(samples, indent=2) + "\n")
    _capture(page, output_path, f"{appearance}-offline-retained-shell")
    page.get_by_role("tab", name="Orchestration", exact=True).click()
    source.click()
    page.get_by_role("option", name="Chat B", exact=True).click()
    expect(source).to_contain_text("Chat B")
    expect(
        orchestration.get_by_role("list", name="Shells", exact=True).locator("[data-resource-row]")
    ).to_have_count(0)
    page.get_by_role("tab", name="Chat A", exact=True).click()
    page.get_by_role("tab", name="Orchestration", exact=True).click()
    expect(source).to_contain_text("Chat B")
    expect(orchestration.get_by_role("button", name="All", exact=True)).to_have_attribute(
        "aria-pressed", "true"
    )
    page.get_by_role("button", name="Close Orchestration", exact=True).click()
    _navigate_chat(page, second)
    _navigate_chat(page, first)
    expect(page.get_by_role("tab", name="Orchestration", exact=True)).to_have_count(0)
    assert manual_creates == []
    assert workspace_journey.attachments == []
    page.get_by_role("tab", name="Chat A", exact=True).click()
    expect(editor).to_have_value("Retained composer draft")
    assert first.event_posts == []


@pytest.mark.parametrize(
    "appearance",
    [("desktop", "dark"), ("mobile", "light")],
    ids=["desktop-dark", "mobile-light"],
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
    browser_contract.json(path, lambda _request: list_payload([notice]))
    page.goto(first.url)
    editor = _view(page, "Chat A").get_by_label("Message the agent")
    editor.fill("Keep this draft while reading notices")
    trigger = page.get_by_role("button", name="Notices: 1", exact=True)
    trigger.click()
    popup = page.get_by_role("dialog", name="Agent notices", exact=True)
    expect(popup).to_contain_text("Codex · Usage limit approaching")
    expect(popup).to_contain_text(notice["message"])
    expect(popup.get_by_role("button", name="Open Agent CLI", exact=True)).to_be_visible()
    expect(
        popup.get_by_role("button", name=re.compile("Submit|Approve|Switch model"))
    ).to_have_count(0)
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
    _navigate_chat(page, second)
    expect(page.get_by_role("button", name="Notices: 1", exact=True)).to_have_count(0)
    assert first.event_posts == [] and second.event_posts == []
