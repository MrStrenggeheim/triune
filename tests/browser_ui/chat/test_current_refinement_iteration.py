# Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
# Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
"""Current refinements through the built SPA with explicit browser contracts.

These journeys prove rendering and interactions, not native CLI delivery.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from itertools import pairwise
from pathlib import Path

import pytest
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
        has=page.get_by_role("link", name="Open chat beside · Hilbert", exact=True)
    )
    expect(agent_row).to_contain_text("Inspect resource controls")
    expect(agent_row).to_contain_text("Running")
    assert_activity_entry(agent_row)
    page.keyboard.press("Escape")
    shelf.get_by_test_id("background-task-pill").click()
    shell_popup = page.get_by_role("dialog", name="1 background task", exact=True)
    _assert_opaque_popup(shell_popup, output_path, f"{appearance}-shells")
    shell_row = shell_popup.locator("[data-resource-row]").filter(
        has=page.get_by_role("button", name="Open shell beside · pnpm test", exact=True)
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
    expect(editor).to_have_text("Keep notes.py")
    expect(chat.get_by_text("notes.py", exact=True)).to_be_visible()
    editor.press_sequentially(" @Chat")
    chat_choice = picker.get_by_role("button", name="Chat B", exact=True)
    expect(chat_choice).to_be_visible()
    editor.press("Enter")
    if appearance.startswith("mobile"):
        expect(editor).to_have_text(re.compile(r"Keep notes.py @Chat"))
        expect(picker).to_have_count(0)
        assert first.event_posts == []
        editor.press_sequentially("@Chat")
        chat_choice.click()
    expect(picker).to_have_count(0)
    expect(chat.get_by_role("link", name="Chat B")).to_have_attribute("href", second.url)
    expect(chat.get_by_role("button", name="Remove keep.txt", exact=True)).to_be_visible()
    assert editor.evaluate("element => element.closest('form').dataset.testSubmits") == "0"
    assert first.event_posts == []

    chat.get_by_role("button", name="Remove Chat B", exact=True).click()
    chat.get_by_role("button", name="Remove notes.py", exact=True).click()
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
